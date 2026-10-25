const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('../desktop/node_modules/typescript');

let flush = () => new Promise((resolve) => setImmediate(resolve));
let find = (tree, label) => !tree ? undefined : Array.isArray(tree)
  ? tree.map((node) => find(node, label)).find(Boolean)
  : tree.props?.label === label ? tree : find(tree.props?.children, label);
let harness = ({ eligible = true, workspace = { id: 'included', machine_id: 'hosted-only', state: 'ready', setup: {} }, launch = async () => ({ success: true, pane_id: 'managed:1', tmux_session: 'agent' }) } = {}) => {
  let states = [], cursor = 0, effects = [], operation = 0, starts = 0;
  let status = { enabled: true, eligible, workspace };
  let requests = [], calls = [];
  let machines = { machines: [{ id: 'hosted-only', online: true }] };
  let react = {
    useState: (initial) => { let id = cursor++; if (!(id in states)) states[id] = typeof initial === 'function' ? initial() : initial; return [states[id], (value) => { states[id] = value; }]; },
    useRef: (initial) => react.useState({ current: initial })[0],
    useEffect: (effect, deps) => { let id = cursor++; if (!(id in states) || deps.some((value, index) => value !== states[id][index])) { states[id] = deps; effects.push(effect); } },
  };
  let element = (type, props) => ({ type, props });
  let modules = {
    react, 'react/jsx-runtime': { jsx: element, jsxs: element },
    'react-native': { StyleSheet: { create: (value) => value }, View: 'View', Text: 'Text', Pressable: 'Pressable' },
    '../theme/colors': { colors: {} }, './Terminal': { MachineTerminalScreen: 'Terminal' },
    './Rentals': { RENTAL_AGENTS: [{ id: 'codex', name: 'Codex', login: 'codex login --device-auth' }] },
    './client': {
      useMachines: () => machines, newOperationId: () => `operation-${++operation}`,
      selectMachine: (id) => { machines.selected = id; }, machineHostRequest: async () => ({}),
      machineRequest: async (id, request) => { requests.push({ id, request }); return launch(id, request); },
    },
  };
  let exports = {};
  let code = ts.transpileModule(fs.readFileSync(__dirname + '/../shared/src/machines/HostedWorkspace.tsx', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, { exports, require: (name) => modules[name], Intl, Date, Error, setInterval: () => 1, clearInterval: () => {} });
  let api = async (method, path, body) => {
    calls.push({ method, path, body });
    if (method === 'GET') return status;
    if (path.endsWith('/start')) { starts++; return status; }
    workspace.setup.providers ??= {};
    let setup = workspace.setup.providers[body.provider] ??= { provider: body.provider, agent_operation_id: 'agent-stable', login_operation_id: 'login-stable' };
    if (body.action.startsWith('restart_')) {
      let action = body.action.slice(8);
      setup[`${action}_operation_id`] = `replacement-${++operation}`;
      delete setup[`${action}_terminal`];
    } else if (body.action !== 'prepare') setup[`${body.action}_terminal`] = body.terminal;
    return { ...setup };
  };
  let render = (props = {}) => { cursor = 0; let tree = exports.HostedWorkspacePanel({ api, ...props }); effects.splice(0).forEach((effect) => effect()); return tree; };
  return { render, requests, calls, machines, starts: () => starts };
};

test('included workspace starts once and requires its own paid entitlement', async () => {
  let denied = harness({ eligible: false, workspace: null }); denied.render(); await flush();
  assert.equal(denied.render(), null);
  let view = harness({ workspace: null }); view.render(); await flush();
  let start = find(view.render(), 'Start included workspace');
  start.props.onPress(); start.props.onPress(); await flush();
  assert.equal(view.starts(), 1);
});

test('reopening an included agent reuses the terminal on the included host', async () => {
  let view = harness(); view.render(); await flush();
  let start = find(view.render(), 'Start agent'); start.props.onPress(); start.props.onPress(); await flush();
  assert.equal(view.requests.length, 1);
  assert.equal(view.requests[0].id, 'hosted-only');
  assert.equal(view.requests[0].request.operation_id, 'agent-stable');
  assert.equal(view.requests[0].request.work_dir, '/home/clawtab/workspace');
  find(view.render(), 'Open agent').props.onPress(); await flush();
  assert.equal(view.requests.length, 1);
  assert.equal(view.machines.selected, 'hosted-only');
});

test('sign-in uses a shared shell slot and exits when sign-in finishes', async () => {
  let view = harness(); view.render(); await flush();
  find(view.render(), 'Sign in to Codex').props.onPress(); await flush();
  assert.equal(view.requests[0].request.provider, 'shell');
  assert.equal(view.requests[0].request.prompt, 'codex login --device-auth; exit');
  assert.equal(view.requests[0].request.operation_id, 'login-stable');
});

test('capacity rejection permits a fresh retry while a lost acknowledgement preserves its operation', async () => {
  let attempt = 0;
  let view = harness({ launch: async () => ++attempt === 1 ? { success: false, status: 'rejected', error: 'Both included workspace sessions are in use' } : { success: true, pane_id: 'managed:2', tmux_session: 'agent' } });
  view.render(); await flush(); find(view.render(), 'Start agent').props.onPress(); await flush();
  find(view.render(), 'Start agent').props.onPress(); await flush();
  assert.notEqual(view.requests[0].request.operation_id, view.requests[1].request.operation_id);
  attempt = 0;
  let lost = harness({ launch: async () => { if (++attempt === 1) throw new Error('Timed out'); return { success: true, pane_id: 'managed:3', tmux_session: 'agent' }; } });
  lost.render(); await flush(); find(lost.render(), 'Start agent').props.onPress(); await flush();
  find(lost.render(), 'Start agent').props.onPress(); await flush();
  assert.equal(lost.requests[0].request.operation_id, lost.requests[1].request.operation_id);
});


test('onboarding provisions an eligible workspace automatically only once', async () => {
  let view = harness({ workspace: null });
  view.render({ autoStart: true }); await flush();
  view.render({ autoStart: true }); await flush();
  view.render({ autoStart: true }); await flush();
  assert.equal(view.starts(), 1);
  let denied = harness({ eligible: false, workspace: null });
  denied.render({ autoStart: true }); await flush();
  denied.render({ autoStart: true }); await flush();
  assert.equal(denied.starts(), 0);
  let ready = harness(); ready.render({ autoStart: true }); await flush();
  ready.render({ autoStart: true }); await flush();
  assert.equal(ready.starts(), 0);
});
