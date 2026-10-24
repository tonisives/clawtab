const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('../desktop/node_modules/typescript');
const { createStore } = require('../remote/node_modules/zustand/vanilla');

let loadDemo = (entry, params = {}, os = 'ios', progress = {}) => {
  let states = [], cursor = 0, pushed = [], cache = {}, effects = [], writes = [], filterStore;
  let modules = {
    '../hooks/useSetupProgress': { useSetupProgress: () => ({ relayComplete: false, machineComplete: false, complete: false, ...progress }) },
    zustand: { create: (initializer) => {
      filterStore = createStore(initializer);
      return (selector) => selector(filterStore.getState());
    } },
    react: { useRef: (value) => ({ current: value }), useEffect: (effect) => effects.push(effect), useState: (initial) => { let index = cursor++; states[index] ??= typeof initial === 'function' ? initial() : initial; return [states[index], (value) => { states[index] = typeof value === 'function' ? value(states[index]) : value; }]; } },
    'react/jsx-runtime': { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) },
    'react-native': { Platform: { OS: os }, StyleSheet: { create: (value) => value }, Text: 'Text', View: 'View', Pressable: 'Pressable', TextInput: 'TextInput', ScrollView: 'ScrollView', KeyboardAvoidingView: 'KeyboardAvoidingView' },
    'expo-router/react-navigation': { useHeaderHeight: () => 96 },
    'react-native-safe-area-context': { SafeAreaView: 'SafeAreaView' },
    'expo-router': { useRouter: () => ({ push: (route) => pushed.push(route) }), useLocalSearchParams: () => params, Stack: { Screen: 'Screen' } },
    '@clawtab/shared': { JobListView: 'JobListView', XtermLog: 'XtermLog', JobKindIcon: 'JobKindIcon', kindForProcess: (process) => process.provider, colors: {} },
    '@expo/vector-icons': { Ionicons: 'Ionicons' },
    '../hooks/useResponsive': { useResponsive: () => ({ isSplitView: true }) },
    './DemoJobList': { DemoJobList: 'DemoJobList' },
    './DemoAgentPane': { DemoAgentPane: 'DemoAgentPane' },
    './DemoOverview': { DemoOverview: 'DemoOverview' },
    './settings/SettingsPage': { SettingsPage: 'SettingsPage' },
    '../../../shared/src/machines/Onboarding': { MachineModal: 'MachineModal' },
    '../src/components/HeaderButtons': { HeaderTitleWithIcon: 'HeaderTitleWithIcon' },
    '../../../shared/src/components/InsetList': { InsetList: 'InsetList', InsetListRow: 'InsetListRow' },
    '../../src/components/settings/SettingsPage': { SettingsPage: 'SettingsPage' },
  };
  let load = (file) => {
    if (cache[file]) return cache[file];
    let exports = {}; cache[file] = exports;
    let source = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    vm.runInNewContext(source, { exports, require: (name) => {
      if (name in modules) return modules[name];
      if (name.endsWith('/demo/data') || name.endsWith('/demo/shell') || name.endsWith('/demo/info') || name.endsWith('/store/jobFilter')) return load(path.resolve(path.dirname(file), `${name}.ts`));
      if (name.endsWith('/DemoDetailsContent')) return load(path.resolve(path.dirname(file), `${name}.tsx`));
      throw new Error(`Demo attempted to import a live dependency: ${name}`);
    } });
    return exports;
  };
  let processes = load(require.resolve('../remote/src/demo/data.ts')).DEMO_PROCESSES;
  if (params.kind === 'process') params.id = processes.find((process) => process.provider === params.id)?.pane_id ?? params.id;
  let component = entry === 'overview' ? load(require.resolve('../remote/src/components/DemoOverview.tsx')).DemoOverview : entry === 'workspace' ? load(require.resolve('../remote/src/components/DemoWorkspace.tsx')).DemoWorkspace : entry === 'index.tsx' ? load(require.resolve('../remote/src/components/DemoJobList.tsx')).DemoJobList : load(require.resolve(entry === 'terminal' ? '../remote/app/demo-agent.tsx' : `../remote/app/demo/${entry}`)).default;
  return { pushed, writes, processes, getFilter: () => filterStore.getState(), render: (props = {}) => {
    cursor = 0;
    let tree = component(props);
    if (typeof tree.type === "function") tree = tree.type(tree.props);
    for (let node of all(tree)) if (node.type === 'XtermLog') node.props.ref.current = { clear: () => writes.push('clear'), writeText: (text) => writes.push(text) };
    effects.splice(0).forEach((effect) => effect());
    return tree;
  } };
};
let all = (node) => Array.isArray(node) ? node.flatMap(all) : node && typeof node === 'object' ? [node, ...all(node.props?.children)] : [];

