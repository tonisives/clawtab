const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('../desktop/node_modules/typescript');
let flush = () => new Promise(setImmediate);
let harness = (overrides = {}, os = 'ios') => {
  let states = [], cursor = 0, pending = [], cleanups = [], resumed;
  let calls = { init: 0, fetch: 0, end: 0 };
  let store = {
    initConnection: async () => { calls.init++; return true; },
    fetchProducts: async () => { calls.fetch++; return [{ id: 'cc.clawtab.pro.monthly', displayPrice: '$5.00' }]; },
    endConnection: () => calls.end++,
    ...overrides,
  };
  let modules = {
    react: {
      useState: (initial) => { let i = cursor++; if (!(i in states)) states[i] = initial; return [states[i], (value) => states[i] = value]; },
      useRef: (initial) => { let i = cursor++; states[i] ??= { current: initial }; return states[i]; },
      useCallback: (callback) => { let i = cursor++; states[i] ??= callback; return states[i]; },
      useEffect: (effect) => { let i = cursor++; if (states[i]) return; states[i] = true; pending.push(() => cleanups.push(effect())); },
    },
    'react-native': { Platform: { OS: os }, AppState: { addEventListener: (_, handler) => { resumed = handler; return { remove() {} }; } } },
    'react-native-iap': store,
    '../api/client': {},
  };
  let exports = {};
  let source = ts.transpileModule(fs.readFileSync(__dirname + '/../remote/src/hooks/useIap.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(source, { exports, require: (name) => modules[name], setTimeout, clearTimeout, Error, console });
  return {
    store, calls,
    render: () => { cursor = 0; let result = exports.useIap(); pending.splice(0).forEach((run) => run()); return result; },
    resume: () => resumed('active'),
    unmount: () => cleanups.forEach((cleanup) => cleanup?.()),
  };
};

test('StoreKit loading is distinct from failure, and connection failures can recover without remounting', async () => {
  let h = harness({ initConnection: async () => { throw Object.assign(new Error('store unavailable'), { code: 'E_IAP_NOT_AVAILABLE' }); } });
  assert.equal(h.render().loading, true);
  await flush();
  assert.equal(h.render().loading, false);
  assert.equal(h.render().available, false);
  assert.match(h.render().diagnostic, /E_IAP_NOT_AVAILABLE/);
  h.store.initConnection = async () => true;
  await h.render().retry();
  assert.equal(h.render().available, true);
  assert.equal(h.render().price, '$5.00');
  assert.equal(h.render().error, null);
  h.unmount();
  assert.equal(h.calls.end, 0, 'unmounting one account page must not disconnect another store consumer');
});

test('an empty product response explains the configured product and retries on foreground', async () => {
  let h = harness({ fetchProducts: async () => [] });
  h.render(); await flush();
  assert.equal(h.render().available, false);
  assert.match(h.render().error, /did not return/);
  assert.match(h.render().diagnostic, /cc\.clawtab\.pro\.monthly/);
  h.store.fetchProducts = async () => [{ id: 'different-product', displayPrice: '$1' }];
  await h.render().retry();
  assert.equal(h.render().available, false);
  h.store.fetchProducts = async () => [{ id: 'cc.clawtab.pro.monthly', displayPrice: '$5' }];
  h.resume(); await flush();
  assert.equal(h.render().available, true);
  assert.equal(h.calls.init, 1, 'catalog retries reuse the open StoreKit connection');
});

test('a false connection result does not fetch products, and web never loads StoreKit', async () => {
  let h = harness({ initConnection: async () => false });
  h.render(); await flush();
  assert.equal(h.calls.fetch, 0);
  assert.match(h.render().diagnostic, /connection was not established/);
  let web = harness({}, 'web');
  web.render(); await flush();
  assert.equal(web.calls.init, 0);
  assert.equal(web.render().loading, false);
});
