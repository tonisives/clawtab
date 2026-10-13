const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');

let machine = '9882aa5a-ec95-458a-a367-d2e1f95068ae';
let load = async () => {
  let sockets = [], sent = [], sequence = 0, timers = new Map();
  let security = { randomId: () => `fixture-${++sequence}`, open: async (_, envelope) => envelope };
  let exports = {};
  let WebSocket = class {
    static OPEN = 1;
    readyState = 1;
    constructor() { sockets.push(this); }
    send(value) { sent.push(JSON.parse(value)); }
    close() { this.readyState = 3; }
  };
  let source = ts.transpileModule(fs.readFileSync(require.resolve('../../shared/src/machines/client.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  let setTimer = (callback) => { let id = ++sequence; timers.set(id, callback); return id; };
  vm.runInNewContext(source, {
    exports, WebSocket, queueMicrotask,
    require: (name) => name === 'react' ? { useSyncExternalStore: () => {} } : {
      machineSecurity: () => security, signedCommand: async (_, message) => ({ ...message, auth: { fixture: true } }),
    },
    setTimeout: setTimer, clearTimeout: (id) => timers.delete(id),
    setInterval: setTimer, clearInterval: (id) => timers.delete(id),
  });
  let tick = async () => { await Promise.resolve(); await Promise.resolve(); };
  let stop = exports.connectMachines(async () => 'ws://fixture.invalid/ws?token=public-fixture');
  await tick();
  let socket = sockets[0]; socket.onopen();
  await socket.onmessage({ data: JSON.stringify({ type: 'machines', connection_id: 'fixture-client', machines: [
    { id: machine, online: true, owned: true, capabilities: ['signed_commands_v1'] },
  ] }) });
  await tick(); sent.length = 0;
  let request = async (message) => {
    let result = exports.machineRequest(machine, message);
    await tick();
    return { result, id: sent.at(-1).request_id };
  };
  let reply = (id, message, host = machine) => socket.onmessage({ data: JSON.stringify({
    type: 'machine_event', machine_id: host, request_id: id, message,
  }) });
  return { request, reply, stop };
};

test('ordinary commands reject unsigned responses decorated with a secure field', async () => {
  let app = await load();
  let { result, id } = await app.request({ type: 'stop_detected_process', pane_id: '%12' });
  let rejected = assert.rejects(result, /unauthenticated/);
  await app.reply(id, { type: 'host_response', result: { secure: { fixture: true } } });
  await rejected; app.stop();
});

test('an authenticated response must match the original request and machine', async () => {
  let app = await load();
  let { result, id } = await app.request({ type: 'stop_detected_process', pane_id: '%12' });
  let message = { type: 'secure_response', envelope: { request_id: id, response: { success: true } } };
  await app.reply(id, message, 'other-machine');
  await app.reply(id, message);
  assert.equal((await result).success, true); app.stop();
});

test('relay control acknowledgements are accepted only for control commands', async () => {
  let app = await load();
  let control = await app.request({ type: 'take_control', pane_id: '%12' });
  await app.reply(control.id, { type: 'control_ack', controller: 'fixture-client' });
  assert.equal((await control.result).type, 'control_ack');
  let stop = await app.request({ type: 'stop_detected_process', pane_id: '%12' });
  let rejected = assert.rejects(stop.result, /unauthenticated/);
  await app.reply(stop.id, { type: 'control_ack', controller: 'fixture-client' });
  await rejected; app.stop();
});

test('encrypted host envelopes are accepted only for encrypted host requests', async () => {
  let app = await load();
  let { result, id } = await app.request({ type: 'host_request', request: { action: 'secure', envelope: {} } });
  await app.reply(id, { type: 'host_response', result: { secure: { fixture: true } } });
  assert.equal((await result).result.secure.fixture, true); app.stop();
});

test('terminal forwarding receipts remain usable without authenticating command success', async () => {
  let app = await load();
  for (let type of ['pty_input', 'pty_resize', 'unsubscribe_pty', 'unsubscribe_logs', 'set_auto_yes_panes', 'tmux_pane_key']) {
    let { result, id } = await app.request({ type, pane_id: '%12' });
    await app.reply(id, { type: 'sent' });
    assert.equal((await result).type, 'sent');
  }
  let stop = await app.request({ type: 'stop_detected_process', pane_id: '%12' });
  let rejected = assert.rejects(stop.result, /unauthenticated/);
  await app.reply(stop.id, { type: 'sent' });
  await rejected; app.stop();
});
