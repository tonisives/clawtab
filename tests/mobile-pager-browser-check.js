(async () => {
 const checks=[],wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 const settled=async()=>{const end=Date.now()+10000;while(document.querySelector("#surface").dataset.paging){if(Date.now()>end)throw new Error("Paging did not settle");await wait(50);}};
 const check=(name,value)=>{if(!value)throw new Error(name);checks.push(name);};
 const card=()=>document.querySelector('#surface > .card');
 const title=()=>card()?.querySelector('h1')?.textContent;
 const chrome=()=>fixture.events.filter(e=>e.native==='chrome').at(-1);
 await wait(100);
 check('opens the requested page',title()==='a');
 // Snapshot arrives after touch-down, before the horizontal threshold is crossed.
 const touch=(x)=>new Touch({identifier:1,target:card(),clientX:x,clientY:300});
 const startTouch=()=>card().dispatchEvent(new TouchEvent('touchstart',{bubbles:true,touches:[touch(300)],changedTouches:[touch(300)]}));
 const moveTouch=()=>card().dispatchEvent(new TouchEvent('touchmove',{bubbles:true,cancelable:true,touches:[touch(150)],changedTouches:[touch(150)]}));
 const endTouch=()=>card().dispatchEvent(new TouchEvent('touchend',{bubbles:true,touches:[],changedTouches:[touch(150)]}));
 let original=card();startTouch();
 fixture.records[0].request.title='a updated';window.nfn.receive(fixture.snapshot());
 check('touch-down holds the card stable',card()===original&&title()==='a');
 moveTouch();
 fixture.records[0].request.body='updated during drag';window.nfn.receive(fixture.snapshot());
 check('snapshot does not reset drag',card()===original&&original.style.transform.includes('-150px'));
 endTouch();
 check('swipe advances immediately',title()==='b');
 window.nfn.receive(fixture.snapshot());await settled();
 check('queued updates preserve swipe destination',title()==='b'&&!document.querySelector('.gallery-page'));
 // A later card in the same shell must not replace the page currently being read.
 original=card();const beforeArrival=chrome().arrival;
 fixture.records.find(r=>r.id==='b').status='superseded';
 fixture.records.push(fixture.record('b newer',4,'b'));window.nfn.receive(fixture.snapshot('b newer'));
 check('same-shell arrival keeps the displayed card',card()===original&&title()==='b');
 check('new arrival signals native navigation',chrome().arrival===beforeArrival+1);
 window.nfn.receive(fixture.snapshot('b newer'));
 check('repeated snapshots do not replay arrival cue',chrome().arrival===beforeArrival+1);
 window.nfn.receive({type:'mobile_action',action:'next'});await settled();
 check('newer same-shell message remains reachable',title()==='c');
 window.nfn.receive({type:'mobile_action',action:'next'});await settled();
 check('explicit navigation opens the newer same-shell message',title()==='b newer');
 window.nfn.receive({type:'mobile_action',action:'list'});
 fixture.records.push(fixture.record('d',5));window.nfn.receive(fixture.snapshot('d'));
 check('arrival does not leave the notification list',Boolean(document.querySelector('.queue'))&&!card());
 // The next swipe also works with rapid store updates arriving while settling.
 window.nfn.receive({type:'open_record',id:'a'});original=card();
 window.nfnPaging.setTouching(true);window.nfnPaging.begin(original);window.nfnPaging.move(-160);
 for(let i=0;i<3;i++){fixture.records[0].request.body='refresh '+i;window.nfn.receive(fixture.snapshot());}
 window.nfnPaging.setTouching(false);window.nfnPaging.release(-160,-1);await settled();
 check('repeated updates cannot consume the next swipe',title()==='c');
 fixture.records=[fixture.record('c',3),fixture.record('c latest',6,'c')];
 fixture.records[0].status='resolved';window.nfn.receive(fixture.snapshot('c latest'));await wait(300);
 check('resolved current message stays visible with one pending arrival',title()==='c');
 original=card();window.nfnPaging.setTouching(true);window.nfnPaging.begin(original);window.nfnPaging.move(-160);
 window.nfnPaging.setTouching(false);window.nfnPaging.release(-160,-1);await settled();
 check('swiping still works with one pending arrival and a resolved current page',title()==='c latest');
 return checks;
})()
