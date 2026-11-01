// Run against the mobile variant of desktop/tests/nfn-fixture.mjs.
(async () => {
  const checks = [], wait = (ms=150) => new Promise(resolve => setTimeout(resolve, ms));
  const check = (name, pass) => { checks.push({name,pass:Boolean(pass)}); };
  const record = fixture.record('inline-shell', 1);
  record.request.template = 'update'; record.request.source.group = 'clawtab'; record.request.body='Ready for review';
  fixture.records.set(record.id, record);
  fixture.log = Array.from({length:100},(_,i)=>'Shell row '+i+' '+ 'content '.repeat(12)).join(String.fromCharCode(10));
  const snapshot = {...fixture.snapshot(), remote:true,native_chrome:true,arrival:undefined};
  window.nfn.receive(snapshot); window.nfn.receive({type:'show'}); await wait();
  check('notifications open pending list', Boolean(document.querySelector('.queue')));
  window.nfn.receive({type:'open_record',id:record.id}); await wait(1300);
  const shell = document.querySelector('.logs'), content = document.querySelector('.details-content');
  check('tall notification loads shell by default', Boolean(shell?.textContent.includes('Shell row')));
  const original = shell, calls = fixture.contextCalls;
  const start=performance.now();
  window.nfn.receive({type:'mobile_action',action:'reply'});
  check('reply expands immediately without replacing shell', document.querySelector('#surface').classList.contains('shell-reply') && document.querySelector('.logs')===original && performance.now()-start<100);
  check('reply starts at top of existing output', content.scrollTop===0);
  check('reply focuses inline input', document.activeElement?.classList.contains('shell-keyboard'));
  record.request.title = "Updated while replying";
  window.nfn.receive({...fixture.snapshot(), remote:true, native_chrome:true, arrival:undefined});
  check('live message metadata preserves the shell and input', document.querySelector('.logs')===original && document.activeElement?.classList.contains('shell-keyboard'));
  const input=document.activeElement; input.value='hello'; input.dispatchEvent(new Event('input',{bubbles:true})); await wait();
  check('typing sends direct shell input', fixture.calls.some(command=>command.op==='shell_input' && command.text==='hello'));
  document.querySelector('[aria-label="Up arrow"]').click(); await wait();
  check('arrow sends terminal sequence', fixture.calls.some(command=>command.op==='shell_input' && command.text==='\x1b[A'));
  check('reply does not restart shell context', fixture.contextCalls < calls+4);
  document.querySelector('[aria-label="Back to notification"]').click();
  check('close retains shell and restores message', !document.querySelector('#surface').classList.contains('shell-reply') && document.querySelector('.logs')===original);
  window.nfn.receive({type:'mobile_action',action:'list'});
  check('center navigation action opens list', Boolean(document.querySelector('.queue')));
  window.nfn.receive({type:'mobile_action',action:'tasks'}); await wait();
  check('task add form starts closed', document.querySelector('.todo-add')?.hidden);
  check('task maintenance controls are absent', !document.querySelector('.todo-refresh') && !document.querySelector('.todo-options'));
  document.querySelector('.todo-add-toggle').click();
  check('plus reveals task form', !document.querySelector('.todo-add')?.hidden);
  return checks;
})()
