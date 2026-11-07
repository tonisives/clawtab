const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('../desktop/node_modules/typescript');
const transpile = file => ts.transpileModule(fs.readFileSync(__dirname + '/../' + file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const nodes = node => !node ? [] : Array.isArray(node) ? node.flatMap(nodes) : typeof node === 'object' ? [node, ...nodes(node.props?.children)] : [];
const text = node => !node ? '' : Array.isArray(node) ? node.map(text).join(' ') : typeof node === 'object' ? text(node.props?.children) : String(node);

test('web agent cards stack status, time and a menu with the actual model inside', () => {
  let values = [], cursor = 0;
  const react = {
    useState(initial) { const i = cursor++; if (!(i in values)) values[i] = typeof initial === 'function' ? initial() : initial; return [values[i], value => { values[i] = value; }]; },
    useRef(initial) { return react.useState({ current: initial })[0]; },
    useEffect() {}, useCallback: fn => fn,
  };
  const modules = {
    react, 'react/jsx-runtime': { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) },
    'react-native': { Platform: { OS: 'web' }, StyleSheet: { create: value => value }, useWindowDimensions: () => ({ width: 1440, height: 900 }), View: 'View', Text: 'Text', TouchableOpacity: 'TouchableOpacity' },
    './ListAppearance': { useMobileListAppearance: () => false },
    '../util/alert': { agentAlertTitle: () => '', sessionSizeAlertLabel: () => null },
    '../util/agent': { compactAgentSelectionLabel: () => 's6.1-md', agentSelectionLabel: (provider, model, effort) => `${model}-${effort}` },
    '../machines/client': { resourceLabel: id => id.split('::').pop(), splitResource: () => null },
    '../machines/Badge': {}, '../types/process': { resolveProcessAgentState: () => 'finished' },
    './PopupMenu': { PopupMenu: 'PopupMenu' }, '../util/format': { processDisplayTitle: () => 'Review changes', compactProcessQuery: () => 'Review this branch', timeAgo: () => '2 minutes ago' },
    './Tooltip': { Tooltip: 'Tooltip' }, '../theme/colors': { colors: {} }, '../theme/spacing': { radius: {}, spacing: {} }, './JobKindIcon': { kindForProcess: () => 'codex', JobKindIcon: 'Icon' },
  };
  const exports = {};
  vm.runInNewContext(transpile('shared/src/components/ProcessCard.tsx'), { exports, require: name => modules[name], setTimeout });
  const render = () => { cursor = 0; return exports.ProcessCard({ process: { pane_id: 'machine::%1', provider: 'codex', model_id: 'gpt-6.1', agent_effort: 'medium', session_started_at: new Date().toISOString() }, onStop() {} }); };
  let tree = render();
  assert.ok(!text(tree).includes('s6.1-md'), 'model lives in menu on web');
  const stack = nodes(tree).find(node => node.props?.style?.alignItems === 'flex-end' && node.props.style.gap === 4);
  assert.equal(stack.props.children.length, 3);
  const menu = nodes(tree).find(node => node.props?.accessibilityLabel === 'Agent menu');
  menu.props.onPress({ stopPropagation() {}, currentTarget: { getBoundingClientRect: () => ({ bottom: 80, right: 400 }) } });
  const popup = nodes(render()).find(node => node.type === 'PopupMenu');
  assert.equal(popup.props.items[0].label, 'gpt-6.1 · medium');
  assert.equal(popup.props.items[0].disabled, true);
  assert.equal(nodes(tree)[0].props.style[0].borderRadius, 28);
});

test('roster arrival waits for host snapshots before clearing saved agents or enabling navigation', () => {
  const state = { connected: true, connectionId: null, machines: [{ id: 'host', online: true }], snapshots: {} };
  const jobState = { loaded: true, processesLoaded: true, detectedProcesses: [{ pane_id: 'host::%1' }], setJobs() { this.loaded = true; }, setDetectedProcesses(value) { this.detectedProcesses = value; this.processesLoaded = true; } };
  const noop = () => {};
  const jobs = { getState: () => new Proxy(jobState, { get: (target, key) => key in target ? target[key] : noop }), setState: patch => Object.assign(jobState, patch) };
  const store = { setState: noop, getState: () => new Proxy({}, { get: () => noop }) };
  const shared = { machineState: () => state, machineJobs: () => ({ jobs: [], statuses: {} }), machineProcesses: () => [{ pane_id: 'host::%1' }], scopedMessage: (_id, value) => value, resolveEnabledModels: () => ({}), hostModelCatalog: () => ({}) };
  const exports = {};
  vm.runInNewContext(transpile('remote/src/hooks/useWebSocket.ts') + '\nexports.synchronize = synchronize;', { exports, require: name => name === '@clawtab/shared' ? shared : name === '../store/jobs' ? { useJobsStore: jobs } : new Proxy({}, { get: (_, key) => key.startsWith('use') ? store : noop }) });
  exports.synchronize();
  assert.equal(jobState.loaded, false);
  assert.equal(jobState.processesLoaded, false);
  assert.equal(jobState.detectedProcesses[0].pane_id, 'host::%1');
  state.connectionId = 'client';
  state.snapshots.host = { jobs_changed: { jobs: [], statuses: {} } };
  exports.synchronize();
  assert.equal(jobState.loaded, true);
  assert.equal(jobState.processesLoaded, false);
  state.snapshots.host.detected_processes = { processes: [] };
  exports.synchronize();
  assert.equal(jobState.processesLoaded, true);
});
