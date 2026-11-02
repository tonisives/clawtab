const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("../desktop/node_modules/typescript");
const source = fs.readFileSync(require("node:path").join(__dirname, "../remote/src/lib/capturedShell.ts"), "utf8");
const load = host => {
  const shellCache = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(require("node:path").join(__dirname, "../remote/src/lib/cacheMessageShell.ts"), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports: shellCache });
  const exports = {};
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
    exports, require: name => name === "./cacheMessageShell" ? shellCache : ({ machineHostRequest: host, splitResource: key => {
      const [machine, id] = key.split("::"); return id ? { machine, id } : null;
    } }),
  });
  return { ...exports, cacheMessageShell: shellCache.cacheMessageShell };
};

test("opening a details shell captures the correct pane without taking control or resizing it", async () => {
  const requests = [];
  const { capturedShellCommand, capturedShellSnapshot } = load(async (machine, request) => {
    requests.push({ machine, ...request }); return { log: "latest output" };
  });
  const command = capturedShellCommand("machine-a::%12");
  await command({ op: "read", id: "synthetic" });
  assert.equal(requests.length, 0);
  assert.equal((await command({ op: "context" })).log, "latest output");
  assert.deepEqual(JSON.parse(JSON.stringify(requests)), [{ machine: "machine-a", action: "message", command: { op: "pane_context", pane_id: "%12" } }]);
  const snapshot = capturedShellSnapshot("machine-a::%12", true);
  assert.equal(snapshot.shell_only, true);
  assert.equal(snapshot.records[0].request.source.pane_id, "machine-a::%12");
  await assert.rejects(command({ op: "resize", cols: 40, rows: 20 }), /Unsupported shell operation/);
  assert.equal(requests.length, 1);
});

test("details sends literal shell input to the owning machine without creating a PTY", async () => {
  const requests = [];
  const { capturedShellCommand } = load(async (machine, request) => { requests.push({ machine, ...request }); return { sent: true }; });
  await capturedShellCommand("machine-b::managed:agent")({ op: "shell_input", text: "hello\r\x1b[A\x03" });
  assert.deepEqual(JSON.parse(JSON.stringify(requests)), [{ machine: "machine-b", action: "message", command: { op: "pane_input", pane_id: "managed:agent", text: "hello\r\x1b[A\x03" } }]);
});

test("details includes the latest notification capture in its first local document", () => {
  const { cacheMessageShell, capturedShellSnapshot } = load(() => assert.fail("first paint must not need the host"));
  cacheMessageShell({ source: { pane_id: "machine-a::%12" }, log: "first capture" });
  cacheMessageShell({ source: { pane_id: "machine-a::%12" }, log: "latest capture\nไทย" });
  const snapshot = capturedShellSnapshot("machine-a::%12", true);
  assert.equal(snapshot.shell_cache["machine-a::%12"], "latest capture\nไทย");
  assert.equal(capturedShellSnapshot("machine-b::%12", true).shell_cache["machine-a::%12"], undefined);
  cacheMessageShell({ source: { pane_id: "machine-a::%12" }, log: "" });
  assert.equal(capturedShellSnapshot("machine-a::%12", true).shell_cache["machine-a::%12"], "");
});
