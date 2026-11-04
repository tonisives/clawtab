const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('native diagnostic export filters unknown stages, old builds and expired events', { skip: process.platform !== 'darwin' }, t => {
  let temporary=fs.mkdtempSync(path.join(os.tmpdir(),'clawtab-iap-reader-'));
  t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  let helper=fs.readFileSync(path.join(__dirname,'../../modules/clawtab-iap-diagnostics/ios/IapDiagnosticsReader.swift'),'utf8');
  let source=path.join(temporary,'main.swift'), binary=path.join(temporary,'reader');
  fs.writeFileSync(source,helper+`
let key="ClawTabIapTrace.v1"
let now=Date().timeIntervalSince1970*1000
UserDefaults.standard.set([
 ["stage":"storekit-success","time":now,"build":"unknown","code":42,"receipt":"private-payload"],
 ["stage":"private-error","time":now,"build":"unknown"],
 ["stage":"storekit-threw","time":0,"build":"unknown"],
 ["stage":"storekit-pending","time":now,"build":"old"]
], forKey:key)
defer { UserDefaults.standard.removeObject(forKey:key) }
let result=IapDiagnosticsReader.read()
precondition(result.contains("storekit-success code=42"))
precondition(!result.contains("private"))
precondition(!result.contains("storekit-threw"))
precondition(!result.contains("storekit-pending"))
print("PASS")
`);
  let compiled=spawnSync('xcrun',['swiftc','-j4','-module-cache-path',path.join(temporary,'cache'),source,'-o',binary],{encoding:'utf8',timeout:60000});
  assert.equal(compiled.status,0,compiled.stderr);
  let result=spawnSync(binary,[],{encoding:'utf8',timeout:10000});
  assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/PASS/);
});
