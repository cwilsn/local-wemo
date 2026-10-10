import dgram from 'node:dgram';
import http from 'node:http';
import { isIPv4 } from 'node:net';
import { networkInterfaces } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { XMLParser } from 'fast-xml-parser';

export const DEFAULT_UDN = 'uuid:Socket-1_0-221827K010D85E';
const BASIC_EVENT = 'urn:Belkin:service:basicevent:1';
const PORTS = [49153, 49152, 49154, 49151, 49155, 49156, 49157, 49158, 49159];
const parser = new XMLParser({ removeNSPrefix: true, parseTagValue: false });

export class WemoError extends Error {}
class LocalReachabilityError extends WemoError {}

function isLocalAddress(address) {
  if (!isIPv4(address)) {
    return false;
  }
  const [first, second] = address.split('.').map(Number);
  return first === 10 || first === 127 || (first === 192 && second === 168)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 169 && second === 254);
}

export function parseDiscoveryReply(message, sourceAddress, udn) {
  const lines = message.toString('utf8').split('\r\n');
  if (!/^HTTP\/1\.[01] 200\b/.test(lines[0])) {
    return null;
  }
  const headers = {};
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(':');
    if (colon > 0) {
      headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
    }
  }
  const identity = headers.usn?.split('::')[0];
  if (!identity?.startsWith('uuid:') || (udn && identity !== udn)) {
    return null;
  }
  try {
    const location = new URL(headers.location);
    if (location.protocol !== 'http:' || location.hostname !== sourceAddress
      || !isLocalAddress(location.hostname) || location.username || location.password
      || location.pathname !== '/setup.xml') {
      return null;
    }
    return { udn: identity, location: location.href };
  } catch {
    return null;
  }
}

export function discoverWemo({ udn, interfaceAddress, durationMs = 2500,
  destination = { address: '239.255.255.250', port: 1900 } } = {}) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    const found = new Map();
    let timer;
    let completed = false;
    const finish = (error) => {
      if (completed) {
        return;
      }
      completed = true;
      clearTimeout(timer);
      socket.close();
      if (error && !found.size) {
        reject(new WemoError(`Discovery failed: ${error.message}`));
      } else {
        resolve([...found.values()]);
      }
    };
    socket.on('error', finish);
    socket.on('message', (message, remote) => {
      const device = parseDiscoveryReply(message, remote.address, udn);
      if (device) {
        found.set(device.udn, device);
      }
    });
    socket.bind(0, () => {
      timer = setTimeout(() => finish(), durationMs);
      try {
        socket.setMulticastTTL(1);
        const interfaces = interfaceAddress ? [interfaceAddress]
          : Object.values(networkInterfaces()).flat().filter((item) => item
            && item.family === 'IPv4' && !item.internal
            && isLocalAddress(item.address)).map((item) => item.address);
        const request = Buffer.from('M-SEARCH * HTTP/1.1\r\n'
          + 'HOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\n'
          + `MX: 1\r\nST: ${BASIC_EVENT}\r\n\r\n`);
        for (const address of interfaces.length ? interfaces : [null]) {
          if (address) {
            socket.setMulticastInterface(address);
          }
          socket.send(request, destination.port, destination.address, (error) => {
            if (error) {
              finish(error);
            }
          });
        }
      } catch (error) {
        finish(error);
      }
    });
  });
}

