// Run against an isolated SELF_HOSTED=false relay and disposable database only.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const base = process.env.CLAWTAB_TEST_RELAY;
const database = process.env.RENTALS_TEST_DATABASE_URL;
if (!base || !/^http:\/\/127\.0\.0\.1:\d+$/.test(base)) throw new Error('Use an isolated loopback relay');
if (database !== 'postgresql://postgres@127.0.0.1:55439/postgres') throw new Error('Use the disposable rental test database on port 55439');
let sockets = [];
let sql = (input) => execFileSync('psql', [database, '-X', '-q', '-v', 'ON_ERROR_STOP=1'], { input, stdio: ['pipe', 'ignore', 'pipe'] });
let api = async (path, token, body) => {
  let response = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.ok(response.ok, `${path}: ${response.status}`);
  return response.json();
};
let connect = (path) => new Promise((resolve, reject) => {
  let ws = new WebSocket(base.replace('http:', 'ws:') + path);
  sockets.push(ws);
  ws.addEventListener('error', () => reject(new Error('Connection rejected')));
  ws.addEventListener('open', () => resolve(ws));
});
let closes = (ws) => new Promise((resolve, reject) => {
  let timer = setTimeout(() => reject(new Error('Expired rental stayed connected')), 20000);
  ws.addEventListener('close', () => { clearTimeout(timer); resolve(); }, { once: true });
});
let run = async () => {
  let owner = await api('/auth/register', null, { email: `rental-${randomUUID()}@test.invalid`, password: randomUUID() });
  let stranger = await api('/auth/register', null, { email: `stranger-${randomUUID()}@test.invalid`, password: randomUUID() });
  // Credentials remain in memory and never enter SQL or assertion output.
  let user = JSON.parse(Buffer.from(owner.access_token.split('.')[1], 'base64url')).sub;
  assert.match(user, /^[0-9a-f-]{36}$/);
  let rented = await api('/devices/pair', owner.access_token, { device_name: 'Rented host' });
  let ordinary = await api('/devices/pair', owner.access_token, { device_name: 'Ordinary host' });
  assert.match(rented.device_id, /^[0-9a-f-]{36}$/);
  let id = randomUUID();
  sql(`DELETE FROM subscriptions WHERE user_id='${user}';
    INSERT INTO rentals (id,user_id,email,name,state,quote,cost_eur_cents,stripe_customer_id,device_id,paid_until)
    VALUES ('${id}','${user}','rental@test.invalid','Rented host','ready','{}',500,'cus_test','${rented.device_id}',now()+interval '30 days');
    UPDATE devices SET rental_id='${id}' WHERE id='${rented.device_id}';`);
  let path = `/ws?device_token=${encodeURIComponent(rented.device_token)}`;
  let host = await connect(path);
  let ownHost = await connect(`/ws?device_token=${encodeURIComponent(ordinary.device_token)}`);
  let client = await connect(`/v2/ws?token=${owner.access_token}`);
  await assert.rejects(connect(`/v2/ws?token=${stranger.access_token}`));
  let machines = await api('/machines', owner.access_token);
  assert.deepEqual(machines.filter((m) => m.online).map((m) => m.id).sort(), [rented.device_id, ordinary.device_id].sort());
  let status = await api('/subscription/status', owner.access_token);
  assert.equal(status.subscribed, true);
  assert.equal(status.relay_included, true);
  assert.equal(machines.find((m) => m.id === rented.device_id).rental.id, id);
  sql(`UPDATE rentals SET paid_until=now()-interval '9 days',unpaid_since=now()-interval '9 days',delete_at=now()+interval '1 day' WHERE id='${id}';`);
  let disconnected = closes(host);
  host.close();
  await disconnected;
  host = await connect(path);
  // The relay enforces ten days even if the billing worker has not run yet.
  let revokedHost = closes(host), revokedOwn = closes(ownHost), revokedClient = closes(client);
  sql(`UPDATE rentals SET paid_until=now()-interval '11 days',unpaid_since=now()-interval '11 days' WHERE id='${id}';`);
  await Promise.all([revokedHost, revokedOwn, revokedClient]);
  await assert.rejects(connect(path));
  await assert.rejects(connect(`/v2/ws?token=${owner.access_token}`));
  console.log('PASS: paid rental without base plan, owner isolation, account-wide own-host access, grace access, and live expiry revocation');
};
run().catch((error) => { console.error(error.message); process.exitCode = 1; }).finally(() => sockets.forEach((ws) => {
  if (ws.readyState === WebSocket.OPEN) ws.close();
}));
