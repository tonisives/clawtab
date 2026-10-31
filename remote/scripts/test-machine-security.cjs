const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');
const { TextEncoder } = require('node:util');
const ts = require('typescript');
const nacl = require('tweetnacl');
const { Buffer: PortableBuffer } = require('buffer/');

const machine = '9882aa5a-ec95-458a-a367-d2e1f95068ae';
const encode = bytes => Buffer.from(bytes).toString('base64');
const decode = text => new Uint8Array(Buffer.from(text, 'base64'));
const utf8 = text => new TextEncoder().encode(text);

async function load() {
  const storage = new Map();
  let security;
  const dependencies = {
    tweetnacl: nacl,
    buffer: { Buffer: PortableBuffer },
    'expo-crypto': {
      getRandomBytes: size => new Uint8Array(crypto.randomBytes(size)),
      randomUUID: crypto.randomUUID,
      CryptoDigestAlgorithm: { SHA256: 'sha256' },
      digestStringAsync: async (algorithm, text) => crypto.createHash(algorithm).update(text).digest('hex'),
    },
    'react-native': { Platform: { OS: 'ios' } },
    '@clawtab/shared': {
      configureMachineSecurity: value => { security = value; },
      configureMoveNavigation: () => {},
    },
    'expo-router': { router: {} },
    'expo-secure-store': {
      WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'unlocked',
      getItemAsync: async key => storage.get(key) ?? null,
      setItemAsync: async (key, value) => { storage.set(key, value); },
    },
  };
  const source = ts.transpileModule(fs.readFileSync(require.resolve('../src/lib/machineSecurity.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(source, {
    exports: {}, require: name => {
      assert.ok(name in dependencies, `Unexpected import: ${name}`);
      return dependencies[name];
    },
    Uint8Array, TextEncoder: undefined, TextDecoder: undefined, btoa, atob,
  });
  assert.ok(security, 'security module initializes without TextEncoder and TextDecoder');
  const host = nacl.box.keyPair();
  await security.pin({ machine_id: machine, noise_key: encode(host.publicKey), box_key: encode(host.publicKey) });
  return { security, host };
}

test('initializes and signs Unicode commands without TextEncoder and TextDecoder', async () => {
  const { security } = await load();
  const payload = { type: 'command', text: 'Bangkok กรุงเทพ café \u{10437}', nested: ['\u0000', '\ud800'] };
  const signed = await security.sign(machine, payload);
  const { identity } = await security.publicIdentity();
  const message = utf8(`clawtab-command-v1\n${signed.client}\n${machine}\n${signed.expires}\n${JSON.stringify(payload)}`);
  assert.equal(signed.message, JSON.stringify(payload));
  assert.equal(nacl.sign.detached.verify(message, decode(signed.signature), decode(identity.signing_key)), true);
});

test('encrypted Unicode requests and responses interoperate with host UTF-8', async () => {
  const { security, host } = await load();
  const { identity } = await security.publicIdentity();
  const value = { text: 'กรุงเทพ café \u{10437}', path: '/tmp/日本語', empty: '', nul: '\u0000' };
  const sealed = await security.seal(machine, value);
  const plaintext = nacl.box.open(decode(sealed.ciphertext), decode(sealed.nonce), decode(identity.box_key), host.secretKey);
  assert.deepEqual(JSON.parse(Buffer.from(plaintext).toString('utf8')), value);
  const nonce = new Uint8Array(crypto.randomBytes(nacl.box.nonceLength));
  const ciphertext = nacl.box(utf8(JSON.stringify(value)), nonce, decode(identity.box_key), host.secretKey);
  const opened = await security.open(machine, { nonce: encode(nonce), ciphertext: encode(ciphertext) });
  assert.equal(JSON.stringify(opened), JSON.stringify(value));
  ciphertext[0] ^= 1;
  await assert.rejects(security.open(machine, { nonce: encode(nonce), ciphertext: encode(ciphertext) }), /authentication failed/);
});
