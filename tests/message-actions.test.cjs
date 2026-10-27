const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('../desktop/node_modules/typescript');

const record = (id, status = 'pending') => ({ id, status, request: { source: {}, actions: [] } });
function harness(storage = new Map()) {
  const state = { connected: false, machines: [{ id: 'host', online: false }] };
  const records = [], calls = [];
  let request = async (_, value) => record(value.command.id, 'resolved');
  const modules = {
    '@react-native-async-storage/async-storage': {
      getItem: async key => storage.get(key) ?? null,
      setItem: async (key, value) => { storage.set(key, value); },
    },
    '@clawtab/shared': {
      machineState: () => state,
      machineHostRequest: async (host, value) => { calls.push([host, value]); return request(host, value); },
      resourceKey: (host, id) => `${host}::${id}`,
      messagePending: value => value.status === 'pending',
    },
    '../store/messages': { useMessageStore: { getState: () => ({ records, updateRecord: value => {
      const index = records.findIndex(item => item.id === value.id);
      if (index < 0) records.push(value); else records[index] = value;
    } }) } },
  };
  const source = ts.transpileModule(fs.readFileSync(require.resolve('../remote/src/lib/messageActions.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const exports = {};
  vm.runInNewContext(source, { exports, require: name => {
    assert.ok(name in modules, `Unexpected import: ${name}`);
    return modules[name];
  } });
  return { ...exports, storage, state, records, calls, request: value => { request = value; }, online: () => { state.connected = true; state.machines[0].online = true; } };
}

test('an offline reply survives restart and is delivered once after reconnect', async () => {
  const first = harness();
  await first.loadMessageActions('alice');
  await first.messageAction({ machine: 'host', id: 'question', op: 'respond', action_id: 'yes' });
  assert.equal(first.calls.length, 0);
  const next = harness(first.storage);
  await next.loadMessageActions('alice'); next.online();
  await next.flushMessageActions(); await next.flushMessageActions();
  assert.equal(next.calls.length, 1);
  assert.equal(next.calls[0][1].command.action_id, 'yes');
  assert.equal(next.records[0].status, 'resolved');
  assert.equal(JSON.parse(next.storage.get('clawtab_message_actions_alice')).length, 0);
});

test('a second reply added during delivery is drained in the same flush', async () => {
  const app = harness(); await app.loadMessageActions('alice'); app.online();
  let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  app.request(async (_, value) => {
    if (value.command.id === 'first') { entered(); await new Promise(resolve => { release = resolve; }); }
    return record(value.command.id, 'resolved');
  });
  const first = app.messageAction({ machine: 'host', id: 'first', op: 'dismiss' });
  await waiting;
  const second = app.messageAction({ machine: 'host', id: 'second', op: 'respond', action_id: 'reply', text: 'Use beta' });
  release(); await Promise.all([first, second]);
  assert.deepEqual(app.calls.map(([, value]) => value.command.id), ['first', 'second']);
});

test('resolved questions are discarded and transient failures remain queued', async () => {
  const app = harness(); await app.loadMessageActions('alice');
  await app.messageAction({ machine: 'host', id: 'old', op: 'respond', action_id: 'yes' });
  app.records.push({ ...record('old', 'resolved'), machine_id: 'host' }); app.online();
  await app.flushMessageActions(); assert.equal(app.calls.length, 0);
  app.request(async () => { throw new Error('Host disconnected'); });
  await assert.rejects(app.messageAction({ machine: 'host', id: 'new', op: 'dismiss' }), /disconnected/);
  assert.equal(JSON.parse(app.storage.get('clawtab_message_actions_alice')).length, 1);
  app.request(async (_, value) => record(value.command.id, 'resolved'));
  await app.flushMessageActions();
  assert.equal(JSON.parse(app.storage.get('clawtab_message_actions_alice')).length, 0);
});

test('an in-flight result cannot enter a different account', async () => {
  const app = harness(); await app.loadMessageActions('alice'); app.online();
  let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  app.request(async () => { entered(); await new Promise(resolve => { release = resolve; }); return record('alice-question', 'resolved'); });
  const sending = app.messageAction({ machine: 'host', id: 'alice-question', op: 'dismiss' });
  await waiting; await app.loadMessageActions('bob'); release(); await sending;
  assert.equal(app.records.length, 0);
  assert.equal(JSON.parse(app.storage.get('clawtab_message_actions_alice')).length, 1);
});
