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
    createContext: (value) => ({ value }),
    useContext: (context) => context.value,
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
let machineMock = (state) => ({ '../machines/client': {
  useMachines: () => state, selectMachine: (id) => { state.selected = id; },
  machineHostRequest: async (_machine, request) => ({ path: request.path === '~' ? '/home/user' : request.path }),
} });
let targetPicker = (picker) => find(picker.props.machinePicker, (node) => typeof node.props?.onSelect === 'function');

test('mobile defaults to an online owned machine and uses its enabled models', async () => {
  let state = { selected: null, machines: [{ id: 'a', name: 'Desktop A', owned: true, online: true }], snapshots: { a: { settings_response: { enabled_models: { claude: ['opus'], codex: [], opencode: [], antigravity: [] } } } } };
  let launched;
  let view = harness('../shared/src/components/GroupAgentRow.tsx', machineMock(state));
  let picker = selector(view.render(view.exports.GroupAgentRow, { onRunAgent: (...args) => { launched = { target: state.selected, args }; } }));
  assert.equal(targetPicker(picker).props.target, 'a');
  assert.ok(picker.props.modelOptions.some((model) => model.modelId === 'opus'));
  assert.ok(picker.props.modelOptions.every((model) => model.provider === 'claude'));
  await picker.props.onChange({ provider: 'claude', modelId: 'opus', effort: 'high' });
  assert.equal(launched.target, 'a');
  assert.deepEqual(launched.args, ['', 'claude', 'opus', 'high', '/home/user', '~']);
});

test('target changes refresh models and launch errors are visible', async () => {
  let state = { selected: 'a', machines: ['a', 'b'].map((id) => ({ id, name: id, owned: true, online: true })), snapshots: { b: { settings_response: { enabled_models: { claude: [], codex: ['gpt-test'], opencode: [], antigravity: [] } } } } };
  let view = harness('../shared/src/components/GroupAgentRow.tsx', machineMock(state));
  let props = { onRunAgent: async () => { throw new Error('Working directory missing'); } };
  let picker = selector(view.render(view.exports.GroupAgentRow, props));
  assert.equal(picker.props.modelOptions.length, 0);
  targetPicker(picker).props.onSelect('b');
  picker = selector(view.render(view.exports.GroupAgentRow, props));
  assert.ok(picker.props.modelOptions.some((model) => model.modelId === 'gpt-test'));
  await picker.props.onChange({ provider: 'codex', modelId: 'gpt-test', effort: 'high' });
  assert.ok(find(view.render(view.exports.GroupAgentRow, props), (node) => node.props?.children === 'Working directory missing'));
});

