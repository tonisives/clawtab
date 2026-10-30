const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('../desktop/node_modules/typescript');
const exportsObject = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(require.resolve('../shared/src/util/cron.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports: exportsObject, Date, Intl, Set, Object });
const next = (cron, after, zone) => exportsObject.nextCronDate(cron, new Date(after), zone)?.toISOString();
test('Bangkok weekdays remain fixed across host timezone and weekends', () => {
  assert.equal(next('0 9 * * 1-5', '2026-10-30T02:00:00Z', 'Asia/Bangkok'), '2026-11-02T02:00:00.000Z');
  assert.equal(next('0 9 * * 1-5', '2026-10-29T23:59:00Z', 'Asia/Bangkok'), '2026-10-30T02:00:00.000Z');
});
test('DST skips missing wall times and includes the second repeated hour', () => {
  assert.equal(next('30 2 * * *', '2026-03-08T06:59:00Z', 'America/New_York'), '2026-03-09T06:30:00.000Z');
  assert.equal(next('30 1 * * *', '2026-11-01T05:30:00Z', 'America/New_York'), '2026-11-01T06:30:00.000Z');
});
