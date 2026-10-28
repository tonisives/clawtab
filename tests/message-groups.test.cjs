const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

function surface() {
  const host = { addEventListener() {} };
  const window = { matchMedia: () => ({ matches: true, addEventListener() {} }), addEventListener() {} };
  window.parent = window;
  const source = fs.readFileSync(require.resolve("../shared/src/nfn/surface.js"), "utf8")
    .replace("  window.nfn = {", "  window.groups = { records, pendingCards, cardMessages, performAction, actionsInProgress }; hiddenByUser = true; render = () => {};\n  window.nfn = {");
  vm.runInNewContext(source, {
    window, document: { getElementById: () => host, addEventListener() {} },
    ResizeObserver: class { observe() {} }, setTimeout, clearTimeout,
  });
  return { ...window.groups, receive: window.nfn.receive, window };
}
const record = (id, time, source = { pane_id: "%1", session_id: "a" }, extra = {}) => ({
  id, created_at: time, status: "pending", request: { source, title: id, body: id }, ...extra,
});

test("one agent card retains its messages in order and uses the latest message", () => {
  const app = surface();
  for (const item of [record("new", 3), record("old", 1), record("middle", 2)]) app.records.set(item.id, item);
  assert.deepEqual(Array.from(app.pendingCards(), item => item.id), ["new"]);
  assert.deepEqual(Array.from(app.cardMessages(app.records.get("new")), item => item.id), ["old", "middle", "new"]);
});

test("sessions, restarted agents, different hosts, and unidentified messages remain separate", () => {
  const app = surface();
  const messages = [record("a", 1), record("session-b", 2, { pane_id: "%1", session_id: "b" }),
    record("restarted", 3, { pane_id: "%1", session_id: "a", agent_started_at: 99 }),
    record("host-b", 4, undefined, { machine_id: "other-host" }), record("unknown-a", 5, {}), record("unknown-b", 6, {})];
  for (const item of messages) app.records.set(item.id, item);
  assert.equal(app.pendingCards().length, messages.length);
});

test("ignored agents disappear from pending cards without resolving their messages", () => {
  const app = surface();
  const ignored = record("ignored", 1, undefined, { ignored: true });
  app.records.set(ignored.id, ignored);
  assert.equal(app.pendingCards().length, 0);
  assert.equal(ignored.status, "pending");
  ignored.ignored = false;
  assert.equal(app.pendingCards()[0].id, ignored.id);
});

test("a successful latest response closes earlier cards but leaves a newer arrival pending", async () => {
  const app = surface();
  for (const item of [record("old", 1), record("latest", 2)]) app.records.set(item.id, item);
  app.window.webkit = { messageHandlers: { nfn: { postMessage({ token, command }) {
    assert.equal(command.id, "latest");
    app.records.set("unloaded", record("unloaded", 0));
    assert.equal(app.pendingCards().length, 0);
    app.records.set("newer", record("newer", 3));
    app.receive({ type: "response", token, value: { ...app.records.get("latest"), status: "resolved" } });
  } } } };
  await app.performAction("latest", { op: "respond", id: "latest", action_id: "approve" });
  assert.equal(app.records.get("old").status, "superseded");
  assert.equal(app.records.get("unloaded").status, "superseded");
  assert.deepEqual(Array.from(app.pendingCards(), item => item.id), ["newer"]);
});

test("a failed latest response restores the entire group for retry", async () => {
  const app = surface();
  for (const item of [record("old", 1), record("latest", 2)]) app.records.set(item.id, item);
  app.window.webkit = { messageHandlers: { nfn: { postMessage({ token }) {
    app.receive({ type: "response", token, error: "Agent is busy" });
  } } } };
  await app.performAction("latest", { op: "respond", id: "latest", action_id: "approve" });
  assert.equal(app.actionsInProgress.size, 0);
  assert.deepEqual(Array.from(app.cardMessages(app.pendingCards()[0]), item => item.id), ["old", "latest"]);
});
