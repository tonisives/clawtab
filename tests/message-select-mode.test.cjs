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

test("selection view uses a static WebView and Copy all copies the frozen text", async () => {
  let copied, done = false;
  const jsx = (type, props) => ({ type, props });
  const { MessageTextSelection } = load("components/MessageTextSelection.tsx", {
    react: { useMemo: callback => callback(), useState: value => [value, () => {}] },
    "react/jsx-runtime": { jsx, jsxs: jsx }, "react-native": { View: "View", Text: "Text", Pressable: "Pressable" },
    "react-native-webview": { default: "WebView" }, "@clawtab/shared": { colors: {} },
    "expo-clipboard": { setStringAsync: async text => { copied = text; } },
    "../lib/terminalSelectionDocument": { terminalSelectionDocument: text => text },
  });
  const root = MessageTextSelection({ text: "frozen text", bottom: 34, onDone: () => done = true });
  const webview = root.props.children.find(node => node.type === "WebView");
  assert.equal(webview.props.javaScriptEnabled, false);
  assert.equal(webview.props.textInteractionEnabled, true);
  assert.equal(webview.props.source.html, "frozen text");
  const buttons = root.props.children.at(-1).props.children;
  buttons[0].props.onPress(); await Promise.resolve();
  assert.equal(copied, "frozen text");
  buttons[1].props.onPress(); assert.equal(done, true);
});
