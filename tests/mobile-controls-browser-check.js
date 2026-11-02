(async () => {
  const checks = [];
  const assert = (ok, text) => { if (!ok) throw Error(text); checks.push(text); };
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const fixture = window.fixture, surface = document.getElementById("surface");
  window.ReactNativeWebView = { postMessage: raw => window.webkit.messageHandlers.nfn.postMessage(JSON.parse(raw)) };
  window.nfn.collapse(); fixture.records.clear();
  const record = fixture.record("controls");
  record.question_id = "controls-question";
  fixture.records.set(record.id, record);
  fixture.autoYesPanes.add(record.request.source.pane_id);
  const snapshot = () => ({ ...fixture.snapshot(), remote: true, native_chrome: true, native_keyboard: true });
  const send = action => window.nfn.receive({ type: "mobile_action", action });
  window.nfn.receive(snapshot());
  window.nfn.receive({ type: "open_record", id: record.id });
  await wait(100);
  const yes = surface.querySelector(".auto-yes-button"), label = yes.firstChild;
  assert(yes.textContent === "! Auto ON", "the enabled auto-yes state is visible on opening");
  const mutations = [];
  const observer = new MutationObserver(items => mutations.push(...items));
  observer.observe(yes, { attributes: true, childList: true, subtree: true, characterData: true });
  for (let i = 0; i < 4; i++) { window.nfn.receive(snapshot()); await wait(20); }
  observer.disconnect();
  assert(yes.firstChild === label && mutations.length === 0,
    "identical live snapshots leave the Auto ON button and its label untouched");
  send("got_it");
  let panel = surface.querySelector(".acknowledge-menu");
  let bounds = panel?.getBoundingClientRect();
  assert(bounds && bounds.top >= 0 && bounds.bottom <= innerHeight && bounds.left >= 0 && bounds.right <= innerWidth,
    "native Got it opens its session menu inside the viewport despite the hidden web footer");
  surface.querySelector(".acknowledge-overlay").click();
  send("reply");
  window.nfn.receive({ type: "mobile_action", action: "shell_input", text: "y\r" });
  await wait(50);
  assert(fixture.calls.some(command => command.op === "shell_input" && command.text === "y\r"),
    "the answer is sent through the shell input path");
  record.status = "resolved";
  record.response = { action_id: "shell", text: "y" };
  window.nfn.receive({ ...snapshot(), records: [record], pending_count: 0 });
  send("reply_close");
  assert(!surface.querySelector(".acknowledge").disabled,
    "Got it remains available after the shell answer resolves the question");
  send("got_it");
  panel = surface.querySelector(".acknowledge-menu");
  bounds = panel?.getBoundingClientRect();
  assert(bounds && bounds.top >= 0 && bounds.bottom <= innerHeight,
    "Got it opens after closing shell input without navigating away and back");
  [...panel.querySelectorAll("button")].find(button => button.textContent === "Keep session alive").click();
  await wait(50);
  assert(fixture.calls.some(command => command.op === "dismiss" && command.id === record.id),
    "the answered notification can be dismissed from its session menu");
  window.nfn.receive({ type: "hide" });
  return { passed: checks.length, checks, viewport: { width: innerWidth, height: innerHeight } };
})()
