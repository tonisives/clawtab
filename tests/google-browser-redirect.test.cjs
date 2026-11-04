const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('../desktop/node_modules/typescript');

function fixture(userAgent = 'iPhone', maxTouchPoints = 1, now = 1000) {
  const values = new Map(), events = [];
  let resolveLogin, rejectLogin;
  const window = {
    sessionStorage: { setItem: (key, value) => values.set(key, value), getItem: key => values.get(key) ?? null, removeItem: key => values.delete(key) },
    location: { origin: 'https://remote.clawtab.cc', pathname: '/login', search: '?return_to=workspace',
      assign: url => events.push(['assign', url]), replace: url => events.push(['replace', url]) },
    history: { replaceState: (_, __, url) => events.push(['clean', url]) },
  };
  const exports = {};
  const source = ts.transpileModule(fs.readFileSync(require.resolve('../remote/src/lib/googleBrowserRedirect.web.ts'), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  vm.runInNewContext(source, { exports, window, navigator: { userAgent, maxTouchPoints }, URL, Date: { now: () => now },
    require: () => ({ useAuthStore: { getState: () => ({ googleLogin: token => {
      events.push(['login', token]);
      return new Promise((resolve, reject) => { resolveLogin = resolve; rejectLogin = reject; });
    } }) } }),
  });
  return { ...exports, values, events, window, resolve: () => resolveLogin(), reject: () => rejectLogin(new Error('Network failure')) };
}
const request = { url: 'https://accounts.google.com/o/oauth2/v2/auth?state=expected', state: 'expected' };

for (const [agent, touch] of [['iPhone', 1], ['iPad', 1], ['Macintosh', 5], ['CriOS iPhone', 1]]) {
  test(`${agent} uses the current browser tab through Google and back to ClawTab`, async () => {
    const f = fixture(agent, touch);
    assert.equal(f.beginGoogleBrowserRedirect(request, '/workspace'), true);
    assert.deepEqual(f.events, [['assign', request.url]]);
    f.window.location.pathname = '/';
    assert.equal(f.completeGoogleBrowserRedirect(new URLSearchParams('id_token=identity&state=expected')), true);
    assert.deepEqual(f.events.slice(1), [['clean', '/'], ['login', 'identity']]);
    assert.equal(f.values.size, 0);
    f.resolve(); await new Promise(setImmediate);
    assert.deepEqual(f.events.at(-1), ['replace', 'https://remote.clawtab.cc/workspace']);
  });
}

test('desktop web keeps the existing popup flow', () => {
  for (const agent of ['Macintosh', 'Windows Chrome', 'Android Chrome']) {
    const f = fixture(agent, 0);
    assert.equal(f.beginGoogleBrowserRedirect(request, '/'), false);
    assert.deepEqual(f.events, []);
    assert.equal(f.values.size, 0);
  }
});

test('a mismatched or expired callback cannot authenticate', () => {
  for (const expired of [false, true]) {
    const f = fixture();
    f.beginGoogleBrowserRedirect(request, '/');
    if (expired) {
      for (const [key, value] of f.values) f.values.set(key, JSON.stringify({ ...JSON.parse(value), startedAt: -1000000 }));
    }
    f.completeGoogleBrowserRedirect(new URLSearchParams(`id_token=identity&state=${expired ? 'expected' : 'wrong'}`));
    assert.equal(f.events.some(([kind]) => kind === 'login'), false);
    const url = new URL(f.events.at(-1)[1]);
    assert.equal(url.pathname, '/login');
    assert.equal(url.searchParams.get('return_to'), 'workspace');
    assert.match(url.searchParams.get('auth_error'), /expired/);
  }
});

test('cancellation and a failed exchange return to login with an error', async () => {
  for (const cancelled of [true, false]) {
    const f = fixture();
    f.beginGoogleBrowserRedirect(request, '/workspace');
    f.completeGoogleBrowserRedirect(new URLSearchParams(cancelled ? 'error=access_denied&state=expected' : 'id_token=identity&state=expected'));
    if (!cancelled) { f.reject(); await new Promise(setImmediate); }
    const url = new URL(f.events.at(-1)[1]);
    assert.equal(url.pathname, '/login');
    assert.match(url.searchParams.get('auth_error'), cancelled ? /cancelled/ : /failed/);
    assert.equal(url.searchParams.has('id_token'), false);
  }
});

test('a popup callback without a same-tab request is left to Expo', () => {
  const f = fixture();
  assert.equal(f.completeGoogleBrowserRedirect(new URLSearchParams('id_token=identity&state=expected')), false);
  assert.deepEqual(f.events, []);
});
