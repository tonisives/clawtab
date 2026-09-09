// Requires a disposable PostgreSQL container on port 55441 and a built relay.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
let binary = process.env.CLAWTAB_TEST_RELAY_BINARY;
if (!binary) throw new Error('Set CLAWTAB_TEST_RELAY_BINARY to the built relay');
let base = 'http://127.0.0.1:18094';
let relay = spawn(binary, [], { cwd: '/private/tmp', stdio: 'ignore', env: {
  PATH: process.env.PATH,
  DATABASE_URL: 'postgresql://postgres@127.0.0.1:55441/postgres',
  JWT_SECRET: randomUUID(), SELF_HOSTED: 'true', LISTEN_ADDR: '127.0.0.1:18094',
} });
let request = async (path, token, body, status = 200) => {
  let response = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.equal(response.status, status, `${path} status`);
  return response.json();
};
(async () => {
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (relay.exitCode !== null) throw new Error('Test relay exited during startup');
      try { ready = (await fetch(base + '/health')).ok; } catch {}
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(ready, 'Test relay started');
    let account = () => request('/auth/register', null, { email: `${randomUUID()}@example.test`, password: randomUUID() });
    let a = await account(), b = await account();
    let prefs = (user, body) => request('/account/preferences', user.access_token, body);
    await request('/account/preferences', null, undefined, 401);
    assert.deepEqual((await prefs(a)).hidden_groups, []);
    await Promise.all(['group-a', 'group-b'].map((group) => prefs(a, { group, hidden: true })));
    assert.deepEqual((await prefs(a)).hidden_groups.sort(), ['group-a', 'group-b']);
    await prefs(a, { group: 'group-a', hidden: true });
    assert.equal((await prefs(a)).hidden_groups.length, 2, 'Hiding is idempotent');
    assert.deepEqual((await prefs(b)).hidden_groups, [], 'Accounts are isolated');
    await prefs(a, { group: 'group-a', hidden: false });
    assert.deepEqual((await prefs(a)).hidden_groups, ['group-b']);
    await request('/account/preferences', a.access_token, { group: 'x'.repeat(1025), hidden: true }, 400);
    assert.deepEqual((await prefs(a)).hidden_groups, ['group-b']);
    console.log('Preferences integration passed: authentication, persistence, concurrent edits, idempotency, account isolation, unhide, validation');
  } finally {
    let exited = once(relay, 'exit');
    relay.kill('SIGTERM');
    await exited;
  }
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
