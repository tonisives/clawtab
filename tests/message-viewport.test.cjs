const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

function viewport() {
  const listeners = {}, frames = [], properties = {}, scrolled = [];
  const root = { style: { setProperty: (key, value) => properties[key] = value } };
  const document = { documentElement: root, activeElement: null,
    addEventListener: (name, callback) => listeners[name] = callback };
  const window = { addEventListener: (name, callback) => listeners[name] = callback,
    visualViewport: { height: 800, addEventListener: (name, callback) => listeners[`viewport:${name}`] = callback } };
  const composer = { getBoundingClientRect: () => ({ height: 150 }), scrollIntoView: () => scrolled.push("composer") };
  const field = { matches: () => true, closest: () => composer,
    scrollIntoView: () => scrolled.push("field"), blur: () => { document.activeElement = null; } };
  const context = { window, document, innerHeight: 800, Math, requestAnimationFrame: callback => frames.push(callback) };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, "../remote/src/lib/messageSurfaceViewport.js"), "utf8"), context);
  const flush = () => { while (frames.length) frames.shift()(); };
  const tap = (interactive, distance = 0) => {
    listeners.pointerdown({ clientX: 10, clientY: 10 });
    listeners.pointerup({ clientX: 10, clientY: 10 + distance, target: { closest: () => interactive } });
  };
  flush();
  return { window, document, context, listeners, properties, scrolled, field, composer, flush, tap };
}

test("mobile safe-area space disappears during keyboard use and returns after dismissal", () => {
  const v = viewport();
  v.window.nfnMobile.setInsets(34, false); v.flush();
  assert.equal(v.properties["--message-safe-bottom"], "34px");
  v.window.nfnMobile.setInsets(34, true); v.context.innerHeight = 460;
  v.window.visualViewport.height = 460; v.flush();
  assert.equal(v.properties["--message-height"], "460px");
  assert.equal(v.properties["--message-safe-bottom"], "0px");
  v.window.nfnMobile.setInsets(34, false); v.context.innerHeight = 800;
  v.window.visualViewport.height = 800; v.flush();
  assert.equal(v.properties["--message-height"], "800px");
  assert.equal(v.properties["--message-safe-bottom"], "34px");
});

test("visual viewport changes reveal the composer, with a field fallback on very short screens", () => {
  const v = viewport(); v.document.activeElement = v.field;
  v.window.visualViewport.height = 400; v.listeners["viewport:resize"](); v.flush();
  assert.equal(v.properties["--message-height"], "400px");
  assert.equal(v.properties["--message-safe-bottom"], "0px");
  assert.equal(v.scrolled.at(-1), "composer");
  v.window.visualViewport.height = 120; v.listeners["viewport:resize"](); v.flush();
  assert.equal(v.scrolled.at(-1), "field");
});

test("background taps dismiss editing while controls and scrolling keep their interactions", () => {
  const v = viewport(); v.document.activeElement = v.field;
  v.tap(true); assert.equal(v.document.activeElement, v.field);
  v.tap(false, 30); assert.equal(v.document.activeElement, v.field);
  v.tap(false); assert.equal(v.document.activeElement, null);
});

test("native keyboard resize uses host overlap and clears stale offsets on hide/background", () => {
  const ts = require("../desktop/node_modules/typescript");
  const events = {}, cleanups = [], values = [], refs = [], exports = {};
  const source = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, "../remote/src/hooks/useMessageKeyboard.ts"), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const subscribe = (name, callback) => { events[name] = callback; return { remove() { delete events[name]; } }; };
  vm.runInNewContext(source, { exports, require: name => name === "react" ? {
    useRef: current => { const ref = { current }; refs.push(ref); return ref; },
    useState: value => [value, next => values.push(next)], useCallback: callback => callback,
    useEffect: effect => cleanups.push(effect()),
  } : { Platform: { OS: "ios" }, Dimensions: { get: () => ({ height: 844 }) },
    Keyboard: { addListener: subscribe, isVisible: () => false }, AppState: { addEventListener: subscribe } } });
  const hook = exports.useMessageKeyboard();
  let bottom = 844;
  hook.host.current = { measureInWindow: callback => callback(0, 100, 390, bottom - 100) };
  const frame = (screenY, height) => events.keyboardWillChangeFrame({ endCoordinates: { screenY, height } });
  frame(500, 344); assert.equal(values.at(-1), 344);
  hook.onLayout(); assert.equal(values.at(-1), 344); // Never adds another keyboard height.
  bottom = 430; hook.onLayout(); assert.equal(values.at(-1), 0); // Popup already above keyboard.
  bottom = 844; frame(500, 344); events.keyboardWillHide(); assert.equal(values.at(-1), 0);
  frame(500, 344); events.change("background"); assert.equal(values.at(-1), 0);
  frame(844, 0); assert.equal(values.at(-1), 0);
  cleanups.forEach(cleanup => cleanup()); assert.deepEqual(Object.keys(events), []);
});

test("web host follows the outer visual viewport rather than the iframe's layout viewport", () => {
  const ts = require("../desktop/node_modules/typescript");
  const effects = [], frames = [], listeners = {}, exports = {};
  const viewport = { height: 800, offsetTop: 0,
    addEventListener: (name, callback) => listeners[name] = callback,
    removeEventListener: name => delete listeners[name] };
  const source = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, "../remote/src/components/MessageSurface.web.tsx"), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const dependencies = {
    react: { useRef: current => ({ current }), useCallback: callback => callback, useEffect: callback => effects.push(callback) },
    "react/jsx-runtime": { jsx: (type, props) => ({ type, props }) },
    "../lib/messageSurfaceDocument.generated": { default: "fixture" },
  };
  vm.runInNewContext(source, { exports, require: name => dependencies[name],
    requestAnimationFrame: callback => { frames.push(callback); return frames.length; }, cancelAnimationFrame() {},
    window: { visualViewport: viewport, addEventListener() {}, removeEventListener() {} } });
  const tree = exports.MessageSurface({ snapshot: {}, onCommand: async () => ({}) });
  const frame = tree.props.ref.current = { style: {}, getBoundingClientRect: () => ({ top: 100 }) };
  const cleanup = effects[0]();
  const flush = () => { while (frames.length) frames.shift()(); };
  flush(); assert.equal(frame.style.maxHeight, "700px");
  viewport.height = 450; listeners.resize(); flush(); assert.equal(frame.style.maxHeight, "350px");
  viewport.offsetTop = 20; listeners.scroll(); flush(); assert.equal(frame.style.maxHeight, "370px");
  viewport.height = 800; viewport.offsetTop = 0; listeners.resize(); flush(); assert.equal(frame.style.maxHeight, "700px");
  cleanup(); assert.deepEqual(Object.keys(listeners), []);
});
