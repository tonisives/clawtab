const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('../desktop/node_modules/typescript');

let harness = (entry, extras = {}) => {
  let states = [], cursor = 0, effects = [];
  let react = {
    useState: (initial) => { let index = cursor++; if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial; return [states[index], (value) => { states[index] = typeof value === 'function' ? value(states[index]) : value; }]; },
    useRef: (initial) => react.useState({ current: initial })[0],
    useEffect: (callback, deps) => { let index = cursor++; if (!states[index] || deps.some((value, position) => value !== states[index][position])) { states[index] = deps; effects.push(callback); } },
    createContext: (value) => { let context = { value }; context.Provider = { context }; return context; },
    useContext: (context) => context.value,
    Children: { toArray: (children) => [children].flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false) },
  };
  let element = (type, props) => ({ type, props });
  let modules = {
    react,
    'react/jsx-runtime': { jsx: element, jsxs: element, Fragment: 'Fragment' },
    'react-native': { Platform: { OS: 'ios' }, StyleSheet: { create: (value) => value, absoluteFill: { position: 'absolute' }, hairlineWidth: 0.5 }, ...Object.fromEntries(['View', 'Text', 'ScrollView', 'Pressable', 'Modal', 'Switch'].map((name) => [name, name])) },
    'react-native-safe-area-context': { SafeAreaProvider: 'SafeAreaProvider', SafeAreaView: 'SafeAreaView' },
    '@expo/vector-icons': { Ionicons: 'Ionicons' },
    'expo-glass-effect': { GlassView: 'GlassView', isGlassEffectAPIAvailable: () => true },
    '@clawtab/shared': { MachineNavigationProvider: 'MachineNavigationProvider', colors: {} },
    '../machines/Onboarding': Object.fromEntries(['MachineModal', 'MachineActionButton', 'MachineSettingsPageButton'].map((name) => [name, name])),
    '../machines/Terminal': { MachineTerminalControls: 'MachineTerminalControls' },
    '../machines/client': { resourceLabel: (value) => value.split('::').at(-1) },
    './AgentActionFormModal': { AgentActionFormModal: 'AgentActionFormModal' },
    ...extras,
  };
  let cache = {};
  let load = (file) => {
    if (cache[file]) return cache[file];
    let exports = {}; cache[file] = exports;
    let source = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    vm.runInNewContext(source, { exports, require: (name) => {
      if (name in modules) return modules[name];
      let next = path.resolve(path.dirname(file), name);
      return load(fs.existsSync(next + '.tsx') ? next + '.tsx' : next + '.ts');
    }, Date, Intl, Error });
    return exports;
  };
  let expand = (node) => {
    if (!node || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map(expand);
    if (node.type?.context) { node.type.context.value = node.props.value; return expand(node.props.children); }
    if (typeof node.type === 'function') return expand(node.type(node.props));
    // A page link carries a child view; it is rendered only after navigation.
    if (node.type === 'MachineSettingsPageButton') return node;
    return { ...node, props: { ...node.props, children: expand(node.props?.children) } };
  };
  let exports = load(path.resolve(__dirname, entry));
  let render = (component, props) => { cursor = 0; let tree = expand(component(props)); effects.splice(0).forEach((effect) => effect()); return tree; };
  return { exports, render, expand };
};
let find = (node, predicate) => {
  if (!node || typeof node !== 'object') return undefined;
  if (Array.isArray(node)) return node.map((item) => find(item, predicate)).find(Boolean);
  return predicate(node) ? node : find(node.props?.children, predicate);
};
let labelled = (tree, label) => find(tree, (node) => node.props?.accessibilityLabel === label || node.props?.label === label);

let action = (id, parameters = []) => ({ id, title: id, description: `${id} description`, available: true, parameters });
let details = () => {
  let calls = [];
  let view = harness('../shared/src/components/NativePaneOverview.tsx');
  let actions = { agentActions: [action('Run test'), action('Configure test', [{ name: 'model' }]), { ...action('Unavailable test'), available: false, unavailable_reason: 'No provider' }], onRunAgentAction: (...args) => calls.push(args), onToggleAutoYes: () => calls.push(['auto']), onTogglePin: () => calls.push(['pin']), onStop: () => calls.push(['stop']), onCancelAgentAction: () => calls.push(['cancel']) };
  let props = { visible: true, paneId: 'machine::%1', cwd: '/home/project', tmuxSession: 'project', windowName: 'agent', actions, onClose: () => calls.push(['close']) };
  let render = () => view.render(view.exports.NativePaneOverview, props);
  let child = () => view.expand(find(render(), (node) => node.type === 'MachineSettingsPageButton').props.children);
  return { ...view, calls, actions, props, render, child };
};

