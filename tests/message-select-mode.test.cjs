const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("../desktop/node_modules/typescript");
const path = require("node:path");

function load(file, dependencies = {}, globals = {}) {
  const exports = {};
  const source = ts.transpileModule(fs.readFileSync(path.join(__dirname, "../remote/src", file), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  vm.runInNewContext(source, { exports, require: name => dependencies[name], ...globals });
  return exports;
}

test("selection captures displayed shell text and releases input focus", () => {
  const { messageSelectionScript } = load("lib/messageSelection.ts");
  let captured, blurred = false;
  const document = { querySelector: () => ({ textContent: "shell output\nnext line" }),
    querySelectorAll: () => [{ textContent: "message summary" }], activeElement: { blur: () => blurred = true } };
  vm.runInNewContext(messageSelectionScript, { document, window: { ReactNativeWebView: { postMessage: raw => captured = JSON.parse(raw).nfn } } });
  assert.equal(captured.text, "shell output\nnext line");
  assert.equal(captured.native, "selection_text");
  assert.equal(blurred, true);
});

test("messages without shell output capture their text in order", () => {
  const { messageSelectionScript } = load("lib/messageSelection.ts");
  let captured;
  vm.runInNewContext(messageSelectionScript, {
    document: { querySelector: () => null, querySelectorAll: () => [{ textContent: "first" }, { textContent: "second" }] },
    window: { ReactNativeWebView: { postMessage: raw => captured = JSON.parse(raw).nfn.text } },
  });
  assert.equal(captured, "first\n\nsecond");
});

test("the static selection document escapes shell content as text", () => {
  const { terminalSelectionDocument } = load("lib/terminalSelectionDocument.ts", { "@clawtab/shared": { colors: { bg: "#000000", text: "#ffffff" } } });
  const html = terminalSelectionDocument('<script>alert("output")</script> & <b>literal</b>');
  assert.ok(!html.includes('<script>alert("output")</script>'));
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(html.includes("&amp;"));
  assert.ok(html.includes("user-select:text"));
});

test("selection positions its outer scroller before revealing and focusing native text", async () => {
  let copied, done = false, index = 0;
  const hooks = [], frames = [], operations = [];
  let copyTimer;
  const jsx = (type, props) => ({ type, props });
  const react = {
    useEffect: () => {},
    useMemo: callback => callback(),
    useRef: current => { const slot = index++; return hooks[slot] ??= { current }; },
    useState: initial => { const slot = index++; if (!(slot in hooks)) hooks[slot] = initial;
      return [hooks[slot], value => { hooks[slot] = value; }]; },
  };
  const { MessageTextSelection } = load("components/MessageTextSelection.tsx", {
    react, "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-native": { View: "View", ScrollView: "ScrollView", Text: "Text", TextInput: "TextInput", Pressable: "Pressable", Platform: { OS: "ios" } },
    "@clawtab/shared": { colors: {} }, "react-native-webview": { default: "WebView" },
    "../lib/terminalSelectionDocument": { terminalSelectionDocument: text => text },
    "../lib/messageSelectionLayout": load("lib/messageSelectionLayout.ts"),
    "expo-clipboard": { setStringAsync: async text => { copied = text; } },
  }, { requestAnimationFrame: callback => frames.push(callback),
    setTimeout: callback => { copyTimer = callback; return 1; }, clearTimeout: () => { copyTimer = undefined; } });
  const root = MessageTextSelection({ text: "frozen text", selection: { start: 7, end: 11 }, bottom: 34, onDone: () => done = true });
  const native = root.props.children.find(node => typeof node?.type === "function");
  const start = index;
  const render = () => { index = start; return native.type(native.props); };
  let tree = render();
  tree.props.onLayout({ nativeEvent: { layout: { height: 100 } } });
  tree.props.children[0].props.onTextLayout({ nativeEvent: { lines: [
    { text: "frozen ", y: 0, height: 18 }, { text: "text", y: 200, height: 18 },
  ] } });
  tree = render();
  const scroller = tree.props.children[1], input = scroller.props.children;
  assert.equal(input.props.editable, false);
  assert.equal(input.props.scrollEnabled, false, "UITextView has no internal scroll animation");
  assert.equal(input.props.showSoftInputOnFocus, false);
  assert.equal(input.props.defaultValue, "frozen text");
  assert.deepEqual(input.props.selection, { start: 7, end: 11 });
  assert.equal(scroller.props.style.opacity, 0);
  scroller.props.ref.current = { scrollTo: value => operations.push(value) };
  input.props.ref.current = { focus: () => operations.push("focus") };
  scroller.props.onContentSizeChange(300, 242);
  assert.equal(operations.length, 1);
  assert.equal(operations[0].animated, false);
  assert.equal(operations[0].y, 142);
  assert.equal(render().props.children[1].props.style.opacity, 0);
  frames.shift()();
  assert.equal(render().props.children[1].props.style.opacity, 1);
  assert.equal(operations.at(-1), "focus", "focus only after the initial offset is applied");
  scroller.props.onContentSizeChange(300, 242);
  assert.equal(operations.length, 2, "later layout does not reposition the reader");
  input.props.onSelectionChange({ nativeEvent: { selection: { start: 0, end: 6 } } });
  assert.equal(copied, undefined, "wait until selection settles");
  copyTimer(); await Promise.resolve();
  assert.equal(copied, "frozen", "native selection copies only the chosen passage");
  input.props.onSelectionChange({ nativeEvent: { selection: { start: 0, end: 0 } } });
  assert.equal(copyTimer, undefined, "clearing selection cancels pending copying");
  const buttons = root.props.children.at(-1).props.children;
  buttons[0].props.onPress(); await Promise.resolve();
  assert.equal(copied, "frozen text");
  buttons[1].props.onPress(); assert.equal(done, true);
});

test("selection measurement follows native wrapped lines and UTF-16 offsets", () => {
  const { messageSelectionLayout } = load("lib/messageSelectionLayout.ts");
  const text = "日本語 😀 wrapped words\nlast";
  const lines = [{ text: "日本語 😀 ", y: 0, height: 18 }, { text: "wrapped words\n", y: 18, height: 18 }, { text: "last", y: 36, height: 18 }];
  assert.equal(messageSelectionLayout(text, text.indexOf("wrapped"), lines).selectedY, 30);
  assert.equal(messageSelectionLayout(text, text.indexOf("last"), lines).selectedY, 48);
  assert.equal(messageSelectionLayout(text, 0, lines).height, 78);
});

test("native handoff preserves UTF-16 word offsets in the displayed shell", () => {
  const source = fs.readFileSync(path.join(__dirname, "../remote/src/lib/messageSurfaceViewport.js"), "utf8");
  const method = source.slice(source.indexOf("    selectText("), source.indexOf("    holdSelection("));
  let captured;
  const target = { textContent: "first\n日本語 shell 😀 output", contains: () => true };
  const context = {
    document: { caretRangeFromPoint: () => ({ startContainer: {}, startOffset: 17 }), createRange: () => ({
      selectNodeContents() {}, setEnd() {}, toString: () => target.textContent.slice(0, 17),
    }) },
    window: { ReactNativeWebView: { postMessage: raw => captured = JSON.parse(raw).nfn } },
    Math, JSON,
  };
  vm.runInNewContext(`({${method}}).selectText(target, 20, 30)`, { ...context, target });
  assert.equal(captured.text, target.textContent);
  assert.equal(captured.text.slice(captured.selection.start, captured.selection.end), "😀");
  assert.equal(captured.gesture, true);
});
