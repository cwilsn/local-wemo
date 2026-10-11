import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { createApp } from '../src/server.js';
import { WemoPlug } from '../src/wemo.js';
import { close, fakeWemo, listen } from './helpers.js';

async function fixture(t, { readOnly = false, wemo = {}, publicOrigin } = {}) {
  const fake = await fakeWemo(wemo);
  t.after(() => close(fake.server));
  let stored = { enabled: false, onTime: '19:00', offTime: '23:00', timeZone: 'America/New_York' };
  const server = await createApp({ readOnly, publicOrigin, plug: new WemoPlug({ ip: '127.0.0.1', port: fake.port }),
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

async function proxyRequest(url, { headers, method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { headers, method }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode,
        data: JSON.parse(Buffer.concat(chunks).toString()) }));
    });
    request.on('error', reject);
    request.end(body);
  });
}

test('Tailscale HTTPS accepts the configured origin and token through its loopback proxy', async (t) => {
  const publicOrigin = 'https://pipipi.tailde190.ts.net';
  const { url, fake } = await fixture(t, { publicOrigin });
  const headers = { Host: 'pipipi.tailde190.ts.net', 'X-Forwarded-Host': 'pipipi.tailde190.ts.net',
    'X-Forwarded-Proto': 'https' };
  const config = await proxyRequest(`${url}/api/config`, { headers });
  assert.equal(config.status, 200);
  const state = await proxyRequest(`${url}/api/state`, { headers });
  assert.equal(state.status, 200);
  assert.equal(state.data.on, true);
  const command = await proxyRequest(`${url}/api/state`, { method: 'POST',
    headers: { ...headers, Origin: publicOrigin, 'X-Wemo-Token': config.data.token,
      'Content-Type': 'application/json' }, body: '{"on":false}' });
  assert.equal(command.status, 200);
  assert.equal(command.data.on, false);
  assert.deepEqual(fake.actions, ['GetBinaryState', 'SetBinaryState', 'GetBinaryState']);
  assert.equal((await fetch(`${url}/api/health`)).status, 200);
});

test('HTTPS proxy support still rejects untrusted hosts, missing proxy headers, and cross-origin writes', async (t) => {
  const publicOrigin = 'https://pipipi.tailde190.ts.net';
  const { url, fake, config } = await fixture(t, { publicOrigin });
  const headers = { Host: 'pipipi.tailde190.ts.net', 'X-Forwarded-Host': 'pipipi.tailde190.ts.net',
    'X-Forwarded-Proto': 'https' };
  for (const altered of [{ Host: headers.Host }, { ...headers, 'X-Forwarded-Host': 'evil.example' },
    { ...headers, Host: 'evil.example' }, { ...headers, 'X-Forwarded-Proto': 'http' }]) {
    const result = await proxyRequest(`${url}/api/config`, { headers: altered });
    assert.equal(result.status, 403);
  }
  for (const origin of ['https://evil.example', url, 'http://pipipi.tailde190.ts.net']) {
    const result = await proxyRequest(`${url}/api/state`, { method: 'POST',
      headers: { ...headers, Origin: origin, 'X-Wemo-Token': config.token,
        'Content-Type': 'application/json' }, body: '{"on":false}' });
    assert.equal(result.status, 403);
  }
  assert.deepEqual(fake.actions, []);
});

test('HTTPS proxy support must be explicitly configured with a valid HTTPS origin', async (t) => {
  const { url, fake } = await fixture(t);
  const response = await proxyRequest(`${url}/api/state`, { headers: {
    Host: 'pipipi.tailde190.ts.net', 'X-Forwarded-Host': 'pipipi.tailde190.ts.net',
    'X-Forwarded-Proto': 'https' } });
  assert.equal(response.status, 403);
  for (const publicOrigin of ['http://pipipi.tailde190.ts.net', 'https://pipipi.tailde190.ts.net/lights/',
    'https://name:password@pipipi.tailde190.ts.net', 'https://pipipi.tailde190.ts.net?test=1']) {
    await assert.rejects(createApp({ publicOrigin }), /PUBLIC_ORIGIN/);
  }
  assert.deepEqual(fake.actions, []);
});

test('serves the home menu and its assets through the existing app for the HTTPS root proxy', async (t) => {
  const { url, fake } = await fixture(t);
  const page = await fetch(`${url}/home/`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Welcome home/);
  assert.match(html, /href="\/pool\/"/);
  assert.match(html, /href="\/lights\/"/);
  for (const match of html.matchAll(/(?:href|src)="([^"]+\.(?:css|svg))"/g)) {
    const response = await fetch(new URL(match[1], `${url}/home/`));
    assert.equal(response.status, 200);
    assert.ok((await response.arrayBuffer()).byteLength > 0);
  }
  assert.equal((await fetch(`${url}/home/.env`)).status, 404);
  assert.deepEqual(fake.actions, []);
});