test('demo list has isolated sample groups and no live mutation callbacks', () => {
  let demo = loadDemo('index.tsx');
  let { props } = demo.render();
  assert.ok(props.jobs.length > 0 && props.detectedProcesses.length > 0);
  assert.equal(props.savedGroups.length, 0);
  for (let callback of ['onRunAgent', 'onStopJob', 'onStopProcess', 'groupPreferencesApi', 'onSaveProcessName', 'onTogglePin']) assert.equal(props[callback], undefined);
  let header = all(demo.render().props.headerContent);
  assert.deepEqual(header.filter((node) => node.type === 'Text').map((node) => node.props.children), ['Demo']);
  assert.equal(header.find((node) => node.props?.accessibilityLabel === 'Connect to relay'), undefined);
  props.onSelectJob(props.jobs[0]);
  props.onSelectProcess(props.detectedProcesses[0]);
  assert.ok(demo.pushed.every((route) => route.pathname === '/demo-agent'));
  assert.equal(demo.pushed[0].params.kind, 'job');
  assert.equal(demo.pushed[1].params.kind, 'process');
  props.onToggleGroup('sample');
  assert.ok(demo.render().props.collapsedGroups.has('sample'));
});

test('demo job and agent details render output offline and disable action controls', () => {
  for (let params of [{ id: 'deploy-api', kind: 'job' }, { id: 'codex', kind: 'process' }]) {
    let nodes = all(loadDemo('[id].tsx', params).render());
    assert.ok(nodes.some((node) => node.type === 'Text' && node.props.children === 'Output'));
    let action = nodes.find((node) => node.type === 'InsetListRow' && node.props.title === 'Agent actions');
    assert.equal(action.props.disabled, true);
    assert.ok(nodes.some((node) => node.type === 'Text' && typeof node.props.children === 'string' && node.props.children.length > 100));
  }
});

test('demo lists follow mobile search input and clear across every list mode', () => {
  for (let platform of ['ios', 'web']) {
    let demo = loadDemo('index.tsx', {}, platform);
    assert.equal(demo.render().props.searchQuery, '');
    demo.getFilter().openSearch();
    for (let mode of ['tabs', 'jobs', 'latest']) {
      demo.render().props.onListModeChange(mode);
      demo.getFilter().setQuery('codex');
      assert.equal(demo.render().props.searchQuery, 'codex');
      demo.getFilter().closeSearch();
      assert.equal(demo.render().props.searchQuery, 'codex');
      demo.render().props.onSearchQueryChange('deploy');
      assert.equal(demo.getFilter().query, 'deploy');
      demo.getFilter().clear();
      assert.equal(demo.render().props.searchQuery, '');
    }
  }
});


