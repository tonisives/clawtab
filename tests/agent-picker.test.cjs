const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('../desktop/node_modules/typescript');

let harness = (entry, extras = {}) => {
  let states = [], cursor = 0;
  let react = {
    useState: (initial) => {
      let index = cursor++;
      if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial;
      return [states[index], (value) => { states[index] = typeof value === 'function' ? value(states[index]) : value; }];
    },
    useRef: (initial) => react.useState({ current: initial })[0],
    useCallback: (callback) => callback,
    useEffect: () => {},
  };
  let element = (type, props) => ({ type, props });
  let modules = {
    react,
    "./JobKindIcon": { JobKindIcon: "JobKindIcon" },
    'react/jsx-runtime': { jsx: element, jsxs: element, Fragment: 'Fragment' },
    'react-native': { Platform: { OS: 'ios' }, StyleSheet: { create: (value) => value }, useWindowDimensions: () => ({ width: 390, height: 844 }), ...Object.fromEntries(['View', 'Text', 'ScrollView', 'TouchableOpacity', 'Pressable', 'Modal'].map((name) => [name, name])) },
    ...extras,
  };
  let cache = {};
  let load = (file) => {
    if (cache[file]) return cache[file];
    let exports = {};
    cache[file] = exports;
    let source = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    vm.runInNewContext(source, { exports, require: (name) => {
      if (name in modules) return modules[name];
      let next = path.resolve(path.dirname(file), name);
      return load(fs.existsSync(next + '.tsx') ? next + '.tsx' : next + '.ts');
    }, setTimeout, clearTimeout, setInterval, clearInterval, console, Error });
    return exports;
  };
  let exports = load(path.resolve(__dirname, entry));
  return { exports, render: (fn, props) => { cursor = 0; return fn(props); } };
};
let find = (node, predicate) => {
  if (!node) return undefined;
  if (Array.isArray(node)) return node.map((item) => find(item, predicate)).find(Boolean);
  if (predicate(node)) return node;
  return find(node.props?.children, predicate);
};
let selector = (tree) => find(tree, (node) => node.props?.targetItems);
let machineMock = (state) => ({ '../machines/client': { useMachines: () => state, selectMachine: (id) => { state.selected = id; } } });

test('mobile defaults to an online owned machine and uses its enabled models', async () => {
  let state = { selected: null, machines: [{ id: 'a', name: 'Desktop A', owned: true, online: true }], snapshots: { a: { settings_response: { enabled_models: { claude: ['opus'], codex: [], opencode: [], antigravity: [] } } } } };
  let launched;
  let view = harness('../shared/src/components/GroupAgentRow.tsx', machineMock(state));
  let picker = selector(view.render(view.exports.GroupAgentRow, { onRunAgent: (...args) => { launched = { target: state.selected, args }; } }));
  assert.match(picker.props.targetItems[0].label, /Desktop A/);
  assert.deepEqual(Array.from(picker.props.modelOptions, (model) => model.modelId), ['opus']);
  await picker.props.onChange({ provider: 'claude', modelId: 'opus', effort: 'high' });
  assert.equal(launched.target, 'a');
  assert.deepEqual(launched.args, ['', 'claude', 'opus', 'high']);
});

test('target changes refresh models and launch errors are visible', async () => {
  let state = { selected: 'a', machines: ['a', 'b'].map((id) => ({ id, name: id, owned: true, online: true })), snapshots: { b: { settings_response: { enabled_models: { claude: [], codex: ['gpt-test'], opencode: [], antigravity: [] } } } } };
  let view = harness('../shared/src/components/GroupAgentRow.tsx', machineMock(state));
  let props = { onRunAgent: async () => { throw new Error('Working directory missing'); } };
  let picker = selector(view.render(view.exports.GroupAgentRow, props));
  assert.equal(picker.props.modelOptions.length, 0);
  picker.props.targetItems.find((item) => item.label === 'b').onPress();
  picker = selector(view.render(view.exports.GroupAgentRow, props));
  assert.equal(picker.props.modelOptions[0].modelId, 'gpt-test');
  await picker.props.onChange({ provider: 'codex', modelId: 'gpt-test', effort: 'high' });
  assert.ok(find(view.render(view.exports.GroupAgentRow, props), (node) => node.props?.children === 'Working directory missing'));
});

test('desktop defaults locally without a relay connection', async () => {
  let state = { selected: null, machines: [], snapshots: {} }, called = false;
  let view = harness('../shared/src/components/GroupAgentRow.tsx', machineMock(state));
  let picker = selector(view.render(view.exports.GroupAgentRow, { localMachineId: null, modelOptions: [{ provider: 'codex', modelId: 'local-model' }], onRunAgent: () => { called = true; } }));
  assert.match(picker.props.targetItems[0].label, /This desktop/);
  assert.equal(picker.props.modelOptions[0].modelId, 'local-model');
  await picker.props.onChange({ provider: 'shell', modelId: null, effort: null });
  assert.equal(called, true);
});

test('native model selection keeps the popup open for effort selection', () => {
  let chosen;
  let view = harness('../shared/src/components/AgentSelector.tsx');
  let props = { modelOptions: [{ provider: 'codex', modelId: 'gpt-test', label: 'Test model' }], onChange: (selection) => { chosen = selection; } };
  let render = () => view.render(view.exports.AgentSelector, props);
  find(render(), (node) => node.type === 'TouchableOpacity').props.onPress({});
  let popup = find(render(), (node) => Array.isArray(node.props?.items));
  let model = popup.props.items[0];
  assert.equal(model.keepOpen, true);
  model.onPress();
  popup = find(render(), (node) => Array.isArray(node.props?.items));
  let high = popup.props.items.find((item) => item.label.toLowerCase() === 'high');
  assert.ok(high);
  high.onPress();
  assert.equal(chosen.modelId, 'gpt-test');
  assert.equal(chosen.effort, 'high');
  assert.equal(find(render(), (node) => Array.isArray(node.props?.items)), undefined);
});
