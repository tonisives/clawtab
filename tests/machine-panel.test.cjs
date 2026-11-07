const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('../desktop/node_modules/typescript');
const nodes = node => !node ? [] : Array.isArray(node) ? node.flatMap(nodes) : typeof node === 'object' ? [node, ...nodes(node.props?.children)] : [];
const text = node => !node ? '' : Array.isArray(node) ? node.map(text).join(' ') : typeof node === 'object' ? text(node.props?.children) : String(node);
const harness = () => {
  let values = [], cursor = 0, effects = [];
  let machine = { id: 'included', name: 'ClawTab', hosted: {}, online: true, owned: true, capabilities: ['host_management'] };
  let state = { machines: [machine], selected: null, snapshots: {}, connected: true, machineAppearance: {} };
  let requests = [];
  let react = {
    useState(initial) { let id = cursor++; if (!(id in values)) values[id] = initial; return [values[id], value => { values[id] = value; }]; },
    useRef(initial) { return react.useState({ current: initial })[0]; },
    useEffect(effect, deps) { let id = cursor++; if (!(id in values) || deps.some((value, i) => value !== values[id][i])) { values[id] = deps; effects.push(effect); } },
  };
  let modules = {
    react,
    'react/jsx-runtime': { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) },
    'react-native': { Platform: { OS: 'web' }, StyleSheet: { create: v => v }, ...Object.fromEntries(['View', 'Text', 'Pressable', 'TextInput', 'ScrollView'].map(v => [v, v])) },
    './HostedWorkspace': { HostedWorkspacePanel: 'HostedWorkspacePanel' }, './Onboarding': {}, './Models': {},
    '../components/AgentSelector': { AgentSelector: 'AgentSelector' },
    '../util/agentModels': { hostModelCatalog: () => ({}), resolveEnabledModels: () => ({ codex: ['model-a', 'model-b'] }) },
    './Connect': {}, '../theme/colors': { colors: {} },
    '../components/SegmentedControl': { SegmentedControl: 'Tabs' },
    './Appearance': { machineAppearance: () => ({ color: 'blue' }), MachineIcon: 'Icon' },
    './client': { useMachines: () => state, selectMachine: id => { state.selected = id; }, clearMachineError() {}, newOperationId: () => 'op', machineHostRequest: async (id, request) => { requests.push({ id, request }); return { path: request.path }; }, machineRequest: async (id, request) => { requests.push({ id, request }); return { success: true }; } },
  };
  let exports = {};
  let code = ts.transpileModule(fs.readFileSync(__dirname + '/../shared/src/machines/Panel.tsx', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, { exports, require: name => modules[name] });
  let render = () => { cursor = 0; let tree = exports.MachinesPanel({ presentation: 'panel', hostedApi() {} }); effects.splice(0).forEach(effect => effect()); return tree; };
  return { render, requests, state };
};

test('one machine is selected automatically and Agents starts in Home with a compact model picker', async () => {
  let view = harness(); view.render(); view.render(); let tree = view.render();
  assert.equal(view.state.selected, 'included');
  assert.equal(nodes(tree).filter(node => node.type === 'AgentSelector').length, 1);
  assert.equal(nodes(tree).filter(node => node.type === 'HostedWorkspacePanel').length, 0);
  assert.equal(nodes(tree).filter(node => node.props?.accessibilityLabel === 'Remote folder').length, 0);
  assert.doesNotMatch(text(tree), /ClawTab machine|MiB|Machine list connected|Git status|model-a|model-b/);
  let start = nodes(tree).find(node => node.type === 'Pressable' && text(node) === 'Start agent');
  start.props.onPress(); await new Promise(setImmediate);
  assert.equal(view.requests[0].request.path, '/home/clawtab/workspace');
  assert.equal(view.requests[1].request.model, 'model-a');
});

test('sign-in and settings panels mount only under their matching tabs', () => {
  let view = harness(); view.render(); view.render(); let tree = view.render();
  let tabs = nodes(tree).find(node => node.type === 'Tabs');
  for (let section of ['signin', 'settings']) {
    tabs.props.onChange(section);
    let panel = nodes(view.render()).find(node => node.type === 'HostedWorkspacePanel');
    assert.equal(panel.props.section, section);
  }
  tabs.props.onChange('agents');
  assert.equal(nodes(view.render()).filter(node => node.type === 'HostedWorkspacePanel').length, 0);
});
