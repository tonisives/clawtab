const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('../desktop/node_modules/typescript');

let compile = (name, require, globals = {}) => {
  let exports = {};
  let source = ts.transpileModule(fs.readFileSync(`${__dirname}/../desktop/src/machines/${name}.ts`, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(source, { exports, require, ...globals });
  return exports;
};
let { remoteConnectionState } = compile('remoteState');
let ready = () => ({ account: 'ready', operation: null, signedOut: false, error: null,
  relay: { enabled: true, connected: true, configured: true, auth_expired: false, subscription_required: false } });
let load = (options = {}) => {
  let fixture = { token: 'fixture-account', relay: ready().relay, calls: [], retries: 0, ...options };
  let listeners = new Map();
  let host = { addEventListener: (key, fn) => listeners.set(key, fn), removeEventListener: key => listeners.delete(key) };
  let controller = compile('remoteConnection', name => {
    if (name === './remoteState') return { remoteConnectionState };
    if (name === 'react') return { useSyncExternalStore: (_subscribe, snapshot) => snapshot() };
    if (name === '@clawtab/shared') return { useMachines: () => ({ connected: true, error: null }), retryMachines: () => fixture.retries++ };
    if (name === '@tauri-apps/api/core') return { invoke: async (command, args) => {
      fixture.calls.push(command);
      if (command === fixture.fail) throw Error('Fixture unavailable');
      if (command === 'get_relay_status') return { ...fixture.relay };
      if (command === 'relay_restore_account') return fixture.restore ? fixture.restore() : fixture.token;
      if (command === 'get_relay_settings') return { server_url: 'https://fixture.invalid', device_token: 'fixture-device', device_id: 'fixture-id', enabled: fixture.relay.enabled };
      if (command === 'set_relay_settings') fixture.relay.enabled = args.settings.enabled;
      if (command === 'relay_disconnect') fixture.relay.connected = false;
      if (command === 'relay_connect') fixture.relay.connected = true;
      if (command === 'relay_sign_out') fixture.token = null;
    } };
    throw Error(`Unexpected module ${name}`);
  }, { window: host, document: { ...host, hidden: false }, setTimeout: options.setTimeout ?? setTimeout, clearTimeout: options.clearTimeout ?? clearTimeout, setInterval: () => 1, clearInterval: () => {} });
  return { fixture, controller };
};

test('Connected requires the account, device connection and machine connection together', () => {
  for (let account of ['checking', 'ready', 'required']) for (let enabled of [false, true])
    for (let configured of [false, true]) for (let connected of [false, true]) for (let machines of [false, true]) {
      let state = ready();
      Object.assign(state, { account });
      Object.assign(state.relay, { enabled, configured, connected });
      assert.equal(remoteConnectionState(state, { connected: machines, error: null }).phase === 'connected',
        account === 'ready' && enabled && configured && connected && machines);
    }
});

test('operation errors do not change a healthy connection; subscription and transport failures do', () => {
  assert.equal(remoteConnectionState(ready(), { connected: true, error: 'A job failed' }).phase, 'connected');
  assert.equal(remoteConnectionState(ready(), { connected: false, error: 'Socket closed' }).phase, 'interrupted');
  let state = ready();
  state.relay.subscription_required = true;
  assert.equal(remoteConnectionState(state, { connected: true, error: null }).phase, 'subscription');
});

test('an expired account disables a still-connected daemon instead of exposing contradictory states', async () => {
  let { fixture, controller } = load({ token: null });
  await controller.checkRemoteConnection();
  assert.equal(fixture.relay.enabled, false);
  assert.equal(fixture.relay.connected, false);
  assert.equal(controller.useRemoteConnection().phase, 'sign_in');
  assert.ok(fixture.calls.includes('set_relay_settings'));
  assert.ok(fixture.calls.includes('relay_disconnect'));
});

test('successful sign-in connects a previously disabled paired Mac automatically', async () => {
  let { fixture, controller } = load({ token: null });
  await controller.checkRemoteConnection();
  controller.beginRemoteSignIn();
  fixture.token = 'fixture-new-account';
  await controller.acceptRemoteSignIn(fixture.token);
  assert.equal(controller.useRemoteConnection().phase, 'connected');
  assert.equal(fixture.relay.enabled, true);
  assert.ok(fixture.calls.includes('relay_connect'));
  assert.equal(fixture.retries, 1);
});

test('sign-out disables remote access and disconnects before removing the account', async () => {
  let { fixture, controller } = load();
  await controller.checkRemoteConnection();
  fixture.calls.length = 0;
  await controller.disconnectRemoteConnection();
  assert.deepEqual(fixture.calls, ['get_relay_settings', 'set_relay_settings', 'relay_disconnect', 'relay_sign_out']);
  assert.equal(fixture.token, null);
  assert.equal(controller.useRemoteConnection().phase, 'disconnected');
  await controller.checkRemoteConnection();
  assert.equal(controller.useRemoteConnection().token, null);
});

test('a session recovered from another app replaces the machine session once', async () => {
  let { fixture, controller } = load();
  await controller.checkRemoteConnection();
  let previous = controller.useRemoteConnection().accountVersion;
  fixture.token = 'fixture-replacement-account';
  await controller.checkRemoteConnection();
  assert.equal(controller.useRemoteConnection().accountVersion, previous + 1);
  await controller.checkRemoteConnection();
  assert.equal(controller.useRemoteConnection().accountVersion, previous + 1);
});

test('a late restore and queued connect cannot resurrect a signed-out account', async () => {
  let { fixture, controller } = load();
  await controller.checkRemoteConnection();
  let resolve;
  fixture.restore = () => new Promise(done => { resolve = done; });
  let pending = controller.connectRemoteConnection();
  await controller.disconnectRemoteConnection();
  resolve('fixture-old-account');
  await pending;
  assert.equal(controller.useRemoteConnection().phase, 'disconnected');
  assert.equal(controller.useRemoteConnection().token, null);
  assert.equal(fixture.relay.enabled, false);
  assert.equal(fixture.calls.includes('relay_connect'), false);
});

test('failed disconnect is retryable and does not falsely report sign-out', async () => {
  let { fixture, controller } = load();
  await controller.checkRemoteConnection();
  fixture.fail = 'relay_disconnect';
  await assert.rejects(controller.disconnectRemoteConnection(), /Could not disconnect/);
  assert.equal(controller.useRemoteConnection().phase, 'interrupted');
  assert.equal(controller.useRemoteConnection().token, 'fixture-account');
  assert.equal(fixture.calls.includes('relay_sign_out'), false);
  fixture.fail = null;
  await controller.disconnectRemoteConnection();
  assert.equal(controller.useRemoteConnection().phase, 'disconnected');
});

test('mounting the watcher again while restoration is pending still completes initialization', async () => {
  let resolve;
  let { controller } = load({ restore: () => new Promise(done => { resolve = done; }) });
  let stop = controller.watchRemoteConnection();
  stop();
  let stopAgain = controller.watchRemoteConnection();
  resolve('fixture-account');
  await controller.checkRemoteConnection();
  assert.equal(controller.useRemoteConnection().phase, 'connected');
  stopAgain();
});


test('a stalled account check times out, can retry, and ignores the late result', async () => {
  let expire;
  let restore;
  let { fixture, controller } = load({
    restore: () => new Promise(resolve => { restore = resolve; }),
    setTimeout: callback => { expire = callback; return 1; },
    clearTimeout: () => {},
  });
  let pending = controller.checkRemoteConnection();
  expire();
  await pending;
  assert.equal(controller.useRemoteConnection().phase, 'interrupted');
  fixture.restore = null;
  await controller.retryRemoteConnection();
  assert.equal(controller.useRemoteConnection().phase, 'connected');
  restore('obsolete-account');
  await Promise.resolve();
  assert.equal(controller.useRemoteConnection().token, 'fixture-account');
});

test('sign-in during initialization cannot leave the status checking forever', async () => {
  let resolve;
  let { fixture, controller } = load({ restore: () => new Promise(done => { resolve = done; }) });
  let pending = controller.checkRemoteConnection();
  controller.beginRemoteSignIn();
  resolve(null);
  await pending;
  assert.equal(controller.useRemoteConnection().phase, 'sign_in');
  fixture.restore = null;
  await controller.retryRemoteConnection();
  assert.equal(controller.useRemoteConnection().phase, 'connected');
});
