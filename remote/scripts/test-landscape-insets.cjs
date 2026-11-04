const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const exportsObject = {};
const source = ts.transpileModule(fs.readFileSync(path.join(__dirname, "../src/lib/remainingSafeArea.ts"), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText;
vm.runInNewContext(source, { exports: exportsObject });
const remaining = (...args) => JSON.parse(JSON.stringify(exportsObject.remainingSafeArea(...args)));
const window = { width: 852, height: 393 };
const insets = { left: 59, right: 59, bottom: 21 };

test("a landscape shell reaching the screen edges protects the notch and home indicator", () => {
  assert.deepEqual(remaining({ x: 0, y: 0, ...window }, window, insets), insets);
});
test("native navigation and tabs already providing safe areas add no second margin", () => {
  assert.deepEqual(remaining({ x: 59, y: 32, width: 734, height: 308 }, window, insets), { left: 0, right: 0, bottom: 0 });
});
test("a split detail protects only its exposed edge", () => {
  assert.deepEqual(remaining({ x: 304, y: 32, width: 548, height: 361 }, window, insets), { left: 0, right: 59, bottom: 21 });
  assert.deepEqual(remaining({ x: 59, y: 32, width: 240, height: 308 }, window, insets), { left: 0, right: 0, bottom: 0 });
});
test("partial safe areas contribute only their remaining overlap", () => {
  assert.deepEqual(remaining({ x: 40, y: 0, width: 772, height: 380 }, window, insets), { left: 19, right: 19, bottom: 8 });
});
