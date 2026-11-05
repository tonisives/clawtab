const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

function viewport() {
  const listeners = {}, frames = [], properties = {}, scrolled = [];
  const classes = new Set();
  const root = { classList: { toggle: (name, active) => active ? classes.add(name) : classes.delete(name), contains: name => classes.has(name) }, style: { setProperty: (key, value) => properties[key] = value } };
  const document = { documentElement: root, activeElement: null,
    addEventListener: (name, callback) => listeners[name] = callback };
  const window = { addEventListener: (name, callback) => listeners[name] = callback,
    dispatchEvent: event => listeners[event.type]?.(event),
    visualViewport: { height: 800, addEventListener: (name, callback) => listeners[`viewport:${name}`] = callback } };
  const composer = { getBoundingClientRect: () => ({ height: 150 }), scrollIntoView: () => scrolled.push("composer") };
  const field = { matches: () => true, closest: () => composer,
    scrollIntoView: () => scrolled.push("field"), blur: () => { document.activeElement = null; } };
  const context = { window, document, innerHeight: 800, Math, Event, requestAnimationFrame: callback => frames.push(callback) };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, "../remote/src/lib/messageSurfaceViewport.js"), "utf8"), context);
  const flush = () => { while (frames.length) frames.shift()(); };
  const tap = (interactive, distance = 0) => {
    listeners.pointerdown({ clientX: 10, clientY: 10 });
    listeners.pointerup({ clientX: 10, clientY: 10 + distance, target: { closest: () => interactive } });
  };
  flush();
  return { window, document, context, listeners, properties, scrolled, field, composer, flush, tap };
}

test("standalone shell swipes leave navigation to iOS while notification cards still page", () => {
  for (const shellOnly of [true, false]) {
    const v = viewport(), calls = [];
    v.context.performance = { now: () => 10 };
    v.window.getSelection = () => ({ isCollapsed: true });
    v.window.nfnPaging = {
      finish() {}, cancel() {}, setTouching() {},
      begin: () => calls.push("begin"), move: () => calls.push("move"),
      release: () => calls.push("release"),
    };
    const card = { isConnected: true, matches: () => true };
    const target = { closest: selector => selector.startsWith("#surface")
      ? shellOnly && selector.includes(":not(.shell-only)") ? null : card
      : null, parentElement: card, scrollWidth: 0, clientWidth: 0 };
    const touch = { identifier: 1, clientX: 10, clientY: 100 };
    v.listeners.touchstart({ touches: [touch], target });
    const moved = { ...touch, clientX: 130 };
    let prevented = false;
    v.listeners.touchmove({ touches: [moved], preventDefault: () => { prevented = true; } });
    v.listeners.touchend({ touches: [], changedTouches: [moved] });
    assert.equal(prevented, !shellOnly);
    assert.deepEqual(calls, shellOnly ? [] : ["begin", "move", "release"]);
  }
});

