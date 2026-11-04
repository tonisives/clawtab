const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('../desktop/node_modules/typescript');
const moduleExports = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(__dirname + '/../remote/src/lib/clawArrivalDocument.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports: moduleExports });

function render(playing, settled, native = false) {
  const nodes = [];
  function element(tag) {
    const node = { tag, attributes: {}, children: [], dataset: {},
      setAttribute(key, value) { this.attributes[key] = String(value); },
      append(...children) { this.children.push(...children); },
      querySelector(selector) {
        if (selector.includes('feDropShadow')) return nodes.find(n => n.tag === 'feDropShadow');
        if (selector[0] === '.') return nodes.find(n => n.attributes.class?.split(' ').includes(selector.slice(1)));
        const [, key, value] = selector.match(/\[([^=]+)="([^"]+)"\]/);
        return nodes.find(n => n.attributes[key] === value);
      },
    };
    nodes.push(node); return node;
  }
  let next;
  const messages = [];
  const document = { createElementNS: (_, tag) => element(tag), body: element('body') };
  const window = native ? { ReactNativeWebView: { postMessage: value => messages.push(value) } } : {};
  const html = moduleExports.clawArrivalDocument(playing, settled);
  vm.runInNewContext(html.split('<script>')[1].split('</script>')[0], {
    document, window, parent: { postMessage: value => messages.push(value) },
    requestAnimationFrame: callback => { next = callback; },
  });
  return { nodes, messages, step(now) { const callback = next; next = undefined; callback?.(now); }, get scheduled() { return !!next; } };
}

test('loading holds a complete sharp icon without running an animation', () => {
  const view = render(false, true);
  assert.equal(view.scheduled, false);
  assert.equal(view.nodes.filter(n => 'data-claw' in n.attributes).length, 3);
  assert.ok(view.nodes.filter(n => 'data-cut' in n.attributes).every(n => n.attributes['stroke-dasharray'] === '1 2'));
});

for (const native of [false, true]) test(`slash completes once and releases the ${native ? 'native' : 'web'} transition`, () => {
  const view = render(true, false, native);
  assert.equal(view.messages.length, 0);
  view.step(0);
  view.step(100);
  const cuts = view.nodes.filter(n => 'data-cut' in n.attributes).map(n => parseFloat(n.attributes['stroke-dasharray']));
  assert.ok(cuts[0] > cuts[1] && cuts[1] > cuts[2], 'the three cuts enter in order');
  view.step(1600);
  assert.equal(view.scheduled, false);
  assert.deepEqual(view.messages, ['{"clawArrival":"complete"}']);
  assert.ok(view.nodes.filter(n => 'data-cut' in n.attributes).every(n => n.attributes['stroke-dasharray'] === '1 2'));
});
