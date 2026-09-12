const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('../desktop/node_modules/typescript');

let load = (fetch) => {
  let exports = {};
  let source = ts.transpileModule(fs.readFileSync(__dirname + '/../desktop/src/relayLogin.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(source, { exports, fetch, crypto, btoa, URLSearchParams });
  return exports;
};

test('a failed session creation never opens an OAuth flow that cannot return to the dev app', async () => {
  for (let fetch of [async () => new Response('', { status: 503 }), async () => { throw Error('Network unavailable'); }]) {
    let opened = false;
    let { startRelayLogin } = load(fetch);
    await assert.rejects(startRelayLogin('https://relay.example', 'google', new AbortController().signal, async () => { opened = true; }));
    assert.equal(opened, false);
  }
});

test('Google and Apple retain the initiating session even if macOS opens a different app', async () => {
  for (let provider of ['google', 'apple']) {
    let created;
    let browserUrl;
    let controller = new AbortController();
    let { startRelayLogin } = load(async (url, options) => {
      assert.equal(url, 'https://relay.example/auth/session');
      assert.equal(options.method, 'POST');
      assert.equal(options.signal, controller.signal);
      created = JSON.parse(options.body).session_id;
      return new Response(null, { status: 201 });
    });
    let pollUrl = await startRelayLogin('https://relay.example/', provider, controller.signal, async (url) => { browserUrl = new URL(url); });
    assert.equal(pollUrl, `https://relay.example/auth/session/${created}`);
    assert.equal(Buffer.from(browserUrl.searchParams.get('state'), 'base64url').toString(), `clawtab:${created}`);
    assert.equal(browserUrl.searchParams.get('redirect_uri'), `https://relay.example/auth/${provider}/callback`);
    assert.equal(browserUrl.hostname, provider === 'google' ? 'accounts.google.com' : 'appleid.apple.com');
  }
});

test('pending polling is uncached and only complete, nonempty token pairs can be saved', async () => {
  let replies = [{ status: 'pending' }, { status: 'complete', access_token: 'fixture-access', refresh_token: 'fixture-refresh' }];
  let { pollRelayLogin } = load(async (_url, options) => {
    assert.equal(options.cache, 'no-store');
    return Response.json(replies.shift());
  });
  let signal = new AbortController().signal;
  assert.equal(await pollRelayLogin('https://relay.example/auth/session/fixture', signal), null);
  let tokens = await pollRelayLogin('https://relay.example/auth/session/fixture', signal);
  assert.equal(tokens.access_token, 'fixture-access');
  assert.equal(tokens.refresh_token, 'fixture-refresh');
  for (let result of [{ status: 'complete' }, { status: 'complete', access_token: 'fixture-access', refresh_token: '' }, { status: 'unknown' }]) {
    let { pollRelayLogin } = load(async () => Response.json(result));
    await assert.rejects(pollRelayLogin('https://relay.example/auth/session/fixture', signal), /incomplete sign-in result/);
  }
});

test('expired and failed polling report actionable errors', async () => {
  for (let [status, message] of [[404, /expired/], [503, /HTTP 503/]]) {
    let { pollRelayLogin } = load(async () => new Response('', { status }));
    await assert.rejects(pollRelayLogin('https://relay.example/auth/session/fixture', new AbortController().signal), message);
  }
});

test('a cancelled login cannot open a browser or deliver a late credential result', async () => {
  let controller = new AbortController();
  let opened = false;
  let { startRelayLogin } = load(async () => { controller.abort(); return new Response(null, { status: 201 }); });
  await assert.rejects(startRelayLogin('https://relay.example', 'google', controller.signal, async () => { opened = true; }));
  assert.equal(opened, false);

  controller = new AbortController();
  let { pollRelayLogin } = load(async () => {
    controller.abort();
    return Response.json({ status: 'complete', access_token: 'fixture-access', refresh_token: 'fixture-refresh' });
  });
  await assert.rejects(pollRelayLogin('https://relay.example/auth/session/fixture', controller.signal));
});
