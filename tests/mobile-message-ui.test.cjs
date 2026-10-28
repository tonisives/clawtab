const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("../desktop/node_modules/typescript");
const base = path.resolve(__dirname, "../remote/src/lib");
const shared = {
  resourceKey: (machine, id) => `${machine}::${id}`,
  messagePending: record => !record.ignored && !record.dismissed_at && ["pending", "delivering"].includes(record.status),
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
const { messageTodosController, messageTodoMachine, isMessageTodoCommand } = load("messageTodosController");
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
  assert.equal(presentation.newMessageArrival(new Set(), [record("mac-a", "ignored", { ignored: true })]), null);
});

test("ignored agents from different machines retain their host when restored", async () => {
  const h = harness([]);
  h.options.host = async (machine, command) => {
    h.calls.push({ machine, ...command });
    return { agents: [{ id: "same-agent", title: machine, source: { pane_id: "%1" } }] };
  };
  const result = await h.controller.execute({ op: "ignored_agents" });
  assert.deepEqual(Array.from(result.agents, agent => agent.id).sort(), ["mac-a::same-agent", "mac-b::same-agent"]);
  await h.controller.execute({ op: "unignore", id: "mac-b::same-agent" });
  assert.deepEqual(h.calls.at(-1), { machine: "mac-b", op: "unignore", id: "same-agent" });
  assert.equal(h.calls.filter(command => command.op === "get").length, 0);
});

test("ignoring an agent updates its messages from the owning host", async () => {
  const h = harness();
  h.options.host = async (machine, command) => {
    h.calls.push({ machine, ...command });
    return { records: [record(machine, command.id, { ignored: true })] };
  };
  const result = await h.controller.execute({ op: "ignore", id: "mac-b::same-id" });
  assert.equal(result.records[0].id, "mac-b::same-id");
  assert.equal(result.records[0].ignored, true);
  assert.deepEqual(h.calls, [{ machine: "mac-b", op: "ignore", id: "same-id" }]);
});

test("arrival tracking seeds cached and initial host history before showing new messages", () => {
  const tracker = presentation.messageArrivalTracker();
  const cached = record("mac-a", "cached"), old = record("mac-a", "old");
  assert.equal(tracker.observe([], {}), null);
  assert.equal(tracker.observe([cached], {}), null);
  const snapshots = { "mac-a": { messages_changed: { records: [old] } } };
  assert.equal(tracker.observe([cached, old], snapshots), null);
  const fresh = record("mac-a", "fresh", { created_at: 20 });
  assert.equal(tracker.observe([cached, old, fresh], snapshots), fresh);
  assert.equal(tracker.observe([cached, old, fresh], snapshots), null);
});

test("the first host snapshot cannot animate when its store hydration arrives later", () => {
  const tracker = presentation.messageArrivalTracker();
  const old = record("mac-a", "old");
  const snapshots = { "mac-a": { messages_changed: { records: [old] } } };
  assert.equal(tracker.observe([], snapshots), null);
  assert.equal(tracker.observe([old], snapshots), null);
  const fresh = record("mac-a", "fresh");
  assert.equal(tracker.observe([old, fresh], snapshots), fresh);
});

test("arrival tracking initializes hosts independently and ignores replayed history", () => {
  const tracker = presentation.messageArrivalTracker();
  const a = record("mac-a"), b = record("mac-b");
  const snapshots = { "mac-a": { messages_changed: { records: [a] } } };
  assert.equal(tracker.observe([a], snapshots), null);
  snapshots["mac-b"] = { messages_changed: { records: [b] } };
  assert.equal(tracker.observe([a, b], snapshots), null);
  assert.equal(tracker.observe([], snapshots), null);
  assert.equal(tracker.observe([a, b], snapshots), null);
  const fresh = record("mac-b", "fresh");
  assert.equal(tracker.observe([a, b, fresh], snapshots), fresh);
});

