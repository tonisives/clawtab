const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');
const { create } = require('zustand');

let load = (file, dependencies) => {
  let exports = {};
  let source = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(source, { exports, require: (name) => {
    assert.ok(name in dependencies, `unexpected dependency ${name}`);
    return dependencies[name];
  }, Date });
  return exports;
};
let pane = (id, timestamp) => ({
  pane_id: id, cwd: '/project', last_query: 'continue', first_query: 'start',
  session_started_at: '2026-10-01T00:00:00Z', last_user_message_at: timestamp,
  log_lines: '', token_count: 0,
});
let latest = (processes) => {
  let hook = load('../../shared/src/components/JobListView/useJobListDerivedItems.ts', {
    react: { useMemo: (read) => read() },
    '../../machines/client': { splitResource: () => null },
    '../../util/jobGroups': { matchesSavedGroup: () => false, savedGroupKey: () => '' },
    '../../util/format': { processDisplayTitle: (process) => process.pane_id },
    './helpers': {
      inferProcessJobSlug: () => null, sortGroupKeys: (keys) => [...keys],
      matchesProcessQuery: () => true, matchesQuery: () => true,
      matchesShellQuery: () => true, displayGroupName: (group) => group,
    },
  }).useJobListDerivedItems;
  return hook({
    data: { detectedProcesses: processes, savedGroups: [], jobs: [], shellPanes: [], statuses: {} },
    ordering: { jobOrder: {}, processOrder: {}, sortMode: 'activity' },
    grouping: { collapsedGroups: new Set(), hiddenSectionCollapsed: false, listMode: 'latest' },
    filters: { query: '' }, agent: {},
  }).items.filter((item) => item.kind === 'process').map((item) => item.process.pane_id).join(',');
};
let store = () => load('../src/store/jobs.ts', { zustand: { create } }).useJobsStore;
let first = Date.parse('2026-10-20T01:00:00Z'), last = first + 60000;

test('Latest orders by human messages on a fresh load, despite newer agent output', () => {
  let state = store();
  state.getState().setDetectedProcesses([pane('%508', last), pane('%582', first)]);
  state.getState().setAgentActivity([{ pane_id: '%582', working: true, asking: false }]);
  state.getState().setDetectedProcesses([pane('%508', last), { ...pane('%582', first), log_lines: 'new output', token_count: 100 }]);
  assert.equal(latest(state.getState().detectedProcesses), '%508,%582');
  let reloaded = store();
  reloaded.getState().setDetectedProcesses([pane('%582', first), pane('%508', last)]);
  assert.equal(latest(reloaded.getState().detectedProcesses), '%508,%582');
});

test('identical repeated messages advance using their provider timestamp', () => {
  let state = store();
  state.getState().setDetectedProcesses([pane('%508', last), pane('%582', first)]);
  state.getState().setDetectedProcesses([pane('%508', last), pane('%582', last + 60000)]);
  assert.equal(latest(state.getState().detectedProcesses), '%582,%508');
});

test('an optimistic send survives a stale snapshot until provider history catches up', () => {
  let state = store();
  state.getState().setDetectedProcesses([pane('%508', last), pane('%582', first)]);
  state.getState().markProcessActivity('%582');
  state.getState().setDetectedProcesses([pane('%508', last), pane('%582', first)]);
  assert.equal(latest(state.getState().detectedProcesses), '%582,%508');
});

test('older hosts retain observed message ordering', () => {
  let state = store();
  state.getState().setDetectedProcesses([pane('%508', null), pane('%582', null)]);
  state.getState().setDetectedProcesses([{ ...pane('%508', null), last_query: 'next' }, pane('%582', null)]);
  assert.equal(latest(state.getState().detectedProcesses), '%508,%582');
});
