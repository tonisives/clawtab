const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('../desktop/node_modules/typescript');

let flush = () => new Promise(setImmediate);
let all = (node) => Array.isArray(node) ? node.flatMap(all) : node && typeof node === 'object' ? [node, ...all(node.props?.children)] : [];
let harness = ({ platform = 'web', subscribed = false, check } = {}) => {
  let states = [], cursor = 0, effects = [], polls = [], opened = [], routes = [], checks = 0, checkout = 0;
  let status = { subscribed, hosted_workspace_eligible: subscribed, relay_included: false, provider: 'stripe' };
  let react = {
    useState: (initial) => { let id = cursor++; if (!(id in states)) states[id] = initial; return [states[id], (value) => { states[id] = typeof value === 'function' ? value(states[id]) : value; }]; },
    useRef: (initial) => react.useState({ current: initial })[0],
    useEffect: (effect, deps) => { let id = cursor++; if (!(id in states) || deps.some((value, index) => value !== states[id][index])) { states[id] = deps; effects.push(effect); } },
  };
  let auth = (select) => select({ userId: 'fixture-account' });
  auth.getState = () => ({ userId: 'fixture-account' });
  let element = (type, props) => ({ type, props });
  let iap = { available: true, price: '€7.99', activation: 0, purchase: async () => { status.subscribed = status.hosted_workspace_eligible = true; return { status: 'purchased' }; } };
  let modules = {
    react, 'react/jsx-runtime': { jsx: element, jsxs: element },
    'react-native': { Platform: { OS: platform }, View: 'View', Text: 'Text', ActivityIndicator: 'Loading', AppState: { addEventListener: () => ({ remove() {} }) } },
    'expo-router': { useRouter: () => ({ push: (route) => routes.push(route) }) },
    '@clawtab/shared': { HostedWorkspacePanel: 'HostedWorkspace', machineState: () => ({ connected: true }), reconnectMachines() {} },
    '../../hooks/useIap': { useIap: () => iap }, '../../store/auth': { useAuthStore: auth },
    '../../api/client': {
      getSubscriptionStatus: async () => { checks++; return check ? check() : { ...status }; },
      createCheckout: async () => { checkout++; return { url: 'https://checkout.example.test' }; }, rentalApi() {},
    },
    '../../lib/platform': { alertError() {}, openUrl: async (url) => { opened.push(url); } },
    '../../theme/colors': { colors: {} },
    './SettingsPage': { SettingsGroup: 'Group', SettingsRow: 'Row', styles: {} },
    './navigation': { useSettingsNavigation: () => (route) => routes.push(route) }, '../RelayWelcome': { RelayWelcome: 'Welcome' },
  };
  let exports = {};
  let source = ts.transpileModule(fs.readFileSync(__dirname + '/../remote/src/components/settings/RelaySubscription.tsx', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(source, { exports, require: (name) => modules[name], setInterval: (work) => { polls.push(work); return polls.length; }, clearInterval() {} });
  let render = (onboarding = true) => { cursor = 0; let tree = exports.RelaySubscription({ onboarding }); effects.splice(0).forEach((effect) => effect()); return tree; };
  return { render, status, iap, polls, opened, routes, checks: () => checks, checkouts: () => checkout };
};

test('subscription activation reveals the automatically connected workspace on the same screen', async () => {
  let h = harness(); h.render(); await flush();
  assert.equal(h.render().type, 'Welcome');
  all(h.render()).find((node) => node.props?.title?.startsWith('Subscribe')).props.onPress(); await flush();
  assert.equal(h.checkouts(), 1);
  assert.deepEqual(h.opened, ['https://checkout.example.test']);
  h.status.subscribed = h.status.hosted_workspace_eligible = true;
  h.polls[0](); await flush();
  let workspace = all(h.render()).find((node) => node.type === 'HostedWorkspace');
  assert.equal(workspace.props.autoStart, true);
  assert.deepEqual(h.routes, []);
});

test('an existing subscriber opens the workspace directly and account settings link back to it', async () => {
  let h = harness({ subscribed: true }); h.render(); await flush();
  assert.ok(all(h.render()).some((node) => node.type === 'HostedWorkspace'));
  assert.ok(!all(h.render()).some((node) => node.props?.title?.startsWith('Subscribe')));
  all(h.render(false)).find((node) => node.props?.title === 'Open Relay workspace').props.onPress();
  assert.deepEqual(h.routes, ['/workspace']);
});

test('onboarding polling lets a slow subscription check finish before starting another', async () => {
  let resolve;
  let h = harness({ check: () => new Promise((done) => { resolve = done; }) });
  h.render(); h.polls[0](); h.polls[0](); await flush();
  assert.equal(h.checks(), 1);
  resolve({ subscribed: true, hosted_workspace_eligible: true }); await flush();
  assert.ok(all(h.render()).some((node) => node.type === 'HostedWorkspace'));
});

test('iOS uses its localized purchase and Android keeps existing-account access', async () => {
  let ios = harness({ platform: 'ios' }); ios.render(); await flush();
  let subscribe = all(ios.render()).find((node) => node.props?.title?.startsWith('Subscribe'));
  assert.match(subscribe.props.title, /€7.99/);
  await subscribe.props.onPress(); await flush();
  assert.ok(all(ios.render()).some((node) => node.type === 'HostedWorkspace'));
  assert.equal(ios.checkouts(), 0);
  let android = harness({ platform: 'android' }); android.render(); await flush();
  assert.ok(!all(android.render()).some((node) => node.props?.title?.startsWith('Subscribe')));
});
