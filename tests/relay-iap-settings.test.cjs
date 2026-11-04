const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('../desktop/node_modules/typescript');
const flush = () => new Promise(setImmediate);
const all = node => Array.isArray(node) ? node.flatMap(all) : node && typeof node === 'object' ? [node, ...all(node.props?.children)] : [];

function harness() {
  let states=[], effects=[], cursor=0, polls=[], fail=false, subscribed=false, purchases=0, managed=0, diagnostics=0;
  let react = {
    useState(initial) { let id=cursor++; if (!(id in states)) states[id]=typeof initial==='function'?initial():initial; return [states[id], value=>{states[id]=typeof value==='function'?value(states[id]):value}]; },
    useRef(initial) { return react.useState({current:initial})[0]; },
    useEffect(effect,deps) { let id=cursor++; if (!(id in states)||deps.some((v,i)=>v!==states[id][i])) { states[id]=deps;effects.push(effect); } },
  };
  let element=(type,props)=>({type,props});
  let auth=select=>select({userId:'account'});auth.getState=()=>({userId:'account'});
  let modules={
    react, 'react/jsx-runtime':{jsx:element,jsxs:element},
    'react-native':{Platform:{OS:'ios'},View:'View',Text:'Text',Pressable:'Pressable',ActivityIndicator:'Loading',AppState:{addEventListener:()=>({remove(){}})}},
    'expo-router':{useRouter:()=>({})},'expo-router/react-navigation':{useIsFocused:()=>true},
    '@clawtab/shared':{HostedWorkspacePanel:'Workspace',machineState:()=>({connected:true}),reconnectMachines(){}},
    '../../store/auth':{useAuthStore:auth},
    '../../hooks/useIap':{useIap:()=>({available:true,price:'$6.99',activation:0,diagnostic:'stages',purchase:async()=>{purchases++;return {status:'purchased'}},manageSubscriptions:async()=>{managed++},refreshDiagnostics:async()=>{diagnostics++}})},
    '../../lib/funnel':{trackFunnel:async()=>{}},
    '../../lib/relaySubscriptionCache':{cachedRelaySubscription:()=>({subscribed:false}),cachedRelayWorkspace:()=>null,loadRelaySubscription:async()=>{if(fail)throw Error('offline');return {subscribed,provider:'apple'}}},
    '../../api/client':{},'../../lib/platform':{alertError(){},openUrl(){throw Error('unexpected browser')}},
    '../../theme/colors':{colors:{}},'./SettingsPage':{SettingsButton:'Button',SettingsGroup:'Group',SettingsRow:'Row',styles:{}},'../RelayWelcome':{RelayWelcome:'Welcome'},
  };
  let exports={};
  let source=ts.transpileModule(fs.readFileSync(__dirname+'/../remote/src/components/settings/RelaySubscription.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText;
  vm.runInNewContext(source,{exports,require:name=>modules[name],setInterval:work=>{polls.push(work);return polls.length},clearInterval(){}});
  let render=()=>{cursor=0;let tree=exports.RelaySubscription();effects.splice(0).forEach(effect=>effect());return tree};
  return {render,button:title=>all(render()).find(node=>node.props?.title?.startsWith(title)),poll:()=>polls[0](),setFail:value=>{fail=value},setSubscribed:value=>{subscribed=value},counts:()=>({purchases,managed,diagnostics})};
}

test('cached Free access cannot buy after a failed check; retry restores the action',async()=>{
  let h=harness();h.render();await flush();
  assert.equal(h.button('Subscribe').props.disabled,false);
  h.setFail(true);h.poll();await flush();
  assert.equal(h.button('Subscribe').props.disabled,true);
  await h.button('Subscribe').props.onPress();assert.equal(h.counts().purchases,0);
  h.setFail(false);await h.button('Retry subscription check').props.onPress();await flush();
  assert.equal(h.button('Subscribe').props.disabled,false);
});

test('Apple management opens the native sheet and diagnostics refresh on expansion',async()=>{
  let h=harness();h.setSubscribed(true);h.render();await flush();
  await h.button('Manage subscription').props.onPress();
  assert.equal(h.counts().managed,1);
  h.button('View purchase diagnostics').props.onPress();
  assert.equal(h.counts().diagnostics,1);
});