test("the popup animates new records while preserving its current message", () => {
  const states = [], effects = [];
  let cursor = 0, changed = false, records = [], snapshots = {}, pathname = "/";
  const inbox = Symbol("MessageInbox");
  const exports = {};
  const dependencies = {
    react: {
      useEffect: effect => effects.push(effect),
      useState: initial => {
        const index = cursor++;
        if (!(index in states)) states[index] = typeof initial === "function" ? initial() : initial;
        return [states[index], value => {
          const next = typeof value === "function" ? value(states[index]) : value;
          if (!Object.is(next, states[index])) { states[index] = next; changed = true; }
        }];
      },
    },
    "react/jsx-runtime": { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) },
    "@clawtab/shared": { useMachines: () => ({ snapshots }) },
    "expo-router": { useGlobalSearchParams: () => ({}), usePathname: () => pathname, useRouter: () => ({ push() {} }) },
    "react-native": { View: "View", Text: "Text", Pressable: "Pressable", StyleSheet: { create: value => value }, useWindowDimensions: () => ({ width: 390, height: 844 }) },
    "react-native-safe-area-context": { useSafeAreaInsets: () => ({ top: 0, left: 0, right: 0, bottom: 0 }) },
    "../store/messages": { useMessageStore: select => select({ records }) },
    "../lib/messagePresentation": presentation,
    "../lib/messageRoutes": routes,
    "./MessageInbox": { MessageInbox: inbox },
  };
  const source = ts.transpileModule(fs.readFileSync(path.resolve(base, "../components/MessageArrival.tsx"), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  vm.runInNewContext(source, { exports, require: name => {
    assert.ok(name in dependencies, `Unexpected popup dependency ${name}`); return dependencies[name];
  } });
  const render = () => {
    let tree;
    do {
      changed = false; cursor = 0; effects.length = 0;
      tree = exports.MessageArrival();
      for (const effect of effects) effect();
    } while (changed);
    return tree?.props.children.find(child => child.type === inbox)?.props ?? null;
  };
  assert.equal(render(), null);
  const old = record("mac-a", "old");
  records = [old]; snapshots = { "mac-a": { messages_changed: { records } } };
  assert.equal(render(), null);
  const first = record("mac-a", "first"); records = [old, first];
  assert.equal(render().arrival, "mac-a::first");
  const second = record("mac-a", "second"); records = [old, first, second];
  const popup = render();
  assert.equal(popup.selection, "mac-a::first");
  assert.equal(popup.arrival, "mac-a::second");
  pathname = "/notifications/message/first";
  assert.equal(render(), null);
  pathname = "/";
  assert.equal(render(), null);
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

test("a live message refresh replaces cached pending state after an answer elsewhere", async () => {
  const h = harness();
  const updates = [];
  h.options.host = async (machine, command) => record(machine, command.id, { status: "resolved" });
  h.options.update = value => updates.push(value);
  const result = await h.controller.execute({ op: "get", id: "mac-b::same-id" });
  assert.equal(result.status, "resolved");
  assert.equal(updates[0].status, "resolved");
  assert.equal(updates[0].machine_id, "mac-b");
  assert.equal(updates[0].request.source.pane_id, "mac-b::%1");
});

test("a fresh pending list excludes handled messages left in local caches", async () => {
  const h = harness();
  await h.controller.execute({ op: "list", offset: 0, pending_only: true });
  h.options.host = async () => ({ records: [] });
  const result = await h.controller.execute({ op: "list", offset: 0, pending_only: true });
  assert.equal(result.records.length, 0);
});

test("offline machines keep their cached messages available during a live list refresh", async () => {
  const h = harness();
  h.options.machines = () => [{ id: "mac-a", online: true }, { id: "mac-b", online: false }];
  h.options.host = async () => ({ records: [] });
  const result = await h.controller.execute({ op: "list", offset: 0, pending_only: true });
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].id, "mac-b::same-id");
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

test("shared task actions use the selected host and open its agent in the remote app", async () => {
  const calls = [], opened = [], updates = [];
  const execute = messageTodosController({
    machine: () => ({ id: "mac-b", online: true }),
    host: async (machine, command) => { calls.push({ machine, ...command }); return { items: [{ id: "task", agent: { pane: "%8" } }] }; },
    update: value => updates.push(value), openAgent: pane => opened.push(pane),
  });
  await execute({ op: "todo_add", text: "Review launch", group: "ClawTab" });
  await execute({ op: "todo_update", id: "task", checked: true });
  await execute({ op: "todo_start", id: "task", cwd: "/projects/clawtab" });
  await execute({ op: "todo_focus", id: "task" });
  assert.deepEqual(calls.map(call => call.op), ["todo_add", "todo_update", "todo_start", "todos"]);
  assert.ok(calls.every(call => call.machine === "mac-b"));
  assert.equal(calls[2].cwd, "/projects/clawtab");
  assert.deepEqual(opened, ["mac-b::%8"]);
  assert.equal(updates.length, 4);
});

test("a late task snapshot cannot overwrite the newly selected machine", async () => {
  let machine = { id: "mac-a", online: true }, finish;
  const updates = [];
  const execute = messageTodosController({ machine: () => machine,
    host: () => new Promise(resolve => { finish = resolve; }), update: value => updates.push(value), openAgent: () => {},
  });
  const pending = execute({ op: "todos" });
  machine = { id: "mac-b", online: true };
  finish({ items: [] });
  await pending;
  assert.equal(updates.length, 0);
});

test("a message-specific task view never falls back to another machine", () => {
  const a = { id: "mac-a", online: true, owned: true };
  const b = { id: "mac-b", online: false, owned: true };
  assert.equal(messageTodoMachine([a], "mac-a", "mac-b::review"), undefined);
  assert.equal(messageTodoMachine([a, b], "mac-a", "mac-b::review"), b);
  assert.equal(messageTodoMachine([a, b], "mac-a", null), a);
  assert.equal(messageTodoMachine([a, b], null, null), a);
});

test("remote task controls reject desktop source linking and disconnected mutations", async () => {
  const execute = messageTodosController({ machine: () => ({ id: "mac-a", online: false }),
    host: async () => assert.fail("offline task must not send"), update: () => {}, openAgent: () => {},
  });
  assert.equal(isMessageTodoCommand({ op: "todo_link" }), false);
  await assert.rejects(execute({ op: "todo_link", note: "/notes/today.md" }), /Unsupported/);
  await assert.rejects(execute({ op: "todo_update", id: "task", checked: true }), /Connect/);
});

for (const variant of ["MessageSurface.web.tsx", "MessageSurface.tsx"]) {
  test(`${variant}: clearing and restoring a deep link cannot retain the previous message`, () => {
    const refs = [], effects = [], sent = [];
    let cursor = 0;
    const react = {
      useRef: value => refs[cursor++] ??= { current: value },
      useCallback: callback => callback,
      useEffect: effect => effects.push(effect),
    };
    const target = { postMessage: value => sent.push(value) };
    const frame = { contentWindow: target, injectJavaScript: source => vm.runInNewContext(source, { window: { nfn: { receive: value => sent.push(value) } } }) };
    const dependencies = {
      react, "react/jsx-runtime": { jsx: (type, props) => ({ type, props }) },
      "react-native-webview": { default: "WebView" },
      "../lib/messageSurfaceDocument.generated": { default: "fixture document" },
    };
    const source = ts.transpileModule(fs.readFileSync(path.resolve(base, `../components/${variant}`), "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    }).outputText;
    const exports = {};
    vm.runInNewContext(source, { exports, require: name => dependencies[name], window: { addEventListener() {}, removeEventListener() {} } });
    const render = selection => {
      cursor = 0; effects.length = 0;
      const node = exports.MessageSurface({ snapshot: { type: "snapshot" }, selection, onCommand: async () => ({}) });
      node.props.ref.current = frame;
      effects.forEach(effect => effect());
      return node;
    };
    const initial = render("mac-a::review");
    if (variant.includes(".web")) initial.props.onLoad();
    else initial.props.onMessage({ nativeEvent: { data: JSON.stringify({ nfn: { preview_ready: true } }) } });
    assert.equal(sent.at(-1).id, "mac-a::review");
    render(null);
    assert.equal(sent.at(-1).type, "show");
    render("mac-a::review");
    assert.equal(sent.at(-1).type, "open_record");
    assert.equal(sent.at(-1).id, "mac-a::review");
  });
}
