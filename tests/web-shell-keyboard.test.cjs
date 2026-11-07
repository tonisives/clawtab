const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

test("shell keyboard forwards navigation and control keys once without bubbling into page shortcuts", () => {
  const source = fs.readFileSync(path.join(__dirname, "../shared/src/nfn/surface.js"), "utf8");
  const start = source.indexOf('input.addEventListener("keydown", event => {');
  const listener = source.slice(start, source.indexOf("card.append(input)", start));
  const sent = [];
  let handler;
  vm.runInNewContext(listener, { input: { addEventListener: (_, callback) => { handler = callback; } }, sendShellInput: text => sent.push(text) });
  for (const [key, modifiers, expected] of [
    ["ArrowDown", {}, "\x1b[B"], ["ArrowUp", {}, "\x1b[A"],
    ["ArrowLeft", {}, "\x1b[D"], ["ArrowRight", {}, "\x1b[C"],
    ["c", { ctrlKey: true }, "\x03"], ["d", { ctrlKey: true }, "\x04"],
    ["Enter", {}, "\r"], ["Backspace", {}, "\x7f"], ["Escape", {}, "\x1b"], ["Tab", {}, "\t"],
  ]) {
    let prevented = false, stopped = false;
    handler({ key, ...modifiers, preventDefault() { prevented = true; }, stopPropagation() { stopped = true; } });
    assert.equal(sent.at(-1), expected, key);
    assert.ok(prevented && stopped, key);
  }
  const count = sent.length;
  for (const event of [{ key: "c", metaKey: true }, { key: "Enter", isComposing: true }, { key: "x" }]) {
    handler({ ...event, preventDefault() { assert.fail("browser input should remain available"); } });
  }
  assert.equal(sent.length, count);
});
