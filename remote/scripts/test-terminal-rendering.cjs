const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');

let load = (filename, dependencies, globals = {}) => {
  let source = fs.readFileSync(path.join(__dirname, filename), 'utf8');
  let compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  let exports = {};
  vm.runInNewContext(compiled, {
    exports,
    require: (name) => {
      assert.ok(name in dependencies, `Unexpected dependency: ${name}`);
      return dependencies[name];
    },
    ...globals,
  });
  return exports;
};

let react = {
  useRef: (current) => ({ current }),
  useState: (value) => [value, () => {}],
  useCallback: (callback) => callback,
  useMemo: (create) => create(),
  forwardRef: (render) => render,
  useImperativeHandle: (ref, create) => { ref.current = create(); },
};

test('native startup preserves writes, resets, and text in order', () => {
  let jsx = (type, props) => ({ type, props });
  let { XtermLog } = load('../../shared/src/components/XtermLog.tsx', {
    react,
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-native': { Platform: { OS: 'ios' }, StyleSheet: { create: (s) => s } },
    'react-native-webview': { default: 'WebView' },
    '../util/terminalInput': { encodeTerminalInput: (value) => value },
    '../theme/terminal': {},
  });
  let ref = {};
  let resize;
  let tree = XtermLog({ onResize: (cols, rows) => { resize = [cols, rows]; } }, ref);
  let webview = tree.props.children[0].props;
  let inlineScript = webview.source.html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(inlineScript);
  assert.doesNotThrow(() => new Function(inlineScript));
  let operations = [];
  let page = { window: {
    enqueueTerminalWrite: (data) => operations.push(['write', data]),
    enqueueTerminalReset: () => operations.push(['reset']),
    enqueueTerminalText: (data) => operations.push(['text', data]),
  } };
  webview.ref.current = { injectJavaScript: (script) => vm.runInNewContext(script, page) };
  assert.equal(ref.current.dimensions().cols, 0);
  ref.current.write('old');
  ref.current.clear();
  ref.current.writeText('prompt\n');
  ref.current.write('new');
  assert.deepEqual(operations, []);
  let message = (data) => webview.onMessage({ nativeEvent: { data: JSON.stringify(data) } });
  message({ type: 'resize', cols: 39, rows: 28 });
  message({ type: 'ready' });
  assert.deepEqual(resize, [39, 28]);
  assert.deepEqual(operations, [['write', 'old'], ['reset'], ['text', 'prompt\r\n'], ['write', 'new']]);
  message({ type: 'ready' });
  assert.equal(operations.length, 4);
  ref.current.clear();
  ref.current.write('live');
  assert.deepEqual(operations.slice(-2), [['reset'], ['write', 'live']]);
});

test('PTY waits for the native grid and subscribes once using measured dimensions', () => {
  let effects = [];
  let sent = [];
  let id = 0;
  let { usePty, dispatchPtyOutput } = load('../src/hooks/usePty.ts', {
    react: { ...react, useEffect: (effect) => effects.push(effect) },
    '@clawtab/shared': { splitResource: () => null, machineState: () => ({}) },
    '../lib/terminalCache': { terminalCache: { get: () => [], append: () => {} } },
    '../lib/wsRuntime': { getWsSend: () => (message) => sent.push(message), nextId: () => String(++id) },
    '../lib/useRequestMap': { clearRequest: () => {}, registerRequest: () => new Promise(() => {}) },
  }, { setTimeout: () => 1, clearTimeout: () => {}, setInterval: () => 1, clearInterval: () => {} });
  let dims = { cols: 0, rows: 0 };
  let term = { current: { dimensions: () => dims, clear: () => {} } };
  let hook = usePty('%test', 'test', term);
  let cleanups = effects.map((effect) => effect());
  assert.equal(sent.length, 0);
  dims = { cols: 39, rows: 28 };
  hook.sendResize(39, 28);
  hook.sendResize(39, 28);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'subscribe_pty');
  assert.equal(sent[0].cols, 39);
  assert.equal(sent[0].rows, 28);
  cleanups.forEach((cleanup) => cleanup?.());

  // Remount during the unsubscribe grace period without a usable cache.
  effects = [];
  dims = { cols: 0, rows: 0 };
  term.current.write = () => {};
  hook = usePty('%test', 'test', term);
  cleanups = effects.map((effect) => effect());
  assert.equal(sent.length, 1);
  // In-flight output can mark the subscription idle before WebView readiness.
  dispatchPtyOutput('%test', 'live frame');
  dims = { cols: 39, rows: 28 };
  hook.sendResize(39, 28);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].type, 'subscribe_pty');
  cleanups.forEach((cleanup) => cleanup?.());
});

test('overflowed terminal caches never replay an incomplete escape stream', () => {
  let { createTerminalCache } = load('../src/lib/terminalCache.ts', {}, { atob });
  let cache = createTerminalCache();
  cache.append('pane', Buffer.from('partial frame').toString('base64'));
  assert.equal(cache.get('pane').length, 0);
  cache.append('pane', Buffer.from('\x1bc').toString('base64'));
  cache.append('pane', Buffer.from('x'.repeat(300 * 1024)).toString('base64'));
  cache.append('pane', Buffer.from('\x1b[2Aworking').toString('base64'));
  assert.equal(cache.get('pane').length, 0);
  let fresh = Buffer.from('\x1bcnew screen').toString('base64');
  cache.append('pane', fresh);
  assert.equal(cache.get('pane').length, 1);
  assert.equal(cache.get('pane')[0], fresh);
});
