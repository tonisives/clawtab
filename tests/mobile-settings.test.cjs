const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('../desktop/node_modules/typescript');

let harness = (file, modules = {}) => {
  let states = [], effects = [], queued = [], cursor = 0;
  let react = {
    useState: (initial) => {
      let index = cursor++;
      if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial;
      return [states[index], (value) => { states[index] = typeof value === 'function' ? value(states[index]) : value; }];
    },
    useEffect: (effect, deps) => {
      let index = cursor++;
      if (effects[index] && deps.every((value, i) => Object.is(value, effects[index].deps[i]))) return;
      effects[index]?.cleanup?.();
      effects[index] = { deps };
      queued.push(() => { effects[index].cleanup = effect(); });
    },
  };
  let exports = {};
  let element = (type, props) => ({ type, props });
  let source = ts.transpileModule(fs.readFileSync(__dirname + '/../' + file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(source, { exports, Error, require: (name) => name === 'react' ? react : name === 'react/jsx-runtime' ? { jsx: element, jsxs: element } : modules[name] });
  return {
    exports,
    render: (fn) => { cursor = 0; let result = fn(); queued.splice(0).forEach((effect) => effect()); return result; },
    unmount: () => effects.forEach((effect) => effect?.cleanup?.()),
  };
};
let flush = () => new Promise(setImmediate);
let findAll = (node, predicate) => !node ? [] : Array.isArray(node) ? node.flatMap((item) => findAll(item, predicate)) : [...(predicate(node) ? [node] : []), ...findAll(node.props?.children, predicate)];

test('usage requests are scoped, do not run while hidden, and ignore stale machine replies', async () => {
  let requests = [];
  let h = harness('remote/src/hooks/useModelUsage.ts', { '@clawtab/shared': { machineRequest: (machine, message) => new Promise((resolve, reject) => requests.push({ machine, message, resolve, reject })) } });
  let render = (machine, enabled = true) => h.render(() => h.exports.useModelUsage(machine, enabled));
  render('a', false);
  render(undefined);
  assert.equal(requests.length, 0);
  render('a');
  assert.equal(requests[0].machine, 'a');
  assert.equal(requests[0].message.type, 'get_usage');
  assert.equal(render('a').loading, true);
  assert.equal(render('b').usage, null);
  requests[1].resolve({ usage: { marker: 'b' } });
  await flush();
  requests[0].resolve({ usage: { marker: 'a' } });
  await flush();
  assert.equal(render('b').usage.marker, 'b');
  render('b').refresh();
  render('b');
  requests[2].reject(new Error('Offline'));
  await flush();
  assert.equal(render('b').error, 'Offline');
  assert.equal(render('b').loading, false);
  assert.equal(render('b', false).usage, null);
  render('b');
  assert.equal(requests.length, 4);
  h.unmount();
  requests[3].resolve({ usage: { marker: 'late' } });
  await flush();
});

test('usage immediately offers machines without a global selection and switches locally', () => {
  let state = { connected: true, selected: null, machines: [{ id: 'offline', name: 'Offline Mac', online: false }, { id: 'online', name: 'Mac', online: true }] };
  let queried = [];
  let h = harness('remote/src/components/settings/UsageSettings.tsx', {
    'react-native': { View: 'View', Text: 'Text', Pressable: 'Pressable', ActivityIndicator: 'ActivityIndicator' },
    '@expo/vector-icons': { Ionicons: 'Ionicons' },
    'expo-router/react-navigation': { useIsFocused: () => true },
    '@clawtab/shared': { useMachines: () => state },
    '../../theme/colors': { colors: {} },
    '../../hooks/useModelUsage': { useModelUsage: (machine, enabled) => { queried.push({ machine, enabled }); return {}; } },
    '../UsageProgressBar': {},
    './SettingsPage': { SettingsPage: 'Page', SettingsRow: 'Row', styles: {} },
    './navigation': { useSettingsVisible: () => true, useSettingsNavigation: () => () => {} },
  });
  let render = () => h.render(h.exports.UsageSettings);
  let tree = render();
  assert.equal(queried.at(-1).machine, 'online');
  let choices = findAll(tree, (node) => node.props?.accessibilityRole === 'radio');
  assert.equal(choices.length, 2);
  assert.equal(choices[1].props.accessibilityState.checked, true);
  choices[0].props.onPress();
  render();
  assert.equal(queried.at(-1).machine, 'offline');
  assert.equal(queried.at(-1).enabled, false);
  assert.equal(state.selected, null);
  state.machines = state.machines.slice(1);
  render();
  assert.equal(queried.at(-1).machine, 'online');
});
