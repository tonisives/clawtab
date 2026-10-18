const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('../desktop/node_modules/typescript');
const { createStore } = require('../remote/node_modules/zustand/vanilla');

let loadDemo = (entry, params = {}, os = 'ios') => {
  let states = [], cursor = 0, pushed = [], cache = {}, effects = [], writes = [], filterStore;
  let modules = {
    zustand: { create: (initializer) => {
      filterStore = createStore(initializer);
      return (selector) => selector(filterStore.getState());
    } },
    react: { useRef: (value) => ({ current: value }), useEffect: (effect) => effects.push(effect), useState: (initial) => { let index = cursor++; states[index] ??= typeof initial === 'function' ? initial() : initial; return [states[index], (value) => { states[index] = typeof value === 'function' ? value(states[index]) : value; }]; } },
    'react/jsx-runtime': { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) },
    'react-native': { Platform: { OS: os }, StyleSheet: { create: (value) => value }, Text: 'Text', View: 'View', Pressable: 'Pressable', TextInput: 'TextInput', KeyboardAvoidingView: 'KeyboardAvoidingView' },
    'expo-router/react-navigation': { useHeaderHeight: () => 96 },
    'react-native-safe-area-context': { SafeAreaView: 'SafeAreaView' },
    'expo-router': { useRouter: () => ({ push: (route) => pushed.push(route) }), useLocalSearchParams: () => params, Stack: { Screen: 'Screen' } },
    '@clawtab/shared': { JobListView: 'JobListView', XtermLog: 'XtermLog', JobKindIcon: 'JobKindIcon', kindForProcess: (process) => process.provider, colors: {} },
    '@expo/vector-icons': { Ionicons: 'Ionicons' },
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
      throw new Error(`Demo attempted to import a live dependency: ${name}`);
    } });
    return exports;
  };
  let component = entry === 'index.tsx' ? load(require.resolve('../remote/src/components/DemoJobList.tsx')).DemoJobList : load(require.resolve(entry === 'terminal' ? '../remote/app/demo-agent.tsx' : `../remote/app/demo/${entry}`)).default;
  return { pushed, writes, getFilter: () => filterStore.getState(), render: (props = {}) => {
    cursor = 0;
    let tree = component(props);
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
  let connected = false;
  let header = all(demo.render({ onConnect: () => { connected = true; } }).props.headerContent);
  assert.deepEqual(header.filter((node) => node.type === 'Text').map((node) => node.props.children), ['Demo', '·', 'Connect to relay']);
  header.find((node) => node.props?.accessibilityLabel === 'Connect to relay').props.onPress();
  assert.equal(connected, true);
  props.onSelectJob(props.jobs[0]);
  props.onSelectProcess(props.detectedProcesses[0]);
  assert.ok(demo.pushed.every((route) => route.pathname === '/demo-agent'));
  assert.equal(demo.pushed[0].params.kind, 'job');
  assert.equal(demo.pushed[1].params.kind, 'process');
  props.onToggleGroup('sample');
  assert.ok(demo.render().props.collapsedGroups.has('sample'));
});

test('demo job and agent details render output offline and disable action controls', () => {
  for (let params of [{ id: 'deploy-api', kind: 'job' }, { id: 'demo-pane-codex', kind: 'process' }]) {
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
  let demo = loadDemo('terminal', { id: 'demo-pane-codex', kind: 'process' });
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
  assert.equal(demo.pushed[0].params.id, 'demo-pane-codex');
});


test('the web demo uses the same compact list presentation as mobile', () => {
  for (let platform of ['web', 'ios']) {
    let { props } = loadDemo('index.tsx', {}, platform).render();
    assert.equal(props.compactMobileToolbar, true);
    assert.equal(props.mobileAppearance, true);
  }
});

test('each demo agent keeps an editable local prompt and model outside the shell buffer', () => {
  for (let id of ['demo-pane-claude', 'demo-pane-codex', 'demo-pane-opencode']) {
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
