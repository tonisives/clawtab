const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('../desktop/node_modules/typescript');

let harness = (file, modules = {}) => {
  let states = [], effects = [], queued = [], cursor = 0;
  let react = {
    useRef: (initial) => { let index = cursor++; states[index] ??= { current: initial }; return states[index]; },
    useState: (initial) => {
      let index = cursor++;
      if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial;
      return [states[index], (value) => { states[index] = typeof value === 'function' ? value(states[index]) : value; }];
    },
    useEffect: (effect, deps) => {
      let index = cursor++;
      if (effects[index] && deps.every((value, i) => Object.is(value, effects[index].deps[i]))) return;
      effects[index]?.cleanup?.();
      effects[index] = { deps };
      queued.push(() => { effects[index].cleanup = effect(); });
    },
  };
  let exports = {};
  let element = (type, props) => ({ type, props });
  let source = ts.transpileModule(fs.readFileSync(__dirname + '/../' + file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(source, { exports, Error, require: (name) => name === 'react' ? react : name === 'react/jsx-runtime' ? { jsx: element, jsxs: element } : modules[name] });
  return {
    exports,
    render: (fn) => { cursor = 0; let result = fn(); queued.splice(0).forEach((effect) => effect()); return result; },
    unmount: () => effects.forEach((effect) => effect?.cleanup?.()),
  };
};
let flush = () => new Promise(setImmediate);
let findAll = (node, predicate) => !node ? [] : Array.isArray(node) ? node.flatMap((item) => findAll(item, predicate)) : [...(predicate(node) ? [node] : []), ...findAll(node.props?.children, predicate)];

test('usage requests are scoped, do not run while hidden, and ignore stale machine replies', async () => {
  let requests = [];
  let h = harness('remote/src/hooks/useModelUsage.ts', { '@clawtab/shared': { machineRequest: (machine, message) => new Promise((resolve, reject) => requests.push({ machine, message, resolve, reject })) } });
  let render = (machine, enabled = true) => h.render(() => h.exports.useModelUsage(machine, enabled));
  render('a', false);
  render(undefined);
  assert.equal(requests.length, 0);
  render('a');
  assert.equal(requests[0].machine, 'a');
  assert.equal(requests[0].message.type, 'get_usage');
  assert.equal(render('a').loading, true);
  assert.equal(render('b').usage, null);
  requests[1].resolve({ usage: { marker: 'b' } });
  await flush();
  requests[0].resolve({ usage: { marker: 'a' } });
  await flush();
  assert.equal(render('b').usage.marker, 'b');
  render('b').refresh();
  render('b');
  requests[2].reject(new Error('Offline'));
  await flush();
  assert.equal(render('b').error, 'Offline');
  assert.equal(render('b').loading, false);
  assert.equal(render('b', false).usage, null);
  render('b');
  assert.equal(requests.length, 4);
  h.unmount();
  requests[3].resolve({ usage: { marker: 'late' } });
  await flush();
});

test('usage immediately offers machines without a global selection and switches locally', () => {
  let state = { connected: true, selected: null, machines: [{ id: 'offline', name: 'Offline Mac', online: false }, { id: 'online', name: 'Mac', online: true }] };
  let queried = [];
  let h = harness('remote/src/components/settings/UsageSettings.tsx', {
    'react-native': { View: 'View', Text: 'Text', Pressable: 'Pressable', ActivityIndicator: 'ActivityIndicator' },
    '@expo/vector-icons': { Ionicons: 'Ionicons' },
    'expo-router/react-navigation': { useIsFocused: () => true },
    '@clawtab/shared': { useMachines: () => state },
    '../../theme/colors': { colors: {} },
    '../../hooks/useModelUsage': { useModelUsage: (machine, enabled) => { queried.push({ machine, enabled }); return {}; } },
    '../UsageProgressBar': {},
    './SettingsPage': { SettingsPage: 'Page', SettingsRow: 'Row', styles: {} },
    './navigation': { useSettingsVisible: () => true, useSettingsNavigation: () => () => {} },
  });
  let render = () => h.render(h.exports.UsageSettings);
  let tree = render();
  assert.equal(queried.at(-1).machine, 'online');
  let choices = findAll(tree, (node) => node.props?.accessibilityRole === 'radio');
  assert.equal(choices.length, 2);
  assert.equal(choices[1].props.accessibilityState.checked, true);
  choices[0].props.onPress();
  render();
  assert.equal(queried.at(-1).machine, 'offline');
  assert.equal(queried.at(-1).enabled, false);
  assert.equal(state.selected, null);
  state.machines = state.machines.slice(1);
  render();
  assert.equal(queried.at(-1).machine, 'online');
});

test('settings disable relay operations offline while preserving account and debugging access', () => {
  let relay = { connected: false, error: 'Relay access is unavailable' };
  let retries = 0, navigated = [];
  let h = harness('remote/app/(tabs)/(settings)/settings.tsx', {
    '@clawtab/shared': { useMachines: () => relay, reconnectMachines: () => retries++ },
    'expo-router/build/react-navigation/native-stack': { createNativeStackNavigator: () => ({}) },
    'expo-router/react-navigation': {},
    '../../../src/components/settings/AccountSettings': {},
    '../../../src/components/settings/SharingSettings': {},
    '../../../src/components/settings/TerminalSettings': {},
    '../../../src/components/settings/UsageSettings': {},
    'react-native': { Platform: { OS: 'ios' }, View: 'View', Text: 'Text' },
    '../../../src/store/auth': { useAuthStore: (select) => select({ email: 'account@example.com' }) },
    '../../../src/components/settings/SettingsPage': { SettingsPage: 'Page', SettingsRow: 'Row', styles: {} },
    '../../../src/components/settings/navigation': { useSettingsNavigation: () => (page) => navigated.push(page) },
    '../../../src/theme/colors': { colors: {} },
  });
  let rows = () => findAll(h.render(h.exports.SettingsHome), (node) => node.type === 'Row');
  let offline = rows();
  for (let title of ['Shared access', 'Model usage', 'Manage machines', 'API tokens']) {
    assert.equal(offline.find((node) => node.props.title === title).props.disabled, true, title);
  }
  for (let title of ['Account & subscription', 'Terminal', 'Connect to relay']) {
    assert.notEqual(offline.find((node) => node.props.title === title).props.disabled, true, title);
  }
  let connection = offline.find((node) => node.props.title === 'Connect to relay');
  assert.equal(connection.props.detail, relay.error);
  connection.props.onPress();
  assert.deepEqual(navigated, ['account']);
  offline.find((node) => node.props.title === 'Retry connection').props.onPress();
  assert.equal(retries, 1);
  offline.find((node) => node.props.title === 'Account & subscription').props.onPress();
  assert.deepEqual(navigated, ['account', 'account']);
  relay = { connected: true, error: null };
  assert.ok(rows().every((node) => !node.props.disabled));
});

let accountHarness = (os = 'ios') => {
  let subscribed = false, statusError = false, reconnects = 0, purchases = 0, restores = 0, checkouts = 0, opened = [], resumed;
  let iap = {
    available: true, purchasing: false, loading: false, error: null, diagnostic: null, retry: async () => {}, price: '$4.99',
    purchase: async () => { purchases++; subscribed = true; return true; },
    restore: async () => { restores++; subscribed = true; return true; },
  };
  let h = harness('remote/src/components/settings/AccountSettings.tsx', {
    '@clawtab/shared': { machineState: () => ({ connected: false }), reconnectMachines: () => reconnects++ },
    '../../hooks/useIap': { useIap: () => iap },
    'react-native': { Platform: { OS: os }, AppState: { addEventListener: (_, handler) => { resumed = handler; return { remove: () => {} }; } }, View: 'View', Text: 'Text', Pressable: 'Pressable', ActivityIndicator: 'ActivityIndicator' },
    'expo-router': { useRouter: () => ({}) },
    '../../store/auth': { useAuthStore: (select) => select({ userId: 'returning-user', email: 'account@example.com' }) },
    '../../hooks/useResponsive': { useResponsive: () => ({ isWide: false }) },
    '../../api/client': { getSubscriptionStatus: async () => { if (statusError) throw new Error('Offline'); return { subscribed, provider: subscribed ? 'apple' : null }; }, createCheckout: async () => { checkouts++; return { url: 'https://checkout.example.com' }; } },
    '../../lib/platform': { openUrl: async (url) => opened.push(url) },
    '../../theme/colors': { colors: {} },
    './SettingsPage': { SettingsPage: 'Page', SettingsRow: 'Row', styles: {} },
    './navigation': { useSettingsNavigation: () => () => {} },
  });
  return {
    iap,
    render: () => h.render(h.exports.AccountSettings),
    rows: () => findAll(h.render(h.exports.AccountSettings), (node) => node.type === 'Row'),
    counts: () => ({ purchases, restores, reconnects, checkouts }),
    opened,
    resume: () => resumed('active'),
    setSubscribed: (value) => { subscribed = value; },
    setStatusError: (value) => { statusError = value; },
  };
};

test('account offers native subscribe and restore, then reconnects only after access is confirmed', async () => {
  for (let action of ['subscribe', 'restore']) {
    let account = accountHarness();
    account.render();
    await flush();
    let rows = account.rows();
    let subscribe = rows.find((node) => node.props.title.startsWith('Subscribe'));
    assert.equal(subscribe.props.disabled, false);
    assert.match(subscribe.props.title, /\$4\.99/);
    let button = action === 'subscribe' ? subscribe : rows.find((node) => node.props.title === 'Restore Purchases');
    await button.props.onPress();
    assert.equal(account.counts().reconnects, 1);
    assert.equal(account.counts()[action === 'subscribe' ? 'purchases' : 'restores'], 1);
    assert.equal(account.counts().checkouts, 0);
    assert.ok(account.rows().some((node) => node.props.title === 'Manage subscription'));
    assert.ok(!account.rows().some((node) => node.props.title.startsWith('Subscribe')));
  }
});

test('unavailable or unsuccessful native purchases do not grant relay access', async () => {
  let account = accountHarness();
  account.render();
  await flush();
  account.iap.available = false;
  assert.equal(account.rows().find((node) => node.props.title.startsWith('Subscribe')).props.disabled, true);
  account.iap.available = true;
  account.iap.purchase = async () => false;
  await account.rows().find((node) => node.props.title.startsWith('Subscribe')).props.onPress();
  assert.equal(account.counts().reconnects, 0);
  assert.ok(findAll(account.render(), (node) => node.props?.accessibilityRole === 'alert').length);
});

test('web checkout refreshes access when returning to the app', async () => {
  let account = accountHarness('web');
  account.render();
  await flush();
  await account.rows().find((node) => node.props.title.startsWith('Subscribe')).props.onPress();
  assert.equal(account.counts().checkouts, 1);
  assert.equal(account.counts().purchases, 0);
  assert.deepEqual(account.opened, ['https://checkout.example.com']);
  assert.equal(account.counts().reconnects, 0);
  account.setSubscribed(true);
  account.resume();
  await flush();
  assert.equal(account.counts().reconnects, 1);
});


test('account distinguishes StoreKit loading from a retryable catalog failure', async () => {
  let account = accountHarness();
  account.iap.available = false;
  account.iap.loading = true;
  account.render(); await flush();
  let loading = account.rows().find((node) => node.props.title === 'Loading purchases…');
  assert.equal(loading.props.disabled, true);
  account.iap.loading = false;
  account.iap.error = 'The App Store did not return the relay subscription.';
  account.iap.diagnostic = 'Product: cc.clawtab.pro.monthly';
  let retried = false;
  account.iap.retry = async () => { retried = true; };
  let rows = account.rows();
  assert.equal(rows.find((node) => node.props.title.startsWith('Subscribe')).props.detail, account.iap.error);
  await rows.find((node) => node.props.title === 'Retry loading purchases').props.onPress();
  assert.equal(retried, true);
});

test('subscription checks offer retry only after failure and hide it after recovery', async () => {
  let account = accountHarness();
  account.render(); await flush();
  assert.ok(!account.rows().some((node) => /Refresh|Retry subscription/.test(node.props.title)));
  account.setStatusError(true);
  account.resume(); await flush();
  let retry = account.rows().find((node) => node.props.title === 'Retry subscription check');
  assert.equal(retry.props.chevron, false);
  await retry.props.onPress();
  assert.ok(account.rows().some((node) => node.props.title === 'Retry subscription check'));
  account.setStatusError(false);
  await retry.props.onPress();
  assert.ok(!account.rows().some((node) => /Refresh|Retry subscription/.test(node.props.title)));
  assert.equal(findAll(account.render(), (node) => node.props?.accessibilityRole === 'alert').length, 0);
});

test('subscription actions omit chevrons and logout has its own Session section', async () => {
  let account = accountHarness();
  account.render(); await flush();
  assert.ok(account.rows().every((node) => node.props.chevron === false));
  let session = findAll(account.render(), (node) => node.type === 'View').find((node) =>
    Array.isArray(node.props.children) && node.props.children.some((child) => child?.type === 'Text' && child.props.children === 'Session'));
  assert.ok(session);
  assert.equal(findAll(session, (node) => node.type === 'Text' && node.props.children === 'Log Out').length, 1);
  await account.rows().find((node) => node.props.title.startsWith('Subscribe')).props.onPress();
  assert.equal(account.rows().find((node) => node.props.title === 'Manage subscription').props.chevron, false);
  assert.ok(!account.rows().some((node) => /Refresh|Retry subscription/.test(node.props.title)));
});
