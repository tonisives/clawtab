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
    let models = { enabled_models: { codex: ['custom-model'], claude: [] }, default_provider: 'codex', default_model: 'custom-model' };
    assert.equal((await prefs(a)).agent_models, null);
    await prefs(a, { agent_models: models, initialize: true });
    await prefs(a, { agent_models: { ...models, default_model: null }, initialize: true });
    assert.deepEqual((await prefs(a)).agent_models, models, 'An old desktop cannot overwrite initialized account models');
    assert.equal((await prefs(b)).agent_models, null, 'Models are account scoped');
    let machine = await request('/devices/pair', a.access_token, { device_name: 'Preference test' });
    let second = await request('/devices/pair', a.access_token, { device_name: 'Second preference test' });
    let appearance = { machine_id: machine.device_id, icon: 'server', color: '#34b3a0' };
    await request('/account/preferences', b.access_token, appearance, 403);
    await request('/account/preferences', a.access_token, { ...appearance, color: 'invalid' }, 400);
    await request('/account/preferences', a.access_token, { ...appearance, icon: 'unknown' }, 400);
    await request('/account/preferences', a.access_token, { agent_models: { ...models, enabled_models: { codex: ['bad\nmodel'] } } }, 400);
    await Promise.all([
      prefs(a, appearance),
      prefs(a, { ...appearance, machine_id: second.device_id, icon: 'laptop' }),
      prefs(a, { group: 'group-c', hidden: true }),
      prefs(a, { agent_models: { ...models, default_model: null } }),
    ]);
    let saved = await prefs(a);
    assert.deepEqual(saved.agent_models, { ...models, default_model: null });
    assert.deepEqual(saved.agent_models.enabled_models.claude, [], 'Disabled providers remain disabled');
    assert.deepEqual(saved.hidden_groups.sort(), ['group-b', 'group-c']);
    assert.equal(saved.machine_appearance[machine.device_id].icon, 'server');
    assert.equal(saved.machine_appearance[second.device_id].icon, 'laptop');
    assert.deepEqual((await prefs(b)).machine_appearance, {});
    await prefs(a, { group: 'group-c', hidden: false });
    await request('/account/preferences', a.access_token, { group: 'x'.repeat(1025), hidden: true }, 400);
    assert.deepEqual((await prefs(a)).hidden_groups, ['group-b']);
    console.log('Preferences integration passed: account model persistence, initialization, machine ownership, concurrent edits, disabled models, hidden groups, and validation');
  } finally {
    let exited = once(relay, 'exit');
    relay.kill('SIGTERM');
    await exited;
  }
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
