const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');
const { create } = require('zustand');

let machine = '9882aa5a-ec95-458a-a367-d2e1f95068ae';
let otherMachine = '11111111-1111-4111-8111-111111111111';
let pane = `${machine}::%12`;
let load = (initial = [], requestError) => {
  let listeners = new Set(), sent = [], prompts = [], errors = [], cache = {};
  let snapshots = { [machine]: { auto_yes_panes: { pane_ids: initial } } };
  let dependencies = {
    zustand: { create },
    './platform': { confirm: (...args) => prompts.push(args), alertError: (...args) => errors.push(args) },
    '@clawtab/shared': {
      splitResource: (key) => { let at = key.indexOf('::'); return at === 36 ? { machine: key.slice(0, at), id: key.slice(at + 2) } : null; },
      machineState: () => ({ snapshots }),
      onMachineEvent: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
      machineRequest: async (host, message) => { sent.push({ host, ...message }); if (requestError) throw new Error(requestError); return { type: 'sent' }; },
    },
  };
  let read = (file) => {
    if (cache[file]) return cache[file];
    let exports = {}; cache[file] = exports;
    let source = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    vm.runInNewContext(source, { exports, require: (name) => dependencies[name] ?? read(path.resolve(path.dirname(file), `${name}.ts`)), setTimeout, clearTimeout, Error });
    return exports;
  };
  let store = read(path.resolve(__dirname, '../src/store/notifications.ts')).useNotificationStore;
  store.getState().setAutoYesPanes(initial.map((id) => `${machine}::${id}`));
  let changes = [];
  let last = store.getState().autoYesPaneIds.has(pane);
  store.subscribe((state) => { let next = state.autoYesPaneIds.has(pane); if (next !== last) { changes.push(next); last = next; } });
  let tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  let broadcast = (ids, host = machine) => {
    snapshots[host] = { auto_yes_panes: { pane_ids: ids } };
    store.getState().setAutoYesPanes(Object.entries(snapshots).flatMap(([host, snapshot]) => snapshot.auto_yes_panes.pane_ids.map((id) => `${host}::${id}`)));
    for (let listener of listeners) listener(host, { type: 'auto_yes_panes', pane_ids: ids });
  };
  return { ...read(path.resolve(__dirname, '../src/lib/autoYes.ts')), store, sent, prompts, errors, changes, listeners, broadcast, tick };
};

test('enable moves once through confirmation, stale snapshots and host acknowledgement', async () => {
  let state = load(['%8']), enabled = 0;
  state.toggleAutoYes(pane, 'Agent', () => enabled++);
  assert.deepEqual(state.changes, [true]);
  assert.equal(state.sent.length, 0);
  state.broadcast(['%8']);
  state.prompts[0][2]();
  await state.tick();
  assert.equal(enabled, 0, 'relay forwarding is not host confirmation');
  state.broadcast(['%8']);
  assert.deepEqual(state.changes, [true]);
  assert.equal(state.sent[0].host, machine);
  assert.deepEqual(Array.from(state.sent[0].pane_ids), ['%8', '%12']);
  state.broadcast(['%8', '%12']);
  await state.tick();
  assert.equal(enabled, 1);
  assert.equal(state.store.getState().pendingAutoYes.size, 0);
  assert.equal(state.listeners.size, 0);
  assert.deepEqual(state.changes, [true]);
});

test('disable moves once while stale snapshots still contain the pane', async () => {
  let state = load(['%12', '%8']);
  state.toggleAutoYes(pane, 'Agent');
  state.broadcast(['%12', '%8']);
  assert.deepEqual(state.changes, [false]);
  state.broadcast(['%8']);
  await state.tick();
  assert.deepEqual(state.changes, [false]);
  assert.deepEqual(Array.from(state.sent[0].pane_ids), ['%8']);
  assert.equal(state.prompts.length, 0);
  assert.equal(state.store.getState().pendingAutoYes.size, 0);
});

test('cancel reverts once without sending or answering anything', () => {
  let state = load(), enabled = 0;
  state.toggleAutoYes(pane, 'Agent', () => enabled++);
  state.broadcast([]);
  state.prompts[0][3]();
  assert.deepEqual(state.changes, [true, false]);
  assert.equal(state.sent.length, 0);
  assert.equal(enabled, 0);
});

for (let initiallyEnabled of [false, true]) {
  test(`failed ${initiallyEnabled ? 'disable' : 'enable'} reverts once and shows an error`, async () => {
    let state = load(initiallyEnabled ? ['%12'] : [], 'Machine is offline');
    state.toggleAutoYes(pane, 'Agent');
    if (!initiallyEnabled) state.prompts[0][2]();
    await state.tick();
    assert.deepEqual(state.changes, [!initiallyEnabled, initiallyEnabled]);
    assert.equal(state.errors[0][1], 'Machine is offline');
    assert.equal(state.listeners.size, 0);
    assert.equal(state.store.getState().pendingAutoYes.size, 0);
  });
}

test('an absent host update times out and reverts even if forwarding succeeded', async () => {
  let state = load();
  state.toggleAutoYes(pane, 'Agent', undefined, 5);
  state.prompts[0][2]();
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.deepEqual(state.changes, [true, false]);
  assert.match(state.errors[0][1], /not confirmed/);
  assert.equal(state.listeners.size, 0);
});

test('duplicate taps are ignored and another machine cannot acknowledge the change', async () => {
  let state = load();
  state.toggleAutoYes(pane, 'Agent');
  state.toggleAutoYes(pane, 'Agent');
  assert.equal(state.prompts.length, 1);
  state.prompts[0][2]();
  state.broadcast(['%12'], otherMachine);
  await state.tick();
  assert.equal(state.store.getState().pendingAutoYes.size, 1);
  state.broadcast(['%12']);
  await state.tick();
  assert.equal(state.store.getState().pendingAutoYes.size, 0);
  assert.deepEqual(state.changes, [true]);
});

test('concurrent panes preserve each pending value through updates and rollback', async () => {
  let state = load();
  let second = `${machine}::%13`;
  state.toggleAutoYes(pane, 'First');
  state.toggleAutoYes(second, 'Second');
  state.prompts[0][2]();
  assert.deepEqual(Array.from(state.sent[0].pane_ids), ['%12'], 'an unconfirmed change must not be sent');
  state.prompts[1][2]();
  assert.deepEqual(Array.from(state.sent[1].pane_ids), ['%12', '%13']);
  state.broadcast(['%12']);
  await state.tick();
  assert.equal(state.store.getState().autoYesPaneIds.has(second), true);
  state.broadcast(['%12', '%13']);
  await state.tick();
  assert.equal(state.store.getState().pendingAutoYes.size, 0);
});
