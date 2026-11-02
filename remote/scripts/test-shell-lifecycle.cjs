const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function load(file, dependencies = {}) {
  const exports = {};
  const source = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(source, { exports, atob, require: name => dependencies[name] });
  return exports;
}

test('notification captures are shared with details and keep the latest raw output', () => {
  const { cacheMessageShell, getMessageShell, clearMessageShellCache, deleteMessageShell } = load('../src/lib/cacheMessageShell.ts');
  const pane = 'mac::%9';
  cacheMessageShell({ source: { pane_id: pane }, log: 'cached output\nไทย' });
  assert.equal(getMessageShell(pane), 'cached output\nไทย');
  cacheMessageShell({ source: { pane_id: pane }, log: 'new capture' });
  assert.equal(getMessageShell(pane), 'new capture');
  assert.equal(getMessageShell('other::%9'), undefined);
  deleteMessageShell(pane); assert.equal(getMessageShell(pane), undefined);
  cacheMessageShell({ source: { pane_id: pane }, log: '' });
  assert.equal(getMessageShell(pane), '');
  clearMessageShellCache(); assert.equal(getMessageShell(pane), undefined);
});

function smoothFixture() {
  const { smoothTerminalScript } = load('../../shared/src/components/smoothTerminalScript.ts');
  const listeners = {}, documentListeners = {}, timers = new Map();
  let clock = 0, timerId = 0, paints = 0;
  const selection = { isCollapsed: true, anchorNode: null, focusNode: null };
  const grid = { style: {} };
  let scroller, output;
  function node() {
    return { style: {}, append() {}, contains: item => item === output,
      addEventListener: (name, fn) => { listeners[name] = fn; },
      replaceChildren: () => paints++, scrollTop: 0, scrollHeight: 500, clientHeight: 500 };
  }
  const document = { getElementById: () => grid, body: { append() {} },
    addEventListener: (name, fn) => documentListeners[name] = fn,
    createElement: tag => { const element = node(); if (tag === 'div' && !scroller) scroller = element; if (tag === 'pre') output = element; return element; },
    createDocumentFragment: node, createTextNode: text => text };
  const line = { translateToString: () => 'x', getCell: () => ({ getWidth: () => 1, getChars: () => 'x', isBgDefault: () => true,
    getFgColor: () => 0, isFgRGB: () => false, isFgPalette: () => false,
    getBgColor: () => 0, isBgRGB: () => false, isBgPalette: () => false,
    isInverse: () => false, isBold: () => false, isDim: () => false, isUnderline: () => false }) };
  let write;
  const window = { getSelection: () => selection, ReactNativeWebView: { postMessage() {} } };
  vm.runInNewContext(smoothTerminalScript.replace('__SMOOTH_SCROLL__', 'true'), {
    document, window, Math, Date,
    term: { options: {}, cols: 1, buffer: { active: { length: 1, getLine: () => line, baseY: 0, cursorY: 0, cursorX: 0 } }, onWriteParsed: fn => write = fn },
    setTimeout: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, at: clock + delay }); return id; },
    clearTimeout: id => timers.delete(id),
  });
  const advance = ms => { clock += ms; for (const [id, timer] of timers) if (timer.at <= clock) { timers.delete(id); timer.fn(); } };
  return { window, selection, output, scroller, documentListeners, advance, write, paints: () => paints,
    touch: type => listeners[type]({ touches: [{ clientX: 10, clientY: 10 }], changedTouches: [{ clientX: 10, clientY: 10 }] }) };
}

test('details long press freezes both text nodes and keyboard offsets until selection clears', () => {
  const f = smoothFixture(); f.advance(100);
  const painted = f.paints();
  f.window.setVisualOffset(320);
  assert.equal(f.scroller.style.bottom, '320px');
  f.touch('touchstart'); f.write(); f.advance(100);
  assert.equal(f.paints(), painted, 'native selection gets stable text before its range exists');
  f.window.setVisualOffset(0);
  assert.equal(f.scroller.style.bottom, '320px', 'keyboard dismissal cannot move the selection target');
  f.selection.isCollapsed = false; f.selection.anchorNode = f.output;
  f.touch('touchcancel'); f.advance(1000);
  assert.equal(f.scroller.style.bottom, '320px');
  assert.equal(f.paints(), painted);
  f.selection.isCollapsed = true; f.documentListeners.selectionchange(); f.advance(100);
  assert.equal(f.scroller.style.bottom, '0px');
  assert.ok(f.paints() > painted, 'live updates resume after selection ends');
});
