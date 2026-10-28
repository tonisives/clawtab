const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('../desktop/node_modules/typescript');
const { createStore } = require('../remote/node_modules/zustand/vanilla.js');

const create = initialize => {
  const store = createStore(initialize);
  return Object.assign(select => select(store.getState()), store);
};
const load = (file, dependencies, globals = {}) => {
  const exports = {};
  const source = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(source, { exports, console, setTimeout, clearTimeout, require: name => {
    assert.ok(name in dependencies, `Unexpected import in ${file}: ${name}`);
    return dependencies[name];
  }, ...globals });
  return exports;
};
const settle = () => new Promise(setImmediate);
const record = (id = 'personal') => ({
  machine_id: 'mac', id, status: 'pending', request: { source: { pane_id: 'mac::%1' }, actions: [] },
});

function harness() {
  const storage = new Map(), delayedReads = new Map();
  const asyncStorage = {
    getItem: async key => delayedReads.has(key) ? delayedReads.get(key) : storage.get(key) ?? null,
    setItem: async (key, value) => { storage.set(key, value); },
    multiGet: async keys => keys.map(key => [key, storage.get(key) ?? null]),
    multiSet: async entries => entries.forEach(([key, value]) => storage.set(key, value)),
    multiRemove: async keys => keys.forEach(key => storage.delete(key)),
  };
  const state = { connected: true, machines: [{ id: 'mac', online: true }], snapshots: {}, controllers: {} };
  const shared = {
    messagePending: record => record.status === 'pending',
    resourceKey: (machine, id) => `${machine}::${id}`,
    machineState: () => state,
    machineHostRequest: async () => { throw new Error('Unexpected host request'); },
  };
  const dependencies = { zustand: { create }, '@react-native-async-storage/async-storage': asyncStorage, '@clawtab/shared': shared };
  const messages = load('remote/src/store/messages.ts', { ...dependencies, '../lib/notifications': { dismissMessageNotification: async () => {} } });
  const actions = load('remote/src/lib/messageActions.ts', { ...dependencies, '../store/messages': messages });
  const notifications = load('remote/src/store/notifications.ts', dependencies).useNotificationStore;
  const jobs = load('remote/src/store/jobs.ts', dependencies).useJobsStore;
  const ws = load('remote/src/store/ws.ts', dependencies).useWsStore;
  const auth = create(() => ({ isAuthenticated: true, loading: false, userId: 'alice', logout: async () => { logoutCalls++; } }));
  let cleanup, connectUrl, logoutCalls = 0, stopped = false, wsSend = null, clearedTerminal = false;
  let pushToken = Promise.resolve(null), wsUrl = Promise.resolve('ws://fixture');
  const registrations = [];
  const { useWebSocket } = load('remote/src/hooks/useWebSocket.ts', {
    react: { useEffect: effect => { cleanup = effect(); }, useCallback: callback => callback },
    'react-native': { Platform: { OS: 'ios' }, AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) } },
    '@clawtab/shared': { ...shared, sendResource() {}, subscribeMachines: () => () => {}, onMachineEvent: () => () => {},
      connectMachines: getUrl => { connectUrl = getUrl; return () => { stopped = true; state.connected = false; state.machines = []; }; } },
    '../api/client': { getWsUrl: () => wsUrl, isInvalidRefreshError: error => error.status === 401,
      registerMachinePushToken: async (...args) => registrations.push(args) },
    '../store/auth': { useAuthStore: auth },
    '../store/jobs': { useJobsStore: jobs },
    '../store/notifications': { useNotificationStore: notifications },
    '../store/ws': { useWsStore: ws },
    '../store/messages': messages,
    '../lib/messageActions': actions,
    '../lib/terminalCache': { terminalCache: { clear: () => { clearedTerminal = true; } } },
    '../lib/wsRuntime': { setWsSend: send => { wsSend = send; } },
    '../store/terminalSettings': { useTerminalSettings: { getState: () => ({ hydrate: async () => {} }) } },
    '../lib/notifications': { getPushToken: () => pushToken },
    '../lib/analytics': {}, '../store/pins': {}, '../lib/useRequestMap': {}, './useLogs': {},
    '../transport/wsTransport': {}, './usePty': {}, '../lib/agentActions': {}, '../lib/machineSecurity': {},
  });
  return { storage, asyncStorage, delayedReads, shared, auth, messages, actions, notifications, jobs, ws, registrations,
    mount: () => useWebSocket(), stop: () => cleanup(), connect: () => connectUrl(),
    delayPush: value => { pushToken = value; }, delayUrl: value => { wsUrl = value; },
    status: () => ({ stopped, wsSend, clearedTerminal, logoutCalls }) };
}

test('unmounting the signed-in provider clears personal messages, questions and agent state before demo', async () => {
  const app = harness(); app.mount(); await settle();
  app.messages.useMessageStore.getState().setRecords([record()]);
  app.notifications.getState().setQuestions([{ question_id: 'private-question', pane_id: 'mac::%1' }]);
  app.notifications.getState().setDeepLinkQuestionId('private-question');
  app.notifications.getState().enableAutoYes('mac::%2');
  app.jobs.setState({ jobs: [{ name: 'private-job' }], detectedProcesses: [{ pane_id: 'mac::%1', _agent_alert: 'private alert' }],
    agentActivity: { 'mac::%1': { alert: 'private alert' } }, loaded: true, enabledModels: { codex: ['private-model'] } });
  app.ws.setState({ connected: true, desktopDeviceId: 'mac' });
  app.stop();
  assert.equal(app.messages.useMessageStore.getState().records.length, 0);
  assert.equal(app.notifications.getState().questions.length, 0);
  assert.equal(app.notifications.getState().deepLinkQuestionId, null);
  assert.equal(app.notifications.getState().autoYesPaneIds.size, 0);
  assert.equal(app.jobs.getState().jobs.length, 0);
  assert.equal(app.jobs.getState().detectedProcesses.length, 0);
  assert.equal(Object.keys(app.jobs.getState().agentActivity).length, 0);
  assert.equal(app.jobs.getState().enabledModels, null);
  assert.equal(app.jobs.getState().loaded, false);
  assert.equal(app.ws.getState().desktopDeviceId, null);
  assert.deepEqual(app.status(), { stopped: true, wsSend: null, clearedTerminal: true, logoutCalls: 0 });
  await assert.rejects(app.actions.messageAction({ machine: 'mac', id: 'personal', op: 'dismiss' }), /Sign in/);
});

