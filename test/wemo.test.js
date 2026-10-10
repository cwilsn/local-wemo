import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { once } from 'node:events';
import test from 'node:test';
import { DEFAULT_UDN, WemoPlug, discoverWemo, parseDiscoveryReply } from '../src/wemo.js';
import { close, fakeWemo } from './helpers.js';

test('reads and switches a simulated Wemo using SOAP, verifying the final state', async (t) => {
  const fake = await fakeWemo();
  t.after(() => close(fake.server));
  const plug = new WemoPlug({ ip: '127.0.0.1', port: fake.port });
  assert.equal((await plug.getState()).name, 'Stair & Hall Lights');
  assert.deepEqual(fake.actions, ['GetBinaryState']);
  assert.equal((await plug.setState(false)).on, false);
  assert.equal((await plug.setState(true)).on, true);
  assert.deepEqual(fake.actions, ['GetBinaryState', 'SetBinaryState', 'GetBinaryState', 'SetBinaryState', 'GetBinaryState']);
});

test('refuses to switch a different device at the configured address', async (t) => {
  const fake = await fakeWemo({ udn: 'uuid:Socket-other-device' });
  t.after(() => close(fake.server));
  const plug = new WemoPlug({ ip: '127.0.0.1', port: fake.port, discover: async () => [] });
  await assert.rejects(plug.setState(false), /Couldn’t reach/);
  assert.deepEqual(fake.actions, []);
});

test('uses discovery to recover when the plug changes its API port', async (t) => {
  const old = await fakeWemo();
  const plug = new WemoPlug({ ip: '127.0.0.1', port: old.port, discover: async () => [
    { udn: DEFAULT_UDN, location: `${replacement.url}/setup.xml` },
  ] });
  assert.equal((await plug.getState()).on, true);
  await close(old.server);
  const replacement = await fakeWemo({ state: '0' });
  t.after(() => close(replacement.server));
  assert.equal((await plug.getState()).on, false);
  assert.equal(plug.port, replacement.port);
});

test('confirms an applied command after its reply is lost without repeating the write', async (t) => {
  const fake = await fakeWemo({ failWrite: true });
  t.after(() => close(fake.server));
  const plug = new WemoPlug({ ip: '127.0.0.1', port: fake.port });
  assert.equal((await plug.setState(false)).on, false);
  assert.deepEqual(fake.actions, ['SetBinaryState', 'GetBinaryState']);
  assert.equal(fake.state, '0');
  assert.equal((await plug.getState()).on, false);
});

test('rejects unknown power states rather than treating them as off', async (t) => {
  const fake = await fakeWemo({ state: '2' });
  t.after(() => close(fake.server));
  const plug = new WemoPlug({ ip: '127.0.0.1', port: fake.port });
  await assert.rejects(plug.getState(), /unknown power state/);
  await assert.rejects(plug.setState('off'), /true or false/);
});

test('SSDP only accepts local responses for the intended device', () => {
  const reply = (location, udn = DEFAULT_UDN) => Buffer.from(`HTTP/1.1 200 OK\r\nLOCATION: ${location}\r\nUSN: ${udn}::urn:Belkin:service:basicevent:1\r\n\r\n`);
  assert.deepEqual(parseDiscoveryReply(reply('http://192.168.4.31:49153/setup.xml'), '192.168.4.31', DEFAULT_UDN), {
    udn: DEFAULT_UDN, location: 'http://192.168.4.31:49153/setup.xml',
  });
  assert.equal(parseDiscoveryReply(reply('http://192.168.4.32/setup.xml'), '192.168.4.31', DEFAULT_UDN), null);
  assert.equal(parseDiscoveryReply(reply('http://example.com/setup.xml'), '192.168.4.31', DEFAULT_UDN), null);
  assert.equal(parseDiscoveryReply(reply('http://192.168.4.31/setup.xml', 'uuid:other'), '192.168.4.31', DEFAULT_UDN), null);
});

test('sends and receives SSDP through a loopback UDP responder', async (t) => {
  const responder = dgram.createSocket('udp4');
  responder.bind(0, '127.0.0.1');
  await once(responder, 'listening');
  t.after(() => responder.close());
  let request;
  responder.on('message', (message, remote) => {
    request = message.toString();
    responder.send(`HTTP/1.1 200 OK\r\nLOCATION: http://127.0.0.1:49153/setup.xml\r\nUSN: ${DEFAULT_UDN}::urn:Belkin:service:basicevent:1\r\n\r\n`, remote.port, remote.address);
  });
  const devices = await discoverWemo({ udn: DEFAULT_UDN, interfaceAddress: '127.0.0.1', durationMs: 100,
    destination: { address: '127.0.0.1', port: responder.address().port } });
  assert.match(request, /M-SEARCH \* HTTP\/1\.1/);
  assert.match(request, /ST: urn:Belkin:service:basicevent:1/);
  assert.equal(devices.length, 1);
});

