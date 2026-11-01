// Run in a browser fixture hosting XtermLog's terminal document with live output.
(async () => {
  const pre = document.querySelector('pre'), scroller = pre.parentElement;
  const checks = [];
  const check = (name, pass) => checks.push({name, pass:Boolean(pass)});
  const wait = () => new Promise(resolve => setTimeout(resolve, 1200));
  check('shell uses native overflow scrolling', getComputedStyle(scroller).overflowY === 'auto');
  scroller.scrollTop = 0;
  check('shell has scrollable history', scroller.scrollHeight > scroller.clientHeight);
  const text = pre.firstElementChild.firstChild.firstChild;
  const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, 6);
  getSelection().removeAllRanges(); getSelection().addRange(range);
  const selected = getSelection().toString(), original = pre.firstChild;
  term.write('\r\nnew live output'); await wait();
  check('live output preserves selection and nodes', getSelection().toString() === selected && original === pre.firstChild);
  getSelection().removeAllRanges(); await wait();
  check('updates resume after selection clears', pre.textContent.includes('new live output'));
  const range2 = document.createRange(); range2.selectNodeContents(pre.firstElementChild);
  getSelection().addRange(range2);
  check('text can be selected again', getSelection().toString().length > 0);
  getSelection().removeAllRanges(); await wait();
  window.setVisualOffset(300);
  check('keyboard leaves shell visible', scroller.style.bottom === '300px' && scroller.clientHeight > 0);
  return checks;
})()