test("mobile safe-area space disappears during keyboard use and returns after dismissal", () => {
  const v = viewport();
  v.window.nfnMobile.setInsets(34, false);
  assert.equal(v.properties["--message-safe-bottom"], "34px", "the native inset applies before the next animation frame");
  v.flush();
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

test("returning from details clears stale selection and outer scroll without replacing shell content", () => {
  const v = viewport();
  let cleared = 0, resets = [];
  v.window.getSelection = () => ({ removeAllRanges: () => cleared++ });
  v.window.scrollTo = (x, y) => resets.push([x, y]);
  v.document.scrollingElement = { scrollTop: 180 };
  const logs = { _selecting: true };
  v.document.querySelectorAll = () => [logs];
  v.document.activeElement = v.field;
  v.window.nfnMobile.setActive(false); v.flush();
  assert.equal(v.document.activeElement, null);
  assert.equal(v.document.scrollingElement.scrollTop, 0);
  assert.equal(logs._selecting, false, "a cancelled native gesture cannot leave the old shell locked");
  v.document.scrollingElement.scrollTop = 220;
  v.window.nfnMobile.setActive(true); v.flush();
  assert.equal(v.document.scrollingElement.scrollTop, 0);
  assert.equal(cleared, 2);
  assert.ok(resets.every(([x, y]) => x === 0 && y === 0));
});

function nativeKeyboard({ bottomAnchored = true, current } = {}) {
  const ts = require("../desktop/node_modules/typescript");
  const events = {}, cleanups = [], values = [], refs = [], animations = [], exports = {};
  const safeArea = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.resolve(__dirname, "../remote/src/lib/remainingSafeArea.ts"), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText, { exports: safeArea });
  const source = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, "../remote/src/hooks/useMessageKeyboard.ts"), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const subscribe = (name, callback) => { events[name] = callback; return { remove() { delete events[name]; } }; };
  vm.runInNewContext(source, { exports, require: name => name === "../lib/remainingSafeArea" ? safeArea : name === "react" ? {
    useRef: current => { const ref = { current }; refs.push(ref); return ref; },
    useState: value => [value, next => values.push(next)], useCallback: callback => callback,
    useEffect: effect => cleanups.push(effect()),
  } : name === "react-native-safe-area-context" ? { useSafeAreaInsets: () => ({ left: 40, right: 0, bottom: 34 }) } : { useWindowDimensions: () => ({ width: 390, height: 844 }), Platform: { OS: "ios" }, Dimensions: { get: () => ({ height: 844 }) },
    Keyboard: { addListener: subscribe, isVisible: () => false, metrics: () => current, scheduleLayoutAnimation: event => animations.push(event) }, AppState: { addEventListener: subscribe } } });
  const hook = exports.useMessageKeyboard(bottomAnchored);
  const frame = (name, screenY, height) => {
    const event = { endCoordinates: { screenY, height }, duration: 250, easing: "keyboard" };
    events[name](event); return event;
  };
  return { hook, frame, events, values, animations, cleanup: () => cleanups.forEach(cleanup => cleanup?.()) };
}

test("popup keyboard resize uses host overlap and clears stale offsets on hide/background", () => {
  const { hook, frame, events, values, cleanup } = nativeKeyboard({ bottomAnchored: false });
  let bottom = 844, hostX = 0;
  hook.host.current = { measureInWindow: callback => callback(hostX, 100, 390 - hostX, bottom - 100) };
  hook.onLayout();
  assert.equal(values.at(-2).left, 40, "full-width content clears the rail");
  hostX = 40; hook.onLayout();
  assert.equal(values.at(-2).left, 0, "an already inset parent is not padded twice");
  frame("keyboardWillChangeFrame", 500, 344); assert.equal(values.at(-1), 344);
  hook.onLayout(); assert.equal(values.at(-1), 344);
  bottom = 430; hook.onLayout(); assert.equal(values.at(-1), 0);
  bottom = 844; frame("keyboardWillShow", 500, 344); events.keyboardWillHide(); assert.equal(values.at(-1), 0);
  frame("keyboardWillShow", 500, 344); events.change("background"); assert.equal(values.at(-1), 0);
  frame("keyboardWillChangeFrame", 844, 0); assert.equal(values.at(-1), 0);
  cleanup(); assert.deepEqual(Object.keys(events), []);
});

test("modal reply lifts controls on keyboard show even with a sheet-local origin or delayed measurement", () => {
  const { hook, frame, events, values, animations, cleanup } = nativeKeyboard();
  let measure;
  hook.host.current = { measureInWindow: callback => { measure = callback; } };
  const show = frame("keyboardWillShow", 500, 344);
  assert.equal(values.at(-1), 344, "toolbar moves without waiting for a frame-change event or measurement");
  assert.equal(animations.at(-1), show, "layout follows the native keyboard animation");
  measure(0, 0, 390, 450);
  assert.equal(values.at(-1), 344, "sheet-local coordinates cannot reset the keyboard lift to zero");
  frame("keyboardWillChangeFrame", 460, 384); assert.equal(values.at(-1), 384);
  frame("keyboardDidShow", 460, 384); assert.equal(values.at(-1), 384);
  const hide = { duration: 250, easing: "keyboard" };
  events.keyboardWillHide(hide); assert.equal(values.at(-1), 0); assert.equal(animations.at(-1), hide);
  measure(0, 0, 390, 450); assert.equal(values.filter(value => typeof value === "number").at(-1), 0, "late measurement cannot restore a dismissed keyboard");
  cleanup();
});