test('agent details groups toggles and moves plugin actions into a child page', () => {
  let view = details(), tree = view.render();
  assert.equal(labelled(tree, 'Run Run test'), undefined);
  assert.equal(find(tree, (node) => node.type === 'MachineSettingsPageButton').props.title, 'Agent actions');
  labelled(tree, 'Auto Yes').props.onValueChange();
  labelled(tree, 'Pin pane').props.onValueChange();
  labelled(tree, 'Stop session').props.onPress();
  assert.deepEqual(view.calls, [['auto'], ['pin'], ['stop']]);
  labelled(view.child(), 'Run Run test').props.onPress();
  assert.deepEqual(view.calls.at(-1), ['Run test']);
  assert.equal(labelled(view.child(), 'Run Unavailable test').props.disabled, true);
});

test('configured actions submit parameters and use the latest progress and callbacks', () => {
  let view = details();
  labelled(view.child(), 'Configure Configure test').props.onPress();
  let modal = view.render();
  assert.equal(modal.props.overlay.props.action.id, 'Configure test');
  modal.props.overlay.props.onSubmit({ model: 'chosen' });
  assert.equal(view.calls.at(-1)[0], 'Configure test');
  assert.equal(view.calls.at(-1)[1].model, 'chosen');
  assert.equal(view.render().props.overlay.props.visible, false);
  view.actions.agentActionRun = { state: 'running', progress: 'Updating', progressPercent: 25 };
  let child = view.child();
  assert.equal(labelled(child, 'Run Run test').props.disabled, true);
  labelled(child, 'Cancel').props.onPress();
  assert.deepEqual(view.calls.at(-1), ['cancel']);
  view.actions.agentActionRun = { state: 'completed', progress: 'Done', progressPercent: 100 };
  view.actions.onRunAgentAction = () => view.calls.push(['latest callback']);
  child = view.child();
  assert.equal(labelled(child, 'Run Run test').props.disabled, false);
  labelled(child, 'Run Run test').props.onPress();
  assert.deepEqual(view.calls.at(-1), ['latest callback']);
});

test('closing and reopening details clears action configuration', () => {
  let view = details();
  labelled(view.child(), 'Configure Configure test').props.onPress();
  view.render().props.onClose();
  assert.equal(view.render().props.overlay.props.visible, false);
  assert.deepEqual(view.calls.at(-1), ['close']);
  view.props.visible = false;
  assert.equal(view.render(), null);
  view.props.visible = true;
  assert.equal(view.render().props.overlay.props.visible, false);
});

test('machine sheets use native push navigation with swipe back and preserve the root form', () => {
  let closed = 0, pushed = [];
  let view = harness('../remote/src/components/MachineNavigationModal.tsx', {
    'expo-router/react-navigation': { NavigationIndependentTree: 'NavigationIndependentTree', NavigationContainer: 'NavigationContainer', DarkTheme: {} },
    'expo-router/build/react-navigation/native-stack': { createNativeStackNavigator: () => ({ Navigator: 'NativeNavigator', Screen: 'NativeScreen' }) },
  });
  let props = { title: 'Add group / machine', children: { type: 'GroupForm', props: { version: 1 } }, overlay: { type: 'Overlay', props: {} }, onClose: () => closed++ };
  let render = () => view.render(view.exports.MachineNavigationModal, props);
  let tree = render();
  assert.equal(tree.type, 'Modal');
  let navigator = find(tree, (node) => node.type === 'NativeNavigator');
  assert.equal(navigator.props.screenOptions.animation, 'slide_from_right');
  assert.equal(navigator.props.screenOptions.gestureEnabled, true);
  let screen = find(tree, (node) => node.type === 'NativeScreen');
  let page = (route) => view.expand(screen.props.children({ navigation: { push: (...args) => pushed.push(args) }, route: { params: route } }));
  let root = page(screen.props.initialParams);
  assert.equal(find(root, (node) => node.type === 'GroupForm').props.version, 1);
  find(root, (node) => node.type === 'MachineNavigationProvider').props.value.push({ title: 'Add machine', content: { type: 'MachineForm', props: {} } });
  assert.equal(pushed[0][0], 'page');
  assert.equal(pushed[0][1].title, 'Add machine');
  assert.ok(find(page(pushed[0][1]), (node) => node.type === 'MachineForm'));
  assert.ok(find(tree, (node) => node.type === 'Overlay'));
  props.children = { type: 'GroupForm', props: { version: 2 } };
  screen = find(render(), (node) => node.type === 'NativeScreen');
  assert.equal(find(page(screen.props.initialParams), (node) => node.type === 'GroupForm').props.version, 2);
  labelled(view.expand(navigator.props.screenOptions.headerRight()), 'Close add group / machine').props.onPress();
  assert.equal(closed, 1);
  render().props.onRequestClose();
  assert.equal(closed, 2);
});
