const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("../desktop/node_modules/typescript");
const base = path.resolve(__dirname, "../remote/src/lib");
const shared = {
  resourceKey: (machine, id) => `${machine}::${id}`,
  messagePending: record => !record.dismissed_at && ["pending", "delivering"].includes(record.status),
};
const modules = { "@clawtab/shared": shared };
function load(name) {
  if (modules[name]) return modules[name];
  const exports = {};
  const source = ts.transpileModule(fs.readFileSync(path.join(base, `${name}.ts`), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(source, { exports, require: dependency => load(dependency.replace(/^\.\//, "")) });
  return modules[name] = exports;
}
const routes = load("messageRoutes");
const { messageNotificationRoute } = load("messageNotificationRoute");
const presentation = load("messagePresentation");
const { messageSurfaceController } = load("messageSurfaceController");
const record = (machine, id = "same-id", extra = {}) => ({
  machine_id: machine, id, status: "pending", created_at: 10,
  request: { title: "Review post", body: "Caption", template: "social-review", source: { pane_id: `${machine}::%1` },
    actions: [{ id: "approve", kind: "choice", label: "Post to X" }], media: [{ kind: "video", src: "https://cdn.clawtab.cc/review.mp4", alt: "Launch preview" }] },
  ...extra,
});

test("specific message routes preserve machine and escaped message IDs", () => {
  const target = routes.messageTarget({ machine_id: "mac-a", message_id: "review/#?caption" });
  assert.equal(routes.messagePath(target), "/notifications/message/review%2F%23%3Fcaption?machine=mac-a");
  assert.equal(routes.messageTarget({ message_id: "review" }), null);
  assert.equal(routes.messageTarget({ machine_id: "", message_id: "review" }), null);
});

test("local and APNs notification body taps select the same exact message", () => {
  const clawtab = { event: "message", machine_id: "mac-b", message_id: "approval-8" };
  const local = { notification: { request: { content: { data: { clawtab } } } } };
  const remote = { notification: { request: { content: { data: {} }, trigger: { payload: { clawtab } } } } };
  assert.equal(messageNotificationRoute(local), "/notifications/message/approval-8?machine=mac-b");
  assert.equal(messageNotificationRoute(remote), messageNotificationRoute(local));
  assert.equal(messageNotificationRoute({ notification: { request: { content: { data: {} } } } }), null);
});

test("surface record identity and arrivals distinguish hosts with identical IDs", () => {
  const a = record("mac-a"), b = record("mac-b");
  assert.equal(presentation.surfaceRecord(a).id, "mac-a::same-id");
  assert.equal(presentation.surfaceRecord(a).request.template, "social-review");
  assert.equal(presentation.targetRecord([a, b], { machine: "mac-b", id: "same-id" }), b);
  assert.equal(presentation.newMessageArrival(new Set(["mac-a::same-id"]), [a, b]), b);
  assert.equal(presentation.newMessageArrival(new Set(), [record("mac-a", "resolved", { status: "resolved" })]), null);
});

function harness(records = [record("mac-a"), record("mac-b")]) {
  const calls = [], opened = [];
  const options = {
    records: () => records,
    machines: () => [{ id: "mac-a", online: true }, { id: "mac-b", online: true }],
    host: async (machine, command) => {
      calls.push({ machine, ...command });
      if (command.op === "list") return { records: records.filter(record => record.machine_id === machine) };
      if (command.op === "get") return record(machine, command.id);
      if (command.op === "context") return { log: "Ready", source: { pane_id: "%1" } };
      return {};
    },
    update: value => records.push(value),
    navigate: value => opened.push(value),
    act: async action => {
      calls.push(action);
      records = records.map(record => record.machine_id === action.machine && record.id === action.id
        ? { ...record, status: "resolved", response: { action_id: action.action_id, text: action.text } } : record);
    },
  };
  return { controller: messageSurfaceController(options), calls, opened, options };
}

test("surface replies target the owning machine and preserve social action and text", async () => {
  const h = harness();
  const result = await h.controller.execute({ op: "respond", id: "mac-b::same-id", action_id: "approve", text: "Final caption" });
  assert.equal(result.id, "mac-b::same-id");
  assert.equal(result.status, "resolved");
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls)), [{ machine: "mac-b", id: "same-id", op: "respond", action_id: "approve", text: "Final caption" }]);
});

test("missing deep-link record is fetched from its machine before opening", async () => {
  const h = harness([]);
  const result = await h.controller.execute({ op: "get", id: "mac-b::older-message" });
  assert.equal(result.id, "mac-b::older-message");
  assert.equal(result.request.source.pane_id, "mac-b::%1");
  assert.equal(result.request.media[0].kind, "video");
  await h.controller.execute({ op: "focus", id: "mac-b::older-message" });
  assert.equal(h.opened[0].request.source.pane_id, "mac-b::%1");
  assert.equal(h.calls.length, 1);
});

test("context keeps scoped source IDs for remote agent navigation", async () => {
  const h = harness();
  const result = await h.controller.execute({ op: "context", id: "mac-b::same-id" });
  assert.equal(result.source.pane_id, "mac-b::%1");
  assert.equal(h.calls[0].id, "same-id");
});

test("message history merges hosts without collapsing equal IDs", async () => {
  const h = harness();
  const result = await h.controller.execute({ op: "list", offset: 0, pending_only: true });
  assert.equal(result.records.length, 2);
  assert.notEqual(result.records[0].id, result.records[1].id);
});

test("offline replies stay visible until the host confirms a decision", async () => {
  const h = harness();
  h.options.act = async () => {};
  await assert.rejects(h.controller.execute({ op: "respond", id: "mac-a::same-id", action_id: "approve" }), /Saved. Waiting/);
});

test("generated mobile document uses the production surface and native bridge", () => {
  const { messageDocument } = require("../remote/scripts/message-surface.cjs");
  const document = messageDocument();
  assert.ok(document.includes(fs.readFileSync(path.resolve(__dirname, "../shared/src/nfn/surface.js"), "utf8")));
  assert.ok(document.includes("window.ReactNativeWebView.postMessage"));
  assert.ok(document.includes("media-src https: clawtab-nfn:"));
});
