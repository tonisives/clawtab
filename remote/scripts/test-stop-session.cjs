const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');

let load = (respond) => {
  let pending = new Map(), sent = [], exports = {};
  let send = respond === null ? null : (message) => {
    sent.push(message);
    respond?.(message, (reply) => pending.get(message.id)?.(reply));
  };
  let dependencies = {
    './wsRuntime': { getWsSend: () => send, nextId: () => 'stop-1' },
    './useRequestMap': {
      registerRequest: (id) => new Promise((resolve) => pending.set(id, resolve)),
      clearRequest: (id) => pending.delete(id),
    },
  };
  let source = ts.transpileModule(fs.readFileSync(require.resolve('../src/lib/stopSession.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(source, { exports, require: (name) => dependencies[name], setTimeout, clearTimeout, Error });
  return { ...exports, pending, sent };
};

test('stops a terminal without a detected agent and registers before sending', async () => {
  let state = load((message, reply) => reply({ success: true }));
  let pane = '9882aa5a-ec95-458a-a367-d2e1f95068ae::%12';
  await state.stopSession(pane);
  assert.equal(state.sent[0].pane_id, pane);
  assert.equal(state.sent[0].type, 'stop_detected_process');
  assert.equal(state.pending.size, 0);
});

test('surfaces host failures and cleans up the pending request', async () => {
  let state = load((message, reply) => reply({ success: false, error: 'Machine is offline' }));
  await assert.rejects(state.stopSession('%12'), /Machine is offline/);
  assert.equal(state.pending.size, 0);
});

test('a missing acknowledgement does not count as a successful stop', async () => {
  let state = load();
  await assert.rejects(state.stopSession('%12', 5), /Stop was not confirmed/);
  assert.equal(state.pending.size, 0);
});

test('requires an explicit success acknowledgement', async () => {
  let state = load((message, reply) => reply({}));
  await assert.rejects(state.stopSession('%12'), /Could not stop/);
});

test('offline attempts fail immediately without sending or leaking a request', async () => {
  let state = load(null);
  await assert.rejects(state.stopSession('%12'), /Not connected/);
  assert.equal(state.sent.length, 0);
  assert.equal(state.pending.size, 0);
});
