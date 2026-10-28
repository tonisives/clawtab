// Run with the worker-exported app served by serve-mobile-message-app.py.
(async () => {
  if (location.pathname === "/login") return await (async()=>{
 const checks=[];const wait=async p=>{for(let i=0;i<300;i++){if(p())return;await new Promise(r=>setTimeout(r,50));}throw Error(document.body.innerText);};
 const check=(n,c)=>{if(!c)throw Error(n);checks.push(n);};
 await wait(()=>document.body.innerText.includes("Sign in with Google"));
 check("exported login route renders",location.pathname==="/login");
 check("login uses unauthenticated fixture",!localStorage.getItem("clawtab_access_token"));
 check("Google sign-in renders without configuration error",document.body.innerText.includes("Sign in with Google")&&!document.body.innerText.includes("Missing required"));
 check("Apple sign-in remains available",document.body.innerText.includes("Sign in with Apple"));
 check("email sign-in remains available",document.body.innerText.includes("Sign in with email"));
 const email=[...document.querySelectorAll('[role="button"]')].find(e=>e.textContent.includes("Sign in with email"));
 if(!email)throw Error("Email toggle not found");email.click();await wait(()=>document.querySelector('[aria-label="Email"]'));
 check("email form opens without signing in",!!document.querySelector('[aria-label="Email"]')&&!!document.querySelector('[aria-label="Password"]'));
 return {passed:checks.length,checks,url:location.href,text:document.body.innerText};
})();
  else if (!location.pathname.startsWith("/notifications/message/")) return await (async()=>{
 const checks=[];const wait=async p=>{for(let i=0;i<400;i++){if(p())return;await new Promise(r=>setTimeout(r,50));}throw Error("Expected arrival state: "+document.body.innerText);};
 const check=(n,c)=>{if(!c)throw Error(n);checks.push(n);};
 await wait(()=>window.messageAppFixture?.calls.some(c=>c.machine==="mac-b"));await new Promise(r=>setTimeout(r,500));
 check("initial history creates no popup",!document.querySelector('[aria-label="Open this message"]'));
 check("existing notification activation is available",!!document.querySelector('[aria-label*="pending notification"]'));
 const id="warm/message?review=1";window.messageAppFixture.arrive("mac-a",id,"A genuinely new remote message");
 await wait(()=>document.querySelector('[aria-label="Open this message"]')&&document.querySelector('iframe[title="Messages"]'));
 check("genuine arrival opens shared renderer popup",!!document.querySelector('iframe[title="Messages"]'));
 check("popup has explicit close control",!!document.querySelector('[aria-label="Close message popup"]'));
 document.querySelector('[aria-label="Open this message"]').click();
 await wait(()=>location.pathname.startsWith("/notifications/message/")&&window.messageAppFixture.calls.some(c=>c.machine==="mac-a"&&c.request?.command?.op==="read"&&c.request.command.id===id));
 check("popup opens exact warm escaped ID",decodeURIComponent(location.pathname.slice("/notifications/message/".length))===id);
 check("warm arrival keeps originating machine",new URLSearchParams(location.search).get("machine")==="mac-a");
 check("warm route marks only originating ID read",!window.messageAppFixture.calls.some(c=>c.machine!=="mac-a"&&c.request?.command?.op==="read"&&c.request.command.id===id));
 check("navigating to message dismisses popup",!document.querySelector('[aria-label="Open this message"]'));
 return {passed:checks.length,checks,url:location.href,text:document.body.innerText,calls:window.messageAppFixture.calls.map(c=>({machine:c.machine,op:c.request?.command?.op,id:c.request?.command?.id}))};
})();
  else return await (async () => {
  const checks=[];
  const wait=async predicate=>{for(let i=0;i<400;i++){if(predicate())return;await new Promise(r=>setTimeout(r,50));}throw Error("App did not reach expected state: "+document.body.innerText.slice(0,500));};
  const check=(name,condition)=>{if(!condition)throw Error(name);checks.push(name);};
  await wait(()=>window.messageAppFixture && document.querySelector("iframe") && window.messageAppFixture.calls.some(c=>c.request?.command?.op==="media"&&c.request.command.index===1));
  await wait(()=>[0,1].every(index=>window.messageAppFixture.media.some(m=>m.index===index&&m.eof&&m.bytes>0)));
  await new Promise(r=>setTimeout(r,500));
  const calls=window.messageAppFixture.calls;
  check("cold route retains exact message and machine",location.pathname==="/notifications/message/launch-review"&&new URLSearchParams(location.search).get("machine")==="mac-b");
  check("shared renderer iframe mounted",document.querySelectorAll("iframe[title=Messages]").length===1);
  check("shared renderer fits phone viewport",document.querySelector("iframe").getBoundingClientRect().width<=390);
  check("selected message read from Mac B",calls.some(c=>c.machine==="mac-b"&&c.request?.command?.op==="read"&&c.request.command.id==="launch-review"));
  check("Mac A matching ID was not marked read",!calls.some(c=>c.machine==="mac-a"&&c.request?.command?.op==="read"));
  check("photo loads from selected host",calls.some(c=>c.machine==="mac-b"&&c.request?.command?.op==="media"&&c.request.command.index===0));
  check("video loads from selected host",calls.some(c=>c.machine==="mac-b"&&c.request?.command?.op==="media"&&c.request.command.index===1));
  check("media never falls back to Mac A",!calls.some(c=>c.machine==="mac-a"&&c.request?.command?.op==="media"));
  check("bounded attachment ranges complete",window.messageAppFixture.media.filter(m=>m.bytes>0).every(m=>m.bytes<=262144));
  check("history navigation does not create popup",!document.querySelector('[aria-label="Open this message"]'));
  return {passed:checks.length,checks,url:location.href,text:document.body.innerText,frames:[...document.querySelectorAll("iframe")].map(f=>({title:f.title,rect:{width:f.getBoundingClientRect().width,height:f.getBoundingClientRect().height}})),media:window.messageAppFixture.media,calls:calls.map(c=>({machine:c.machine,op:c.request?.command?.op,id:c.request?.command?.id,index:c.request?.command?.index}))};
})();
})()
