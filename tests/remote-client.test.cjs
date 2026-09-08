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
