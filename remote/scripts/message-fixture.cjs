const fs = require("node:fs");
const path = require("node:path");
const ts = require("../../desktop/node_modules/typescript");
const { messageDocument } = require("./message-surface.cjs");
const root = path.resolve(__dirname, "../..");
const literal = value => JSON.stringify(value).replace(/</g, "\\u003c");
const arg = flag => process.argv[process.argv.indexOf(flag) + 1];
const assets = [
  { mime: "image/png", data: fs.readFileSync(arg("--image") || path.join(root, "remote/assets/icon.png")).toString("base64") },
  ...(process.argv.includes("--video") ? [{ mime: "video/mp4", data: fs.readFileSync(arg("--video")).toString("base64") }] : []),
];
const names = ["messagePresentation", "messageSurfaceController"];
const modules = names.map(name => {
  const source = ts.transpileModule(fs.readFileSync(path.join(root, "remote/src/lib", `${name}.ts`), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return `modules[${literal(`./${name}`)}] = (()=>{ const exports={}; ${source}; return exports; })();`;
}).join("\n");
const check = fs.readFileSync(path.join(root, "tests/mobile-message-browser-check.js"), "utf8");
const document = messageDocument().replace("</body>", `<script>
parent.postMessage({instrumented:true},"*");
window.addEventListener("error",event=>parent.postMessage({checkError:event.message},"*"));
window.addEventListener("message", async event => {
 if(event.data?.type === "snapshot") window.lastSnapshot = event.data;
 if(event.data?.runChecks) { parent.postMessage({checking:true},"*"); try { parent.postMessage({checks:await (${check})()},"*"); } catch(error){parent.postMessage({checkError:String(error.stack||error)},"*");} }
});
</script></body>`);
const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>ClawTab remote messages</title>
<style>html,body{margin:0;width:100%;height:100%;background:#101010;color:#e4e4e4;font-family:-apple-system,sans-serif}main{height:100%;max-width:720px;margin:auto;display:flex;flex-direction:column}header{padding:12px 16px;display:flex;justify-content:space-between;border-bottom:1px solid #333;font-size:13px}iframe{width:100%;flex:1;min-height:0;border:0}</style></head>
<body><main><header><span>ClawTab</span><span>Messages</span></header><iframe title="Messages" sandbox="allow-scripts"></iframe></main><script>
const modules={"@clawtab/shared":{resourceKey:(machine,id)=>machine+"::"+id,messagePending:r=>!r.dismissed_at&&["pending","delivering"].includes(r.status)}};
const require=name=>modules[name];
${modules}
const {surfaceRecord}=modules["./messagePresentation"];
const assets=${literal(assets)}.map(asset=>({...asset,bytes:atob(asset.data)}));
const record=(machine,body)=>({machine_id:machine,id:"launch-review",status:"pending",created_at:1,read_at:null,dismissed_at:null,request:{title:"Review the launch post",body,template:"social-review",response_destination:"result",source:{group:"ClawTab",agent_title:"Release",provider:"codex",pane_id:machine+"::%18"},data:{platform:"X"},actions:[{id:"post",kind:"choice",label:"Post to X"},{id:"revise",kind:"choice",label:"Request changes"},{id:"reject",kind:"choice",label:"Reject"}],media:assets.map((asset,index)=>({kind:index?"video":"image",src:"/host/attachment-"+index+(index?".mp4":".png"),alt:index?"ClawTab remote demo":"ClawTab terminal and agent"}))}});
let records=[record("mac-a","Caption from Mac A"),record("mac-b","Your agents, wherever you are. Review the ClawTab launch post and its media.\\n<img src=x onerror=window.unsafeMarkup=true>")];
const frame=document.querySelector("iframe");
const send=value=>frame.contentWindow.postMessage(value,"*");
const fixture=window.fixture={calls:[],nativeEvents:[],opened:[],checks:null,error:null,video:assets.length>1};
const snapshot=()=>({type:"snapshot",remote:true,visible:true,records:records.map(surfaceRecord),pending_count:records.filter(r=>!r.dismissed_at&&r.status==="pending").length,settings:{preview_seconds:8},templates_by_machine:Object.fromEntries(["mac-a","mac-b"].map(machine=>[machine,{templates:[{id:"social-review",layout:[{type:"text",field:"body"},{type:"media"},{type:"choices"},{type:"reply"},{type:"logs"}]}]}]))});
const controller=modules["./messageSurfaceController"].messageSurfaceController({
 records:()=>records,machines:()=>[{id:"mac-a",online:true},{id:"mac-b",online:true}],update:record=>{records=records.map(r=>r.id===record.id&&r.machine_id===record.machine_id?record:r)},navigate:record=>fixture.opened.push(record),
 act:async action=>{fixture.calls.push(action);records=records.map(r=>r.id===action.id&&r.machine_id===action.machine?{...r,status:"resolved",response:{action_id:action.action_id,text:action.text}}:r);send(snapshot());},
 host:async(machine,command)=>{fixture.calls.push({machine,...command});const record=records.find(r=>r.machine_id===machine&&r.id===command.id);
  if(command.op==="get")return record;if(command.op==="list")return{records:records.filter(r=>r.machine_id===machine)};
  if(command.op==="context")return{source:record.request.source,log:"Draft and attachments ready for review",models:[],plugins:[]};
  if(command.op==="media"){const asset=assets[command.index],bytes=asset.bytes.slice(command.offset,command.offset+command.length);return{mime:asset.mime,size:asset.bytes.length,offset:command.offset,data:btoa(bytes),eof:command.offset+bytes.length===asset.bytes.length};}
  return{};
 }
});
window.addEventListener("message",async event=>{
 if(event.source!==frame.contentWindow)return;
 if(event.data?.instrumented)fixture.instrumented=true;if(event.data?.checking)fixture.checking=true;
 if(event.data?.checks)fixture.checks=event.data.checks;if(event.data?.checkError)fixture.error=event.data.checkError;
 const value=event.data?.nfn;if(!value)return;
 if(value.native)fixture.nativeEvents.push(value);
 if(value.preview_ready){send(snapshot());send({type:"open_record",id:"mac-b::launch-review"});}
 if(value.command){try{send({type:"response",token:value.token,value:await controller.execute(value.command)});}catch(error){send({type:"response",token:value.token,error:String(error.message||error)});}}
});
fixture.run=()=>send({runChecks:true});fixture.select=id=>send({type:"open_record",id});fixture.snapshot=()=>send(snapshot());
frame.srcdoc=${literal(document)};
</script></body></html>`;
let output = html;
if (process.argv.includes("--native")) {
  let setup = html.slice(html.indexOf("<script>") + 8, html.lastIndexOf("frame.srcdoc="));
  setup = setup.replace('const frame=document.querySelector("iframe");', 'const frame={contentWindow:window};')
    .replace('const send=value=>frame.contentWindow.postMessage(value,"*");', 'const send=value=>{if(value.type==="snapshot")window.lastSnapshot=value;queueMicrotask(()=>window.nfn.receive(value));};');
  setup += `
window.ReactNativeWebView={postMessage:raw=>window.dispatchEvent(new MessageEvent("message",{source:window,data:JSON.parse(raw)}))};
fixture.run=async()=>{try{fixture.checks=await (${check})();}catch(error){fixture.error=String(error.stack||error);}};
`;
  output = messageDocument().replace("<script>", "<script>" + setup + "\n");
}
fs.writeFileSync(process.argv[2] || "/tmp/clawtab-mobile-message-fixture.html", output);
