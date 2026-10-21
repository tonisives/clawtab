const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('../desktop/node_modules/typescript');
const exports_ = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(__dirname + '/../remote/src/lib/jobListState.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports: exports_ });
const state = (changes = {}) => exports_.jobListState({ authenticated: false, authLoading: false, connected: false, hostOnline: false, loaded: false, ...changes });

test('authentication loading never presents sample jobs', () => {
  const view = state({ authLoading: true });
  assert.equal(view.demo, false);
  assert.match(view.loading, /Loading your account/);
});
test('signed-in initial connection and reconnection never switch to demo', () => {
  for (const loaded of [false, true]) {
    const view = state({ authenticated: true, loaded });
    assert.equal(view.demo, false);
    assert.match(view.loading, /Connecting to relay/);
  }
});
test('connected hosts show loading until jobs arrive, including an empty snapshot', () => {
  assert.match(state({ authenticated: true, connected: true, hostOnline: true }).loading, /Loading jobs/);
  const loaded = state({ authenticated: true, connected: true, hostOnline: true, loaded: true });
  assert.equal(loaded.demo, false);
  assert.equal(loaded.loading, null);
});
test('a relay without online hosts offers the real machine list rather than sample data', () => {
  const view = state({ authenticated: true, connected: true });
  assert.equal(view.demo, false);
  assert.equal(view.loading, null);
});
test('only a settled signed-out session falls back to demo', () => {
  assert.equal(state().demo, true);
  assert.equal(state().loading, null);
  assert.equal(state({ connected: true }).demo, false);
});
