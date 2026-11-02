(async () => {
  const checks = [];
  const assert = (ok, text) => { if (!ok) throw Error(text); checks.push(text); };
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const fixture = window.fixture, surface = document.getElementById("surface");
  window.ReactNativeWebView = { postMessage: raw => window.webkit.messageHandlers.nfn.postMessage(JSON.parse(raw)) };
  window.nfn.collapse(); fixture.records.clear();
  fixture.log = Array.from({ length: 150 }, (_, i) => `Shell line ${i}: output from this agent`).join("\n");
  const detected = fixture.record("detected"), custom = fixture.record("custom");
  detected.question_id = "detected-question"; detected.request.body = fixture.log;
  custom.request.body = "Review the deployment configuration before continuing.";
  custom.request.source.pane_id = "%other";
  fixture.records.set(detected.id, detected); fixture.records.set(custom.id, custom);
  const snapshot = () => ({ ...fixture.snapshot(), remote: true, native_chrome: true });
  const open = id => window.nfn.receive({ type: "open_record", id });
  const bottom = () => {
    const scroller = surface.querySelector(".details-content");
    return scroller.scrollHeight > scroller.clientHeight && Math.abs(scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop) < 2;
  };
  window.nfn.receive(snapshot()); open(detected.id); await wait(150);
  assert(bottom(), "a notification opens with its shell scrolled to the latest line");
  assert(surface.querySelector(".message").hidden, "shell-derived question text is hidden while its captured shell is visible");
  const yes = surface.querySelector(".auto-yes-button"), action = surface.querySelector(".actions button");
  const yesBounds = yes.getBoundingClientRect();
  assert(Math.abs(yesBounds.left - 12) < 1 && Math.abs(innerWidth - yesBounds.right - 12) < 1,
    "Yes all fills the row with the same 12-point side insets as the native bottom segmented control");
  assert(getComputedStyle(yes).justifyContent === "center" && getComputedStyle(yes).padding === getComputedStyle(action).padding,
    "Yes all centers its label and uses the same padding as the other actions");
  open(custom.id); await wait(100);
  assert(bottom(), "a cached shell is also positioned at the bottom on first display");
  assert(!surface.querySelector(".message").hidden && surface.querySelector(".message").textContent === custom.request.body, "custom notification text remains above the shell");
  open(detected.id); await wait(100);
  assert(bottom(), "returning to a cached notification starts its shell at the bottom");
  const scroller = surface.querySelector(".details-content");
  scroller.scrollTop = 0; scroller.dispatchEvent(new Event("scroll"));
  fixture.log += "\nA new output line"; await wait(1100);
  assert(scroller.scrollTop === 0, "live shell updates preserve a reader's position in older output");
  window.nfn.receive({ ...snapshot(), remote: false }); open(detected.id); await wait(100);
  assert(!surface.querySelector(".message").hidden, "the compact desktop card retains its shell-derived summary");
  custom.request.source.pane_id = detected.request.source.pane_id;
  custom.created_at = 1; detected.created_at = 2;
  window.nfn.receive(snapshot()); open(detected.id); await wait(100);
  assert(surface.querySelector('[data-id="detected"]').hidden && !surface.querySelector('[data-id="custom"]').hidden,
    "a mixed message thread keeps custom text while hiding captured question summaries");
  window.nfn.collapse();
  window.nfn.receive({ ...snapshot(), shell_only: true, templates: { templates: [{ id: detected.request.template, layout: [{ type: "logs" }] }] } });
  open(detected.id); await wait(100);
  assert(surface.classList.contains("shell-only") && bottom(), "details uses the notification shell renderer and opens at the latest output");
  assert(getComputedStyle(surface.querySelector(".top")).display === "none" && getComputedStyle(surface.querySelector(".heading")).display === "none", "details omits the notification navigation and duplicated heading");
  const logs = surface.querySelector(".logs");
  assert(getComputedStyle(logs).userSelect === "text" || getComputedStyle(logs).webkitUserSelect === "text", "details output supports native text selection");
  const range = document.createRange(); range.selectNodeContents(logs);
  const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
  const before = logs.textContent;
  fixture.log = "Changed while selecting"; await wait(1100);
  assert(logs.textContent === before && selection.anchorNode.isConnected, "details capture updates preserve the selected shell text and its handles");
  selection.removeAllRanges();
  logs.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 25, clientY: 100 }));
  logs.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: 25, clientY: 100 }));
  assert(surface.classList.contains("shell-reply") && document.activeElement === surface.querySelector(".shell-keyboard"), "tapping details output uses the notification shell input");
  assert(getComputedStyle(surface.querySelector(".heading")).display === "none", "typing in details keeps its shell free of notification headings");
  window.nfn.receive({ type: "mobile_action", action: "reply_close" });
  assert(surface.querySelector(".details-content").getBoundingClientRect().top === surface.getBoundingClientRect().top,
    "the details shell starts directly below its native header with no card padding");
  window.nfn.receive({ type: "hide" });
  fixture.records.clear();
  const cached = fixture.record("cached-details"); fixture.records.set(cached.id, cached);
  fixture.heldOps.add("context");
  window.nfn.receive({ ...snapshot(), shell_only: true, shell_cache: { [cached.id]: "Already loaded in notifications" } });
  open(cached.id);
  assert(surface.querySelector(".logs").textContent === "Already loaded in notifications", "details paints its inherited capture before a context request completes");
  fixture.heldOps.delete("context");
  fixture.deferred.filter(item => item.command.op === "context").forEach(item => item.complete());
  window.nfn.receive({ type: "hide" });
  fixture.log = "\x1b[48;2;38;43;51m" + (" ".repeat(80) + "\n").repeat(35)
    + "\x1b[0mEditor status\n\x1b[48;2;38;43;51m" + " ".repeat(80) + "\x1b[0m\nLast line";
  const blank = fixture.record("blank-rows"); fixture.records.set(blank.id, blank);
  window.nfn.receive({ ...snapshot(), shell_only: true }); open(blank.id); await wait(150);
  const cleaned = surface.querySelector(".logs");
  assert(cleaned.textContent === "Editor status\n\nLast line", "unused leading screen rows are removed while internal paragraph spacing remains");
  assert(![...cleaned.querySelectorAll("span")].some(node => !node.textContent.trim() && node.style.backgroundColor),
    "blank terminal rows cannot draw colored bars");
  window.nfn.receive({ type: "hide" });
  return { passed: checks.length, checks, viewport: { width: innerWidth, height: innerHeight } };
})()
