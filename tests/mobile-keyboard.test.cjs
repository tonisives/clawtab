const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('../desktop/node_modules/typescript');

let mount = (menuOpen = false) => {
  let keyboard = {}, appState, offsets = [], cleanups = [], delayed = [];
  let exports = {};
  let source = ts.transpileModule(fs.readFileSync(require.resolve('../remote/src/hooks/useTerminalKeyboard.ts'), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  let modules = {
    react: {
      useState: (value) => [value, () => {}],
      useRef: (current) => ({ current }),
      useCallback: (callback) => callback,
      useEffect: (effect) => { let cleanup = effect(); if (cleanup) cleanups.push(cleanup); },
    },
    'react-native': {
      Platform: { OS: 'ios' }, Dimensions: { get: () => ({ height: 800 }) },
      Keyboard: { isVisible: () => false, addListener: (name, callback) => {
        keyboard[name] = callback; return { remove: () => delete keyboard[name] };
      } },
      AppState: { addEventListener: (_, callback) => { appState = callback; return { remove: () => {} }; } },
    },
  };
  vm.runInNewContext(source, { exports, require: (name) => modules[name], requestAnimationFrame: (callback) => callback(), setTimeout: (callback) => delayed.push(callback) });
  let termRef = { current: { setVisualOffset: (offset) => offsets.push(offset), focus: () => {} } };
  let hook = exports.useTerminalKeyboard({ termRef, menuOpen, toolbarHeight: 48, extraClearance: 10 });
  hook.terminalSurfaceRef.current = { measureInWindow: (callback) => callback(0, 100, 400, 650) };
  let frame = (screenY, height) => keyboard.keyboardWillChangeFrame({ endCoordinates: { screenY, height } });
  return { keyboard, frame, appState, offsets, hook, cleanup: () => cleanups.forEach((cleanup) => cleanup()) };
};

test('keyboard dismissal clears the terminal offset while its menu is open', () => {
  let view = mount(true);
  view.frame(500, 300);
  assert.equal(view.offsets.at(-1), 308);
  view.keyboard.keyboardWillHide();
  assert.equal(view.offsets.at(-1), 0);
  view.cleanup();
});

test('off-screen and zero-height keyboard frames clear the terminal offset', () => {
  let view = mount();
  view.frame(500, 300);
  view.frame(800, 300);
  assert.equal(view.offsets.at(-1), 0);
  view.frame(500, 300);
  view.frame(500, 0);
  assert.equal(view.offsets.at(-1), 0);
  view.cleanup();
});

test('background and resume without a keyboard clear stale terminal offsets', () => {
  let view = mount();
  view.frame(500, 300);
  view.appState('background');
  assert.equal(view.offsets.at(-1), 0);
  view.frame(500, 300);
  view.appState('active');
  assert.equal(view.offsets.at(-1), 0);
  view.cleanup();
});
