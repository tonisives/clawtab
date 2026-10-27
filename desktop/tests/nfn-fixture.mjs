// Generate a standalone browser fixture from the production renderer.
// Usage: node desktop/tests/nfn-fixture.mjs /tmp/clawtab-nfn-fixture.html
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const root = new URL("../../shared/src/nfn/", import.meta.url);
const read = name => readFileSync(new URL(name, root), "utf8");
const setup = String.raw`
window.fixture = { todos: {items: []}, calls: [], records: new Map(), contextCalls: 0, autoYesPanes: new Set(), heldOps: new Set(), deferred: [], surfaces: [], nativeEvents: [], settings: { delivery: "enhanced", placement: "notch", display: "primary", focus: "follow", preview_seconds: 8, hover_expand: false, sound: true, menu_bar_icon: true, position: null } };
window.webkit = { messageHandlers: { nfn: { postMessage(value) {
  if (value.native) window.fixture.nativeEvents.push(value);
  if (value.native === "surface") window.fixture.surfaces.push({ ...value, at: performance.now() });
  if (!value.command) return;
  const { command, token } = value, fixture = window.fixture;
  fixture.calls.push(command);
  const complete = (error = null) => {
  if (error) { window.nfn.receive({ type: "response", token, error }); return; }
  if (command.op.startsWith("todo")) {
    if (!fixture.todoError && command.op === "todo_update") fixture.todos.items.find(item => item.id === command.id).checked = command.checked;
    if (!fixture.todoError && command.op === "todo_add" && !fixture.todos.items.some(item => item.text === command.text && item.group === command.group)) fixture.todos.items.push({ id: "new-task", text: command.text, group: command.group, depth: 0, checked: false });
    setTimeout(() => window.nfn.receive({ type: "response", token, error: fixture.todoError, value: command.op === "todo_focus" ? {focused:true} : fixture.todos }), 1); return;
  }
  const record = fixture.records.get(command.id);
  let response = record || {};
  if (command.op === "save_settings") {
    if (fixture.settingsError) {
      setTimeout(() => window.nfn.receive({ type: "response", token, error: fixture.settingsError }), 1);
      return;
    }
    fixture.settings = { ...fixture.settings, ...command.patch };
    response = { settings: fixture.settings };
  }
  if (command.op === "context") { fixture.contextCalls++; response = { source: record?.request.source, log: fixture.log || "Review ready\nWaiting for input", models: ["gpt-5.6-sol"], plugins: [] }; }
  if (command.op === "read") record.read_at = Date.now();
  if (command.op === "dismiss") { record.dismissed_at = Date.now(); record.read_at = Date.now(); }
  if (command.op === "auto_yes") {
    if (fixture.autoYesError) {
      setTimeout(() => window.nfn.receive({ type: "response", token, error: fixture.autoYesError }), 1);
      return;
    }
    const pane = record.request.source.pane_id;
    if (fixture.autoYesPanes.has(pane)) fixture.autoYesPanes.delete(pane); else fixture.autoYesPanes.add(pane);
    response = { auto_yes: fixture.autoYesPanes.has(pane) };
  }
  if (command.op === "dismiss_many") {
    response = { records: command.ids.map(id => { const record = fixture.records.get(id); record.dismissed_at = Date.now(); record.read_at = Date.now(); return record; }) };
  }
  if (command.op === "respond") {
    if (fixture.responseError) {
      setTimeout(() => window.nfn.receive({ type: "response", token, error: fixture.responseError }), 1);
      return;
    }
    if (record.request.actions.find(action => action.id === command.action_id)?.kind === "focus") {
      response = { focused: true, record };
    } else {
      record.status = "resolved";
      record.response = { action_id: command.action_id, text: command.text };
    }
  }
  if (command.op === "focus" || response.focused) {
    if (fixture.focusError) {
      setTimeout(() => window.nfn.receive({ type: "response", token, error: fixture.focusError }), 1);
      return;
    }
    record.dismissed_at = Date.now(); record.read_at = Date.now();
    response = { focused: true, record };
  }
  if (command.op === "list") response = { records: fixture.listRecords(command.pending_only).slice(command.offset, command.offset + 50), next_offset: command.offset + 50 };
  setTimeout(() => window.nfn.receive({ type: "response", token, value: response }), 1);
  };
  if (fixture.heldOps.has(command.op)) fixture.deferred.push({ command, complete }); else complete();
} } } };
window.fixture.record = (id, actions = 4) => ({
  id, status: "pending", read_at: null, dismissed_at: null, created_at: Date.now(),
    request: { title: "Review the launch post", body: "The launch post is ready. Review the changes and decide how to continue.\n<img src=x onerror=window.unsafeMarkup=true>", template: "review", response_destination: "agent_message", source: { pane_id: "%test", provider: "codex", branch: "launch", cwd: "~/projects/clawtab" },
    data: { diff: "- Previous caption\n+ New launch caption", plan: "Review the caption\nApprove publication" },
    media: [], actions: ["Approve", "Request changes", "Reject", "Later"].slice(0, actions).map((label, i) => ({ id: String(i), label, kind: "choice" })) }
});
window.fixture.listRecords = pendingOnly => {
  const items = [...window.fixture.records.values()].filter(r => !pendingOnly || (["pending", "delivering"].includes(r.status) && !r.dismissed_at));
  return window.fixture.serverOrder ? items.sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id)) : items;
};
window.fixture.snapshot = (arrival = null) => ({ todos: window.fixture.todos, type: "snapshot", visible: true, preview: false, records: window.fixture.listRecords(true).slice(0,50), pending_count: window.fixture.listRecords(true).length, arrival, auto_yes_panes: [...window.fixture.autoYesPanes],
  settings: window.fixture.settings, platform: { displays: [{id:"test-display",name:"Test display"}] }, templates: { templates: [{ id: "review", layout: [{ type: "text", field: "body" }, { type: "row", children: [{ type: "diff", field: "data.diff" }, { type: "plan", field: "data.plan" }] }, { type: "reply" }, { type: "choices" }, { type: "logs" }] }] } });
`;
const ready = String.raw`
window.fixture.records.set("first", window.fixture.record("first"));
window.nfn.receive(window.fixture.snapshot("first"));
`;
const native = process.argv.includes("--native");
// Tart's no-graphics mode marks every page hidden. These UI scenarios exercise a visible card.
const visibility = process.argv.includes("--headless-visible")
  ? `Object.defineProperty(document, "hidden", { configurable: true, get: () => false }); Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });\n`
  : "";
