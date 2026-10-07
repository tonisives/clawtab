const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('../desktop/node_modules/typescript');

let find = (tree, label) => {
  if (!tree) return;
  if (Array.isArray(tree)) return tree.map((node) => find(node, label)).find(Boolean);
  return tree.props?.label === label ? tree : find(tree.props?.children, label);
};
let findType = (tree, type) => {
  if (!tree) return;
  if (Array.isArray(tree)) return tree.map((node) => findType(node, type)).find(Boolean);
  return tree.type === type ? tree : findType(tree.props?.children, type);
};
let flush = () => new Promise((resolve) => setImmediate(resolve));
let harness = (rental, launch, props = {}, rentals = [rental]) => {
  let states = [], cursor = 0, effects = [], operation = 0;
  let machines = { machines: [{ id: rental.machine_id, online: true }], agentModels: { default_provider: 'codex' }, controllers: {} };
  let react = {
    useState: (value) => { let i = cursor++; if (!(i in states)) states[i] = typeof value === 'function' ? value() : value; return [states[i], (value) => { states[i] = value; }]; },
    useRef: (value) => react.useState({ current: value })[0],
    useEffect: (effect) => { let i = cursor++; if (!(i in states)) { states[i] = true; effects.push(effect); } },
  };
  let element = (type, props) => ({ type, props });
  let modules = {
    react,
    'react/jsx-runtime': { jsx: element, jsxs: element },
    'react-native': { Platform: { OS: 'ios' }, StyleSheet: { create: (value) => value }, ...Object.fromEntries(['View','Text','TextInput','Pressable'].map((name) => [name, name])) },
    './Terminal': { MachineTerminalScreen: 'MachineTerminalScreen' },
    '../theme/colors': { colors: {} },
    './client': { useMachines: () => machines, machineState: () => machines, machineRequest: launch, machineSend: () => {}, resourceKey: (m, p) => `${m}::${p}`, selectMachine: (id) => { machines.selected = id; }, newOperationId: () => `request-${++operation}` },
  };
  let exports = {};
  let code = ts.transpileModule(fs.readFileSync(__dirname + '/../shared/src/machines/Rentals.tsx', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, { exports, require: (name) => modules[name], Intl, Error, setInterval: () => 1, clearInterval: () => {} });
  let calls = [];
  let api = async (method, path, body) => {
    calls.push({ method, path, body });
    if (method === 'GET') return { rentals };
    if (body.action === 'prepare') {
      rental.setup.provider ??= 'codex';
      rental.setup.login_operation_id ??= 'login-stable';
      rental.setup.agent_operation_id ??= 'agent-stable';
    } else rental.setup[`${body.action}_terminal`] = body.terminal;
    return { ...rental.setup };
  };
  let render = () => { cursor = 0; let tree = exports.RentalsPanel({ api, purchases: true, ...props }); effects.splice(0).forEach((effect) => effect()); return tree; };
  return { render, calls, machines };
};
let rental = () => ({ id: 'rental-1', machine_id: 'remote-only', name: 'My box', state: 'ready', quote: { currency: 'eur', monthly_cents: 540 }, agent_provider: 'codex', setup: {} });

test('first agent runs on the rental workspace and repeated clicks share one operation', async () => {
  let box = rental(), requests = [];
  let view = harness(box, async (machine, message) => { requests.push({ machine, message }); return { success: true, pane_id: '%1', tmux_session: 'agent' }; });
  view.render(); await flush();
  let start = find(view.render(), 'Start agent');
  start.props.onPress(); start.props.onPress();
  await flush();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].machine, 'remote-only');
  assert.equal(requests[0].message.work_dir, '/home/clawtab/workspace');
  assert.equal(requests[0].message.operation_id, 'agent-stable');
  assert.equal(requests[0].message.provider, 'codex');
  assert.equal(box.setup.agent_terminal.pane_id, '%1');
  assert.equal(view.machines.selected, 'remote-only');
});

test('reopening setup attaches to the saved agent without launching a duplicate', async () => {
  let box = rental();
  box.setup = { provider: 'codex', agent_terminal: { pane_id: '%4', tmux_session: 'existing' } };
  let requests = 0;
  let view = harness(box, async () => { requests++; });
  view.render(); await flush();
  find(view.render(), 'Open agent').props.onPress(); await flush();
  assert.equal(requests, 0);
  assert.equal(view.calls.filter((call) => call.body?.action === 'agent').length, 0);
});

test('provider sign-in is a shell command and uses its own stable operation', async () => {
  let box = rental(), request;
  let view = harness(box, async (machine, message) => { request = message; return { success: true, pane_id: '%2', tmux_session: 'login' }; });
  view.render(); await flush();
  find(view.render(), 'Sign in to Codex').props.onPress(); await flush();
  assert.equal(request.provider, 'shell');
  assert.equal(request.prompt, 'codex login --device-auth');
  assert.equal(request.operation_id, 'login-stable');
  assert.equal(box.setup.login_terminal.pane_id, '%2');
  let screen = findType(view.render(), 'MachineTerminalScreen');
  assert.equal(screen.props.signIn, true);
  assert.equal(screen.props.machineId, 'remote-only');
  screen.props.onClose();
  assert.equal(findType(view.render(), 'MachineTerminalScreen'), undefined);
  find(view.render(), 'Resume sign-in').props.onPress(); await flush();
  assert.equal(findType(view.render(), 'MachineTerminalScreen').props.paneId, '%2');
});


test('add-machine view keeps existing boxes in management', async () => {
  let view = harness(rental(), async () => {}, { showExistingRentals: false });
  view.render(); await flush();
  assert.equal(find(view.render(), 'Sign in to Codex'), undefined);
  assert.ok(find(view.render(), 'Rent a box'));
});

test('deleted and failed boxes stay in collapsed history after the management controls', async () => {
  let current = rental();
  let deleted = { ...rental(), id: 'deleted', name: 'Deleted box', state: 'deleted' };
  let failed = { ...rental(), id: 'failed', name: 'Failed order', state: 'failed' };
  let controls = { type: 'MachineControls', props: {} };
  let view = harness(current, async () => {}, { allowNewRentals: false, children: controls }, [deleted, current, failed]);
  view.render(); await flush();
  let tree = view.render();
  let text = (node) => !node ? '' : Array.isArray(node) ? node.map(text).join(' ') : typeof node === 'string' ? node : text(node.props?.children);
  assert.ok(find(tree, 'Start agent'));
  assert.doesNotMatch(text(tree), /Deleted box|Failed order/);
  let history = tree.props.children.find((child) => child?.props?.children?.[0]?.props?.accessibilityState?.expanded === false);
  assert.ok(tree.props.children.indexOf(controls) < tree.props.children.indexOf(history));
  history.props.children[0].props.onPress();
  assert.match(text(view.render()), /Deleted box.*Permanently deleted.*Failed order.*Order closed/);
});

test('machine controls remain available when the account has no rentals', async () => {
  let controls = { type: 'MachineControls', props: {} };
  let view = harness(rental(), async () => {}, { allowNewRentals: false, children: controls }, []);
  view.render(); await flush();
  assert.equal(findType(view.render(), 'MachineControls'), controls);
});