test('demo agents open a read-only shell terminal with a native header menu', () => {
  let demo = loadDemo('terminal', { id: 'codex', kind: 'process' });
  let nodes = all(demo.render());
  let terminal = nodes.find((node) => node.type === 'XtermLog');
  assert.equal(terminal.props.interactive, false);
  assert.equal(terminal.props.onData, undefined);
  assert.equal(demo.writes[0], 'clear');
  assert.ok(demo.writes[1].length > 100);
  let screen = nodes.find((node) => node.type === 'Screen');
  let menu = screen.props.options.headerRight();
  assert.equal(menu.props.accessibilityLabel, 'Open pane overview');
  menu.props.onPress();
  assert.equal(demo.pushed[0].pathname, '/demo-agent-details');
  assert.equal(demo.pushed[0].params.id, demo.processes.find((process) => process.provider === 'codex').pane_id);
});


test('the web demo uses the same compact list presentation as mobile', () => {
  for (let platform of ['web', 'ios']) {
    let { props } = loadDemo('index.tsx', {}, platform).render();
    assert.equal(props.compactMobileToolbar, true);
    assert.equal(props.mobileAppearance, true);
  }
});

test('each demo agent keeps an editable local prompt and model outside the shell buffer', () => {
  for (let id of ['claude', 'codex', 'opencode']) {
    let demo = loadDemo('terminal', { id, kind: 'process' });
    let nodes = all(demo.render());
    let prompt = nodes.find((node) => node.type === 'TextInput');
    assert.equal(prompt.props.accessibilityLabel, 'Demo prompt');
    prompt.props.onChangeText('Try the keyboard');
    assert.equal(all(demo.render()).find((node) => node.type === 'TextInput').props.value, 'Try the keyboard');
    let footer = nodes.find((node) => node.type === 'SafeAreaView');
    assert.ok(all(footer).some((node) => node.type === 'Text' && typeof node.props.children === 'string' && node.props.children.length));
    assert.ok(all(footer).some((node) => node.props?.accessibilityLabel === 'Show keyboard'));
    assert.ok(!demo.writes[1].includes('────────────────'));
    assert.ok(!demo.writes[1].includes('▀▀▀▀'));
    assert.equal(nodes.find((node) => node.type === 'XtermLog').props.extendedViewport, true);
    assert.equal(nodes[0].props.keyboardVerticalOffset, 96);
  }
});

test('wide web demo keeps sample selection beside the sidebar without routing away', () => {
  let demo = loadDemo('workspace', {}, 'web');
  let nodes = all(demo.render());
  let list = nodes.find((node) => node.type === 'DemoJobList');
  assert.ok(nodes.some((node) => node.type === 'DemoOverview'));
  assert.equal(list.props.selectedSlug, undefined);
  let pane;
  let paneId = demo.processes.find((process) => process.provider === 'codex').pane_id;
  list.props.onSelectProcess({ pane_id: paneId });
  nodes = all(demo.render());
  pane = nodes.find((node) => node.type === 'DemoAgentPane');
  assert.equal(pane.props.id, paneId);
  assert.equal(pane.props.kind, 'process');
  nodes.find((node) => node.type === 'DemoJobList').props.onSelectJob({ slug: 'deploy-api' });
  pane = all(demo.render()).find((node) => node.type === 'DemoAgentPane');
  assert.equal(pane.props.id, 'deploy-api');
  assert.equal(pane.props.kind, 'job');
  nodes = all(demo.render());
  nodes.find((node) => node.type === 'DemoJobList').props.onShowOverview();
  nodes = all(demo.render());
  assert.ok(nodes.some((node) => node.type === 'DemoOverview'));
  assert.equal(nodes.find((node) => node.type === 'DemoJobList').props.selectedSlug, undefined);
  assert.deepEqual(demo.pushed, []);
});
test('native demo keeps navigation to sample detail screens', () => {
  let tree = loadDemo('workspace', {}, 'ios').render();
  assert.equal(tree.type, 'DemoJobList');
  assert.equal(tree.props.onSelectJob, undefined);
});

