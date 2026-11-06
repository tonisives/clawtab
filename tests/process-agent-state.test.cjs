const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('../desktop/node_modules/typescript');
const exportsForTest = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(__dirname + '/../shared/src/types/process.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText, { exports: exportsForTest });

test('machine activity overrides recent logs and missing log timestamps', () => {
  const resolve = exportsForTest.resolveProcessAgentState;
  assert.equal(resolve('finished', true), 'finished');
  assert.equal(resolve('alert', true), 'alert');
  assert.equal(resolve('asking', true), 'asking');
  assert.equal(resolve('working', false), 'working');
  assert.equal(resolve(undefined, true), 'working');
  assert.equal(resolve(undefined, false), 'finished');
});

test('Codex sign-in screen is actionable and clears when its composer appears', () => {
  const alerts = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(__dirname + '/../shared/src/util/alert.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText, { exports: alerts });
  const process = { provider: 'codex', log_lines: 'Welcome to Codex\nSign in with ChatGPT\nSign in with device code' };
  assert.match(alerts.agentSetupAlert(process), /Sign in to Codex/);
  assert.equal(alerts.agentSetupAlert({ ...process, log_lines: process.log_lines + '\n› Ask Codex to do anything' }), undefined);
  assert.equal(alerts.agentSetupAlert({ ...process, provider: 'shell' }), undefined);
});
