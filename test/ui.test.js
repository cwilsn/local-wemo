import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

async function page({ readOnly = false, offline = false, stateRead, basePath = '/' } = {}) {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const script = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((match) => match[1]));
  const elements = new Map();
  class Element {
    constructor() {
      this.dataset = {};
      this.attributes = {};
      this.listeners = new Map();
      this.children = [];
      this._disabled = false;
      this.disabledChanges = [];
      this.hidden = false;
      this.value = '';
      this.checked = false;
    }
    get disabled() { return this._disabled; }
    set disabled(value) {
      if (this._disabled !== value) this.disabledChanges.push(value);
      this._disabled = value;
    }
    addEventListener(name, callback) { this.listeners.set(name, callback); }
    setAttribute(name, value) { this.attributes[name] = value; }
    replaceChildren() { this.children = []; }
    append(value) { this.children.push(value); }
    async fire(name) { await this.listeners.get(name)?.({ preventDefault() {} }); }
  }
  const document = {
    hidden: false,
    getElementById(id) {
      assert.ok(ids.has(id), 'Script refers to missing element: ' + id);
      if (!elements.has(id)) elements.set(id, new Element());
      return elements.get(id);
    },
    createElement() { return new Element(); },
    addEventListener() {},
  };
  let on = true;
  let stateReads = 0;
  let poll;
  let schedule = { enabled: false, onMode: 'time', sunset: '2026-10-10T22:43:45.913Z', onTime: '19:00', offTime: '23:00', timeZone: 'America/New_York' };
  const writes = [];
  const requests = [];
  const fetch = async (path, options) => {
    requests.push(new URL(path, 'https://pipipi.tailde190.ts.net' + basePath).pathname);
    let data;
    if (path === 'api/config') {
      data = { token: 'test-token', readOnly };
    } else if (path === 'api/state') {
      if (offline) throw new Error('Plug unavailable');
      if (options.method === 'POST') {
        const value = JSON.parse(options.body);
        writes.push({ path, ...value });
        on = value.on;
      }
      const snapshot = on;
      if (options.method !== 'POST' && stateRead) {
        await stateRead({ read: ++stateReads, on: snapshot });
      }
      data = { name: 'Stair Lights', on: snapshot };
    } else if (path === 'api/schedule') {
      if (options.method === 'POST') {
        const value = JSON.parse(options.body);
        writes.push({ path, ...value });
        schedule = { ...schedule, ...value };
      }
      data = schedule;
    } else {
      throw new Error('Unexpected API path');
    }
    return { ok: true, async json() { return data; } };
  };
  vm.runInNewContext(script, { document, fetch, AbortSignal, Intl, Date, setInterval(callback) { poll = callback; } });
  await new Promise((resolve) => setImmediate(resolve));
  return { element: (id) => document.getElementById(id), writes, document, poll, requests };
}

test('phone UI displays verified state and sends one explicit power command per tap', async () => {
  const { element, writes } = await page();
  assert.equal(element('powerButton').disabled, false);
  assert.equal(element('stateBadge').textContent, 'ON');
  assert.equal(element('lightCard').dataset.power, 'on');
  assert.equal(element('connectionText').textContent, 'Connected');
  assert.equal(element('powerButton').attributes['aria-label'], 'Turn off Stair Lights');
  await element('powerButton').fire('click');
  assert.deepEqual(writes, [{ path: 'api/state', on: false }]);
  assert.equal(element('stateBadge').textContent, 'OFF');
  assert.equal(element('powerButtonText').textContent, 'Turn lights on');
});

test('schedule form saves an overnight schedule and updates its active state', async () => {
  const { element, writes } = await page();
  element('scheduleEnabled').checked = true;
  element('onTime').value = '18:30';
  element('offTime').value = '01:00';
  await element('scheduleForm').fire('input');
  assert.equal(element('scheduleMessage').textContent, 'Unsaved changes');
  await element('scheduleForm').fire('submit');
  assert.deepEqual(writes, [{ path: 'api/schedule', enabled: true, onMode: 'time', onTime: '18:30', offTime: '01:00', timeZone: 'America/New_York' }]);
  assert.equal(element('scheduleBadge').textContent, 'ACTIVE');
  assert.match(element('scheduleMessage').textContent, /Saved/);
});

