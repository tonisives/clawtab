const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const context = vm.createContext({ window: {}, URL });
for (const name of ['vendor/marked.js', 'markdown.js']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../shared/src/nfn', name), 'utf8'), context);
}
const links = text => JSON.parse(JSON.stringify(context.window.nfnMessageLinks(text)));

test('discovers labeled, bare, reference, autolink and code URLs', () => {
  assert.deepEqual(links('[Web deployment](https://github.com/tgs-space/clawtab/actions/runs/42420259638)\n\nhttp://localhost:3000/preview.\n\n[Report][report]\n\n[report]: https://example.com/report?a=1&b=2\n\n<https://example.com/auto>\n\n`https://example.com/build_(final)`'), [
    { label: 'Web deployment', url: 'https://github.com/tgs-space/clawtab/actions/runs/42420259638' },
    { label: 'http://localhost:3000/preview', url: 'http://localhost:3000/preview' },
    { label: 'Report', url: 'https://example.com/report?a=1&b=2' },
    { label: 'https://example.com/auto', url: 'https://example.com/auto' },
    { label: 'https://example.com/build_(final)', url: 'https://example.com/build_(final)' },
  ]);
});

test('deduplicates destinations and ignores non-web links and image sources', () => {
  assert.deepEqual(links('[Preview](https://example.com) https://example.com/ [bad](javascript:alert(1)) [file](file:///tmp/report) [mail](mailto:a@example.com) ![image](https://example.com/image.png)'), [
    { label: 'Preview', url: 'https://example.com/' },
  ]);
});

test('trims sentence punctuation around code URLs and accepts empty messages', () => {
  assert.deepEqual(links('`(https://example.com/report).`'), [{ label: 'https://example.com/report', url: 'https://example.com/report' }]);
  assert.deepEqual(links(null), []);
});
