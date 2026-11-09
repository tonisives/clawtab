const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');

function compile(file, dependencies, globals = {}) {
  const exports = {};
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { exports, require: name => { assert.ok(name in dependencies, name); return dependencies[name]; }, Error, setTimeout, clearTimeout, AbortController, atob, ...globals });
  return exports;
}
const response = (status, value) => ({ status, ok: status < 400, text: async () => JSON.stringify(value), json: async () => value });
function fixture(fetcher, locks) {
  const storage = new Map(Object.entries({ clawtab_access_token: 'old', clawtab_refresh_token: 'refresh', clawtab_user_id: 'user' }));
  const dependencies = {
    '../lib/analytics': { trackRemoteEvent() {} },
    '../lib/storage': { getItem: async key => storage.get(key) ?? null, setItem: async (key, value) => storage.set(key, value), deleteItem: async key => storage.delete(key) },
  };
  const api = compile('src/api/client.ts', dependencies, { fetch: fetcher, navigator: locks ? { locks } : {} });
  let state;
  const create = factory => {
    const set = value => Object.assign(state, value);
    state = factory(set, () => state);
    return { getState: () => state, setState: set };
  };
  const auth = compile('src/store/auth.ts', {
    '../api/client': api, zustand: { create },
    '../lib/analytics': { trackRemoteEvent() {} },
    '../lib/jobCache': { clearCache: async () => {} },
    '../lib/terminalCache': { terminalCache: { clear() {} } },
    '../lib/cacheMessageShell': { clearMessageShellCache() {} },
  }).useAuthStore;
  auth.setState({ isAuthenticated: true, userId: 'user', email: 'a@example.com', loading: false });
  return { api, auth, storage };
}

test('an HTTP request with a rejected refresh signs out the existing UI', async () => {
  const app = fixture(async () => response(401, { error: 'Expired' }));
  await assert.rejects(app.api.getDevices(), /Expired/);
  assert.equal(app.auth.getState().isAuthenticated, false);
  assert.equal(app.auth.getState().userId, null);
  assert.equal(app.storage.has('clawtab_access_token'), false);
});

test('network and server errors keep the session available for reconnection', async () => {
  for (const failure of [async () => { throw new Error('Offline'); }, async () => response(503, { error: 'Unavailable' })]) {
    const app = fixture(failure);
    assert.equal(await app.auth.getState().refreshToken(), false);
    assert.equal(app.auth.getState().isAuthenticated, true);
    assert.equal(app.storage.get('clawtab_refresh_token'), 'refresh');
  }
});

test('resuming a tab whose credentials were removed clears its authenticated state', async () => {
  const app = fixture(async () => { throw new Error('Unexpected request'); });
  app.storage.clear();
  await app.auth.getState().init();
  assert.equal(app.auth.getState().isAuthenticated, false);
  assert.equal(app.auth.getState().userId, null);
});

test('a successful refresh retries the original HTTP request and keeps the session', async () => {
  let calls = 0;
  const app = fixture(async (url, options) => {
    calls++;
    if (url.endsWith('/auth/refresh')) return response(200, { user_id: 'user', access_token: 'new', refresh_token: 'next' });
    return options.headers.Authorization === 'Bearer new' ? response(200, []) : response(401, {});
  });
  assert.deepEqual(await app.api.getDevices(), []);
  assert.equal(calls, 3);
  assert.equal(app.auth.getState().isAuthenticated, true);
});

test('another tab can refresh while this tab waits for the shared lock', async () => {
  let release;
  const app = fixture(async () => { throw new Error('Refresh token was reused'); }, {
    request: async (name, run) => { assert.equal(name, 'clawtab-session-refresh'); await new Promise(resolve => { release = resolve; }); return run(); },
  });
  const pending = app.api.refreshToken();
  while (!release) await new Promise(resolve => setImmediate(resolve));
  app.storage.set('clawtab_access_token', 'other-tab-access');
  app.storage.set('clawtab_refresh_token', 'other-tab-refresh');
  release();
  assert.equal((await pending).access_token, 'other-tab-access');
});

test('an old refresh failure cannot clear a newly signed-in account', async () => {
  let reply;
  const app = fixture(async () => new Promise(resolve => { reply = resolve; }));
  const pending = app.api.refreshToken();
  while (!reply) await new Promise(resolve => setImmediate(resolve));
  app.storage.set('clawtab_user_id', 'new-user');
  app.storage.set('clawtab_refresh_token', 'new-user-refresh');
  app.auth.setState({ userId: 'new-user' });
  reply(response(401, { error: 'Old session' }));
  await assert.rejects(pending);
  assert.equal(app.auth.getState().isAuthenticated, true);
  assert.equal(app.storage.get('clawtab_refresh_token'), 'new-user-refresh');
});

test('web resume, cross-tab logout and BFCache restoration revalidate only visible pages', () => {
  const browser = new EventTarget(), page = new EventTarget();
  page.visibilityState = 'visible';
  let checks = 0;
  const { observeWebSession } = compile('src/lib/webSessionRecovery.ts', {});
  const stop = observeWebSession(browser, page, () => checks++);
  browser.dispatchEvent(new Event('focus'));
  browser.dispatchEvent(new Event('pageshow'));
  browser.dispatchEvent(Object.assign(new Event('storage'), { key: 'clawtab_access_token' }));
  browser.dispatchEvent(Object.assign(new Event('storage'), { key: 'other-setting' }));
  assert.equal(checks, 3);
  page.visibilityState = 'hidden';
  page.dispatchEvent(new Event('visibilitychange'));
  assert.equal(checks, 3);
  page.visibilityState = 'visible';
  page.dispatchEvent(new Event('visibilitychange'));
  assert.equal(checks, 4);
  stop();
  browser.dispatchEvent(new Event('focus'));
  assert.equal(checks, 4);
});


test('a transient refresh failure is not reported as the original unauthorized response', async () => {
  const app = fixture(async url => url.endsWith('/auth/refresh')
    ? response(503, { error: 'Temporarily unavailable' }) : response(401, {}));
  await assert.rejects(app.api.getDevices(), error => error.status === 503);
  assert.equal(app.auth.getState().isAuthenticated, true);
  assert.equal(app.storage.get('clawtab_refresh_token'), 'refresh');
});
