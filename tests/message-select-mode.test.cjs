const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("../desktop/node_modules/typescript");
const path = require("node:path");

function load(file, dependencies = {}) {
  const exports = {};
  const source = ts.transpileModule(fs.readFileSync(path.join(__dirname, "../remote/src", file), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  vm.runInNewContext(source, { exports, require: name => dependencies[name] });
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
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(html.includes("&amp;"));
  assert.ok(html.includes("user-select:text"));
});

test("selection uses read-only native text and Copy all copies the frozen text", async () => {
  let copied, done = false;
  const jsx = (type, props) => ({ type, props });
  const { MessageTextSelection } = load("components/MessageTextSelection.tsx", {
    react: { useMemo: callback => callback(), useRef: current => ({ current }), useState: value => [value, () => {}] },
    "react/jsx-runtime": { jsx, jsxs: jsx }, "react-native": { View: "View", Text: "Text", TextInput: "TextInput", Pressable: "Pressable", Platform: { OS: "ios" } },
    "@clawtab/shared": { colors: {} },
    "react-native-webview": { default: "WebView" },
    "../lib/terminalSelectionDocument": { terminalSelectionDocument: text => text },
    "expo-clipboard": { setStringAsync: async text => { copied = text; } },
  });
  const root = MessageTextSelection({ text: "frozen text", selection: { start: 0, end: 6 }, bottom: 34, onDone: () => done = true });
  const input = root.props.children.find(node => node?.type === "TextInput");
  assert.equal(input.props.editable, false);
  assert.equal(input.props.showSoftInputOnFocus, false);
  assert.equal(input.props.defaultValue, "frozen text");
  assert.deepEqual(input.props.selection, { start: 0, end: 6 }, "initial native props position before first layout");
  assert.equal(input.props.ref, undefined, "no animated imperative scroll after layout");
  assert.ok(!JSON.stringify(root).includes("Touch and hold"));
  const buttons = root.props.children.at(-1).props.children;
  buttons[0].props.onPress(); await Promise.resolve();
  assert.equal(copied, "frozen text");
  buttons[1].props.onPress(); assert.equal(done, true);
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
