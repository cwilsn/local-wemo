import { discoverWemo } from './wemo.js';

try {
  const devices = await discoverWemo({ interfaceAddress: process.env.WEMO_INTERFACE });
  if (!devices.length) {
    console.log('No Wemo plugs replied. Check the network or set WEMO_INTERFACE to the Pi’s LAN IPv4 address.');
  }
  for (const device of devices) {
    console.log(`${device.udn}\n  ${device.location}`);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
