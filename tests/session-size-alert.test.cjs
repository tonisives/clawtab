const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('../desktop/node_modules/typescript');

test('machine session alerts stay scoped to their host and clear with new activity', () => {
  let exports = {};
  let source = ts.transpileModule(fs.readFileSync(__dirname + '/../shared/src/machines/client.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(source, { exports, require: () => ({}) });
  let state = exports.machineState();
  let first = '11111111-1111-1111-1111-111111111111';
  let second = '22222222-2222-2222-2222-222222222222';
  state.machines = [{ id: first }, { id: second }];
  state.snapshots = Object.fromEntries([first, second].map((id) => [id, {
    detected_processes: { processes: [{ pane_id: '%1' }] },
    agent_activity: { activity: [{ pane_id: '%1', working: true, asking: false, ...(id === first ? { alert: 'Codex session file is 1200 MB' } : {}) }] },
  }]));
  let processes = exports.machineProcesses();
  assert.equal(processes[0].pane_id, first + '::%1');
  assert.equal(processes[0]._agent_state, 'alert');
  assert.match(processes[0]._agent_alert, /1200 MB/);
  assert.equal(processes[1]._agent_state, 'working');
  assert.equal(processes[1]._agent_alert, undefined);
  state.snapshots[first].agent_activity.activity[0].alert = undefined;
  assert.equal(exports.machineProcesses()[0]._agent_alert, undefined);
  assert.equal(exports.machineProcesses()[0]._agent_state, 'working');
});


test('session size alert labels identify size warnings and preserve other alerts', () => {
  let exports = {};
  let source = ts.transpileModule(fs.readFileSync(__dirname + '/../shared/src/util/alert.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(source, { exports });
  assert.equal(exports.sessionSizeAlertLabel('Codex session file is 590 MB (warning at 200 MB).'), '↑590 MB');
  assert.equal(exports.agentAlertTitle('Capacity error.\nCodex session file is 1200 MB (warning at 200 MB).'), 'Alert ↑1200 MB');
  assert.equal(exports.sessionSizeAlertLabel('Quota is 590 MB'), null);
  assert.equal(exports.agentAlertTitle('Selected model is at capacity.'), 'Alert');
  assert.equal(exports.sessionSizeAlertLabel(undefined), null);
});
