const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('../desktop/node_modules/typescript');

let load = (status) => {
  let values = new Map([['clawtab_access_token', 'previous-access']]);
  let requests = [], exports = {};
  let source = ts.transpileModule(fs.readFileSync(require.resolve('../remote/src/api/client.ts'), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  vm.runInNewContext(source, {
    exports, Error, Map, setTimeout, clearTimeout,
    require: (name) => name.endsWith('/storage') ? {
      getItem: async (key) => values.get(key), setItem: async (key, value) => values.set(key, value),
    } : { trackRemoteEvent: () => {} },
    fetch: async (url, options) => {
      requests.push({ url, body: JSON.parse(options.body) });
      return { ok: status === 200, status,
        json: async () => ({ user_id: 'review-user', access_token: 'new-access', refresh_token: 'new-refresh' }),
        text: async () => JSON.stringify({ error: 'Unauthorized' }) };
    },
  });
  return { api: exports, values, requests };
};

test('password login uses the relay endpoint and stores the complete successful session', async () => {
  let h = load(200);
  await h.api.passwordLogin(' reviewer@example.com ', ' password ');
  assert.deepEqual(h.requests, [{ url: 'https://relay.clawtab.cc/auth/login', body: { email: 'reviewer@example.com', password: ' password ' } }]);
  assert.equal(h.values.get('clawtab_user_id'), 'review-user');
  assert.equal(h.values.get('clawtab_access_token'), 'new-access');
  assert.equal(h.values.get('clawtab_refresh_token'), 'new-refresh');
});

test('rejected password login preserves the previous session', async () => {
  let h = load(401);
  await assert.rejects(h.api.passwordLogin('reviewer@example.com', 'incorrect'), (error) => error.status === 401);
  assert.equal(h.values.get('clawtab_access_token'), 'previous-access');
  assert.equal(h.values.has('clawtab_refresh_token'), false);
});
