const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('../desktop/node_modules/typescript');

function load(file, modules, globals = {}) {
  const source = ts.transpileModule(fs.readFileSync(require.resolve(file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(source, { exports, ...globals, require: name => {
    assert.ok(name in modules, `Unexpected import: ${name}`);
    return modules[name];
  } });
  return exports;
}

test('web funnel events use the existing tag once and fixed app context', () => {
  const calls = [];
  const browser = { location: { hostname: 'remote.clawtab.cc' }, gtag: (...args) => calls.push(args) };
  const navigator = { doNotTrack: '0' };
  const analytics = load('../remote/src/lib/analytics.web.ts', {}, {
    window: browser, navigator,
    document: { cookie: 'ct_entry=%2Farticles%2Fauto-yes', createElement: () => ({}), head: { appendChild: () => {} } },
  });
  analytics.trackFunnelEvent('setup_started'); analytics.trackFunnelEvent('setup_started');
  const events = calls.filter(call => call[0] === 'event' && call[1] === 'setup_started');
  assert.equal(events.length, 1);
  assert.equal(events[0][2].client_platform, 'web');
  assert.equal(events[0][2].source_page, '/web-remote');
  assert.equal(events[0][2].page_location, 'https://remote.clawtab.cc/');
  assert.equal(events[0][2].entry_page, '/articles/auto-yes');
  navigator.doNotTrack = '1'; analytics.trackFunnelEvent('terminal_viewed');
  assert.equal(calls.filter(call => call[1] === 'terminal_viewed').length, 0);
  navigator.doNotTrack = '0'; browser.location.hostname = 'own-relay.example';
  analytics.trackFunnelEvent('agent_answer_sent');
  assert.equal(calls.filter(call => call[1] === 'agent_answer_sent').length, 0);
});

function bridge(platform = 'web') {
  const values = new Map(), events = [], firstParty = [];
  const storage = { getItem: async key => values.get(key) ?? null, setItem: async (key, value) => values.set(key, value) };
  const app = load('../remote/src/lib/funnel.ts', {
    'react-native': { Platform: { OS: platform } },
    'expo-crypto': { randomUUID: () => 'uuid' },
    './storage': storage,
    './analytics': { trackFunnelEvent: event => events.push(event) },
    '../../../shared/src/funnel': {
      FUNNEL_DISABLED_KEY: 'clawtab_analytics_disabled',
      createFunnelTracker: (_, store, uuid, enabled) => async event => {
        if (await enabled() && await store.getItem('clawtab_analytics_disabled') !== '1') firstParty.push(event);
      },
    },
  }, { __DEV__: false, window: { location: { hostname: 'remote.clawtab.cc' } }, navigator: { doNotTrack: '0' } });
  return { ...app, values, events, firstParty };
}

test('the analytics switch and self hosting block both web collection paths', async () => {
  const app = bridge();
  app.values.set('clawtab_analytics_disabled', '1'); await app.trackFunnel('app_open');
  assert.deepEqual(app.events, []); assert.deepEqual(app.firstParty, []);
  app.values.delete('clawtab_analytics_disabled'); app.values.set('clawtab_server_url', 'https://own-relay.example');
  await app.trackFunnel('app_open');
  assert.deepEqual(app.events, []); assert.deepEqual(app.firstParty, []);
  app.values.delete('clawtab_server_url'); await app.trackFunnel('host_connected');
  assert.deepEqual(app.events, ['host_connected']); assert.deepEqual(app.firstParty, ['host_connected']);
});

test('native clients send to ClawTab without also using the web tag', async () => {
  const app = bridge('ios'); await app.trackFunnel('upgrade_view');
  assert.deepEqual(app.events, []); assert.deepEqual(app.firstParty, ['upgrade_view']);
});
