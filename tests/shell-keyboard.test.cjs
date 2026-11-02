const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("../desktop/node_modules/typescript");
const exports_ = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(require.resolve("../remote/src/lib/shellKeyboardEdit.ts"), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports: exports_ });
const { shellKeyboardEdit } = exports_;

test("native shell input sends typing, deletion, replacement and pasted line breaks literally", () => {
  assert.equal(shellKeyboardEdit("", "hello"), "hello");
  assert.equal(shellKeyboardEdit("hello", "hell"), "\x7f");
  assert.equal(shellKeyboardEdit("hello", "help"), "\x7f\x7fp");
  assert.equal(shellKeyboardEdit("", "first\r\nsecond\n"), "first\rsecond\r");
  assert.equal(shellKeyboardEdit("same", "same"), "");
});

test("replacing a supplementary character deletes a whole code point", () => {
  assert.equal(shellKeyboardEdit("\u{1D400}", "\u{1D401}"), "\x7f\u{1D401}");
  assert.equal(shellKeyboardEdit("a\u{1D400}", "a"), "\x7f");
});
