const fs = require("node:fs");
const { messageDocument } = require("../remote/scripts/message-surface.cjs");
const setup = `
window.fixture={events:[],records:[],calls:[]};
window.ReactNativeWebView={postMessage(raw){
 const value=JSON.parse(raw).nfn;
 if(value?.native)fixture.events.push(value);
 if(value?.command){fixture.calls.push(value.command);const record=fixture.records.find(r=>r.id===value.command.id);
 setTimeout(()=>window.nfn.receive({type:'response',token:value.token,value:value.command.op==='context'?{log:'Shell output for '+record.id,source:record.request.source}:record||{}}),1);}
}};
fixture.record=(id,time,pane=id)=>({id,status:'pending',created_at:time,request:{title:id,body:'Message '+id,template:'shell',source:{pane_id:pane},actions:[]}});
fixture.snapshot=arrival=>({type:'snapshot',remote:true,native_chrome:true,visible:true,arrival,records:structuredClone(fixture.records),pending_count:fixture.records.filter(record=>record.status==='pending').length,templates:{templates:[{id:'shell',layout:[{type:'text',field:'body'},{type:'logs'}]}]}});
fixture.records=['a','b','c'].map((id,i)=>fixture.record(id,i+1));
window.nfn.receive(fixture.snapshot());window.nfn.receive({type:'open_record',id:'a'});
`;
fs.writeFileSync(process.argv[2]||"/private/tmp/clawtab-pager-fixture.html",messageDocument().replace(/<\/body>\s*<\/html>\s*$/i,closing=>'<script>'+setup+'</script>'+closing));