test("mounting the message surface with an open keyboard restores its toolbar clearance", () => {
  const view = nativeKeyboard({ current: { screenY: 500, height: 344 } });
  assert.equal(view.values.at(-1), 344);
  view.events.keyboardDidHide(); assert.equal(view.values.at(-1), 0);
  view.cleanup();
});

test("web host keeps full height through route entry and follows the outer keyboard viewport", () => {
  const ts = require("../desktop/node_modules/typescript");
  const effects = [], frames = [], listeners = {}, exports = {};
  const viewport = { height: 800, offsetTop: 0,
    addEventListener: (name, callback) => listeners[name] = callback,
    removeEventListener: name => delete listeners[name] };
  const source = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, "../remote/src/components/MessageSurface.web.tsx"), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const dependencies = {
    react: { useRef: current => ({ current }), useState: value => [value, () => {}], useCallback: callback => callback, useEffect: callback => effects.push(callback) },
    "react/jsx-runtime": { jsx: (type, props) => ({ type, props }) },
    "../lib/messageSurfaceDocument.generated": { default: "fixture" },
    "../lib/messageSurfaceBootstrap": { messageSurfaceInitialDocument: document => document },
  };
  const window = { innerHeight: 800, visualViewport: viewport, addEventListener() {}, removeEventListener() {} };
  vm.runInNewContext(source, { exports, require: name => dependencies[name],
    requestAnimationFrame: callback => { frames.push(callback); return frames.length; }, cancelAnimationFrame() {},
    window });
  const tree = exports.MessageSurface({ snapshot: {}, onCommand: async () => ({}) });
  let top = 100;
  const frame = tree.props.ref.current = { style: {}, getBoundingClientRect: () => ({ top }) };
  const cleanup = effects[0]();
  const flush = () => { while (frames.length) frames.shift()(); };
  flush(); assert.equal(frame.style.maxHeight, "");
  top = 60; // Route entrance finishes without firing visualViewport.resize.
  assert.equal(frame.style.maxHeight, "", "no stale initial position limits natural full height");
  viewport.height = 450; listeners.resize(); flush(); assert.equal(frame.style.maxHeight, "390px");
  viewport.offsetTop = 20; listeners.scroll(); flush(); assert.equal(frame.style.maxHeight, "410px");
  viewport.height = 800; viewport.offsetTop = 0; listeners.resize(); flush(); assert.equal(frame.style.maxHeight, "");
  window.innerHeight = viewport.height = 450; listeners.resize(); flush();
  assert.equal(frame.style.maxHeight, "", "layout viewport resizing already constrains the frame");
  cleanup(); assert.deepEqual(Object.keys(listeners), []);
});

test("inline shell input retains focus and its cached scroll position during keyboard layout", () => {
  const v = viewport();
  v.field.classList = { contains: name => name === "shell-keyboard" };
  v.document.activeElement = v.field;
  v.window.nfnMobile.setInsets(34, true);
  v.flush();
  assert.deepEqual(v.scrolled, []);
  v.tap(false);
  assert.equal(v.document.activeElement, v.field);
});

test("native phone orientation controls compact shell even in a portrait-shaped split pane", () => {
  const v = viewport();
  v.window.nfnMobile.setInsets(0, false, true);
  assert.equal(v.document.documentElement.classList.contains("phone-landscape"), true);
  v.context.innerHeight = 900;
  v.listeners.resize(); v.flush();
  assert.equal(v.document.documentElement.classList.contains("phone-landscape"), true);
  v.window.nfnMobile.setInsets(34, false, false);
  assert.equal(v.document.documentElement.classList.contains("phone-landscape"), false);
  assert.equal(v.properties["--message-safe-bottom"], "34px");
});