const todoFileIndex = process.argv.indexOf("--todo-data");
const todoData = todoFileIndex >= 0 ? JSON.parse(readFileSync(process.argv[todoFileIndex + 1], "utf8")) : { linked: true, note: "/notes/today.md", items: [
  { id: "release", text: "Prepare the release", group: "clawtab", depth: 0, checked: false, agent: { pane: "%42", state: "working", summary: "Checking the release artifacts" } },
  { id: "posting", text: "Verify posting", group: "clawtab", depth: 1, checked: false, agent: { pane: "%42", state: "working" } },
  { id: "screenshots", text: "Organize research screenshots", group: "gp", depth: 0, checked: false }
] };
const todoSetup = process.argv.includes("--todos") || todoFileIndex >= 0 ? `window.fixture.todos = ${JSON.stringify(todoData)}; window.nfn.receive({type:"todos",todos:window.fixture.todos});` : "";
const fixtureSetup = native ? setup.slice(0, setup.indexOf("window.webkit =")) + setup.slice(setup.indexOf("window.fixture.record")) : setup;
const document = read("surface.html").replace("/* NFN_CSS */", read("surface.css") + (native ? "" : "\nbody{background:#202126;padding:24px;display:flex;justify-content:center}"))
  .replace("/* NFN_JS */", visibility + fixtureSetup + "\n" + read("surface.js") + "\n" + ready + "\n" + todoSetup);
writeFileSync(process.argv[2] || fileURLToPath(new URL("./nfn-fixture.html", import.meta.url)), document);
