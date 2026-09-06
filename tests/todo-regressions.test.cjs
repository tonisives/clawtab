const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('../desktop/node_modules/typescript');

const load = (file, dependencies = {}, globals = {}) => {
  const source = ts.transpileModule(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
  }).outputText;
  const exports = {};
  const context = { exports, require: (name) => {
    if (!(name in dependencies)) throw new Error(`Unexpected dependency: ${name}`);
    return dependencies[name];
  }, atob, btoa, setTimeout, clearTimeout, AbortController, Error, ...globals };
  vm.runInNewContext(source, context, { filename: file });
  return exports;
};

const { encodeTerminalInput } = load('shared/src/util/terminalInput.ts');

test('terminal input preserves straight and smart apostrophes, non-Latin text, control keys, and surrogate pairs', () => {
  for (const value of ["it's", 'it\u2019s', '\u0e44\u0e17\u0e22', '\u4e2d\u6587', '\ud834\udd1e', '\ud800', '\x1b[A', 'first\nsecond']) {
    assert.equal(encodeTerminalInput(value), Buffer.from(value, 'utf8').toString('base64'));
  }
});

test('terminal encoder remains self-contained when embedded in the WebView', () => {
  const embedded = vm.runInNewContext(`(${encodeTerminalInput.toString()})`);
  assert.equal(embedded('smart\u2019quote'), Buffer.from('smart\u2019quote').toString('base64'));
});

const models = load('shared/src/types/process.ts');
for (const file of ['remote/src/lib/agentModels.ts', 'desktop/src/components/JobEditor/utils.ts']) {
  const { buildModelOptions } = load(file, { '@clawtab/shared': models, './types': {} });
  test(`${file}: pickers honor checked models and place Astra first`, () => {
    const result = buildModelOptions(['claude', 'codex'], {
      codex: ['gpt-5.6-sol', 'gpt-6-astra', 'codex-high', 'gpt-6-astra'],
      claude: ['claude-opus-5', 'claude-sonnet-5'],
    });
    assert.equal(result.length, 4);
    assert.equal(result[0].modelId, 'gpt-6-astra');
    assert.equal(result.filter((model) => model.provider === 'claude').length, 2);
    assert.equal(buildModelOptions(['claude', 'codex'], { claude: [], codex: [] }).length, 0);
    assert.equal(buildModelOptions(['codex'], { codex: ['my-custom-model'] })[0].modelId, 'my-custom-model');
    assert.ok(buildModelOptions(['codex'], {}).length > 0);
  });
}

const { createTerminalCache } = load('remote/src/lib/terminalCache.ts');
const b64 = (text) => Buffer.from(text).toString('base64');
test('terminal cache replays recent panes, evicts LRU, and handles a combined reset/redraw', () => {
  const cache = createTerminalCache(5);
  for (let i = 0; i < 5; i++) cache.append(`%${i}`, b64(`screen ${i}`));
  cache.get('%0');
  cache.append('%5', b64('screen 5'));
  assert.equal(cache.get('%1').length, 0);
  assert.equal(cache.get('%0').length, 1);
  cache.append('%0', b64('\x1bcnew snapshot'));
  assert.equal(cache.get('%0').length, 1);
  assert.equal(Buffer.from(cache.get('%0')[0], 'base64').toString(), '\x1bcnew snapshot');
  cache.setLimit(0);
  assert.equal(cache.get('%0').length, 0);
  cache.append('%0', b64('disabled'));
  assert.equal(cache.get('%0').length, 0);
  cache.setLimit(10);
  for (let i = 0; i < 10; i++) cache.append(`%${i}`, b64('screen'));
  assert.equal(cache.get('%0').length, 1);
  cache.clear();
  assert.equal(cache.get('%0').length, 0);
});

test('terminal cache bounds bytes without splitting individual output chunks', () => {
  const cache = createTerminalCache();
  for (let i = 0; i < 10; i++) cache.append('%1', b64('x'.repeat(40000)));
  const chunks = cache.get('%1');
  assert.ok(chunks.reduce((size, chunk) => size + chunk.length, 0) <= 384 * 1024);
  assert.ok(chunks.every((chunk) => Buffer.from(chunk, 'base64').length === 40000));
});

const setupApi = (fetch) => {
  const stored = new Map([['clawtab_refresh_token', 'test-refresh']]);
  const storage = {
    getItem: async (key) => stored.get(key) ?? null,
    setItem: async (key, value) => { stored.set(key, value); },
    deleteItem: async (key) => { stored.delete(key); },
  };
  const api = load('remote/src/api/client.ts', { '../lib/storage': storage }, { fetch });
  return { api, stored };
};

test('concurrent refresh callers share one rotating credential request', async () => {
  let calls = 0;
  const { api, stored } = setupApi(async () => {
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { ok: true, status: 200, json: async () => ({ access_token: 'test-access-new', refresh_token: 'test-refresh-new', user_id: 'test-user' }) };
  });
  await Promise.all([api.refreshToken(), api.refreshToken(), api.refreshToken()]);
  assert.equal(calls, 1);
  assert.equal(stored.get('clawtab_refresh_token'), 'test-refresh-new');
});

test('network and server errors do not invalidate saved refresh credentials', async () => {
  for (const failure of ['network', 503, 401]) {
    const { api } = setupApi(async () => {
      if (failure === 'network') throw new TypeError('Network unavailable');
      return { ok: false, status: failure, text: async () => '{"error":"failed"}' };
    });
    let error;
    try { await api.refreshToken(); } catch (caught) { error = caught; }
    assert.ok(error);
    assert.equal(api.isInvalidRefreshError(error), failure === 401);
  }
});

test('invalid and missing JWT expiries trigger refresh recovery', () => {
  const { api } = setupApi(() => { throw new Error('Unexpected fetch'); });
  assert.equal(api.isTokenExpiringSoon('malformed'), true);
  assert.equal(api.isTokenExpiringSoon(`x.${b64('{}')}.x`), true);
  const future = Buffer.from(JSON.stringify({ exp: Date.now() / 1000 + 3600 })).toString('base64url');
  assert.equal(api.isTokenExpiringSoon(`x.${future}.x`), false);
});

test('auth initialization and reconnect retain login through transient refresh failures', async () => {
  for (const status of [undefined, 503, 401]) {
    let state;
    let cleared = 0;
    const error = Object.assign(new Error('Refresh failed'), { status });
    const api = {
      getStoredTokens: async () => ({ accessToken: 'old-test-token', userId: 'test-user' }),
      isTokenExpiringSoon: () => true,
      refreshToken: async () => { throw error; },
      isInvalidRefreshError: (value) => value.status === 401,
      clearTokens: async () => { cleared++; },
    };
    load('remote/src/store/auth.ts', {
      zustand: { create: (initialize) => { state = initialize((update) => Object.assign(state, update)); return state; } },
      '../api/client': api,
      '../lib/jobCache': { clearCache: async () => {} },
      '../lib/terminalCache': { terminalCache: { clear: () => {} } },
    });
    await state.init();
    assert.equal(state.isAuthenticated, status !== 401);
    assert.equal(cleared, status === 401 ? 1 : 0);
    if (status !== 401) {
      assert.equal(await state.refreshToken(), false);
      assert.equal(state.isAuthenticated, true);
      assert.equal(cleared, 0);
    }
  }
});
