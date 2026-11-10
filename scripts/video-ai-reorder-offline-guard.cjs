// Local verification preload: fail closed before outbound network operations.
const deny = () => { throw new Error('OFFLINE_VERIFICATION_NETWORK_FORBIDDEN'); };
globalThis.fetch = deny;
for (const name of ['http','https']) {
  const mod = require('node:' + name);
  mod.request = deny; mod.get = deny;
}
const net = require('node:net');
net.connect = deny; net.createConnection = deny;
require('node:module').syncBuiltinESMExports();