test('desktop defaults locally without a relay connection', async () => {
  let state = { selected: null, machines: [], snapshots: {} }, called = false;
  let view = harness('../shared/src/components/GroupAgentRow.tsx', machineMock(state));
  let picker = selector(view.render(view.exports.GroupAgentRow, { localMachineId: null, localHostRequest: async () => ({ path: '/home/user' }), modelOptions: [{ provider: 'codex', modelId: 'local-model' }], onRunAgent: () => { called = true; } }));
  assert.equal(targetPicker(picker).props.localMachineId, null);
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
  assert.equal(typeof popup.props.onBack, 'function');
  assert.equal(popup.props.items.some((item) => item.label === 'Back to models'), false);
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
  let firstModels = Array.from(render().props.modelOptions, (option) => option.modelId);
  assert.ok(firstModels.includes('my-custom-model'));
  assert.equal(firstModels.includes('old-default'), false);
  targetPicker(render()).props.onSelect('b');
  assert.deepEqual(Array.from(render().props.modelOptions, (option) => option.modelId), firstModels);
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

test('Home combines machines and orders agents by latest activity above project groups', () => {
  let homeGroups = ['desktop', 'remote'].map((machine_id) => ({
    id: `home-${machine_id}`, name: 'Home', machine_id, work_dir: `/${machine_id}/home`,
  }));
  let processes = [
    { pane_id: 'local-older', machine_id: 'desktop', cwd: '/desktop/home', provider: 'codex', _last_activity: 10 },
    { pane_id: 'remote-newest', machine_id: 'remote', cwd: '/remote/home', provider: 'codex', _last_activity: 30 },
    { pane_id: 'local-newer', machine_id: 'desktop', cwd: '/desktop/home', provider: 'codex', _last_activity: 20 },
  ];
  let { items } = derivedGroups({ savedGroups: [{ ...groupA, name: 'A Project' }, ...homeGroups], detectedProcesses: processes });
  assert.equal(items[0].displayGroup, 'Home');
  assert.equal(items.filter((item) => item.kind === 'header' && item.displayGroup === 'Home').length, 1);
  assert.deepEqual(Array.from(items.filter((item) => item.kind === 'process'), (item) => item.process.pane_id),
    ['remote-newest', 'local-newer', 'local-older']);
  let add = items.find((item) => item.kind === 'group-agent');
  assert.equal(add.workDir, '~');
  assert.equal(add.machineId, undefined);
  assert.equal(derivedGroups({ savedGroups: homeGroups, detectedProcesses: processes },
    { collapsedGroups: new Set(['__home']) }).items.length, 1);
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
  find(render(), (node) => node.props?.label === 'Add group / machine').props.onPress();
  find(render(), (node) => node.props?.accessibilityLabel === 'Group name').props.onChangeText('Project');
  find(render(), (node) => node.props?.accessibilityLabel === 'Group folder').props.onChangeText('~/project');
  let create = () => find(render(), (node) => node.props?.label === 'Create group').props.onPress();
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


test('detected new models join saved choices, use detected labels, and respect removals', () => {
  let { exports: models } = harness('../shared/src/util/agentModels.ts');
  let catalog = { codex: [['gpt-6.1-sol', 'GPT-6.1 Sol'], ['gpt-6-astra', 'GPT-6 Astra'], ['codex-high', 'Old display label']] };
  let enabled = { codex: ['gpt-6-astra', 'custom-model'], claude: [] };
  let options = models.buildModelOptions(['codex', 'claude'], enabled, catalog);
  assert.deepEqual(Array.from(options, (option) => option.modelId), ['gpt-6.1-sol', 'gpt-6-astra', 'custom-model']);
  assert.equal(options[0].label, 'GPT-6.1 Sol');
  options = models.buildModelOptions(['codex', 'claude'], enabled, catalog, { codex: ['gpt-6.1-sol'] });
  assert.deepEqual(Array.from(options, (option) => option.modelId), ['gpt-6-astra', 'custom-model']);
  assert.equal(models.buildModelOptions(['codex'], { codex: [] }, catalog).length, 0);
});

test('OpenCode catalogs stay opt-in while their models remain available to manage', () => {
  let { exports: models } = harness('../shared/src/util/agentModels.ts');
  let catalog = { opencode: [['provider/new', 'New'], ['provider/selected', 'Selected']] };
  assert.equal(models.buildModelOptions(['opencode'], {}, catalog)[0].modelId, null);
  assert.deepEqual(Array.from(models.buildModelOptions(['opencode'], { opencode: ['provider/selected'] }, catalog), (option) => option.modelId), ['provider/selected']);
});

test('remote plus menus refresh their target catalog and carry an inline editor', () => {
  let state = { selected: 'a', machines: [{ id: 'a', online: true, owned: true }], snapshots: { a: { settings_response: { enabled_models: { codex: ['gpt-old'], claude: [], opencode: [], antigravity: [] }, detected_models: { codex: [['gpt-6.1-sol', 'GPT-6.1 Sol']] } } } } };
  let requests = [], launched = false;
  let mock = machineMock(state);
  mock['../machines/client'].machineRequest = async (target, message) => requests.push({ target, message });
  let view = harness('../shared/src/components/GroupAgentRow.tsx', mock);
  let props = { modelOptions: [{ provider: 'codex', modelId: 'gpt-old', label: 'Old' }], onRunAgent: () => { launched = true; } };
  let picker = selector(view.render(view.exports.GroupAgentRow, props));
  assert.ok(picker.props.modelOptions.some((model) => model.modelId === 'gpt-6.1-sol'));
  picker.props.onOpen();
  assert.equal(requests[0].target, 'a');
  assert.equal(requests[0].message.type, 'get_settings');
  assert.equal(picker.props.modelEditor.props.machineId, 'a');
  assert.equal(picker.props.modelEditor.props.compact, true);
  assert.equal(launched, false);
});

test('Edit models stays in the plus popup and returns to model choices without launching', () => {
  let selected = false;
  let view = harness('../shared/src/components/AgentSelector.tsx');
  let editor = { type: 'ModelManager' }, footer = { type: 'MachineTargetPicker' };
  let props = { mode: 'plus', modelOptions: [], modelEditor: editor, machinePicker: footer, onChange: () => { selected = true; } };
  let render = () => view.render(view.exports.AgentSelector, props);
  find(render(), (node) => node.type === 'TouchableOpacity').props.onPress({});
  let popup = find(render(), (node) => Array.isArray(node.props?.items));
  assert.equal(popup.props.items.some((item) => item.label === 'Edit models'), false);
  assert.equal(popup.props.headerAction.props.accessibilityLabel, 'Edit models');
  popup.props.headerAction.props.onPress();
  popup = find(render(), (node) => Array.isArray(node.props?.items));
  assert.equal(popup.props.title, 'Edit models');
  assert.equal(popup.props.content, editor);
  assert.equal(popup.props.footer, undefined);
  assert.equal(selected, false);
  popup.props.onBack();
  popup = find(render(), (node) => Array.isArray(node.props?.items));
  assert.equal(popup.props.title, 'Add agent');
  assert.equal(popup.props.content, undefined);
  assert.equal(popup.props.footer, footer);
  assert.equal(popup.props.headerAction.props.accessibilityLabel, 'Edit models');
});

test('older host model choices include sol 6.1 and still respect explicit removals', () => {
  let { exports: models } = harness('../shared/src/util/agentModels.ts');
  let enabled = { codex: ['gpt-5.6-sol'] };
  let catalog = models.hostModelCatalog({ enabled_models: enabled });
  assert.ok(models.buildModelOptions(['codex'], enabled, catalog).some((option) => option.modelId === 'gpt-6.1-sol'));
  assert.equal(models.buildModelOptions(['codex'], enabled, catalog, { codex: ['gpt-6.1-sol'] }).some((option) => option.modelId === 'gpt-6.1-sol'), false);
  assert.equal(models.buildModelOptions(['codex'], { codex: [] }).length, 0);
  let live = models.hostModelCatalog({ detected_models: { codex: [['future-release', 'Future']] } });
  assert.deepEqual(Array.from(models.buildModelOptions(['codex'], enabled, live), (option) => option.modelId), ['future-release', 'gpt-5.6-sol']);
  assert.equal(Object.keys(models.hostModelCatalog()).length, 0);
  assert.equal(Object.keys(models.hostModelCatalog({ detected_models: {} })).length, 0);
});

test('a remote plus menu includes sol 6.1 when its older host has not loaded detection yet', () => {
  let state = { selected: 'a', machines: [{ id: 'a', online: true, owned: true }], snapshots: { a: { settings_response: { enabled_models: { codex: ['gpt-5.6-sol'], claude: [], opencode: [], antigravity: [] } } } } };
  let view = harness('../shared/src/components/GroupAgentRow.tsx', machineMock(state));
  let picker = selector(view.render(view.exports.GroupAgentRow, { onRunAgent: () => {} }));
  assert.ok(picker.props.modelOptions.some((option) => option.modelId === 'gpt-6.1-sol'));
});

let managerFixture = () => {
  let state = { selected: 'a', machines: [{ id: 'a', online: true, owned: true }],
    agentModels: { enabled_models: { codex: ['gpt-old'], claude: ['claude-custom'] }, default_provider: 'codex', default_model: 'gpt-6.1-sol' },
    snapshots: { a: { settings_response: { detected_models: { codex: [['gpt-6.1-sol', 'GPT-6.1 Sol'], ['gpt-old', 'Old']] } } } } };
  let saves = [], refreshes = [], fail = false;
  let view = harness('../shared/src/machines/Models.tsx', { './client': {
    useMachines: () => state,
    machineErrorMessage: (error) => error.message,
    saveAgentModelPreferences: async (preferences) => {
      if (fail) throw new Error('Network unavailable');
      saves.push(preferences); state.agentModels = preferences;
    },
    machineRequest: async (target, message) => refreshes.push({ target, message }),
  } });
  let render = () => view.render(view.exports.ModelManager, { machineId: 'a' });
  let row = (id) => find(render(), (node) => node.props?.id === id && typeof node.props?.onToggle === 'function');
  return { state, saves, refreshes, render, row, fail: () => { fail = true; } };
};

test('model removal survives catalog refresh, clears its default, and can be reversed', async () => {
  let manager = managerFixture();
  assert.equal(manager.row('gpt-6.1-sol').props.enabled, true);
  manager.row('gpt-6.1-sol').props.onToggle('gpt-6.1-sol', false);
  await new Promise(setImmediate);
  assert.equal(manager.state.agentModels.default_model, null);
  assert.deepEqual(Array.from(manager.state.agentModels.disabled_models.codex), ['gpt-6.1-sol']);
  assert.deepEqual(Array.from(manager.state.agentModels.enabled_models.claude), ['claude-custom']);
  find(manager.render(), (node) => node.type === 'Pressable' && node.props?.children?.props?.children === 'Refresh detected models').props.onPress();
  await new Promise(setImmediate);
  assert.equal(manager.refreshes[0].target, 'a');
  assert.equal(manager.refreshes[0].message.refresh_models, true);
  assert.equal(manager.row('gpt-6.1-sol').props.enabled, false);
  manager.row('gpt-6.1-sol').props.onToggle('gpt-6.1-sol', true);
  await new Promise(setImmediate);
  assert.equal(manager.row('gpt-6.1-sol').props.enabled, true);
  assert.equal(manager.state.agentModels.disabled_models.codex.length, 0);
});

test('custom additions are trimmed and deduplicated, and defaults can be changed', async () => {
  let manager = managerFixture();
  find(manager.render(), (node) => node.props?.accessibilityLabel === 'Custom model identifier').props.onChangeText('  custom/new-model  ');
  find(manager.render(), (node) => node.props?.accessibilityLabel === 'Add custom model').props.onPress();
  await new Promise(setImmediate);
  assert.equal(manager.row('custom/new-model').props.enabled, true);
  manager.row('custom/new-model').props.onDefault('custom/new-model');
  await new Promise(setImmediate);
  assert.equal(manager.state.agentModels.default_model, 'custom/new-model');
  find(manager.render(), (node) => node.props?.accessibilityLabel === 'Custom model identifier').props.onChangeText('custom/new-model');
  find(manager.render(), (node) => node.props?.accessibilityLabel === 'Add custom model').props.onPress();
  await new Promise(setImmediate);
  assert.equal(manager.state.agentModels.enabled_models.codex.filter((id) => id === 'custom/new-model').length, 1);
});

test('failed saves keep the confirmed model selection and surface an error', async () => {
  let manager = managerFixture();
  manager.fail();
  manager.row('gpt-6.1-sol').props.onToggle('gpt-6.1-sol', false);
  await new Promise(setImmediate);
  assert.equal(manager.row('gpt-6.1-sol').props.enabled, true);
  assert.ok(find(manager.render(), (node) => node.props?.children === 'Network unavailable'));
});


test('picker labels distinguish releases of the same model family', () => {
  let { exports: labels } = harness('../shared/src/util/agent.ts');
  assert.equal(labels.modelPickerLabel('gpt-6.1-sol', 'GPT-6.1 Sol'), 'sol 6.1');
  assert.equal(labels.modelPickerLabel('gpt-6-sol', 'GPT-6 Sol'), 'sol 6');
});

for (let workDir of [undefined, '/home/user/project']) {
  test(`plus launch uses ${workDir ?? 'home'} without a folder input`, async () => {
    let state = { selected: 'a', machines: [{ id: 'a', owned: true, online: true }], snapshots: {} };
    let launched;
    let view = harness('../shared/src/components/GroupAgentRow.tsx', machineMock(state));
    let picker = selector(view.render(view.exports.GroupAgentRow, { workDir, sourceMachineId: 'a', targetMachineId: workDir ? 'a' : undefined, onRunAgent: (...args) => { launched = args; } }));
    assert.equal(find(picker.props.machinePicker, (node) => node.type === 'TextInput'), undefined);
    await picker.props.onChange({ provider: 'shell', modelId: null, effort: null });
    assert.equal(launched[4], workDir ?? '/home/user');
    assert.equal(launched[5], workDir ?? '~');
  });
}
