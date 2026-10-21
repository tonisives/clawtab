const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('../desktop/node_modules/typescript');

function browser() {
  let entries = [{ state: { router: 'preserved' }, url: 'https://remote.test/?process=one' }];
  let index = 0;
  let listeners = new Set();
  let win = {
    location: { href: entries[0].url },
    addEventListener: (_, listener) => listeners.add(listener),
    removeEventListener: (_, listener) => listeners.delete(listener),
  };
  let move = (delta) => {
    let next = index + delta;
    if (next < 0 || next >= entries.length) return;
    index = next;
    win.location.href = entries[index].url;
    listeners.forEach((listener) => listener({ state: structuredClone(entries[index].state) }));
  };
  win.history = {
    get state() { return structuredClone(entries[index].state); },
    replaceState: (state, _, url) => {
      entries[index] = { state: structuredClone(state), url };
      win.location.href = url;
    },
    pushState: (state, _, url) => {
      entries.splice(++index, entries.length, { state: structuredClone(state), url });
      win.location.href = url;
    },
    back: () => move(-1),
    forward: () => move(1),
  };
  return { win, entries };
}

function harness(web = browser()) {
  let slots = [], cursor = 0, queued = [], dirty = false;
  let value = { page: 'agent-one' }, enabled = true;
  let restored = [];
  let react = {
    useRef: (initial) => { let i = cursor++; return slots[i] ??= { current: initial }; },
    useState: (initial) => {
      let i = cursor++;
      if (!(i in slots)) slots[i] = initial;
      return [slots[i], (next) => { if (slots[i] !== next) { slots[i] = next; dirty = true; } }];
    },
    useCallback: (fn) => fn,
    useEffect: (fn, deps) => {
      let i = cursor++;
      if (slots[i] && deps.every((dep, j) => Object.is(dep, slots[i].deps[j]))) return;
      slots[i]?.cleanup?.();
      slots[i] = { deps };
      queued.push(() => { slots[i].cleanup = fn(); });
    },
  };
  let exports = {};
  let source = ts.transpileModule(fs.readFileSync(__dirname + '/../remote/src/hooks/useWebBackStack.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(source, { exports, window: web.win, require: () => react });
  let render = () => {
    let result;
    do {
      dirty = false;
      cursor = 0;
      result = exports.useWebBackStack({ enabled, navigationKey: value.page, value, onRestore: (next) => {
        restored.push(next);
        value = next;
        dirty = true;
      } });
      queued.splice(0).forEach((fn) => fn());
    } while (dirty);
    return result;
  };
  return {
    ...web, render, restored,
    navigate: (next, url = web.win.location.href) => {
      value = next;
      // Existing selection code replaces the URL before the new render.
      web.win.history.replaceState(web.win.history.state, '', url);
      return render();
    },
    setEnabled: (next) => { enabled = next; return render(); },
    get value() { return value; },
    unmount: () => slots.forEach((slot) => slot?.cleanup?.()),
  };
}

test('Back and Forward restore agents and each nested settings view', () => {
  let view = harness();
  assert.equal(view.render().canGoBack, false);
  view.navigate({ page: 'settings', settings: { routes: ['home'] } });
  view.navigate({ page: 'terminal', settings: { routes: ['home', 'terminal'] } });
  view.navigate({ page: 'agent-two' }, 'https://remote.test/?process=two');
  assert.equal(view.entries.length, 4);
  view.render().goBack();
  assert.equal(view.value.page, 'terminal');
  assert.deepEqual(view.value.settings.routes, ['home', 'terminal']);
  view.render().goBack();
  assert.equal(view.value.page, 'settings');
  view.render().goBack();
  assert.equal(view.value.page, 'agent-one');
  assert.equal(view.win.location.href, 'https://remote.test/?process=one');
  assert.equal(view.render().canGoBack, false);
  view.win.history.forward();
  view.render();
  view.win.history.forward();
  assert.equal(view.value.page, 'terminal');
  assert.equal(view.entries.length, 4, 'Restoration must not create extra history entries');
  assert.equal(view.win.history.state.router, 'preserved');
});

test('repeated selections replace state and a new destination discards forward history', () => {
  let view = harness();
  view.render();
  view.navigate({ page: 'settings', scroll: 20 });
  view.navigate({ page: 'settings', scroll: 40 });
  assert.equal(view.entries.length, 2);
  view.navigate({ page: 'terminal' });
  view.render().goBack();
  view.render();
  assert.equal(view.value.scroll, 40);
  view.navigate({ page: 'notifications' });
  view.win.history.forward();
  assert.equal(view.value.page, 'notifications');
  assert.equal(view.entries.length, 3);
});

test('remount restores the current nested view and keeps its Back history', () => {
  let web = browser();
  let first = harness(web);
  first.render();
  first.navigate({ page: 'terminal', settings: { routes: ['home', 'terminal'] } });
  first.unmount();
  let second = harness(web);
  assert.equal(second.render().canGoBack, true);
  assert.equal(second.value.page, 'terminal');
  second.render().goBack();
  assert.equal(second.value.page, 'agent-one');
  assert.equal(second.render().canGoBack, false);
});

test('native and narrow layouts leave browser history untouched', () => {
  let view = harness();
  view.setEnabled(false);
  view.navigate({ page: 'settings' });
  assert.equal(view.entries.length, 1);
  assert.deepEqual(view.win.history.state, { router: 'preserved' });
});
