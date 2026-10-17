const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('../desktop/node_modules/typescript');
let harness = (rows = 24, baseY = 100) => {
  let events = {}, frames = new Map(), frame = 0, clock = 0, selected = false;
  let surface = { style: {} };
  let element = {
    clientHeight: 240,
    querySelector: (selector) => selector === '.xterm' ? surface : { getBoundingClientRect: () => ({ height: rows * 10 }) },
    addEventListener: (name, handler) => events[name] = handler,
    removeEventListener: (name) => delete events[name],
  };
  let buffer = { viewportY: Math.min(50, baseY), baseY };
  let terminal = { rows, buffer: { active: buffer }, hasSelection: () => selected, scrollToLine: (line) => buffer.viewportY = Math.max(0, Math.min(baseY, line)) };
  let exports = {};
  let source = ts.transpileModule(fs.readFileSync(__dirname + '/../shared/src/util/terminalTouchScroll.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(source, { exports, performance: { now: () => clock }, requestAnimationFrame: (callback) => { frames.set(++frame, callback); return frame; }, cancelAnimationFrame: (id) => frames.delete(id) });
  let detach = exports.attachTerminalTouchScroll(element, terminal);
  return {
    buffer, surface, frames, events, detach,
    select: () => selected = true,
    touch: (name, x, y, count = 1) => {
      clock += 16;
      let prevented = false;
      events[name]({ touches: Array.from({ length: count }, () => ({ clientX: x, clientY: y })), preventDefault: () => prevented = true, stopImmediatePropagation() {} });
      return prevented;
    },
  };
};
test('vertical swipes scroll shell history, start momentum, and clean up listeners', () => {
  let h = harness();
  h.touch('touchstart', 50, 200);
  assert.equal(h.touch('touchmove', 50, 100), true);
  assert.equal(h.buffer.viewportY, 60);
  h.touch('touchend', 50, 100, 0);
  assert.equal(h.frames.size, 1);
  h.detach();
  assert.equal(h.frames.size, 0);
  assert.equal(Object.keys(h.events).length, 0);
});
test('touch scrolling preserves selection, horizontal gestures, and multitouch', () => {
  for (let gesture of ['selection', 'horizontal', 'multitouch']) {
    let h = harness();
    if (gesture === 'selection') h.select();
    h.touch('touchstart', 50, 200, gesture === 'multitouch' ? 2 : 1);
    assert.equal(h.touch('touchmove', gesture === 'horizontal' ? 200 : 50, 100), false);
    assert.equal(h.buffer.viewportY, 50);
    h.detach();
  }
});
test('swipes can read a taller fixed shell grid and stay within its bounds', () => {
  let h = harness(60, 0);
  h.touch('touchstart', 50, 500);
  h.touch('touchmove', 50, 400);
  assert.equal(h.surface.style.transform, 'translateY(-100px)');
  h.touch('touchmove', 50, -1000);
  assert.equal(h.surface.style.transform, 'translateY(-360px)');
  h.touch('touchmove', 50, 3000);
  assert.equal(h.surface.style.transform, '');
  h.detach();
});