test('demo overview explains relay, host setup, and launches, with setup links', () => {
  let connected = false;
  let demo = loadDemo('overview', {}, 'web');
  let nodes = all(demo.render({ onConnect: () => { connected = true; } }));
  let press = (label) => nodes.find((node) => node.type === 'Pressable' && all(node).some((child) => child.type === 'Text' && child.props.children === label)).props.onPress();
  let text = nodes.filter((node) => node.type === 'Text').map((node) => node.props.children).join('\n');
  for (let phrase of ['sample agents', 'Set up relay access', 'Connect a desktop or server', 'cwtctl setup', 'Launch agents from any device', 'where its CLI is installed']) assert.ok(text.includes(phrase), phrase);
  press('Choose a box');
  assert.equal(demo.pushed[0], '/add-machine');
  press('Add machine');
  assert.equal(demo.pushed[1], '/add-machine');
  press('Set up relay');
  assert.equal(connected, true);
});

test('sample navigation survives native URL decoding and a fresh module load', () => {
  let list = loadDemo('index.tsx');
  let props = list.render().props;
  assert.deepEqual(Array.from(props.detectedProcesses, (process) => process.pane_label), ['%1', '%2', '%3']);
  for (let sample of props.detectedProcesses) props.onSelectProcess(sample);
  for (let sample of props.jobs) props.onSelectJob(sample);
  for (let route of list.pushed) {
    let params = Object.fromEntries(Object.entries(route.params).map(([key, value]) => [key, decodeURIComponent(value)]));
    let terminal = loadDemo('terminal', params);
    let nodes = all(terminal.render());
    assert.notEqual(nodes.find((node) => node.type === 'Screen').props.options.title, 'Sample agent');
    assert.ok(terminal.writes[1].length > 0, route.params.id);
    assert.ok(!terminal.writes[1].includes('Sample not found'));
    let details = all(loadDemo('[id].tsx', params).render());
    assert.ok(details.some((node) => node.type === 'Text' && node.props.children === 'Output'));
  }
});

test('setup checklist reflects relay and paired machine completion', () => {
  for (let progress of [
    { relayComplete: false, machineComplete: false },
    { relayComplete: true, machineComplete: false },
    { relayComplete: true, machineComplete: true, complete: true },
  ]) {
    let nodes = all(loadDemo('overview', {}, 'ios', progress).render({ onConnect: () => {} }));
    assert.equal(nodes.some((node) => node.props?.accessibilityLabel === 'Relay access complete'), progress.relayComplete);
    assert.equal(nodes.some((node) => node.props?.accessibilityLabel === 'Machine setup complete'), progress.machineComplete);
  }
});

test('native sample list lets the root scroll view adjust below the large title and tabs', () => {
  for (let platform of ['ios', 'android', 'web']) {
    let props = loadDemo('index.tsx', {}, platform).render().props;
    assert.equal(props.contentInsetAdjustmentBehavior, platform === 'web' ? 'never' : 'automatic');
    assert.equal(props.renderAsScrollRoot, platform !== 'web');
  }
});

test('mobile Demo info buttons open the onboarding screen from list, terminal, and details', () => {
  for (let entry of ['index.tsx', 'terminal', '[id].tsx']) {
    let demo = loadDemo(entry, { id: 'claude', kind: 'process' });
    let tree = demo.render();
    let nodes = all(entry === 'index.tsx' ? tree.props.headerContent : tree);
    nodes.find((node) => node.props?.accessibilityLabel === 'About demo mode').props.onPress();
    assert.equal(demo.pushed[0], '/demo-overview');
  }
});

test('web Demo info returns the main pane to onboarding', () => {
  let demo = loadDemo('workspace', {}, 'web');
  all(demo.render()).find((node) => node.type === 'DemoJobList').props.onSelectProcess(demo.processes[0]);
  all(demo.render()).find((node) => node.type === 'DemoAgentPane').props.onShowOverview();
  assert.ok(all(demo.render()).some((node) => node.type === 'DemoOverview'));
  assert.deepEqual(demo.pushed, []);
});
