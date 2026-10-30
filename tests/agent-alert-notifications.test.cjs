const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('../desktop/node_modules/typescript');

function load(file, modules = {}) {
  const source = ts.transpileModule(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(source, { exports, require: name => {
    assert.ok(name in modules, `Unexpected import: ${name}`);
    return modules[name];
  }, console: { log() {} } });
  return exports;
}

const element = (type, props) => ({ type, props });
function nodes(tree) {
  if (!tree || typeof tree !== 'object') return [];
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  return [tree, ...nodes(tree.props?.children)];
}

test('notification cards use live alerts, preserve machine identity, and clear on recovery', () => {
  const alert = load('shared/src/util/alert.ts');
  const { AgentAlertCards } = load('shared/src/components/AgentAlertCards.tsx', {
    'react/jsx-runtime': { jsx: element, jsxs: element },
    'react-native': { StyleSheet: { create: styles => styles }, Pressable: 'Pressable', View: 'View', Text: 'Text' },
    '../util/alert': alert,
    '../util/format': { processDisplayTitle: p => p.display_name, shortenPath: value => value },
    '../theme/colors': { colors: {} },
    '../theme/spacing': { radius: {}, spacing: {} },
  });
  const first = { pane_id: 'machine-a::%1', display_name: 'Build', cwd: '/repo', _agent_alert: 'Selected model is at capacity. Please try a different model.' };
  const second = { pane_id: 'machine-b::%1', display_name: 'Review', cwd: '/repo', _agent_state: 'working' };
  let opened;
  const render = () => nodes(AgentAlertCards({ processes: [first, second], onOpen: p => { opened = p.pane_id; } }));
  const card = render();
  assert.equal(card.filter(node => node.type === 'Pressable').length, 1);
  assert.ok(card.some(node => node.props.children === first._agent_alert));
  assert.ok(card.some(node => node.props.children === '!'));
  card.find(node => node.type === 'Pressable').props.onPress();
  assert.equal(opened, 'machine-a::%1');
  first._agent_alert = undefined;
  assert.equal(render().filter(node => node.type === 'Pressable').length, 0);
});

test('mobile notification count includes alerts even when auto-yes hides questions', () => {
  const { NotificationsMenuButton } = load('remote/src/components/NotificationsMenuButton.tsx', {
    'react/jsx-runtime': { jsx: element, jsxs: element },
    'react-native': { Platform: { OS: 'web' }, StyleSheet: { create: styles => styles }, Pressable: 'Pressable', View: 'View', Text: 'Text' },
    '@expo/vector-icons': { Ionicons: 'Ionicons' },
    'expo-glass-effect': {},
    'expo-router': { useRouter: () => ({}), usePathname: () => '/' },
    '@clawtab/shared': { colors: {}, messagePending: record => record.status === 'pending', useMachines: () => ({ connected: true }) },
    '../store/auth': { useAuthStore: select => select({ isAuthenticated: true, loading: false }) },
    '../store/messages': { useMessageStore: select => select({ records: [] }), uncoveredAlerts: (_, processes) => processes, questionMessage: () => null },
    '../store/notifications': { useNotificationStore: select => select({ questions: [] }) },
    '../store/jobs': { useJobsStore: select => select({ detectedProcesses: [{ _agent_alert: 'Capacity error' }, {}] }) },
    '../hooks/useResponsive': { useResponsive: () => ({ isSplitView: false }) },
  });
  const button = nodes(NotificationsMenuButton({ countOnly: true, hideWhenEmpty: true })).find(node => node.type === 'Pressable');
  assert.ok(button);
  assert.equal(button.props.accessibilityLabel, '1 pending notification');
});

function pushHarness() {
  let lastResponse = null, listener;
  const routes = [], answers = [], injected = [];
  const state = { answerQuestion: id => answers.push(id), injectFromNotification: value => injected.push(value) };
  const store = Object.assign(select => select(state), { getState: () => state });
  const hook = load('remote/src/hooks/useNotifications.ts', {
    react: { useRef: value => ({ current: value }), useEffect: effect => effect() },
    'react-native': { Platform: { OS: 'ios' } },
    'expo-notifications': {
      DEFAULT_ACTION_IDENTIFIER: 'default',
      getLastNotificationResponseAsync: async () => lastResponse,
      addNotificationResponseReceivedListener: callback => { listener = callback; return { remove() {} }; },
    },
    'expo-router': { useRouter: () => ({ push: value => routes.push(value) }) },
    '../store/notifications': { useNotificationStore: store },
    '../lib/wsRuntime': {}, '../lib/pendingAnswers': {}, '../api/client': {}, '../lib/messageActions': {},
    '../lib/messageNotificationRoute': load('remote/src/lib/messageNotificationRoute.ts', {
      './messageRoutes': load('remote/src/lib/messageRoutes.ts'),
    }),
  });
  return { hook, routes, answers, injected, respond: response => listener(response), setLast: response => { lastResponse = response; } };
}

const push = (identifier, data) => ({ actionIdentifier: 'default', notification: { request: {
  identifier, content: { data: { clawtab: data }, body: 'Selected model is at capacity.' }, trigger: null,
} } });

test('alert pushes open the originating machine session without creating or answering a question', async () => {
  const harness = pushHarness();
  harness.hook.useNotifications();
  const response = push('alert-1', { event: 'agent_alert', pane_id: 'machine-a::%1' });
  harness.respond(response);
  harness.respond(response);
  await Promise.resolve();
  assert.deepEqual(harness.routes, ['/process/machine-a::_pct_1?source=notifications']);
  assert.deepEqual(harness.answers, []);
  assert.deepEqual(harness.injected, []);
});

test('cold-start alert pushes retain the session target until the router is ready', async () => {
  const harness = pushHarness();
  harness.setLast(push('alert-2', { event: 'agent_alert', pane_id: 'machine-b::%2' }));
  harness.hook.handleColdStartAnswer();
  await Promise.resolve();
  assert.equal(harness.hook.consumePendingNavigation(), '/process/machine-b::_pct_2?source=notifications');
  assert.deepEqual(harness.answers, []);
  assert.deepEqual(harness.injected, []);
});

test('message body taps open the exact review and do not duplicate warm navigation', async () => {
  const harness = pushHarness();
  harness.hook.useNotifications();
  const response = push('message-warm', { event: 'message', machine_id: 'mac-b', message_id: 'review#8' });
  await harness.respond(response);
  await harness.respond(response);
  assert.deepEqual(harness.routes, ['/notifications/message/review%238?machine=mac-b']);
  assert.deepEqual(harness.answers, []);
});

test('cold-start message selection survives router initialization and getLast replay', async () => {
  const harness = pushHarness();
  harness.setLast(push('message-cold', { event: 'message', machine_id: 'mac-a', message_id: 'review-1' }));
  harness.hook.handleColdStartAnswer();
  await Promise.resolve();
  harness.hook.useNotifications();
  await Promise.resolve();
  assert.deepEqual(harness.routes, ['/notifications/message/review-1?machine=mac-a']);
});
