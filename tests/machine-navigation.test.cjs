const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('../desktop/node_modules/typescript');
let load = (path, modules) => {
  let exports = {};
  let source = ts.transpileModule(fs.readFileSync(__dirname + '/../' + path, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(source, { exports, require: (name) => modules[name], Uint8Array, btoa });
  return exports;
};
let { resolveRentalAvailability, rentalAvailabilityMessage } = load('remote/src/lib/rentalAvailability.ts');
let capabilities = { enabled: true, ios_storefronts: ['USA', 'US'], android_storefronts: ['US'] };

test('paused backend has a distinct reason and does not depend on native billing', async () => {
  let result = await resolveRentalAvailability({ ...capabilities, enabled: false }, 'ios', () => { throw Error('Must not call'); });
  assert.equal(result.reason, 'paused');
  assert.equal(result.purchases, false);
  assert.match(rentalAvailabilityMessage(result.reason), /paused/);
});
test('web checkout works without a storefront, native checkout uses the server allowlist', async () => {
  assert.equal((await resolveRentalAvailability(capabilities, 'web', () => { throw Error(); })).purchases, true);
  assert.equal((await resolveRentalAvailability(capabilities, 'ios', async () => ' usa ')).purchases, true);
  assert.equal((await resolveRentalAvailability(capabilities, 'android', async () => 'US')).purchases, true);
  assert.equal((await resolveRentalAvailability(capabilities, 'ios', async () => 'THA')).reason, 'region');
  assert.equal((await resolveRentalAvailability({ ...capabilities, android_storefronts: [] }, 'android', async () => 'US')).reason, 'region');
});
test('failed and empty storefront lookups are retryable, and a later lookup can succeed', async () => {
  for (let lookup of [async () => '', async () => { throw Error('offline'); }]) {
    let result = await resolveRentalAvailability(capabilities, 'ios', lookup);
    assert.equal(result.reason, 'storefront');
    assert.match(rentalAvailabilityMessage(result.reason), /Try again/);
  }
  assert.equal((await resolveRentalAvailability(capabilities, 'ios', async () => 'USA')).purchases, true);
});

let element = (type, props) => ({ type, props });
let native = { StyleSheet: { create: (value) => value }, ...Object.fromEntries(['View', 'Text', 'Pressable'].map((value) => [value, value])) };
let jsx = { jsx: element, jsxs: element };
let find = (node, match) => {
  if (!node) return;
  if (Array.isArray(node)) return node.map((child) => find(child, match)).find(Boolean);
  return match(node) ? node : find(node.props?.children, match);
};
let { TerminalKeyBar } = load('shared/src/machines/TerminalKeyBar.tsx', { 'react-native': native, 'react/jsx-runtime': jsx, '../theme/colors': { colors: {} } });

test('terminal keys send the standard escape sequences and disabled controls send nothing', () => {
  let received = [];
  let view = TerminalKeyBar({ disabled: false, onKey: (value) => received.push(value) });
  for (let label of ['Arrow left', 'Arrow down', 'Arrow up', 'Arrow right', 'Enter']) find(view, (node) => node.props?.accessibilityLabel === label).props.onPress();
  assert.deepEqual(received, ['\x1b[D', '\x1b[B', '\x1b[A', '\x1b[C', '\r']);
  let disabled = TerminalKeyBar({ disabled: true, onKey: (value) => received.push(value) });
  find(disabled, (node) => node.props?.accessibilityLabel === 'Arrow up').props.onPress();
  assert.equal(received.length, 5);
});

test('box terminal encodes toolbar input for its own pane only while online and in control', () => {
  let state = { connected: true, connectionId: 'viewer', machines: [{ id: 'box', online: true }], controllers: { 'box::%2': 'viewer' } };
  let requests = [];
  let { encodeTerminalInput } = load('shared/src/util/terminalInput.ts');
  let { MachineTerminal } = load('shared/src/machines/Terminal.tsx', {
    react: { useRef: () => ({ current: null }), useState: () => [null, () => {}], useEffect: () => {} },
    'react/jsx-runtime': jsx, 'react-native': native,
    './TerminalKeyBar': { TerminalKeyBar }, './Actions': {}, '../components/XtermLog': {}, '../theme/colors': { colors: {} }, '../theme/spacing': { spacing: {} }, '../util/terminalInput': { encodeTerminalInput },
    './client': { useMachines: () => state, resourceKey: (machine, pane) => `${machine}::${pane}`, executionFor: () => '', machineRequest: async (machine, message) => requests.push({ machine, message }) },
  });
  let render = () => find(MachineTerminal({ machineId: 'box', paneId: '%2', tmuxSession: 'shell' }), (node) => node.type === TerminalKeyBar);
  render().props.onKey('\x1b[A');
  assert.equal(requests[0].machine, 'box');
  assert.equal(requests[0].message.pane_id, '%2');
  assert.equal(Buffer.from(requests[0].message.data, 'base64').toString(), '\x1b[A');
  state.controllers['box::%2'] = 'someone-else';
  assert.equal(render().props.disabled, true);
  render().props.onKey('\x1b[B');
  state.connectionId = undefined;
  delete state.controllers['box::%2'];
  render().props.onKey('\x1b[B');
  state.connected = false;
  render().props.onKey('\x1b[B');
  assert.equal(requests.length, 1);
});
