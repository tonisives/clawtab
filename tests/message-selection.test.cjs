const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

function fixture() {
  const handlers = {}, timers = new Map();
  let time = 0, timerId = 0, replies = 0, blurs = 0;
  const text = {};
  const logs = { contains: node => node === text, addEventListener: (name, callback) => handlers[name] = callback };
  const selection = { isCollapsed: true, anchorNode: null, focusNode: null };
  const input = { blur: () => { blurs++; document.activeElement = null; } };
  const document = { activeElement: input };
  const source = fs.readFileSync(require.resolve("../shared/src/nfn/surface.js"), "utf8");
  const functions = source.slice(source.indexOf("  function installLogSelection("), source.indexOf("  async function refreshContext()"));
  const context = { document, card: { _shellInput: input, _logs: logs }, window: { getSelection: () => selection },
    performance: { now: () => time }, Math, Boolean,
    setTimeout: (callback, delay) => { const id = ++timerId; timers.set(id, { callback, at: time + delay }); return id; },
    clearTimeout: id => timers.delete(id), setShellReply: () => replies++,
  };
  vm.runInNewContext(functions, context);
  context.installLogSelection(logs, true);
  const advance = milliseconds => {
    time += milliseconds;
    for (const [id, timer] of timers) if (timer.at <= time) { timers.delete(id); timer.callback(); }
  };
  return { logs, selection, text, advance, selected: () => context.hasLogSelection(logs),
    event: (type, x = 10, y = 10) => handlers[type]({ clientX: x, clientY: y }),
    replies: () => replies, blurs: () => blurs };
}

test("long press protects output before a native selection range exists", () => {
  const app = fixture();
  app.event("pointerdown");
  assert.equal(app.selected(), true);
  app.advance(350);
  assert.equal(app.blurs(), 1, "the hidden shell input releases keyboard focus");
  app.event("pointercancel");
  app.advance(500);
  assert.equal(app.selected(), true, "native gesture takeover keeps the output stable");
  app.selection.isCollapsed = false; app.selection.anchorNode = app.text;
  app.advance(500);
  assert.equal(app.selected(), true, "the native range protects output after the gesture ends");
  app.selection.isCollapsed = true;
  assert.equal(app.selected(), false, "live updates resume after the selection is cleared");
  assert.equal(app.replies(), 0);
});

test("short taps still open the shell keyboard", () => {
  const app = fixture(); app.event("pointerdown"); app.advance(100); app.event("pointerup");
  assert.equal(app.replies(), 1); assert.equal(app.selected(), false);
  app.advance(1000); assert.equal(app.blurs(), 0);
});

test("scrolling cancels the hold without opening or blurring the keyboard", () => {
  const app = fixture(); app.event("pointerdown"); app.event("pointermove", 10, 40);
  app.advance(400); app.event("pointerup", 10, 40); app.advance(1000);
  assert.equal(app.replies(), 0); assert.equal(app.blurs(), 0); assert.equal(app.selected(), false);
});

test("tapping a selected passage does not enter reply", () => {
  const app = fixture(); app.selection.isCollapsed = false; app.selection.focusNode = app.text;
  app.event("pointerdown"); app.advance(100); app.event("pointerup");
  assert.equal(app.replies(), 0); assert.equal(app.selected(), true);
});
