// Standalone mobile document with the same synthetic command bridge as desktop.
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { messageDocument } = require("../remote/scripts/message-surface.cjs");
const target = path.resolve(process.argv[2]);
const root = path.resolve(__dirname, "..");
execFileSync(process.execPath, [path.join(root, "desktop/tests/nfn-fixture.mjs"), target, "--headless-visible"]);
const desktop = fs.readFileSync(target, "utf8");
const setup = desktop.split("<script>")[1].split("/* Shared by")[0];
const ready = `
window.fixture.settings.hover_expand=false;
for(let i=0;i<60;i++)window.fixture.records.set("message-"+i,window.fixture.record("message-"+i));
window.nfn.receive({...window.fixture.snapshot(),remote:true});
window.nfn.receive({type:"show"});
`;
fs.writeFileSync(target, messageDocument().replace("<script>", "<script>" + setup)
  .replace("</body>", "<script>" + ready + "</script></body>"));
