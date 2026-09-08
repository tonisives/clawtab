// Run against an isolated SELF_HOSTED relay and disposable database only.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
// Uses the WebSocket client built into Node 22+.
const base = process.env.CLAWTAB_TEST_RELAY;
if (!base || !/^http:\/\/127\.0\.0\.1:\d+$/.test(base)) throw new Error('CLAWTAB_TEST_RELAY must be an isolated loopback relay');
let sockets = [];
let api = async (path, token, body, method = body ? 'POST' : 'GET') => {
  let response = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.ok(response.ok, `${method} ${path}: ${response.status}`);
  return response.json();
};
let connect = (path) => new Promise((resolve, reject) => {
  let ws = new WebSocket(base.replace('http:', 'ws:') + path);
  let messages = [], waiters = [];
  sockets.push(ws);
  ws.addEventListener('error', () => reject(new Error('Test WebSocket connection failed')));
  ws.addEventListener('message', (event) => { let message = JSON.parse(event.data); messages.push(message); for (let waiter of [...waiters]) waiter(); });
  ws.addEventListener('open', () => resolve({ ws, messages, send: (message) => ws.send(JSON.stringify(message)), next: (predicate) => new Promise((resolve, reject) => {
    let timer;
    let check = () => { let index = messages.findIndex(predicate); if (index < 0) return; clearTimeout(timer); waiters = waiters.filter((fn) => fn !== check); resolve(messages.splice(index, 1)[0]); };
    timer = setTimeout(() => { waiters = waiters.filter((fn) => fn !== check); reject(new Error('Expected relay event did not arrive')); }, 5000);
    waiters.push(check); check();
  }) }));
});
let command = async (client, machine, message) => {
  let request_id = randomUUID();
  client.send({ version: 2, machine_id: machine, request_id, message: { id: request_id, ...message } });
  return { request_id, reply: () => client.next((v) => v.request_id === request_id) };
};
let run = async () => {
  let owner = await api('/auth/register', null, { email: `owner-${randomUUID()}@test.invalid`, password: randomUUID() });
  let guest = await api('/auth/register', null, { email: `guest-${randomUUID()}@test.invalid`, password: randomUUID() });
  // Tokens stay in this process; assertions and server logs never print them.
  let guestEmail = JSON.parse(Buffer.from(guest.access_token.split('.')[1], 'base64url')).email;
  let share = await api('/shares', owner.access_token, { email: guestEmail, allowed_groups: ['shared'] });
  let a = await api('/devices/pair', owner.access_token, { device_name: 'Host A' });
  let b = await api('/devices/pair', owner.access_token, { device_name: 'Host B' });
  let hostA = await connect(`/ws?device_token=${encodeURIComponent(a.device_token)}`);
  let hostB = await connect(`/ws?device_token=${encodeURIComponent(b.device_token)}`);
  let clients = [await connect(`/v2/ws?token=${owner.access_token}`), await connect(`/v2/ws?token=${owner.access_token}`)];
  await clients[0].next((v) => v.type === 'machines' && v.machines.length === 2);
  let snapshot = { type: 'detected_processes', id: 'snapshot', processes: [{ pane_id: '%1', matched_group: 'shared', execution_id: 'execution-a' }] };
  hostA.send(snapshot); hostB.send({ ...snapshot, processes: [{ ...snapshot.processes[0], execution_id: 'execution-b' }] });
  await clients[0].next((v) => v.type === 'machine_event' && v.machine_id === a.device_id && v.message.type === 'detected_processes');
  let request = await command(clients[0], a.device_id, { type: 'run_agent', prompt: 'test', operation_id: randomUUID() });
  let forwarded = await hostA.next((v) => v.type === 'run_agent');
  assert.equal(hostB.messages.some((v) => v.type === 'run_agent'), false, 'launch routed to more than one host');
  hostA.send({ type: 'run_agent_ack', id: forwarded.id, success: true, pane_id: '%1' });
  let reply = await request.reply(); assert.equal(reply.machine_id, a.device_id);
  assert.equal(clients[1].messages.some((v) => v.request_id === request.request_id), false, 'reply leaked to another client');
  let subscribe = async (client) => {
    let request = await command(client, a.device_id, { type: 'subscribe_pty', pane_id: '%1', execution_id: 'execution-a', tmux_session: 'same', cols: 100, rows: 40 });
    let incoming = await hostA.next((v) => v.type === 'subscribe_pty');
    hostA.send({ type: 'subscribe_pty_ack', id: incoming.id, pane_id: '%1', success: true });
    await request.reply();
  };
  await subscribe(clients[0]); await subscribe(clients[1]);
  request = await command(clients[1], a.device_id, { type: 'pty_input', pane_id: '%1', execution_id: 'execution-a', data: 'eA==' });
  assert.equal((await request.reply()).type, 'machine_error', 'observer was allowed terminal input');
  request = await command(clients[1], a.device_id, { type: 'take_control', pane_id: '%1', execution_id: 'execution-a' });
  assert.equal((await request.reply()).message.type, 'control_ack');
  request = await command(clients[0], a.device_id, { type: 'pty_resize', pane_id: '%1', execution_id: 'execution-a', cols: 20, rows: 10 });
  assert.equal((await request.reply()).type, 'machine_error', 'old controller could resize');
  request = await command(clients[1], a.device_id, { type: 'pty_input', pane_id: '%1', execution_id: 'execution-b', data: 'eA==' });
  assert.equal((await request.reply()).type, 'machine_error', 'stale execution accepted');
  hostA.send({ type: 'claude_questions', questions: [{ pane_id: '%1', question_id: 'question-one', matched_group: 'shared' }] });
  await clients[0].next((v) => v.machine_id === a.device_id && v.message?.type === 'claude_questions');
  request = await command(clients[1], a.device_id, { type: 'answer_question', pane_id: '%1', execution_id: 'execution-a', question_id: 'question-one', answer: '1' });
  forwarded = await hostA.next((v) => v.type === 'answer_question');
  hostA.send({ type: 'answer_question_ack', id: forwarded.id, success: true }); await request.reply();
  hostA.send({ type: 'claude_questions', questions: [{ pane_id: '%1', question_id: 'question-one', matched_group: 'shared' }] });
  request = await command(clients[0], a.device_id, { type: 'answer_question', pane_id: '%1', execution_id: 'execution-a', question_id: 'question-one', answer: '2' });
  assert.equal((await request.reply()).type, 'machine_error', 'question could be answered twice after stale snapshot');
  let guestClient = await connect(`/v2/ws?token=${guest.access_token}`);
  assert.equal((await guestClient.next((v) => v.type === 'machines')).machines.length, 0, 'new machines inherited sharing');
  await api(`/machines/${a.device_id}/grants`, owner.access_token, { share_id: share.id });
  guestClient.send({ type: 'refresh_machines' });
  assert.equal((await guestClient.next((v) => v.type === 'machines')).machines.length, 1);
  request = await command(guestClient, b.device_id, { type: 'list_jobs' });
  assert.equal((await request.reply()).type, 'machine_error', 'guest accessed ungranted machine');
  request = await command(guestClient, a.device_id, { type: 'host_request', request: { action: 'info' } });
  assert.equal((await request.reply()).type, 'machine_error', 'guest accessed owner host management');
  let closed = new Promise((resolve) => guestClient.ws.addEventListener('close', resolve, { once: true }));
  await api(`/machines/${a.device_id}/grants`, owner.access_token, { share_id: share.id }, 'DELETE');
  await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error('revoked guest remained connected')), 5000))]);
  let freshGuest = await connect(`/v2/ws?token=${guest.access_token}`);
  assert.equal((await freshGuest.next((v) => v.type === 'machines')).machines.length, 0);
  console.log('PASS: machine routing, private hosts, requester replies, terminal controller, stale execution, and live access revocation');
};
run().catch((error) => { console.error(error.message); process.exitCode = 1; }).finally(() => sockets.forEach((ws) => ws.close()));
