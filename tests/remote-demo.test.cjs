const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('../desktop/node_modules/typescript');

let loadDemo = (entry, params = {}) => {
  let states = [], cursor = 0, pushed = [], cache = {};
  let modules = {
    react: { useState: (initial) => { let index = cursor++; states[index] ??= typeof initial === 'function' ? initial() : initial; return [states[index], (value) => { states[index] = typeof value === 'function' ? value(states[index]) : value; }]; } },
    'react/jsx-runtime': { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) },
    'react-native': { Platform: { OS: 'ios' }, StyleSheet: { create: (value) => value }, Text: 'Text', View: 'View' },
    'expo-router': { useRouter: () => ({ push: (route) => pushed.push(route) }), useLocalSearchParams: () => params, Stack: { Screen: 'Screen' } },
    '@clawtab/shared': { JobListView: 'JobListView', colors: {} },
    '../../../shared/src/components/InsetList': { InsetList: 'InsetList', InsetListRow: 'InsetListRow' },
    '../../src/components/settings/SettingsPage': { SettingsPage: 'SettingsPage' },
  };
  let load = (file) => {
    if (cache[file]) return cache[file];
    let exports = {}; cache[file] = exports;
    let source = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    vm.runInNewContext(source, { exports, require: (name) => {
      if (name in modules) return modules[name];
      if (name.endsWith('/demo/data')) return load(path.resolve(path.dirname(file), `${name}.ts`));
      throw new Error(`Demo attempted to import a live dependency: ${name}`);
    } });
    return exports;
  };
  let component = load(require.resolve(`../remote/app/demo/${entry}`)).default;
  return { pushed, render: () => { cursor = 0; return component(); } };
};
let all = (node) => Array.isArray(node) ? node.flatMap(all) : node && typeof node === 'object' ? [node, ...all(node.props?.children)] : [];

test('demo list has isolated sample groups and no live mutation callbacks', () => {
  let demo = loadDemo('index.tsx');
  let { props } = demo.render();
  assert.ok(props.jobs.length > 0 && props.detectedProcesses.length > 0);
  assert.equal(props.savedGroups.length, 0);
  for (let callback of ['onRunAgent', 'onStopJob', 'onStopProcess', 'groupPreferencesApi', 'onSaveProcessName', 'onTogglePin']) assert.equal(props[callback], undefined);
  let controls = all(props.headerContent).filter((node) => node.type === 'InsetListRow');
  assert.equal(controls.length, 2);
  assert.ok(controls.every((node) => node.props.disabled));
  props.onSelectJob(props.jobs[0]);
  props.onSelectProcess(props.detectedProcesses[0]);
  assert.ok(demo.pushed.every((route) => route.pathname === '/demo/[id]'));
  assert.equal(demo.pushed[0].params.kind, 'job');
  assert.equal(demo.pushed[1].params.kind, 'process');
  props.onToggleGroup('sample');
  assert.ok(demo.render().props.collapsedGroups.has('sample'));
});

test('demo job and agent details render output offline and disable action controls', () => {
  for (let params of [{ id: 'deploy-api', kind: 'job' }, { id: 'demo-pane-codex', kind: 'process' }]) {
    let nodes = all(loadDemo('[id].tsx', params).render());
    assert.ok(nodes.some((node) => node.type === 'Text' && node.props.children === 'Output'));
    let action = nodes.find((node) => node.type === 'InsetListRow' && node.props.title === 'Agent actions');
    assert.equal(action.props.disabled, true);
    assert.ok(nodes.some((node) => node.type === 'Text' && typeof node.props.children === 'string' && node.props.children.length > 100));
  }
});
