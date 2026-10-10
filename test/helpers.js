import http from 'node:http';
import { once } from 'node:events';
import { DEFAULT_UDN } from '../src/wemo.js';

export async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

export async function close(server) {
  const stopped = once(server, 'close');
  server.close();
  server.closeAllConnections();
  await stopped;
}

export async function fakeWemo({ udn = DEFAULT_UDN, state = '1', failWrite = false,
  failReads = 0, staleReads = 0, applyWrite = true, omitWriteState = false } = {}) {
  const actions = [];
  const connections = new Set();
  let previousState = state;
  let written = false;
  const server = http.createServer(async (request, response) => {
    response.setHeader('Content-Type', 'text/xml');
    if (request.method === 'GET' && request.url === '/setup.xml') {
      response.end(`<root xmlns="urn:Belkin:device-1-0"><device><UDN>${udn}</UDN><deviceType>urn:Belkin:device:controllee:1</deviceType><friendlyName>Stair &amp; Hall Lights</friendlyName><modelName>Socket</modelName><firmwareVersion>test-firmware</firmwareVersion><serviceList><service><serviceType>urn:Belkin:service:basicevent:1</serviceType><controlURL>/upnp/control/basicevent1</controlURL></service></serviceList></device></root>`);
      return;
    }
    if (request.method !== 'POST' || request.url !== '/upnp/control/basicevent1') {
      response.writeHead(404).end();
      return;
    }
    let body = '';
    for await (const chunk of request) {
      body += chunk;
    }
    const action = request.headers.soapaction?.split('#')[1]?.replace('"', '');
    actions.push(action);
    if (action === 'SetBinaryState') {
      previousState = state;
      written = true;
      if (applyWrite) {
        state = body.includes('<BinaryState>1</BinaryState>') ? '1' : '0';
      }
      if (failWrite) {
        request.socket.destroy();
        return;
      }
    }
    if (!['SetBinaryState', 'GetBinaryState'].includes(action)) {
      response.writeHead(400).end();
      return;
    }
    let reported = state;
    if (action === 'GetBinaryState' && written) {
      if (failReads > 0) {
        failReads--;
        request.socket.destroy();
        return;
      }
      if (staleReads > 0) {
        staleReads--;
        reported = previousState;
      }
    }
    const argument = action === 'SetBinaryState' && omitWriteState ? '' : `<BinaryState>${reported}</BinaryState>`;
    response.end(`<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:${action}Response xmlns:u="urn:Belkin:service:basicevent:1">${argument}</u:${action}Response></s:Body></s:Envelope>`);
  });
  server.on('connection', (socket) => connections.add(socket));
  const url = await listen(server);
  return { server, url, port: server.address().port, actions, connections, get state() { return state; } };
}
