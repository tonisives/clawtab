const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('../desktop/node_modules/typescript');

function load(relative) {
  const file = path.resolve(__dirname, '../shared/src', relative);
  const source = fs.readFileSync(file, 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, { exports, require: (name) => load(`util/${name}.ts`) });
  return exports;
}

const { parseAnsi, stripAnsi } = load('util/ansi.ts');
const { collapseSeparators } = load('util/logs.ts');
const spans = (text) => JSON.parse(JSON.stringify(parseAnsi(text)));

test('shell previews preserve CR and CRLF line breaks without doubling them', () => {
  const input = '\x1b[32m$ build\r\nFinished\rAllow?\x1b[0m\r\n';
  assert.equal(stripAnsi(input), '$ build\nFinished\nAllow?\n');
  assert.equal(spans(input).map((s) => s.text).join(''), '$ build\nFinished\nAllow?\n');
  assert.equal(collapseSeparators('a\rb\r\nc'), 'a\nb\nc');
});

test('supports base, bright, indexed, and truecolor foreground and backgrounds', () => {
  const result = spans('\x1b[31;44mred\x1b[93;104mbright\x1b[38;5;208;48;5;235mindexed\x1b[38;2;1;2;3;48;2;4;5;6mrgb');
  assert.deepEqual(result.map((s) => s.style), [
    { color: '#ff6b6b', backgroundColor: '#74c0fc' },
    { color: '#ffe066', backgroundColor: '#a5d8ff' },
    { color: 'rgb(255,135,0)', backgroundColor: 'rgb(38,38,38)' },
    { color: 'rgb(1,2,3)', backgroundColor: 'rgb(4,5,6)' },
  ]);
});

test('colon colors and inverse selection match terminal SGR semantics', () => {
  const result = spans('\x1b[38:2::10:20:30;48:5:21mcolor\x1b[7mselected\x1b[27;39;49mplain');
  assert.deepEqual(result, [
    { text: 'color', style: { color: 'rgb(10,20,30)', backgroundColor: 'rgb(0,0,255)' } },
    { text: 'selected', style: { color: 'rgb(0,0,255)', backgroundColor: 'rgb(10,20,30)' } },
    { text: 'plain', style: {} },
  ]);
  assert.equal(spans('\x1b[38:2:0:1:2:3mvalue')[0].style.color, 'rgb(1,2,3)');
});

test('styles and resets persist correctly over newlines and long shell commands', () => {
  const command = 'x'.repeat(200);
  const result = spans(`\x1b[1;2;3;4;32m${command}\nnext\x1b[22;23;24;39mplain\x1b[7minverse\x1b[mreset`);
  assert.equal(result[0].text, `${command}\nnext`);
  assert.deepEqual(result[0].style, { color: '#69db7c', fontWeight: 'bold', opacity: 0.6, fontStyle: 'italic', textDecorationLine: 'underline' });
  assert.deepEqual(result[1].style, {});
  assert.deepEqual(result[2].style, { color: '#000000', backgroundColor: '#dee2e6' });
  assert.deepEqual(result[3].style, {});
});

test('hides terminal cursor controls and hyperlink wrappers without losing labels', () => {
  const input = '\x1b[?25l\x1b[2J\x1b[H\x1b]8;;https://example.test\x1b\\link\x1b]8;;\x07\x1b(Bdone';
  assert.equal(spans(input).map((s) => s.text).join(''), 'linkdone');
  assert.equal(stripAnsi(input), 'linkdone');
});

test('invalid extended colors keep the current style and do not leak control bytes', () => {
  const result = spans('\x1b[32mgreen\x1b[38;5;999mbad index\x1b[48;2;999;0;0mbad RGB');
  assert.ok(result.every((s) => s.style.color === '#69db7c' && !s.style.backgroundColor));
  assert.equal(result.map((s) => s.text).join(''), 'greenbad indexbad RGB');
});

test('notification previews omit gray row fills and preserve colored text and newlines', () => {
  const input = '\x1b[48;2;72;76;92m    \r\nWould you like to run this command?\r\n'
    + '\x1b[38;2;166;227;161mcommand\x1b[39m\r\n';
  const result = parseAnsi(input, '#aaaaaa', '#000000', false);
  assert.ok(result.every((s) => !s.style.backgroundColor));
  assert.equal(result.find((s) => s.text === 'command').style.color, 'rgb(166,227,161)');
  assert.equal(result.map((s) => s.text).join(''), '    \nWould you like to run this command?\ncommand\n');
});

test('notification selections remain readable when their ANSI fills are removed', () => {
  const input = '\x1b[1;38;2;0;0;46;48;2;99;168;248mYes, proceed'
    + '\x1b[0;7minverse\x1b[0;30;40mdark\x1b[0mplain';
  const result = JSON.parse(JSON.stringify(parseAnsi(input, '#aaaaaa', '#000000', false)));
  assert.deepEqual(result, [
    { text: 'Yes, proceed', style: { color: 'rgb(99,168,248)', fontWeight: 'bold' } },
    { text: 'inverse', style: { color: '#aaaaaa' } },
    { text: 'dark', style: { color: '#aaaaaa' } },
    { text: 'plain', style: {} },
  ]);
});