function requestXml(url, { body, action, timeoutMs = 3000 } = {}) {
  return new Promise((resolve, reject) => {
    const headers = body ? {
      'Content-Type': 'text/xml; charset="utf-8"',
      SOAPAction: `"${BASIC_EVENT}#${action}"`,
      'Content-Length': Buffer.byteLength(body),
    } : {};
    const request = http.request(url, {
      method: body ? 'POST' : 'GET', agent: false, headers, signal: AbortSignal.timeout(timeoutMs),
    }, (response) => {
      let length = 0;
      const chunks = [];
      response.on('data', (chunk) => {
        length += chunk.length;
        if (length > 128 * 1024) {
          response.destroy(new WemoError('The plug returned an oversized response.'));
        } else {
          chunks.push(chunk);
        }
      });
      response.on('error', reject);
      response.on('end', () => {
        try {
          const xml = Buffer.concat(chunks).toString('utf8');
          if (/<!DOCTYPE|<!ENTITY/i.test(xml)) {
            throw new WemoError('The plug returned unsupported XML.');
          }
          const result = parser.parse(xml, true);
          const fault = result.Envelope?.Body?.Fault;
          if (fault || response.statusCode !== 200) {
            throw new WemoError('The plug rejected the request.');
          }
          resolve(result);
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on('error', (error) => {
      if (process.platform === 'darwin' && error.code === 'EHOSTUNREACH') {
        reject(new LocalReachabilityError('macOS reported “No route to host” for the plug. Check that it’s connected, and check Local Network access for the app running Node under System Settings → Privacy & Security.'));
      } else {
        reject(error);
      }
    });
    request.end(body);
  });
}

export class WemoPlug {
  #device;
  #queue = Promise.resolve();

  constructor({ ip = '192.168.4.31', udn = DEFAULT_UDN, port = 49153,
    interfaceAddress, discover = discoverWemo, timeoutMs = 3000, confirmationDelaysMs = [0, 500, 1500] } = {}) {
    if (!isLocalAddress(ip) || !udn.startsWith('uuid:')) {
      throw new WemoError('Configure a local IPv4 address and a Wemo device UDN.');
    }
    if (interfaceAddress && !isLocalAddress(interfaceAddress)) {
      throw new WemoError('WEMO_INTERFACE must be a local IPv4 address.');
    }
    this.ip = ip;
    this.udn = udn;
    this.port = port;
    this.interfaceAddress = interfaceAddress;
    this.discover = discover;
    this.timeoutMs = timeoutMs;
    this.confirmationDelaysMs = confirmationDelaysMs;
  }

  #serialize(operation) {
    const result = this.#queue.then(operation);
    this.#queue = result.catch(() => {});
    return result;
  }

  async #describe(location) {
    const url = new URL(location);
    if (url.protocol !== 'http:' || !isLocalAddress(url.hostname)
      || url.username || url.password || url.pathname !== '/setup.xml') {
      throw new WemoError('The plug advertised an invalid local endpoint.');
    }
    const xml = await requestXml(url, { timeoutMs: this.timeoutMs });
    const device = xml.root?.device;
    if (device?.UDN !== this.udn || !device.deviceType?.startsWith('urn:Belkin:')) {
      throw new WemoError('This address belongs to a different device.');
    }
    const services = device.serviceList?.service;
    const service = (Array.isArray(services) ? services : [services])
      .find((item) => item?.serviceType === BASIC_EVENT);
    if (!service?.controlURL) {
      throw new WemoError('The plug does not advertise local power control.');
    }
    const control = new URL(service.controlURL, url);
    if (control.origin !== url.origin || control.username || control.password) {
      throw new WemoError('The plug advertised an invalid control endpoint.');
    }
    return {
      location: url.href, control: control.href, name: device.friendlyName || 'Wemo plug',
      ip: url.hostname, port: Number(url.port || 80), firmware: device.firmwareVersion || '',
      model: device.modelName || '',
    };
  }

  async #resolve() {
    let networkError;
    if (this.#device) {
      try {
        this.#device = await this.#describe(this.#device.location);
        return this.#device;
      } catch (error) {
        if (error instanceof LocalReachabilityError) {
          networkError = error;
        }
        this.#device = undefined;
      }
    }
    const ports = [...new Set([this.port, ...PORTS])];
    for (const port of networkError ? [] : ports) {
      try {
        this.#device = await this.#describe(`http://${this.ip}:${port}/setup.xml`);
        return this.#device;
      } catch (error) {
        if (error instanceof LocalReachabilityError) {
          networkError = error;
          break;
        }
        // A timeout normally means the host is offline; try SSDP before other ports.
        if (error.name === 'AbortError' || error.code === 'EHOSTUNREACH') {
          break;
        }
      }
    }
    let found;
    try {
      found = await this.discover({ udn: this.udn, interfaceAddress: this.interfaceAddress });
    } catch (error) {
      throw networkError || error;
    }
    for (const candidate of found) {
      try {
        this.#device = await this.#describe(candidate.location);
        this.ip = this.#device.ip;
        this.port = this.#device.port;
        return this.#device;
      } catch (error) {
        if (error instanceof LocalReachabilityError) {
          networkError = error;
        }
        // Discovery replies are hints; only a matching device description is accepted.
      }
    }
    throw networkError || new WemoError('Couldn’t reach your plug. Check that it is powered and on the same Wi-Fi.');
  }

  async #state(device, action = 'GetBinaryState', state) {
    const argument = state === undefined ? '' : `<BinaryState>${state ? 1 : 0}</BinaryState>`;
    const body = '<?xml version="1.0" encoding="utf-8"?>'
      + '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" '
      + 's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">'
      + `<s:Body><u:${action} xmlns:u="${BASIC_EVENT}">${argument}</u:${action}></s:Body></s:Envelope>`;
    const result = await requestXml(device.control, { body, action, timeoutMs: this.timeoutMs });
    if (action === 'SetBinaryState') {
      return;
    }
    const value = result.Envelope?.Body?.[`${action}Response`]?.BinaryState?.split('|')[0];
    if (value !== '0' && value !== '1') {
      throw new WemoError('The plug returned an unknown power state.');
    }
    return value === '1';
  }

  getState() {
    return this.#serialize(async () => {
      const device = await this.#resolve();
      try {
        return { ...device, on: await this.#state(device), checkedAt: new Date().toISOString() };
      } catch (error) {
        this.#device = undefined;
        throw error instanceof WemoError ? error : new WemoError('Couldn’t read the plug’s state. Try refreshing.');
      }
    });
  }

  setState(on) {
    if (typeof on !== 'boolean') {
      return Promise.reject(new WemoError('Power state must be true or false.'));
    }
    return this.#serialize(async () => {
      const device = await this.#resolve();
      let confirmationError;
      try {
        await this.#state(device, 'SetBinaryState', on);
      } catch (error) {
        // The plug may apply the command before dropping its reply. Never resend it.
        confirmationError = error;
      }
      for (const delayMs of this.confirmationDelaysMs) {
        if (delayMs > 0) {
          await delay(delayMs);
        }
        try {
          const actual = await this.#state(device);
          if (actual === on) {
            return { ...device, on: actual, checkedAt: new Date().toISOString() };
          }
        } catch (error) {
          confirmationError = error;
        }
      }
      throw new WemoError('The command could not be confirmed. Refresh to check the plug before trying again.', { cause: confirmationError });
    });
  }
}
