const fs = require('node:fs');
const path = require('node:path');
const { messageDocument } = require('../../remote/scripts/message-surface.cjs');
const setup = `
const log = 'Selection starts here\\nA second line of captured shell output\\nDrag the selection handles across these words\\nFinal line';
const record = {id:'selection',status:'pending',created_at:Date.now(),request:{title:'Selection fixture',body:'',template:'shell',source:{pane_id:'%fixture'},actions:[]}};
window.ReactNativeWebView={postMessage(raw){
 const value=JSON.parse(raw).nfn;
 if(value?.native) { window.webkit.messageHandlers.probe.postMessage(value); setTimeout(report,250); }
 if(value?.command) setTimeout(()=>window.nfn.receive({type:'response',token:value.token,value:value.command.op==='context'?{log,source:record.request.source}: {}}),1);
}};
window.nfn.receive({type:'snapshot',remote:true,native_chrome:true,native_keyboard:window.__nativeKeyboard,shell_only:window.__shellOnly,visible:true,records:[record],pending_count:1,shell_cache:{selection:log},settings:{hover_expand:false},templates:{templates:[{id:'shell',layout:[{type:'logs'}]}]}});
window.nfn.receive({type:'open_record',id:'selection'});
function report(){
 const logs=document.querySelector('.logs'); if(!logs)return;
 const selection=window.getSelection(), r=logs.getBoundingClientRect();
 let end={x:0,y:0};
 if(selection.rangeCount&&!selection.isCollapsed){const rects=selection.getRangeAt(0).getClientRects(),last=rects[rects.length-1];if(last)end={x:last.right,y:last.bottom};}
 window.webkit.messageHandlers.probe.postMessage(JSON.stringify({ready:true,x:r.left+28,y:r.top+16,length:selection.toString().length,end}));
}
document.addEventListener('selectionchange',report);
window.reportSelection=report;
setTimeout(report,700);
`;
fs.writeFileSync(path.join(__dirname, 'App/fixture.html'), messageDocument().replace('</body>', '<script>'+setup+'</script></body>'));
