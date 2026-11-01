const fs = require("node:fs");
const path = require("node:path");

// Metro bundles this document for both iframe and WKWebView hosts.
function messageDocument(root = path.resolve(__dirname, "../../shared/src/nfn")) {
  const read = name => fs.readFileSync(path.join(root, name), "utf8");
  return read("surface.html")
    .replace("/* NFN_CSS */", read("surface.css") + `
html,body{width:100%;height:var(--message-height,100%);background:#161616;overflow:hidden;-webkit-text-size-adjust:100%;text-size-adjust:100%}
body{display:flex;justify-content:center}
.message,.message-thread,.logs,.logs span{-webkit-user-select:text;user-select:text;-webkit-touch-callout:default}
#surface,#surface.details-open,#surface.pill{width:100%;height:100%;max-width:100%;max-height:100%;border:0;border-radius:0;box-shadow:none}
#surface{height:100%;min-height:0;--surface-max-height:var(--message-height,100dvh)}
.queue{flex:1;height:auto;padding-bottom:max(6px,var(--message-safe-bottom,env(safe-area-inset-bottom,0px)))}
.card{overflow-y:auto;padding-bottom:calc(12px + var(--message-safe-bottom,env(safe-area-inset-bottom,0px)))}
.details-open .card{overflow:hidden}
.controls .footer-actions button{min-height:44px}
.controls .details-toggle{min-height:36px;min-width:24px;padding:4px}
.top .brand{pointer-events:none}
button.bar-toggle{touch-action:auto;cursor:pointer}
button,input,select,textarea{font-size:16px}
button{min-height:44px;border-radius:999px;padding:8px 16px;font-size:14px;font-weight:600}
button.utility:not(.icon-button):not(.close):not(.nav-step):not(.menu-link):not(.session-action):not(.reply-toggle):not(.auto-yes-switch):not(.todo-toggle):not([role="tab"]){min-height:44px;padding:8px 16px;border:1px solid var(--line);background:#202020;color:var(--accent);border-radius:999px;font-size:14px;font-weight:600}
button.utility:not(.icon-button):not(.close):not(.nav-step):not(.menu-link):not(.session-action):not(.reply-toggle):not(.auto-yes-switch):not(.todo-toggle):not([role="tab"]):hover{background:#292929}
button.primary,.actions button,button.open-session,button.send{min-height:44px;padding:8px 16px;border-radius:999px;font-size:14px;font-weight:600;color:var(--accent);border-color:var(--accent);background:#7986cb1a}
button.primary:hover,.actions button:hover,button.open-session:hover,button.send:hover{background:#7986cb30}
button:active:not(:disabled){opacity:.65}
button.bar-toggle,button.todo-toggle{min-height:0}
button.icon-button{min-height:36px;border-radius:999px}
button.close,button.nav-step{min-height:36px;min-width:36px;padding:4px}
button.queue-item,button.menu-link,button.reply-toggle{border-radius:6px}
.segments:not(.segmented-control) button{min-height:36px;padding:4px 12px;border:0;border-radius:6px;background:transparent;color:var(--muted)}
.segments:not(.segmented-control) button[aria-selected="true"]{background:#38383a;color:#e4e4e4}
button.auto-yes-button{min-height:44px;padding:8px 16px;border-radius:999px}
.todo-agent{margin-top:0}
.todo-heading,.todo-row{align-items:center}
.todo-add{grid-template-columns:minmax(0,1fr) auto}
.icon-button{min-height:36px}
.footer-actions.segmented-control{display:flex;padding:4px;border:1px solid var(--line);border-radius:999px;background:#202020;gap:4px}
.footer-actions.segmented-control button{border-radius:999px;flex:1}

.native-chrome>.top{display:none}
.native-chrome .footer-actions{display:none}
.native-mobile .details-content{margin-top:8px;min-height:120px;max-height:none;flex:1 1 120px}
.native-mobile .card,.native-mobile .message-content,.native-mobile .details-content,.native-mobile .log-output{min-width:0;max-width:100%;overflow-x:hidden}
.native-mobile .logs{box-sizing:border-box;width:100%;min-width:0;white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;line-height:16px;border:0;border-radius:0;background:#000000;padding:8px;margin:0}
.native-mobile.details-open>.card{flex:1;min-height:0}
.native-chrome.details-open:not(.shell-reply)>.card{padding:12px 0 0}
.native-chrome.details-open:not(.shell-reply)>.card>.heading,.native-chrome.details-open:not(.shell-reply) .message-content>:not(.details-content),.native-chrome.details-open:not(.shell-reply)>.card>.answer-row,.native-chrome.details-open:not(.shell-reply)>.card>.reply,.native-chrome.details-open:not(.shell-reply)>.card>.notice{margin-left:12px;margin-right:12px}
.native-chrome.details-open>.card>.controls{display:none}
.native-chrome.details-open .details-content{background:#000000}
.native-mobile.shell-reply>.card{padding:0;display:flex;flex:1;min-height:0;overflow:hidden}
.native-mobile.shell-reply .card>:not(.heading):not(.message-content):not(.shell-keyboard):not(.notice){display:none}
.native-mobile.shell-reply .notice{flex:none;padding:0 12px}
.native-mobile.shell-reply .notice:empty{display:none}
.native-mobile.shell-reply .heading{display:flex;padding:8px 12px}
.native-mobile.shell-reply .heading h1{min-width:0;white-space:normal;text-align:left}
.native-mobile.shell-reply .heading-tools>:not(.options-toggle){display:none}
.native-mobile.shell-reply .source-group{max-width:25%;font-size:12px}
.native-mobile.details-open .details-toggle{display:none}
.native-mobile.shell-reply .message-content{flex:1;min-height:0;display:flex;flex-direction:column}
.native-mobile.shell-reply .message-content>:not(.details-content){display:none}
.native-mobile.shell-reply .details-content{margin:0;min-height:0;flex:1;overflow-y:auto;overflow-x:hidden}
.native-mobile.shell-reply .block-label{display:none}
.shell-keyboard{position:absolute;width:1px;height:1px;opacity:0;left:0;top:0;font-size:16px}
.todo-add[hidden]{display:none}
.message{max-height:35dvh}
.message-thread{max-height:35dvh}
.details-content{max-height:50dvh}
`)
    .replace("/* NFN_JS */", read("surface.js") + "\n" + fs.readFileSync(path.resolve(__dirname, "../src/lib/messageSurfaceViewport.js"), "utf8"));
}

function generate() {
  const target = path.resolve(__dirname, "../src/lib/messageSurfaceDocument.generated.ts");
  const source = "// Generated by remote/scripts/message-surface.cjs from the shared desktop surface.\n"
    + "export default " + JSON.stringify(messageDocument()) + ";\n";
  if (!fs.existsSync(target) || fs.readFileSync(target, "utf8") !== source) fs.writeFileSync(target, source);
}

module.exports = { messageDocument, generate };
if (require.main === module) generate();