test('a personal message cache finishing after sign-out cannot repopulate demo or the next account', async () => {
  const app = harness();
  let finishRead;
  app.delayedReads.set('clawtab_messages_alice', new Promise(resolve => { finishRead = resolve; }));
  app.mount(); app.stop();
  finishRead(JSON.stringify([record()])); await settle();
  assert.equal(app.messages.useMessageStore.getState().records.length, 0);
  app.auth.setState({ userId: 'bob' }); app.mount(); await settle();
  assert.equal(app.messages.useMessageStore.getState().records.length, 0);
  app.messages.useMessageStore.getState().setRecords([record('bob-message')]);
  assert.equal(JSON.parse(app.storage.get('clawtab_messages_bob'))[0].id, 'bob-message');
  assert.equal(app.storage.has('clawtab_messages_alice'), false);
  app.stop();
});

test('a late push permission response from the previous session cannot register after sign-out', async () => {
  const app = harness(); let finishPermission;
  app.delayPush(new Promise(resolve => { finishPermission = resolve; }));
  app.mount(); app.stop(); finishPermission('fixture-device-token'); await settle();
  assert.equal(app.registrations.length, 0);
});

test('an expired connection from the previous account cannot sign out the next account', async () => {
  const app = harness(); let failConnection;
  app.delayUrl(new Promise((resolve, reject) => { failConnection = reject; }));
  app.mount(); const connecting = app.connect();
  app.stop(); app.auth.setState({ userId: 'bob' });
  failConnection(Object.assign(new Error('Expired previous account'), { status: 401 }));
  await assert.rejects(connecting, /Expired previous account/);
  assert.equal(app.status().logoutCalls, 0);
});

test('jobs and questions load only from their account and ignore the old unowned cache', async () => {
  const app = harness(), timers = new Map(); let nextTimer = 0;
  const cache = load('remote/src/lib/jobCache.ts', { '@react-native-async-storage/async-storage': app.asyncStorage }, {
    setTimeout: callback => { timers.set(++nextTimer, callback); return nextTimer; },
    clearTimeout: id => timers.delete(id),
  });
  app.storage.set('clawtab_cached_jobs', JSON.stringify([{ name: 'old-personal-job' }]));
  app.storage.set('clawtab_cached_questions', JSON.stringify([{ question_id: 'old-personal-question' }]));
  assert.equal(await cache.loadCache('bob'), null);
  cache.saveJobsCache('alice', [{ name: 'private-job' }], { 'private-job': { state: 'running' } });
  cache.saveQuestionsCache('alice', [{ question_id: 'private-question' }]);
  for (const callback of timers.values()) callback(); timers.clear();
  const personal = await cache.loadCache('alice');
  assert.equal(personal.jobs[0].name, 'private-job');
  assert.equal(personal.questions[0].question_id, 'private-question');
  assert.equal(await cache.loadCache('bob'), null);
  cache.saveQuestionsCache('alice', [{ question_id: 'delayed-personal-question' }]);
  await cache.clearCache('alice');
  assert.equal(timers.size, 0);
  assert.equal(await cache.loadCache('alice'), null);
  assert.equal(app.storage.has('clawtab_cached_questions'), false);
});

test('demo headers cannot expose or open a stale personal notification badge', () => {
  const app = harness(); let pathname = '/';
  app.messages.useMessageStore.getState().setRecords(Array.from({ length: 47 }, (_, index) => record(String(index))));
  const jsx = (type, props) => ({ type, props });
  const { NotificationsMenuButton } = load('remote/src/components/NotificationsMenuButton.tsx', {
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-native': { Platform: { OS: 'ios' }, StyleSheet: { create: value => value }, View: 'View', Text: 'Text', Pressable: 'Pressable' },
    '@expo/vector-icons': { Ionicons: 'Ionicons' },
    'expo-glass-effect': {},
    'expo-router': { usePathname: () => pathname, useRouter: () => ({}) },
    '@clawtab/shared': { ...app.shared, colors: {}, useMachines: () => machines },
    '../store/auth': { useAuthStore: app.auth },
    '../store/notifications': { useNotificationStore: app.notifications },
    '../store/jobs': { useJobsStore: app.jobs },
    '../store/messages': app.messages,
    '../hooks/useResponsive': { useResponsive: () => ({ isSplitView: false }) },
  });
  const machines = { connected: false, error: null };
  app.auth.setState({ isAuthenticated: false });
  assert.equal(NotificationsMenuButton({}), null);
  app.auth.setState({ isAuthenticated: true });
  machines.error = 'Relay subscription required';
  assert.equal(NotificationsMenuButton({}), null);
  machines.error = null;
  for (pathname of ['/demo', '/demo/claude', '/demo-agent', '/demo-agent-details', '/demo-overview']) {
    assert.equal(NotificationsMenuButton({}), null);
  }
  pathname = '/';
  const button = NotificationsMenuButton({}).props.children[0];
  assert.equal(button.props.accessibilityLabel, '47 pending notifications');
});