test('offline state disables switching instead of showing an assumed power state', async () => {
  const { element, writes } = await page({ offline: true });
  assert.equal(element('powerButton').disabled, true);
  assert.equal(element('lightCard').dataset.power, 'unknown');
  assert.equal(element('controlError').hidden, false);
  await element('powerButton').fire('click');
  assert.deepEqual(writes, []);
});

test('read-only preview disables both manual switching and schedule saves', async () => {
  const { element, writes } = await page({ readOnly: true });
  assert.equal(element('readOnlyNotice').hidden, false);
  assert.equal(element('powerButton').disabled, true);
  assert.equal(element('saveButton').disabled, true);
  assert.equal(element('onMode').disabled, true);
  await element('powerButton').fire('click');
  await element('scheduleForm').fire('submit');
  assert.deepEqual(writes, []);
});

test('background status polls never disable the power button', async () => {
  const { element, poll } = await page();
  const button = element('powerButton');
  const before = button.disabledChanges.length;
  await poll();
  assert.deepEqual(button.disabledChanges.slice(before), []);
  assert.equal(element('powerButtonText').textContent, 'Turn lights off');
});

test('a slow background poll permits a tap and cannot overwrite the confirmed change', async () => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const { element, writes, poll } = await page({
    async stateRead({ read }) {
      if (read === 2) {
        await held;
      }
    },
  });
  const polling = poll();
  assert.equal(element('powerButton').disabled, false);
  await element('powerButton').fire('click');
  release();
  await polling;
  assert.deepEqual(writes, [{ path: 'api/state', on: false }]);
  assert.equal(element('stateBadge').textContent, 'OFF');
  assert.equal(element('powerButtonText').textContent, 'Turn lights on');
  assert.equal(element('controlError').hidden, true);
});

test('a failed old poll cannot mark a newer confirmed change unavailable', async () => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const { element, poll } = await page({
    async stateRead({ read }) {
      if (read === 2) {
        await held;
        throw new Error('Old read lost its connection');
      }
    },
  });
  const polling = poll();
  await element('powerButton').fire('click');
  release();
  await polling;
  assert.equal(element('stateBadge').textContent, 'OFF');
  assert.equal(element('connectionText').textContent, 'Connected');
  assert.equal(element('powerButton').disabled, false);
});

test('sunset selector shows the local sunset preview and preserves the fixed-time setting', async () => {
  const { element } = await page();
  assert.equal(element('onMode').value, 'time');
  assert.equal(element('sunsetField').hidden, true);
  element('onMode').value = 'sunset';
  await element('scheduleForm').fire('input');
  assert.equal(element('onTimeField').hidden, true);
  assert.equal(element('onTime').disabled, true);
  assert.equal(element('sunsetField').hidden, false);
  assert.match(element('sunsetTime').textContent, /6:43|18:43/);
  assert.match(element('scheduleHint').textContent, /adjusts each day/);
  element('onMode').value = 'time';
  await element('scheduleForm').fire('input');
  assert.equal(element('onTimeField').hidden, false);
  assert.equal(element('onTime').disabled, false);
  assert.equal(element('onTime').value, '19:00');
});

test('sunset saves with a fixed off-time even when it matches the unused fixed on-time', async () => {
  const { element, writes } = await page();
  element('onMode').value = 'sunset';
  element('scheduleEnabled').checked = true;
  element('offTime').value = '19:00';
  await element('scheduleForm').fire('input');
  await element('scheduleForm').fire('submit');
  assert.deepEqual(writes, [{ path: 'api/schedule', enabled: true, onMode: 'sunset',
    onTime: '19:00', offTime: '19:00', timeZone: 'America/New_York' }]);
  assert.equal(element('scheduleBadge').textContent, 'ACTIVE');
  assert.equal(element('onTimeField').hidden, true);
});

test('light controls and scheduling keep API requests under the HTTPS lights path', async () => {
  const { element, requests } = await page({ basePath: '/lights/' });
  await element('powerButton').fire('click');
  await element('scheduleForm').fire('submit');
  assert.deepEqual(requests.toSorted(), ['/lights/api/config', '/lights/api/schedule',
    '/lights/api/schedule', '/lights/api/state', '/lights/api/state']);
});
