const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');

let machine = '9882aa5a-ec95-458a-a367-d2e1f95068ae';
let pane = `${machine}::%12`;
let load = (dimensions = { cols: 80, rows: 24 }) => {
  let effects = [], requests = [], sent = [], pending = new Map(), timers = new Map(), timerId = 0;
  let state = { connectionId: 'mobile-client', controllers: { [pane]: 'other-client' } };
  let send = (message) => {
    sent.push(message);
    if (message.type === 'subscribe_pty') pending.get(message.id)?.({ success: true });
  };
  let dependencies = {
    '@clawtab/shared': {
      machineState: () => state,
      splitResource: (key) => key.includes('::') ? { machine: key.slice(0, 36), id: key.slice(38) } : null,
      machineRequest: (host, message) => new Promise((resolve, reject) => requests.push({ host, message, resolve: () => {
        state.controllers[pane] = state.connectionId; resolve({ type: 'control_ack' });
      }, reject })),
      machineSend: (host, message) => sent.push({ host, ...message }),
    },
    react: {
      useEffect: (effect) => effects.push(effect), useRef: (current) => ({ current }),
      useCallback: (callback) => callback, useState: (initial) => [initial, () => {}],
    },
    '../lib/terminalCache': { terminalCache: { get: () => [], append: () => {}, delete: () => {} } },
    '../lib/wsRuntime': { getWsSend: () => send, nextId: () => `request-${++timerId}` },
    '../lib/useRequestMap': {
      registerRequest: (id) => new Promise((resolve) => pending.set(id, resolve)),
      clearRequest: (id) => pending.delete(id),
    },
  };
  let exports = {};
  let source = ts.transpileModule(fs.readFileSync(require.resolve('../src/hooks/usePty.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  let setTimer = (callback, delay) => { let id = ++timerId; timers.set(id, { callback, delay }); return id; };
  vm.runInNewContext(source, {
    exports, require: (name) => dependencies[name], setTimeout: setTimer,
    clearTimeout: (id) => timers.delete(id), setInterval: setTimer, clearInterval: (id) => timers.delete(id),
  });
  let terminal = exports.usePty(pane, 'fixture-session', { current: { dimensions: () => dimensions, clear: () => {}, write: () => {} } });
  let cleanup = effects.map((effect) => effect()).filter(Boolean);
  let tick = async () => { await Promise.resolve(); await Promise.resolve(); };
  let close = () => cleanup.forEach((callback) => callback());
  let reopen = () => {
    effects.length = 0;
    terminal = exports.usePty(pane, 'fixture-session', { current: { dimensions: () => dimensions, clear: () => {}, write: () => {} } });
    cleanup = effects.map((effect) => effect()).filter(Boolean);
  };
  let runTimer = (delay) => {
    for (let [id, timer] of timers) if (timer.delay === delay) { timers.delete(id); timer.callback(); }
  };
  return { ...exports, terminal, requests, sent, pending, timers, tick, close, reopen, runTimer };
};

test('opening claims an existing lease before subscribing and permits input', async () => {
  let app = load();
  app.terminal.sendInput('fixture');
  assert.equal(app.sent.length, 0);
  assert.equal(app.requests[0].host, machine);
  assert.equal(app.requests[0].message.type, 'take_control');
  assert.equal(app.requests[0].message.pane_id, '%12');
  app.requests[0].resolve(); await app.tick();
  assert.equal(app.sent[0].type, 'subscribe_pty');
  app.terminal.sendInput('fixture');
  assert.equal(app.sent.at(-1).type, 'pty_input');
  app.close(); app.runTimer(1200);
  assert.equal(app.sent.at(-1).type, 'release_control');
});

test('foreground and socket replay automatically reclaim control', async () => {
  let app = load();
  app.requests[0].resolve(); await app.tick();
  app.releaseActivePtySubscriptions();
  app.replayActivePtySubscriptions('resume');
  assert.equal(app.requests[1].message.type, 'take_control');
  app.requests[1].resolve(); await app.tick();
  assert.equal(app.sent.filter((message) => message.type === 'subscribe_pty').length, 2);
  app.replayActivePtySubscriptions();
  assert.equal(app.requests[2].message.type, 'take_control');
  app.close();
});

test('closing while control is pending does not attach a hidden terminal', async () => {
  let app = load();
  app.close();
  app.requests[0].resolve(); await app.tick();
  assert.equal(app.sent.some((message) => message.type === 'subscribe_pty'), false);
  assert.equal(app.sent.at(-1).type, 'release_control');
});

test('a failed control claim retries without subscribing', async () => {
  let app = load();
  app.requests[0].reject(new Error('offline')); await app.tick();
  assert.equal(app.sent.length, 0);
  app.runTimer(700);
  assert.equal(app.requests.length, 2);
  app.close();
});

test('an old control reply cannot release a reopened terminal', async () => {
  let app = load();
  app.close(); app.runTimer(1200); app.reopen();
  app.requests[1].resolve(); await app.tick();
  let releases = app.sent.filter((message) => message.type === 'release_control').length;
  app.requests[0].resolve(); await app.tick();
  assert.equal(app.sent.filter((message) => message.type === 'release_control').length, releases);
  assert.equal(app.sent.filter((message) => message.type === 'subscribe_pty').length, 1);
  app.close();
});

test('control waits until native terminal dimensions are measured', () => {
  let dimensions = { cols: 0, rows: 0 };
  let app = load(dimensions);
  assert.equal(app.requests.length, 0);
  dimensions.cols = 91; dimensions.rows = 32;
  app.terminal.sendResize(91, 32);
  assert.equal(app.requests[0].message.cols, 91);
  assert.equal(app.requests[0].message.rows, 32);
  app.close();
});
