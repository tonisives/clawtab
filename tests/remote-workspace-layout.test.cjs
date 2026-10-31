const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('../desktop/node_modules/typescript');
const exports_ = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(__dirname + '/../remote/src/lib/workspaceLayout.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText, { exports: exports_ });
const layout = exports_.workspaceLayout;

test('available width controls splitting in both orientations', () => {
  assert.equal(layout(393, 852).split, false);
  assert.equal(layout(604, 900).split, false);
  assert.equal(layout(605, 900).split, true);
  assert.equal(layout(800, 500).split, true);
  assert.equal(layout(800, 1100).split, true);
  assert.equal(layout(800, 1100, 1.5).split, false);
  assert.equal(layout(1000, 1100, 1.5).split, true);
});

test('a vertical division becomes the gutter when both panes fit', () => {
  const result = layout(900, 800, 1, [{ x: 400, y: 0, width: 20, height: 800 }]);
  assert.equal(result.split, true);
  assert.equal(result.listWidth, 400);
  assert.equal(result.gutterWidth, 20);
});

test('a horizontal fold or narrow half keeps content on the larger side', () => {
  const horizontal = layout(900, 800, 1, [{ x: 0, y: 300, width: 900, height: 20 }]);
  assert.equal(horizontal.split, false);
  assert.equal(horizontal.clearance.top, 320);
  const vertical = layout(700, 800, 1, [{ x: 200, y: 0, width: 20, height: 800 }]);
  assert.equal(vertical.split, false);
  assert.equal(vertical.clearance.left, 220);
});

test('regions outside the current app window do not prevent splitting', () => {
  assert.equal(layout(800, 900, 1, [{ x: 900, y: 0, width: 20, height: 900 }]).split, true);
});