test('explains macOS reachability failures after trying discovery', { skip: process.platform !== 'darwin' }, async (t) => {
  let discovered = false;
  t.mock.method(http, 'request', () => {
    const request = new EventEmitter();
    request.end = () => queueMicrotask(() => request.emit('error', Object.assign(new Error('Host unreachable'), { code: 'EHOSTUNREACH' })));
    return request;
  });
  const plug = new WemoPlug({ discover: async () => { discovered = true; return []; } });
  await assert.rejects(plug.getState(), /No route to host.*Local Network/);
  assert.equal(discovered, true);
});

test('an unreachable old Mac address still permits discovery of the plug at its new address', { skip: process.platform !== 'darwin' }, async (t) => {
  const fake = await fakeWemo();
  t.after(() => close(fake.server));
  const realRequest = http.request.bind(http);
  t.mock.method(http, 'request', (url, ...args) => {
    if (url.hostname !== '192.168.4.31') {
      return realRequest(url, ...args);
    }
    const request = new EventEmitter();
    request.end = () => queueMicrotask(() => request.emit('error', Object.assign(new Error('Host unreachable'), { code: 'EHOSTUNREACH' })));
    return request;
  });
  const plug = new WemoPlug({ discover: async () => [{ udn: DEFAULT_UDN, location: `${fake.url}/setup.xml` }] });
  assert.equal((await plug.getState()).on, true);
  assert.equal(plug.ip, '127.0.0.1');
  assert.deepEqual(fake.actions, ['GetBinaryState']);
});

test('retries status reads when the first confirmation connection drops', async (t) => {
  const fake = await fakeWemo({ failReads: 1 });
  t.after(() => close(fake.server));
  const plug = new WemoPlug({ ip: '127.0.0.1', port: fake.port, confirmationDelaysMs: [0, 0, 0] });
  assert.equal((await plug.setState(false)).on, false);
  assert.deepEqual(fake.actions, ['SetBinaryState', 'GetBinaryState', 'GetBinaryState']);
});

test('waits for the reported state to settle without repeating the power command', async (t) => {
  const fake = await fakeWemo({ staleReads: 2 });
  t.after(() => close(fake.server));
  const plug = new WemoPlug({ ip: '127.0.0.1', port: fake.port, confirmationDelaysMs: [0, 0, 0] });
  assert.equal((await plug.setState(false)).on, false);
  assert.deepEqual(fake.actions, ['SetBinaryState', 'GetBinaryState', 'GetBinaryState', 'GetBinaryState']);
});

test('reports an unconfirmed change after bounded failed status reads', async (t) => {
  const fake = await fakeWemo({ failWrite: true, failReads: Infinity });
  t.after(() => close(fake.server));
  const plug = new WemoPlug({ ip: '127.0.0.1', port: fake.port, confirmationDelaysMs: [0, 0, 0] });
  await assert.rejects(plug.setState(false), /could not be confirmed/);
  assert.deepEqual(fake.actions, ['SetBinaryState', 'GetBinaryState', 'GetBinaryState', 'GetBinaryState']);
});

test('does not report success when the power command was never applied', async (t) => {
  const fake = await fakeWemo({ failWrite: true, applyWrite: false });
  t.after(() => close(fake.server));
  const plug = new WemoPlug({ ip: '127.0.0.1', port: fake.port, confirmationDelaysMs: [0, 0, 0] });
  await assert.rejects(plug.setState(false), /could not be confirmed/);
  assert.equal(fake.state, '1');
  assert.deepEqual(fake.actions, ['SetBinaryState', 'GetBinaryState', 'GetBinaryState', 'GetBinaryState']);
  assert.equal(fake.actions.filter((action) => action === 'SetBinaryState').length, 1);
});

test('accepts a write reply without a state only after reading back the requested state', async (t) => {
  const fake = await fakeWemo({ omitWriteState: true });
  t.after(() => close(fake.server));
  const plug = new WemoPlug({ ip: '127.0.0.1', port: fake.port, confirmationDelaysMs: [0, 0, 0] });
  assert.equal((await plug.setState(false)).on, false);
  assert.deepEqual(fake.actions, ['SetBinaryState', 'GetBinaryState']);
});

test('uses separate HTTP connections for legacy Wemo requests', async (t) => {
  const fake = await fakeWemo();
  t.after(() => close(fake.server));
  const plug = new WemoPlug({ ip: '127.0.0.1', port: fake.port });
  assert.equal((await plug.setState(false)).on, false);
  assert.equal(fake.connections.size, 3);
});
