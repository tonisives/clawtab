const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('../desktop/node_modules/typescript');

let token = (expires = Date.now() / 1000 + 3600) => `fixture.${Buffer.from(JSON.stringify({ exp: expires })).toString('base64')}.signature`;
let loadApi = (respond, timers = {}) => {
  let values = new Map();
  let calls = [];
  let exports = {};
  let storage = {
    getItem: async (key) => values.get(key) ?? null,
    setItem: async (key, value) => { values.set(key, value); },
    deleteItem: async (key) => { values.delete(key); },
  };
  let source = ts.transpileModule(fs.readFileSync(require.resolve('../remote/src/api/client.ts'), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  vm.runInNewContext(source, {
    exports, require: (name) => name.endsWith('/storage') ? storage : { trackRemoteEvent: () => {} },
    fetch: async (url, options) => {
      calls.push({ path: new URL(url).pathname, options });
      let { status = 200, body } = await respond(new URL(url).pathname, options);
      return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
    },
    setTimeout, clearTimeout, AbortController, atob, URL, URLSearchParams, ...timers,
  });
  return { api: exports, calls, values };
};

test('returning Apple users store relay credentials even when Apple omits name and email', async () => {
  let accessToken = token();
  let { api, calls, values } = loadApi(async (path) => ({ body: path === '/auth/apple'
    ? { user_id: 'returning-user', access_token: accessToken, refresh_token: 'fixture-refresh' }
    : { subscribed: true } }));
  await api.appleAuth('fixture-apple-identity');
  assert.equal(values.get('clawtab_user_id'), 'returning-user');
  assert.equal(await api.getWsUrl(), `wss://relay.clawtab.cc/ws?token=${accessToken}`);
  assert.equal(calls[1].options.headers.Authorization, `Bearer ${accessToken}`);
});

test('denied relay access is explained and manual retry can recover after entitlement changes', async () => {
  let subscribed = false;
  let { api, calls } = loadApi(async () => ({ body: { subscribed } }));
  await api.storeTokens(token(), 'fixture-refresh', 'returning-user');
  await assert.rejects(api.getWsUrl(), /does not have active relay access.*demo/);
  subscribed = true;
  assert.match(await api.getWsUrl(), /^wss:\/\/relay\.clawtab\.cc\/ws\?token=/);
  assert.deepEqual(calls.map((call) => call.path), ['/subscription/status', '/subscription/status']);
});

test('expired relay credentials refresh before checking access for an existing account', async () => {
  let accessToken = token();
  let checks = 0;
  let { api, calls } = loadApi(async (path) => {
    if (path === '/auth/refresh') return { body: { user_id: 'existing-user', access_token: accessToken, refresh_token: 'refreshed-fixture' } };
    return ++checks === 1 ? { status: 401, body: { error: 'Expired credentials' } } : { body: { subscribed: true } };
  });
  await api.storeTokens(token(1), 'fixture-refresh', 'existing-user');
  assert.equal(await api.getWsUrl(), `wss://relay.clawtab.cc/ws?token=${accessToken}`);
  assert.deepEqual(calls.map((call) => call.path), ['/subscription/status', '/auth/refresh', '/subscription/status']);
});

test('invalid returning-account credentials remain recognizable so connection recovery can sign out', async () => {
  let { api } = loadApi(async () => ({ status: 401, body: { error: 'Invalid credentials' } }));
  await api.storeTokens(token(1), 'fixture-refresh', 'existing-user');
  await assert.rejects(api.getWsUrl(), (error) => api.isInvalidRefreshError(error));
});


test('a stalled relay access check times out with a retryable explanation', async () => {
  let expire;
  let { api } = loadApi(async (_path, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('Aborted')));
  }), { setTimeout: (callback) => { expire = callback; return 1; }, clearTimeout: () => {} });
  await api.storeTokens(token(), 'fixture-refresh', 'existing-user');
  let connecting = api.getWsUrl();
  await new Promise(setImmediate);
  expire();
  await assert.rejects(connecting, /timed out.*retry/);
});
