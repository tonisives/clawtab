const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../shared/src/nfn/surface.js'), 'utf8');
function render(raw) {
  const node = (tag, _, text) => ({ tag, text: text || '', style: {}, children: [], append(child) { this.children.push(child); } });
  const parent = { replaceChildren(fragment) { this.children = fragment.children; } };
  const code = source.slice(source.indexOf('  function stripAnsi('), source.indexOf('  function field('));
  vm.runInNewContext(code + '\nrenderAnsi(parent, raw);', {
    URL, raw, parent, el: node,
    externalLink(text, href) { return { ...node('a', '', text), href }; },
    document: { createDocumentFragment: () => node('fragment'), createTextNode: text => node('text', '', text) },
  });
  return parent.children;
}
const url = 'https://auth.example.test/authorize?client_id=test&state=fixture';
const osc = (label, end = '\x1b\\') => `\x1b]8;;${url}${end}\x1b[4;36m${label}\x1b]8;;${end}\x1b[0m`;
test('wrapped sign-in hyperlinks retain their first row and full destination', () => {
  const first = url.slice(0, 35), rest = url.slice(35);
  const nodes = render(`\nWelcome\n\n${osc(first)}\n${osc(rest)}\n\n`);
  assert.equal(nodes.map(n => n.text).join(''), `Welcome\n\n${first}\n${rest}`);
  const links = nodes.filter(n => n.tag === 'a');
  assert.equal(links.length, 2);
  assert.ok(links.every(n => n.href === url));
});
test('BEL-terminated hyperlinks keep their labels and reset before plain text', () => {
  const nodes = render(osc('Sign in', '\x07') + ' plain');
  assert.equal(nodes[0].href, url);
  assert.equal(nodes[1].tag, 'span');
  assert.equal(nodes.map(n => n.text).join(''), 'Sign in plain');
});
test('non-web terminal destinations render as plain text', () => {
  assert.equal(render('\x1b]8;;javascript:alert(1)\x07label\x1b]8;;\x07')[0].tag, 'span');
});
