const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('../desktop/node_modules/typescript');
let flush = async () => { for(let i=0;i<8;i++) await new Promise(setImmediate); };
let deferred = () => { let resolve, reject; let promise = new Promise((yes,no)=>{resolve=yes;reject=no;}); return {promise,resolve,reject}; };
let purchase = (extra={}) => ({ platform:'ios', productId:'cc.clawtab.pro.monthly', transactionId:'test-transaction', purchaseToken:'header.payload.signature', purchaseState:'purchased', transactionDate:1, ...extra });
let harness = (overrides={}) => {
  let now=0, next=0, active=true, timers=new Map(), foreground=new Set(), updated, failed, options;
  let calls={init:0,verify:[],finish:0,sync:0,jws:0,activated:[],request:[]};
  let store={
    initConnection:async()=>{calls.init++;return true},
    fetchProducts:async()=>[{id:'cc.clawtab.pro.monthly',displayPrice:'$4.99'}],
    purchaseUpdatedListener:(callback,config)=>{updated=callback;options=config;return {remove(){}}},
    purchaseErrorListener:(callback)=>{failed=callback;return {remove(){}}},
    getAvailablePurchases:async()=>[], syncIOS:async()=>{calls.sync++},
    getTransactionJwsIOS:async()=>{calls.jws++;return 'fallback.payload.signature'},
    finishTransaction:async()=>{calls.finish++},
    requestPurchase:async(request)=>{calls.request.push(request);return null},
    ...overrides,
  };
  let exports={};
  let source=ts.transpileModule(fs.readFileSync(__dirname+'/../remote/src/lib/iapClient.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  vm.runInNewContext(source,{exports,Date,Map,Set,Promise,Error,setTimeout:(fn,ms)=>{let id=++next;timers.set(id,{fn,at:now+ms});return id},clearTimeout:(id)=>timers.delete(id)});
  let verify=async(signed,user)=>{calls.verify.push({signed,user});return {subscribed:true}};
  let client=exports.createIapClient({loadStore:()=>store,verify:(...args)=>verify(...args),onVerified:(user)=>calls.activated.push(user),isActive:()=>active,onActive:(fn)=>{foreground.add(fn);return ()=>foreground.delete(fn)}});
  return { client,store,calls,get options(){return options},set verify(fn){verify=fn},
    update:(value=purchase())=>updated(value),error:(value)=>failed(value),
    activate:(value)=>{active=value;foreground.forEach(fn=>fn(value))},
    advance:async(ms)=>{now+=ms;for(let [id,timer] of [...timers])if(timer.at<=now){timers.delete(id);timer.fn()}await flush()},
    ready:async()=>{await client.retry();client.setAccount('account-a');await flush()},
  };
};

test('catalog retries keep one connection and a duplicate-enabled listener',async()=>{
  let h=harness({fetchProducts:async()=>[]});await h.ready();
  assert.equal(h.client.getState().available,false);assert.match(h.client.getState().error,/did not return/);
  h.store.fetchProducts=async()=>[{id:'cc.clawtab.pro.monthly',displayPrice:'$5'}];await h.client.retry();
  assert.equal(h.client.getState().price,'$5');assert.equal(h.calls.init,1);assert.equal(h.options.dedupeTransactionIOS,false);assert.equal(h.calls.sync,0);
});
test('connection failure releases loading and retries',async()=>{
  let h=harness({initConnection:async()=>false});await h.client.retry();assert.equal(h.client.getState().loading,false);
  h.store.initConnection=async()=>true;await h.client.retry();assert.equal(h.client.getState().available,true);
});
test('transaction-ID tokens use signed fallback and purchase carries account attribution',async()=>{
  let h=harness();await h.ready();let result=h.client.purchase();await flush();
  assert.equal(h.calls.request[0].request.apple.appAccountToken,'account-a');
  h.update(purchase({purchaseToken:'12345'}));assert.equal((await result).status,'purchased');
  assert.equal(h.calls.jws,1);assert.equal(h.calls.verify[0].signed,'fallback.payload.signature');assert.equal(h.calls.finish,1);
});
test('duplicate callbacks and late native errors cannot override accepted verification',async()=>{
  let h=harness();await h.ready();let verification=deferred();let count=0;h.verify=()=>{count++;return verification.promise};
  let result=h.client.purchase();await flush();h.update();h.update();h.error({code:'unknown',message:'private-message'});await flush();
  assert.equal(h.client.getState().purchasing,true);assert.equal(count,1);
  verification.resolve({subscribed:true});assert.equal((await result).status,'purchased');assert.equal(h.calls.finish,1);
  assert.match(h.client.getState().diagnostic,/error-after-purchase-ignored/);assert.doesNotMatch(h.client.getState().diagnostic,/private-message|account-a|signature|test-transaction/);
});
test('finish failure retains verified access',async()=>{
  let h=harness({finishTransaction:async()=>{throw Error('failure')}});await h.ready();let result=h.client.purchase();await flush();h.update();
  assert.equal((await result).status,'purchased');assert.deepEqual(h.calls.activated,['account-a']);
});
test('failed verification leaves transaction unfinished and explicit restore recovers it',async()=>{
  let h=harness();await h.ready();h.verify=async()=>{throw Error('network')};let result=h.client.purchase();await flush();h.update();
  assert.equal((await result).status,'pending');assert.equal(h.calls.finish,0);
  h.verify=async()=>({subscribed:true});h.store.getAvailablePurchases=async()=>[purchase()];
  assert.equal((await h.client.restore()).status,'purchased');assert.equal(h.calls.sync,1);assert.equal(h.calls.finish,1);
});
test('cancellation is normal and a null SDK return waits for callbacks',async()=>{
  let h=harness();await h.ready();let result=h.client.purchase();await flush();assert.equal(h.client.getState().purchasing,true);
  h.error({code:'user-cancelled'});assert.equal((await result).status,'cancelled');assert.equal(h.calls.verify.length,0);
});
test('purchase deadline pauses for authentication and late callbacks still activate',async()=>{
  let h=harness();await h.ready();let result=h.client.purchase();await flush();h.activate(false);await h.advance(200000);
  assert.equal(h.client.getState().purchasing,true);h.activate(true);await h.advance(120001);
  assert.equal((await result).status,'pending');h.update();await flush();assert.deepEqual(h.calls.activated,['account-a']);
});
test('verification has a separate bound and duplicate callbacks do not restart it',async()=>{
  let h=harness();await h.ready();let verification=deferred();h.verify=()=>verification.promise;
  let result=h.client.purchase();await flush();await h.advance(110000);h.update();await flush();await h.advance(30000);h.update();
  await h.advance(15001);assert.equal((await result).status,'pending');assert.equal(h.calls.finish,0);
});
test('signed-out transactions recover after login without another Apple prompt',async()=>{
  let h=harness();await h.client.retry();h.update();await flush();assert.equal(h.calls.verify.length,0);
  h.store.getAvailablePurchases=async()=>[purchase()];h.client.setAccount('account-b');await flush();
  assert.equal(h.calls.verify[0].user,'account-b');assert.equal(h.calls.sync,0);
});
test('account changes invalidate in-flight activation',async()=>{
  let h=harness();await h.ready();let verification=deferred();h.verify=()=>verification.promise;
  let result=h.client.purchase();await flush();h.update();await flush();h.client.setAccount('account-b');verification.resolve({subscribed:true});
  assert.equal((await result).status,'cancelled');await flush();assert.deepEqual(h.calls.activated,[]);
});
test('account conflicts explain recovery and never finish the transaction',async()=>{
  let h=harness();await h.ready();h.verify=async()=>{throw {status:409}};let result=h.client.purchase();await flush();h.update();
  assert.match((await result).message,/another ClawTab account/);assert.equal(h.calls.finish,0);
});
test('restore reports missing purchases and releases the button',async()=>{
  let h=harness();await h.ready();assert.equal((await h.client.restore()).status,'not-found');assert.equal(h.client.getState().purchasing,false);
});
test('nonempty SDK return works when no listener callback arrives',async()=>{
  let h=harness({requestPurchase:async()=>purchase()});await h.ready();assert.equal((await h.client.purchase()).status,'purchased');
});

test('a restore sync error after a transaction callback cannot override verification',async()=>{
  let h=harness();await h.ready();let verification=deferred();h.verify=()=>verification.promise;
  h.store.syncIOS=async()=>{h.update();throw Error('late sync error')};
  let result=h.client.restore();await flush();assert.equal(h.client.getState().purchasing,true);
  verification.resolve({subscribed:true});assert.equal((await result).status,'purchased');
});
