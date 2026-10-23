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
test('a settled signed-out session falls back to demo', () => {
  assert.equal(state().demo, true);
  assert.equal(state().loading, null);
  assert.equal(state({ connected: true }).demo, false);
});

test('signed-in users without relay access can explore the demo and setup overview', () => {
  for (const loaded of [false, true]) {
    const view = state({ authenticated: true, loaded, error: 'Relay subscription required' });
    assert.equal(view.demo, true);
    assert.equal(view.loading, null);
  }
});

test('transient connection failures keep the real session separate from sample data', () => {
  for (const error of ['Relay connection timed out', 'Failed to fetch', 'Connection to the machine service was lost. Retrying…']) {
    const view = state({ authenticated: true, error });
    assert.equal(view.demo, false);
    assert.match(view.loading, /Connecting to relay/);
  }
});

test('checking the account and reconnecting after a subscription do not show stale demo data', () => {
  const denied = { authenticated: true, error: 'Relay subscription required' };
  assert.equal(state({ ...denied, authLoading: true }).demo, false);
  assert.equal(state({ ...denied, connected: true }).demo, false);
  assert.equal(state({ ...denied, connected: true, hostOnline: true, loaded: true }).loading, null);
  assert.equal(state({ ...denied, error: null }).demo, false);
});

test('connection failures show their cause and recovery actions without a loading spinner', () => {
  const component = {};
  let retried = 0, accountOpened = 0;
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(__dirname + '/../remote/src/components/ConnectionLoadingView.tsx', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports: component, require: (name) => {
    if (name === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
    if (name === 'react-native') return { View: 'View', Text: 'Text', Pressable: 'Pressable', ActivityIndicator: 'ActivityIndicator', StyleSheet: { create: (styles) => styles } };
    if (name === '@clawtab/shared') return { colors: {}, reconnectMachines: () => { retried++; } };
    throw new Error(`Unexpected import: ${name}`);
  } });
  const all = (node) => Array.isArray(node) ? node.flatMap(all) : node && typeof node === 'object' ? [node, ...all(node.props?.children)] : [];
  const render = (error) => all(component.ConnectionLoadingView({ label: 'Connecting to relay…', error, onAccount: () => { accountOpened++; } }));
  assert.ok(render(null).some((node) => node.type === 'ActivityIndicator'));
  const failed = render('Relay connection timed out');
  assert.ok(!failed.some((node) => node.type === 'ActivityIndicator'));
  assert.ok(failed.some((node) => node.type === 'Text' && node.props.children === 'Unable to connect to relay'));
  assert.ok(failed.some((node) => node.type === 'Text' && node.props.children === 'Relay connection timed out'));
  for (const node of failed.filter((node) => node.type === 'Pressable')) node.props.onPress();
  assert.equal(retried, 1);
  assert.equal(accountOpened, 1);
});
