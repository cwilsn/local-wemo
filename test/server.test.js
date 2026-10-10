import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { createApp } from '../src/server.js';
import { WemoPlug } from '../src/wemo.js';
import { close, fakeWemo, listen } from './helpers.js';

async function fixture(t, { readOnly = false, wemo = {} } = {}) {
  const fake = await fakeWemo(wemo);
  t.after(() => close(fake.server));
  let stored = { enabled: false, onTime: '19:00', offTime: '23:00', timeZone: 'America/New_York' };
  const server = await createApp({ readOnly, plug: new WemoPlug({ ip: '127.0.0.1', port: fake.port }),
    schedule: { getStatus() { return stored; }, async save(value) { stored = value; return stored; } } });
  const url = await listen(server);
  t.after(() => close(server));
  const config = await (await fetch(`${url}/api/config`)).json();
  return { fake, url, config, headers: { Origin: url, 'X-Wemo-Token': config.token, 'Content-Type': 'application/json' } };
}

test('serves the complete UI and reads state without switching the plug', async (t) => {
  const { fake, url } = await fixture(t);
  const page = await fetch(url);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(await page.text(), /Enable daily schedule/);
  for (const path of ['/app.js', '/style.css', '/icon.svg']) {
    assert.equal((await fetch(url + path)).status, 200);
  }
  assert.equal((await (await fetch(`${url}/api/state`)).json()).on, true);
  assert.deepEqual(fake.actions, ['GetBinaryState']);
  assert.equal((await fetch(`${url}/src/server.js`)).status, 404);
  assert.equal((await fetch(`${url}/.env`)).status, 404);
});

test('the browser API controls a simulated plug and confirms its final state', async (t) => {
  const { fake, url, headers } = await fixture(t);
  const off = await fetch(`${url}/api/state`, { method: 'POST', headers, body: JSON.stringify({ on: false }) });
  assert.equal(off.status, 200);
  assert.equal((await off.json()).on, false);
  assert.equal(fake.state, '0');
  const on = await fetch(`${url}/api/state`, { method: 'POST', headers, body: JSON.stringify({ on: true }) });
  assert.equal((await on.json()).on, true);
});

test('rejects cross-origin commands, missing tokens, and invalid state values', async (t) => {
  const { fake, url, headers } = await fixture(t);
  for (const altered of [{ ...headers, Origin: 'https://example.com' }, { Origin: url, 'Content-Type': 'application/json' }]) {
    assert.equal((await fetch(`${url}/api/state`, { method: 'POST', headers: altered, body: '{"on":false}' })).status, 403);
  }
  assert.equal((await fetch(`${url}/api/state`, { method: 'POST', headers, body: '{"on":"false"}' })).status, 400);
  const badHostStatus = await new Promise((resolve, reject) => {
    http.get(`${url}/api/config`, { headers: { Host: 'example.com' } }, (response) => {
      response.resume();
      resolve(response.statusCode);
    }).on('error', reject);
  });
  assert.equal(badHostStatus, 403);
  assert.deepEqual(fake.actions, []);
});

test('read-only mode blocks power commands', async (t) => {
  const { fake, url, headers, config } = await fixture(t, { readOnly: true });
  assert.equal(config.readOnly, true);
  assert.equal((await fetch(`${url}/api/state`, { method: 'POST', headers, body: '{"on":false}' })).status, 403);
  assert.deepEqual(fake.actions, []);
});

test('the browser API returns confirmed state when the plug applies the command but loses its reply', async (t) => {
  const { fake, url, headers } = await fixture(t, { wemo: { failWrite: true } });
  const result = await fetch(`${url}/api/state`, { method: 'POST', headers, body: '{"on":false}' });
  assert.equal(result.status, 200);
  assert.equal((await result.json()).on, false);
  assert.deepEqual(fake.actions, ['SetBinaryState', 'GetBinaryState']);
});
