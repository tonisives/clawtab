// Generate a standalone browser fixture from the production renderer.
// Usage: node desktop/tests/nfn-fixture.mjs /tmp/clawtab-nfn-fixture.html
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const root = new URL("../../shared/src/nfn/", import.meta.url);
const read = name => readFileSync(new URL(name, root), "utf8");
const setup = String.raw`
window.fixture = { calls: [], records: new Map(), contextCalls: 0, autoYesPanes: new Set(), surfaces: [] };
window.webkit = { messageHandlers: { nfn: { postMessage(value) {
  if (value.native === "surface") window.fixture.surfaces.push({ ...value, at: performance.now() });
  if (!value.command) return;
  const { command, token } = value, fixture = window.fixture;
  fixture.calls.push(command);
  const record = fixture.records.get(command.id);
  let response = record || {};
  if (command.op === "context") { fixture.contextCalls++; response = { source: record?.request.source, log: fixture.log || "Review ready\nWaiting for input", models: ["gpt-5.6-sol"], plugins: [] }; }
  if (command.op === "read") record.read_at = Date.now();
  if (command.op === "auto_yes") {
    if (fixture.autoYesError) {
      setTimeout(() => window.nfn.receive({ type: "response", token, error: fixture.autoYesError }), 1);
      return;
    }
    const pane = record.request.source.pane_id;
    if (fixture.autoYesPanes.has(pane)) fixture.autoYesPanes.delete(pane); else fixture.autoYesPanes.add(pane);
    response = { auto_yes: fixture.autoYesPanes.has(pane) };
  }
  if (command.op === "respond") {
    if (fixture.responseError) {
      setTimeout(() => window.nfn.receive({ type: "response", token, error: fixture.responseError }), 1);
      return;
    }
    if (record.request.actions.find(action => action.id === command.action_id)?.kind === "focus") {
      response = { focused: true };
    } else {
      record.status = "resolved";
      record.response = { action_id: command.action_id, text: command.text };
    }
  }
  if (command.op === "list") response = { records: [...fixture.records.values()].filter(r => !command.pending_only || r.status === "pending").slice(command.offset, command.offset + 50), next_offset: command.offset + 50 };
  setTimeout(() => window.nfn.receive({ type: "response", token, value: response }), 1);
} } } };
window.fixture.record = (id, actions = 4) => ({
  id, status: "pending", read_at: null, dismissed_at: null, created_at: Date.now(),
  request: { title: "Review the launch post", body: "The launch post is ready. Review the changes and decide how to continue.\n<img src=x onerror=window.unsafeMarkup=true>", template: "review", response_destination: "agent_message", source: { pane_id: "%test", task: "Review the launch post", provider: "codex", branch: "launch", cwd: "~/projects/clawtab" },
    data: { diff: "- Previous caption\n+ New launch caption", plan: "Review the caption\nApprove publication" },
    media: [], actions: ["Approve", "Request changes", "Reject", "Later"].slice(0, actions).map((label, i) => ({ id: String(i), label, kind: "choice" })) }
});
window.fixture.snapshot = (arrival = null) => ({ type: "snapshot", visible: true, preview: false, records: [...window.fixture.records.values()].slice(0,50), pending_count: [...window.fixture.records.values()].filter(r => r.status === "pending").length, arrival, auto_yes_panes: [...window.fixture.autoYesPanes],
  settings: { preview_seconds: 8, hover_expand: false }, templates: { templates: [{ id: "review", layout: [{ type: "text", field: "body" }, { type: "row", children: [{ type: "diff", field: "data.diff" }, { type: "plan", field: "data.plan" }] }, { type: "reply" }, { type: "choices" }, { type: "logs" }] }] } });
`;
const ready = String.raw`
window.fixture.records.set("first", window.fixture.record("first"));
window.nfn.receive(window.fixture.snapshot("first"));
`;
const native = process.argv.includes("--native");
const fixtureSetup = native ? setup.slice(0, setup.indexOf("window.webkit =")) + setup.slice(setup.indexOf("window.fixture.record")) : setup;
const document = read("surface.html").replace("/* NFN_CSS */", read("surface.css") + (native ? "" : "\nbody{background:#202126;padding:24px;display:flex;justify-content:center}"))
  .replace("/* NFN_JS */", fixtureSetup + "\n" + read("surface.js") + "\n" + ready);
writeFileSync(process.argv[2] || fileURLToPath(new URL("./nfn-fixture.html", import.meta.url)), document);
