const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")
const ts = require("typescript")
const { messageDocument } = require("./message-surface.cjs")
function load(file) {
  const exports = {}
  const source = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, file), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText
  vm.runInNewContext(source, { exports, require: () => ({ create: () => {} }) })
  return exports
}
const data = load("../src/demo/data.ts")
const question = data.demoQuestionForSelection("demo-claude", "process")
const record = load("../src/demo/messages.ts").DEMO_SOCIAL_MESSAGE
const setup = `
window.fixture={calls:[],post:${JSON.stringify(record)},question:${JSON.stringify(question)}};
window.ReactNativeWebView={postMessage(raw){
 const value=JSON.parse(raw).nfn;
 if(!value?.command)return;
 fixture.calls.push(value.command);
 const result=value.command.op==="context"?{log:"Sample Claude output\\n".repeat(80),models:[],plugins:[]}:fixture.record;
 queueMicrotask(()=>window.nfn.receive({type:"response",token:value.token,value:result}));
}};
fixture.open=kind=>{
 window.nfn.collapse();
 fixture.record=kind==="question"?{id:"demo-question",status:"pending",question_id:"demo-question",created_at:0,request:{title:"Claude",template:"question",body:"",source:{pane_id:"demo-claude"},actions:fixture.question.options.map(option=>({id:option.number,kind:"choice",label:option.number+". "+option.label}))}}:{...fixture.post,details_available:false};
 window.nfn.receive({type:"snapshot",remote:true,native_chrome:true,visible:true,demo:kind==="post",shell_only:kind==="question",shell_answers:kind==="question",records:[fixture.record],pending_count:1,settings:{placement:"right"},templates:{templates:[{id:"question",layout:[{type:"logs"}]}]}});
 window.nfn.receive({type:"open_record",id:fixture.record.id});
 window.nfnMobile.setInsets(34,false);
};
`
fs.writeFileSync(process.argv[2], messageDocument().replace("<script>", "<script>" + setup))
