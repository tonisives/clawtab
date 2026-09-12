const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const ts=require('../desktop/node_modules/typescript');
const exportsForTest={};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(require.resolve('../shared/src/util/agentFolder.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports:exportsForTest,Error});
const {defaultAgentFolder,resolveAgentFolder}=exportsForTest;

test('switching from a desktop project to a rental starts with the rental home folder',()=>{
  assert.equal(defaultAgentFolder('/Users/tonis/tonisdev','desktop','rental'),'~');
  assert.equal(defaultAgentFolder('/Users/tonis/tonisdev','desktop','desktop'),'/Users/tonis/tonisdev');
  assert.equal(defaultAgentFolder('/home/clawtab/workspace','rental','rental'),'/home/clawtab/workspace');
});

test('the selected host resolves the home folder before launch',async()=>{
  const calls=[];
  const folder=await resolveAgentFolder('~',async request=>{calls.push(request);return {path:'/home/clawtab'};});
  assert.equal(folder,'/home/clawtab');
  assert.equal(calls[0].action,'list_directory');
  assert.equal(calls[0].path,'~');
});

test('missing folders and invalid host responses reject the launch preflight',async()=>{
  await assert.rejects(resolveAgentFolder('/Users/tonis/tonisdev',async()=>{throw Error('No such directory on rental');}),/No such directory/);
  for(const path of [undefined,'~','relative',42]){
    await assert.rejects(resolveAgentFolder('~',async()=>({path})),/Could not resolve/);
  }
});
