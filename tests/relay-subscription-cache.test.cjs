const { test }=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const ts=require('../desktop/node_modules/typescript');

test('verified activation invalidates pending Free checks without deleting the replacement request',async()=>{
  let resolve=[];
  let api={getSubscriptionStatus:()=>new Promise(done=>resolve.push(done))};
  let exports={};
  let source=ts.transpileModule(fs.readFileSync(__dirname+'/../remote/src/lib/relaySubscriptionCache.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  vm.runInNewContext(source,{exports,Map,Date,require:()=>api});
  let old=exports.loadRelaySubscription('user',true);
  exports.invalidateRelaySubscription('user');
  let fresh=exports.loadRelaySubscription('user',true);
  resolve[0]({subscribed:false});await old;
  assert.equal(exports.cachedRelaySubscription('user'),null);
  assert.equal(exports.loadRelaySubscription('user',true),fresh);
  resolve[1]({subscribed:true});await fresh;
  assert.equal(exports.cachedRelaySubscription('user').subscribed,true);
});
