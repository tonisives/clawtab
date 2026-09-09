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
    useMemo: (callback) => callback(),
    useEffect: () => {},
  };
  let element = (type, props) => ({ type, props });
  let modules = {
    react,
    "./JobKindIcon": { JobKindIcon: "JobKindIcon" },
    'react/jsx-runtime': { jsx: element, jsxs: element, Fragment: 'Fragment' },
    'react-native': { Platform: { OS: 'ios' }, StyleSheet: { create: (value) => value }, useWindowDimensions: () => ({ width: 390, height: 844 }), ...Object.fromEntries(['View', 'Text', 'ScrollView', 'TouchableOpacity', 'Pressable', 'Modal', 'TextInput'].map((name) => [name, name])) },
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
let selector = (tree) => find(tree, (node) => node.props?.machinePicker);
let machineMock = (state) => ({ '../machines/client': { useMachines: () => state, selectMachine: (id) => { state.selected = id; } } });

test('mobile defaults to an online owned machine and uses its enabled models', async () => {
  let state = { selected: null, machines: [{ id: 'a', name: 'Desktop A', owned: true, online: true }], snapshots: { a: { settings_response: { enabled_models: { claude: ['opus'], codex: [], opencode: [], antigravity: [] } } } } };
  let launched;
  let view = harness('../shared/src/components/GroupAgentRow.tsx', machineMock(state));
  let picker = selector(view.render(view.exports.GroupAgentRow, { onRunAgent: (...args) => { launched = { target: state.selected, args }; } }));
  assert.equal(picker.props.machinePicker.props.target, 'a');
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
  picker.props.machinePicker.props.onSelect('b');
  picker = selector(view.render(view.exports.GroupAgentRow, props));
  assert.equal(picker.props.modelOptions[0].modelId, 'gpt-test');
  await picker.props.onChange({ provider: 'codex', modelId: 'gpt-test', effort: 'high' });
  assert.ok(find(view.render(view.exports.GroupAgentRow, props), (node) => node.props?.children === 'Working directory missing'));
});

test('desktop defaults locally without a relay connection', async () => {
  let state = { selected: null, machines: [], snapshots: {} }, called = false;
  let view = harness('../shared/src/components/GroupAgentRow.tsx', machineMock(state));
  let picker = selector(view.render(view.exports.GroupAgentRow, { localMachineId: null, modelOptions: [{ provider: 'codex', modelId: 'local-model' }], onRunAgent: () => { called = true; } }));
  assert.equal(picker.props.machinePicker.props.localMachineId, null);
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


test('configured account models stay the same across desktop and remote targets', async () => {
  let state = { selected: 'a', machines: ['a', 'b'].map((id) => ({ id, name: id, owned: true, online: true })),
    agentModels: { enabled_models: { codex: ['my-custom-model'], claude: [], opencode: [], antigravity: [] } }, snapshots: {} };
  let view = harness('../shared/src/components/GroupAgentRow.tsx', machineMock(state));
  let launched;
  let props = { localMachineId: 'a', modelOptions: [{ provider: 'codex', modelId: 'old-default' }], onRunAgent: (...args) => { launched = args; } };
  let render = () => selector(view.render(view.exports.GroupAgentRow, props));
  assert.deepEqual(Array.from(render().props.modelOptions, (option) => option.modelId), ['my-custom-model']);
  render().props.machinePicker.props.onSelect('b');
  assert.deepEqual(Array.from(render().props.modelOptions, (option) => option.modelId), ['my-custom-model']);
  await render().props.onChange({ provider: 'codex', modelId: 'my-custom-model', effort: 'high' });
  assert.equal(launched[2], 'my-custom-model');
});

test('machine choices remain in the footer through model and effort selection', () => {
  let view = harness('../shared/src/components/AgentSelector.tsx');
  let footer = { type: 'MachineTargetPicker' };
  let props = { modelOptions: [{ provider: 'codex', modelId: 'custom', label: 'Custom' }], machinePicker: footer, onChange: () => {} };
  let render = () => view.render(view.exports.AgentSelector, props);
  find(render(), (node) => node.type === 'TouchableOpacity').props.onPress({});
  let popup = find(render(), (node) => Array.isArray(node.props?.items));
  assert.equal(popup.props.footer, footer);
  assert.equal(popup.props.items.length, 1);
  popup.props.items[0].onPress();
  assert.equal(find(render(), (node) => Array.isArray(node.props?.items)).props.footer, footer);
});


test('saved groups launch on their own machine even when another target is selected', async () => {
  let state = { selected: 'desktop', machines: [{ id: 'remote', name: 'Remote', owned: true, online: true }], snapshots: {} };
  let launched;
  let view = harness('../shared/src/components/GroupAgentRow.tsx', machineMock(state));
  let props = { targetMachineId: 'remote', onRunAgent: () => { launched = state.selected; } };
  let picker = selector(view.render(view.exports.GroupAgentRow, props));
  await picker.props.onChange({ provider: 'shell', modelId: null, effort: null });
  assert.equal(launched, 'remote');
  state.machines[0].online = false;
  launched = null;
  picker = selector(view.render(view.exports.GroupAgentRow, props));
  await picker.props.onChange({ provider: 'shell', modelId: null, effort: null });
  assert.equal(launched, null);
  assert.ok(find(view.render(view.exports.GroupAgentRow, props), (node) => node.props?.children === 'Choose an online machine.'));
});

let groupA = { id: 'group-a', name: 'Project', machine_id: 'remote', work_dir: '/home/user/project' };
let derivedGroups = (overrides = {}, grouping = {}, query = '') => {
  let view = harness('../shared/src/components/JobListView/useJobListDerivedItems.ts', {
    '../../machines/client': { splitResource: () => null },
  });
  return view.exports.useJobListDerivedItems({
    data: { jobs: [], statuses: {}, detectedProcesses: [], shellPanes: [], savedGroups: [groupA], ...overrides },
    grouping: { collapsedGroups: new Set(), listMode: 'tabs', ...grouping },
    ordering: { sortMode: 'name', jobOrder: {}, processOrder: {} },
    filters: { query }, agent: { onRunAgent: () => {} },
  });
};

test('an empty saved group renders its name and machine-bound agent control', () => {
  let { items } = derivedGroups();
  assert.equal(items[0].displayGroup, 'Project');
  assert.equal(items[0].group, 'saved:group-a');
  assert.equal(items[1].kind, 'group-agent');
  assert.equal(items[1].machineId, 'remote');
  assert.equal(items[1].workDir, groupA.work_dir);
});

test('identical paths on different machines keep agents in separate groups', () => {
  let processes = ['remote', 'desktop'].map((machine_id) => ({ pane_id: machine_id, machine_id, cwd: groupA.work_dir + '/', provider: 'codex' }));
  let { items } = derivedGroups({ detectedProcesses: processes });
  let group = items.findIndex((item) => item.kind === 'header' && item.group === 'saved:group-a');
  assert.equal(items[group + 1].process.pane_id, 'remote');
  assert.equal(items[group + 2].kind, 'group-agent');
  assert.equal(items.filter((item) => item.kind === 'process').length, 2);
  assert.equal(items.find((item) => item.kind === 'process' && item.process.pane_id === 'desktop').process.machine_id, 'desktop');
});

test('saved groups respect collapse, hide, search, and latest mode', () => {
  let processes = [{ pane_id: 'p', machine_id: 'remote', cwd: groupA.work_dir, provider: 'codex', first_query: 'fix regression' }];
  assert.equal(derivedGroups({}, { collapsedGroups: new Set(['saved:group-a']) }).items.length, 1);
  assert.equal(derivedGroups({}, { hiddenGroups: new Set(['saved:group-a']), hiddenSectionCollapsed: true }).items[0].kind, 'hidden-section');
  assert.equal(derivedGroups({}, {}, 'missing').items.length, 0);
  assert.equal(derivedGroups({}, {}, 'project').items[0].displayGroup, 'Project');
  assert.equal(derivedGroups({ detectedProcesses: processes }, {}, 'regression').items[1].process.pane_id, 'p');
  assert.equal(derivedGroups({ detectedProcesses: processes }, { listMode: 'latest' }).items[0].process.pane_id, 'p');
});

let createGroupHarness = (fail = false) => {
  let saved = [], requests = [], listMode;
  let state = { selected: 'desktop', jobGroups: {}, machines: [{ id: 'desktop', online: false, owned: true }, { id: 'remote', online: true, owned: true }], snapshots: {} };
  let view = harness('../shared/src/components/JobListView/AddGroup.tsx', {
    '../../machines/client': { useMachines: () => state, newOperationId: () => 'new-group',
      machineHostRequest: async (machine, request) => { requests.push({ machine, request }); if (fail) throw new Error('Folder does not exist'); return { path: '/home/remote/project/' }; },
      saveAccountPreferences: async (api, body) => { saved.push(body); return api('POST', '/account/preferences', body); },
    },
    '../../machines/TargetPicker': { MachineTargetPicker: 'MachineTargetPicker' },
  });
  let hook = { groupPreferencesApi: async () => ({}), setSearchQuery: () => {}, onListModeChange: (value) => { listMode = value; }, collapsedGroups: new Set() };
  let render = () => view.render(view.exports.AddGroup, { hook });
  find(render(), (node) => node.type === 'Pressable').props.onPress();
  find(render(), (node) => node.props?.accessibilityLabel === 'Group name').props.onChangeText('Project');
  find(render(), (node) => node.props?.accessibilityLabel === 'Group folder').props.onChangeText('~/project');
  let create = () => find(render(), (node) => node.type === 'Pressable' && node.props.children.props?.children === 'Create group').props.onPress();
  return { render, create, state, saved, requests, listMode: () => listMode };
};

test('creating a group resolves the folder on an online remote while desktop is offline', async () => {
  let view = createGroupHarness();
  await view.create();
  assert.equal(view.requests[0].machine, 'remote');
  assert.equal(view.requests[0].request.path, '~/project');
  assert.equal(view.saved[0].job_group.machine_id, 'remote');
  assert.equal(view.saved[0].job_group.work_dir, '/home/remote/project');
  assert.equal(view.listMode(), 'tabs');
});

test('invalid remote folders do not save a group and leave the error visible', async () => {
  let view = createGroupHarness(true);
  await view.create();
  assert.equal(view.saved.length, 0);
  assert.ok(find(view.render(), (node) => node.props?.children === 'Folder does not exist'));
});
