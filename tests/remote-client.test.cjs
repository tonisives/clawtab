const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('../desktop/node_modules/typescript');
let load = (timers = {}) => {
  let sockets = [];
  class Socket {
    static OPEN = 1;
    static CONNECTING = 0;
    readyState = 1;
    sent = [];
    constructor(url) { this.url = url; sockets.push(this); }
    close() { this.readyState = 3; this.onclose?.(); }
    send(text) { this.sent.push(JSON.parse(text)); }
    receive(value) { this.onmessage?.({ data: JSON.stringify(value) }); }
  }
  let exports = {};
  let source = ts.transpileModule(fs.readFileSync(require.resolve('../shared/src/machines/client.ts'), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  vm.runInNewContext(source, { exports, require: () => ({ useSyncExternalStore: () => {} }), WebSocket: Socket, setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask, Error, ...timers });
  return { client: exports, sockets };
};
let a = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', b = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
test('account models load without an online desktop and clear after logout', async () => {
  let { client, sockets } = load();
  let preferences = { agent_models: { enabled_models: { codex: ['custom'] }, default_provider: 'codex' }, machine_appearance: { [a]: { icon: 'server', color: '#34b3a0' } } };
  let stop = client.connectMachines(async () => 'ws://localhost/v2/ws?token=fixture', async () => preferences);
  await new Promise(setImmediate);
  sockets[0].onopen();
  await new Promise(setImmediate);
  assert.equal(client.machineState().agentModels.enabled_models.codex[0], 'custom');
  assert.equal(client.machineState().machineAppearance[a].icon, 'server');
  stop();
  assert.equal(client.machineState().agentModels, null);
  assert.equal(Object.keys(client.machineState().machineAppearance).length, 0);
});
test('an earlier preference fetch cannot undo a save or repopulate a signed out account', async () => {
  let { client, sockets } = load();
  let resolveFetch;
  let stop = client.connectMachines(async () => 'ws://localhost/v2/ws?token=fixture', () => new Promise((resolve) => { resolveFetch = resolve; }));
  await new Promise(setImmediate); sockets[0].onopen();
  let newer = { agent_models: { enabled_models: { codex: ['new'] } } };
  await client.saveAccountPreferences(async () => newer, {});
  resolveFetch({ agent_models: { enabled_models: { codex: ['old'] } } });
  await new Promise(setImmediate);
  assert.equal(client.machineState().agentModels.enabled_models.codex[0], 'new');
  let resolveSave;
  let saving = client.saveAccountPreferences(() => new Promise((resolve) => { resolveSave = resolve; }), {});
  stop(); resolveSave(newer); await saving;
  assert.equal(client.machineState().agentModels, null);
});
test('resource identities and nested statuses stay separate across identical host pane IDs', () => {
  let { client } = load();
  let message = { type: 'status_update', name: 'job', status: { pane_id: '%1', run_id: 'run' } };
  let first = client.scopedMessage(a, message), second = client.scopedMessage(b, message);
  assert.notEqual(first.status.pane_id, second.status.pane_id);
  assert.equal(first.status.run_id, a + '::run');
  assert.equal(client.resourceLabel(first.name), 'job');
  assert.equal(message.status.pane_id, '%1');
});
test('already-versioned websocket URLs remain versioned once; launch target is explicit', async (t) => {
  let { client, sockets } = load();
  let stop = client.connectMachines(async () => 'ws://localhost/v2/ws?token=fixture');
  t.after(stop);
  await new Promise(setImmediate);
  let ws = sockets[0];
  assert.equal(ws.url, 'ws://localhost/v2/ws?token=fixture');
  ws.onopen(); ws.receive({ type: 'machines', connection_id: 'connection', machines: [{ id: a, online: false, owned: true }, { id: b, online: false, owned: true }] });
  assert.equal(client.machineState().selected, null);
  client.sendResource({ type: 'run_agent', prompt: 'fixture' });
  assert.equal(ws.sent.length, 0);
  stop();
});
test('logout rejects pending mutations and clears cached machine contents', async (t) => {
  let { client, sockets } = load();
  let stop = client.connectMachines(async () => 'ws://localhost/ws?token=fixture');
  t.after(stop);
  await new Promise(setImmediate); let ws = sockets[0]; ws.onopen();
  ws.receive({ type: 'machines', connection_id: 'connection', machines: [{ id: a, online: true, owned: true }] });
  let promise = client.machineRequest(a, { type: 'run_agent', prompt: 'fixture' });
  let rejected = assert.rejects(promise, /Disconnected/);
  stop(); await rejected;
  assert.equal(client.machineState().machines.length, 0);
  assert.equal(Object.keys(client.machineState().snapshots).length, 0);
});

test('a host reconnect between roster polls refreshes machine snapshots', async (t) => {
  let { client, sockets } = load();
  let stop = client.connectMachines(async () => 'ws://localhost/v2/ws?token=fixture'); t.after(stop);
  await new Promise(setImmediate); let ws = sockets[0]; ws.onopen();
  let roster = (generation) => ({ type: 'machines', connection_id: 'viewer', machines: [{ id: a, online: true, owned: true, connection_id: generation }] });
  ws.receive(roster('first')); ws.sent.length = 0;
  ws.receive(roster('second'));
  assert.ok(ws.sent.some((message) => message.message?.type === 'detect_processes'));
});

test('failed credentials back off instead of repeatedly refreshing an expired login', async (t) => {
  let queued = [];
  let { client, sockets } = load({
    setTimeout: (callback, delay) => { queued.push({ callback, delay }); return queued.length; },
    clearTimeout: () => {},
    setInterval: () => 1,
    clearInterval: () => {},
  });
  let stop = client.connectMachines(async () => { throw new Error('Sign in again'); });
  t.after(stop);
  let delays = [];
  for (let attempt = 0; attempt < 7; attempt++) {
    await new Promise(setImmediate);
    let timer = queued.shift();
    delays.push(timer.delay);
    if (attempt < 6) await timer.callback();
  }
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  assert.equal(sockets.length, 0);
});

test('Tauri string errors remain visible and manual retry reconnects immediately', async (t) => {
  let cleared = [];
  let { client, sockets } = load({
    setTimeout: () => 17,
    clearTimeout: (timer) => cleared.push(timer),
    setInterval: () => 1,
    clearInterval: () => {},
  });
  let signedIn = false;
  let stop = client.connectMachines(async () => {
    if (!signedIn) throw 'Account session expired';
    return 'ws://localhost/v2/ws?token=fixture';
  });
  t.after(stop);
  await new Promise(setImmediate);
  assert.equal(client.machineState().error, 'Account session expired');
  signedIn = true;
  client.retryMachines();
  await new Promise(setImmediate);
  assert.ok(cleared.includes(17));
  assert.equal(sockets.length, 1);
  sockets[0].onopen();
  assert.equal(client.machineState().connected, true);
  assert.equal(client.machineState().error, null);
  client.retryMachines();
  await new Promise(setImmediate);
  assert.equal(sockets.length, 1);
});

test('a stopped account lookup cannot overwrite a newer connection error', async (t) => {
  let { client } = load();
  let rejectLookup;
  client.connectMachines(() => new Promise((_, reject) => { rejectLookup = reject; }));
  let stop = client.connectMachines(async () => { throw 'Current account error'; });
  t.after(stop);
  await new Promise(setImmediate);
  rejectLookup('Stale account error');
  await new Promise(setImmediate);
  assert.equal(client.machineState().error, 'Current account error');
});

test('unchanged errors do not recursively notify machine subscribers', () => {
  let { client } = load();
  let calls = 0;
  let unsubscribe = client.subscribeMachines(() => {
    calls++;
    if (calls > 3) throw new Error('Recursive machine update');
    client.sendResource({ type: 'subscribe_pty', pane_id: '%1' });
  });
  client.sendResource({ type: 'subscribe_pty', pane_id: '%1' });
  unsubscribe();
  assert.equal(calls, 1);
});

let fakeClock = () => {
  let time = 0;
  let timers = new Set();
  let intervals = new Set();
  return {
    timers,
    intervals,
    advance: (ms) => { time += ms; },
    tools: {
      Date: { now: () => time },
      setTimeout: (callback, delay) => { let timer = { callback, delay }; timers.add(timer); return timer; },
      clearTimeout: (timer) => timers.delete(timer),
      setInterval: (callback) => { intervals.add(callback); return callback; },
      clearInterval: (callback) => intervals.delete(callback),
    },
  };
};

test('resume replaces a silent socket without waiting for its close event', async (t) => {
  let clock = fakeClock();
  let { client, sockets } = load(clock.tools);
  let stop = client.connectMachines(async () => 'ws://localhost/ws?token=fixture');
  t.after(stop);
  await new Promise(setImmediate);
  let first = sockets[0]; first.onopen();
  first.receive({ type: 'machines', connection_id: 'first', machines: [] });
  let lateOpen = first.onopen;
  first.close = () => {};
  client.reconnectMachines();
  assert.equal(client.machineState().connected, false);
  await new Promise(setImmediate);
  assert.equal(sockets.length, 2);
  lateOpen();
  assert.equal(client.machineState().connected, false);
  sockets[1].onopen();
  assert.equal(client.machineState().connected, true);
  assert.equal(clock.timers.size, 1);
});

test('a stalled handshake retries even when close does not emit an event', async (t) => {
  let clock = fakeClock();
  let { client, sockets } = load(clock.tools);
  let stop = client.connectMachines(async () => 'ws://localhost/ws?token=fixture');
  t.after(stop);
  await new Promise(setImmediate);
  sockets[0].readyState = 0;
  sockets[0].close = () => {};
  [...clock.timers][0].callback();
  let retry = [...clock.timers].find((timer) => timer.delay === 1000);
  assert.ok(retry);
  await retry.callback();
  assert.equal(sockets.length, 2);
});

test('an open socket with no relay traffic is retired and retried', async (t) => {
  let clock = fakeClock();
  let { client, sockets } = load(clock.tools);
  let stop = client.connectMachines(async () => 'ws://localhost/ws?token=fixture');
  t.after(stop);
  await new Promise(setImmediate);
  sockets[0].onopen();
  sockets[0].receive({ type: 'machines', connection_id: 'viewer', machines: [] });
  sockets[0].close = () => {};
  clock.advance(31_000);
  [...clock.intervals][0]();
  assert.equal(client.machineState().connected, false);
  await [...clock.timers].find((timer) => timer.delay === 1000).callback();
  assert.equal(sockets.length, 2);
});

test('cleanup from an old session cannot disconnect the current session', async (t) => {
  let { client, sockets } = load();
  let oldStop = client.connectMachines(async () => 'ws://localhost/ws?token=fixture');
  await new Promise(setImmediate);
  let stop = client.connectMachines(async () => 'ws://localhost/ws?token=fixture');
  t.after(stop);
  await new Promise(setImmediate);
  sockets[1].onopen();
  oldStop();
  assert.equal(client.machineState().connected, true);
  assert.equal(sockets[1].readyState, 1);
});

test('mobile subscription replay records the connection before synchronous error notifications', () => {
  let notify, cleanup, replayCount = 0;
  let noop = () => {};
  let state = { connected: true, selected: null, snapshots: {}, machines: [{ id: a, online: true }] };
  let store = Object.assign(() => true, {
    setState: noop,
    getState: () => new Proxy({}, { get: () => noop }),
  });
  let modules = {
    react: { useEffect: (effect) => { cleanup = effect(); }, useCallback: (callback) => callback },
    'react-native': { AppState: { addEventListener: () => ({ remove: noop }) }, Platform: { OS: 'ios' } },
    '@clawtab/shared': {
      machineState: () => state, machineProcesses: () => [],
      machineJobs: () => ({ jobs: [], statuses: {} }),
      subscribeMachines: (callback) => { notify = callback; return noop; },
      onMachineEvent: () => noop, connectMachines: () => noop,
    },
    '../lib/notifications': { getPushToken: async () => null },
    '../lib/terminalCache': { terminalCache: { clear: noop, delete: noop } },
    './usePty': { replayActivePtySubscriptions: () => {
      if (++replayCount > 3) throw new Error('Recursive subscription replay');
      notify();
    } },
  };
  let exports = {};
  let source = ts.transpileModule(fs.readFileSync(require.resolve('../remote/src/hooks/useWebSocket.ts'), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  vm.runInNewContext(source, { exports, require: (name) => modules[name] ?? new Proxy({}, { get: (_, key) => String(key).startsWith('use') ? store : noop }) });
  exports.useWebSocket();
  notify();
  assert.equal(replayCount, 1);
  cleanup();
});
