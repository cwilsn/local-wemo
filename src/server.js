import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DailySchedule } from './schedule.js';
import { WemoError, WemoPlug } from './wemo.js';

const publicDirectory = new URL('../public/', import.meta.url);
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/icon.svg', ['icon.svg', 'image/svg+xml']],
]);

function json(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

async function readJson(request) {
  if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
    throw new Error('Send a JSON request.');
  }
  let length = 0;
  const chunks = [];
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 2048) {
      throw new Error('Request is too large.');
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('Send valid JSON.');
  }
}

export async function createApp({ plug, schedule, readOnly = false } = {}) {
  const token = randomBytes(32).toString('hex');
  const files = new Map(await Promise.all([...assets].map(async ([path, [file, type]]) => [
    path, { content: await readFile(new URL(file, publicDirectory)), type },
  ])));
  const server = http.createServer({ requestTimeout: 15_000, headersTimeout: 10_000 }, async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'same-origin');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const host = new URL(`http://${request.headers.host || ''}`);
      const allowedHosts = new Set([
        'localhost', '127.0.0.1', hostname().toLowerCase(), `${hostname().toLowerCase()}.local`,
        request.socket.localAddress?.replace(/^::ffff:/, ''),
      ]);
      if (!allowedHosts.has(host.hostname)) {
        json(response, 403, { error: 'Open this page using the Pi’s hostname or local IP address.' });
        return;
      }
      const path = new URL(request.url, host).pathname;
      if (request.method === 'GET') {
        const file = files.get(path);
        if (file) {
          response.writeHead(200, { 'Content-Type': file.type });
          response.end(file.content);
        } else if (path === '/api/health') {
          json(response, 200, { ok: true, readOnly });
        } else if (path === '/api/config') {
          json(response, 200, { token, readOnly });
        } else if (path === '/api/state') {
          try {
            const state = await plug.getState();
            json(response, 200, { name: state.name, on: state.on, checkedAt: state.checkedAt });
          } catch (error) {
            json(response, 503, { error: error.message });
          }
        } else if (path === '/api/schedule') {
          json(response, 200, schedule.getStatus());
        } else {
          json(response, 404, { error: 'Page not found.' });
        }
        return;
      }
      if (request.method !== 'POST' || !['/api/state', '/api/schedule'].includes(path)) {
        json(response, 405, { error: 'Method not allowed.' });
        return;
      }
      const supplied = Buffer.from(request.headers['x-wemo-token'] || '');
      const expected = Buffer.from(token);
      if (request.headers.origin !== host.origin || supplied.length !== expected.length
        || !timingSafeEqual(supplied, expected)) {
        json(response, 403, { error: 'Refresh this page before making changes.' });
        return;
      }
      const value = await readJson(request);
      if (path === '/api/schedule') {
        json(response, 200, await schedule.save(value));
      } else if (readOnly) {
        json(response, 403, { error: 'Power control is disabled in read-only mode.' });
      } else if (typeof value?.on !== 'boolean') {
        json(response, 400, { error: 'Choose On or Off.' });
      } else {
        try {
          const state = await plug.setState(value.on);
          json(response, 200, { name: state.name, on: state.on, checkedAt: state.checkedAt });
        } catch (error) {
          json(response, 503, { error: error.message });
        }
      }
    } catch (error) {
      json(response, 400, { error: error.message || 'The request could not be completed.' });
    }
  });
  return server;
}

async function main() {
  try {
    process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)));
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
  const port = Number(process.env.PORT || 8081);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535.');
  }
  const readOnly = process.env.READ_ONLY === '1';
  const plug = new WemoPlug({ ip: process.env.WEMO_IP, udn: process.env.WEMO_UDN,
    interfaceAddress: process.env.WEMO_INTERFACE });
  const schedule = await new DailySchedule({ plug, readOnly,
    file: fileURLToPath(new URL('../data/schedule.json', import.meta.url)) }).load();
  const server = await createApp({ plug, schedule, readOnly });
  server.on('error', (error) => {
    console.error(error.code === 'EADDRINUSE' ? `Port ${port} is in use. Choose another PORT in .env.` : error.message);
    schedule.close();
    process.exitCode = 1;
  });
  server.listen(port, process.env.HOST || '0.0.0.0', () => {
    console.log(`Local Wemo is listening on port ${port}. Open this Pi’s local IP or hostname in your browser.`);
    if (readOnly) {
      console.log('Read-only mode: manual and scheduled power commands are disabled.');
    }
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      schedule.close();
      server.close();
      server.closeAllConnections();
    });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof WemoError ? error.message : `Could not start: ${error.message}`);
    process.exitCode = 1;
  });
}
