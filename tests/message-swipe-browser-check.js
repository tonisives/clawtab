// Run on the mobile fixture in WKWebView or a touch-enabled background browser.
(async () => {
  const checks = [];
  const assert = (ok, text) => { if (!ok) throw Error(text); checks.push(text); };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const fixture = window.fixture, surface = document.getElementById("surface");
  window.ReactNativeWebView = { postMessage: () => {} };
  window.nfn.collapse();
  fixture.records.clear();
  for (const id of ["swipe-a", "swipe-b", "swipe-c"]) {
    const item = fixture.record(id); item.request.title = id;
    fixture.records.set(id, item);
  }
  window.nfn.receive({ ...fixture.snapshot(), remote: true, native_chrome: true });
  const open = () => window.nfn.receive({ type: "open_record", id: "swipe-b" });
  const title = () => document.querySelector("h1")?.textContent;
  const touch = (target, type, x, y, multiple = false) => {
    const point = { identifier: 1, clientX: x, clientY: y };
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.assign(event, { touches: type === "touchend" ? [] : multiple ? [point, { ...point, identifier: 2 }] : [point], changedTouches: [point] });
    target.dispatchEvent(event); return event;
  };
  const swipe = (dx, dy = 0, target = document.querySelector(".message")) => {
    touch(target, "touchstart", 160, 150);
    const move = touch(target, "touchmove", 160 + dx, 150 + dy);
    touch(target, "touchend", 160 + dx, 150 + dy); return move;
  };
  open();
  assert(swipe(-100).defaultPrevented && title() === "swipe-c", "left swipe opens the next notification without scrolling sideways");
  swipe(100);
  assert(title() === "swipe-b", "right swipe opens the previous notification");
  const slowMessage = document.querySelector(".message");
  touch(slowMessage, "touchstart", 160, 150);
  await sleep(450);
  touch(slowMessage, "touchmove", 60, 150); touch(slowMessage, "touchend", 60, 150);
  assert(title() === "swipe-c", "a swipe still navigates when the first movement event arrives after 350 ms");
  swipe(100);
  window.nfn.receive({ type: "mobile_action", action: "next" });
  assert(title() === "swipe-c", "chevron navigation still uses the same notification order");
  swipe(-100);
  assert(title() === "swipe-a", "swiping wraps through notifications like the chevrons");
  open();
  swipe(20);
  assert(title() === "swipe-b", "short horizontal movements keep the current notification");
  assert(!swipe(20, 100).defaultPrevented && title() === "swipe-b", "vertical scrolling keeps the current notification and native scrolling");
  swipe(-100, 90);
  assert(title() === "swipe-b", "diagonal scrolling does not switch notifications");
  swipe(-100, 0, document.querySelector(".options-toggle"));
  assert(title() === "swipe-b", "gestures on notification controls do not navigate");
  const message = document.querySelector(".message");
  touch(message, "touchstart", 160, 150); touch(message, "touchcancel", 60, 150); touch(message, "touchend", 60, 150);
  assert(title() === "swipe-b", "cancelled touch gestures do not navigate");
  touch(message, "touchstart", 160, 150); touch(message, "touchstart", 160, 150, true); touch(message, "touchend", 60, 150);
  assert(title() === "swipe-b", "multitouch gestures do not navigate");
  touch(message, "touchstart", 160, 150); await sleep(400); touch(message, "touchend", 160, 150);
  assert(title() === "swipe-b", "long presses remain available for text selection");
  const range = document.createRange(); range.selectNodeContents(message);
  window.getSelection().addRange(range); swipe(-100);
  assert(title() === "swipe-b" && !window.getSelection().isCollapsed, "swiping selected message text preserves the selection");
  window.getSelection().removeAllRanges();
  await sleep(40);
  swipe(-100, 0, document.querySelector(".logs"));
  assert(title() === "swipe-c" && !surface.classList.contains("shell-reply"), "swiping shell output navigates without entering reply");
  window.nfn.receive({ type: "mobile_action", action: "reply" });
  const shellInput = document.querySelector(".shell-keyboard");
  swipe(100, 0, shellInput);
  assert(title() === "swipe-c" && surface.classList.contains("shell-reply"), "swipes within the reply input preserve editing");
  swipe(100, 0, document.querySelector(".logs"));
  assert(title() === "swipe-b" && !surface.classList.contains("shell-reply"), "swiping shell output while replying navigates like the chevrons");
  window.nfn.receive({ type: "mobile_action", action: "list" });
  swipe(-100, 0, document.querySelector(".queue"));
  assert(document.querySelector(".queue"), "the pending list keeps its normal touch behavior");
  delete window.ReactNativeWebView;
  window.nfn.receive({ ...fixture.snapshot(), remote: true }); open(); swipe(-100);
  assert(title() === "swipe-c", "the mobile web view also supports swipe navigation");
  return { passed: checks.length, checks, viewport: { width: innerWidth, height: innerHeight } };
})()
