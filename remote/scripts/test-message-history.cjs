const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const ts = require("typescript");

const key = record => `${record.machine_id}::${record.id}`;
const pending = record => !record.dismissed_at && record.status === "pending";
const dependencies = {
  "@clawtab/shared": { messagePending: pending, resourceKey: (machine, id) => `${machine}::${id}` },
  "./messagePresentation": { surfaceId: key, surfaceRecord: record => record },
};
const exportsObject = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, "../src/lib/messageSurfaceController.ts"), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports: exportsObject, require: name => dependencies[name] });

test("history merges machines by latest close or response before slicing pages", async () => {
  const record = (id, machine, created, extra = {}) => ({
    id, machine_id: machine, created_at: created, updated_at: 9999,
    status: "pending", request: { title: "History", source: {} }, ...extra,
  });
  const online = [record("closed", "a", 1, { dismissed_at: 300 })];
  const offline = [
    record("answered", "b", 2, { response: { responded_at: 400 } }),
    record("both", "b", 3, { dismissed_at: 200, response: { responded_at: 500 } }),
    ...Array.from({ length: 52 }, (_, i) => record(`new-${i}`, "b", 100 + i)),
  ];
  const controller = exportsObject.messageSurfaceController({
    records: () => offline,
    machines: () => [{ id: "a", online: true }, { id: "b", online: false }],
    host: async () => ({ records: online }),
  });
  const first = await controller.execute({ op: "list", pending_only: false });
  assert.equal(first.records.slice(0, 3).map(r => r.id).join(","), "both,answered,closed");
  assert.equal(first.records.length, 50);
  const second = await controller.execute({ op: "list", pending_only: false, offset: 50, query: "History" });
  assert.equal(second.records.length, 5);
  assert.ok(second.records.every(r => !first.records.some(other => key(other) === key(r))));
  const inbox = await controller.execute({ op: "list", pending_only: true });
  assert.equal(inbox.records[0].id, "new-51");
});
