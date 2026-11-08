const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');
const source = fs.readFileSync(path.join(__dirname, '../src/lib/messageKeyboardViewport.ts'), 'utf8');
const result = {};
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports: result });

function fixture() {
  const viewport = new EventTarget();
  Object.assign(viewport, { height: 800, offsetTop: 0, scale: 1 });
  const browser = new EventTarget();
  const frames = new Map();
  let id = 0;
  Object.assign(browser, { innerHeight: 800, visualViewport: viewport,
    requestAnimationFrame: fn => { frames.set(++id, fn); return id; },
    cancelAnimationFrame: key => frames.delete(key),
  });
  const element = { style: {}, getBoundingClientRect: () => ({ top: 60 }) };
  const changes = [];
  const stop = result.observeMessageKeyboard(browser, () => element, (visible, dismissed) => changes.push({ visible, dismissed }));
  const flush = () => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(fn => fn()); };
  const resize = (height, offsetTop = 0) => { Object.assign(viewport, { height, offsetTop }); viewport.dispatchEvent(new Event('resize')); flush(); };
  flush();
  return { viewport, element, changes, resize, flush, stop };
}

test('Safari Done hides actions without needing input blur', () => {
  const app = fixture();
  app.resize(450);
  assert.equal(app.element.style.maxHeight, '390px');
  app.resize(800);
  assert.deepEqual(app.changes, [{ visible: true, dismissed: false }, { visible: false, dismissed: true }]);
  assert.equal(app.element.style.maxHeight, '');
  app.stop();
});

test('keyboard geometry includes viewport scrolling and the entire toolbar host', () => {
  const app = fixture();
  app.resize(450, 25);
  assert.equal(app.element.style.maxHeight, '415px');
  app.resize(430, 35);
  assert.equal(app.element.style.maxHeight, '405px');
  assert.equal(app.changes.length, 1);
  app.stop();
});

test('address bar changes and pinch zoom do not open keyboard controls', () => {
  const app = fixture();
  app.resize(740);
  app.viewport.scale = 2;
  app.resize(400);
  assert.deepEqual(app.changes, []);
  assert.equal(app.element.style.maxHeight, '');
  app.stop();
});

test('dismiss and reopen produce separate visibility transitions', () => {
  const app = fixture();
  for (const height of [450, 800, 450, 800]) app.resize(height);
  assert.deepEqual(app.changes.map(change => change.dismissed), [false, true, false, true]);
  app.stop();
});

test('unmount cancels updates, removes listeners and restores layout', () => {
  const app = fixture();
  app.resize(450);
  app.viewport.height = 800;
  app.viewport.dispatchEvent(new Event('resize'));
  app.stop();
  app.flush();
  app.resize(400);
  assert.equal(app.element.style.maxHeight, '');
  assert.equal(app.changes.length, 1);
});

test('web action buttons and reply mode clear when Safari dismisses the keyboard', () => {
  const hooks = [];
  const effects = [];
  const listeners = new Map();
  const sent = [];
  let cursor = 0, mounted = false, keyboard;
  const jsx = (type, props) => ({ type, props });
  const react = {
    useState: initial => { const key = cursor++; if (!(key in hooks)) hooks[key] = typeof initial === 'function' ? initial() : initial; return [hooks[key], value => { hooks[key] = value; }]; },
    useRef: initial => { const key = cursor++; return hooks[key] ??= { current: initial }; },
    useCallback: fn => fn,
    useEffect: fn => { if (!mounted) effects.push(fn); },
  };
  const dependencies = {
    react,
    'react/jsx-runtime': { jsx, jsxs: jsx },
    './TerminalKeyboardToolbar': { TerminalKeyboardToolbar: 'Toolbar' },
    './TerminalWriteDialog': { TerminalWriteDialog: 'WriteDialog' },
    '../lib/messageKeyboardViewport': { observeMessageKeyboard: (_browser, _target, change) => { keyboard = change; } },
    '../lib/messageSurfaceDocument.generated': { __esModule: true, default: '<script>' },
    '../lib/messageSurfaceBootstrap': { messageSurfaceInitialDocument: value => value, messageSurfaceDefaultView: () => 'shell' },
  };
  const component = {};
  const source = fs.readFileSync(path.join(__dirname, '../src/components/MessageSurface.web.tsx'), 'utf8');
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, {
    exports: component, require: name => { assert.ok(name in dependencies, name); return dependencies[name]; },
    window: { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener() {} },
  });
  const props = { snapshot: { shell_only: true }, onCommand: async () => ({}) };
  const render = () => {
    cursor = 0;
    const tree = component.MessageSurface(props);
    const iframe = tree.props.children[0];
    iframe.props.ref.current = { contentWindow: { postMessage: value => sent.push(value) } };
    if (!mounted) { mounted = true; effects.forEach(fn => fn()); }
    return tree.props.children[1];
  };
  assert.equal(render(), null);
  const frameRef = hooks.find(value => value?.current?.contentWindow);
  listeners.get('message')({ source: frameRef.current.contentWindow, data: { nfn: { native: 'chrome', reply: true } } });
  assert.equal(render(), null);
  keyboard(true, false);
  assert.equal(render().type, 'Toolbar');
  keyboard(false, true);
  assert.equal(render(), null);
  assert.ok(sent.some(value => value.action === 'reply_close'));
  keyboard(true, false);
  assert.equal(render(), null, 'reply mode was cleared, so another input cannot resurrect the buttons');
});
