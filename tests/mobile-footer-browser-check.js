// Run against tests/message-immediate-fixture.cjs at a phone viewport.
(async () => {
  const checks = [];
  const assert = (ok, label) => { if (!ok) throw Error(label); checks.push(label); };
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const fixture = window.fixture;
  assert(!window.ReactNativeWebView, "checks run in the web remote host");
  window.nfn.receive({ type: "hide" });
  fixture.records.clear(); fixture.calls.length = 0;
  fixture.log = "Preloaded shell output";
  const first = fixture.record("footer-first", 0), second = fixture.record("footer-second", 0);
  first.request.source.job_id = "outreach";
  second.request.source.job_id = "outreach";
  fixture.records.set(first.id, first); fixture.records.set(second.id, second);
  window.nfn.receive({ ...fixture.snapshot(), remote: true });
  window.nfn.receive({ type: "open_record", id: first.id });
  await wait(100);
  assert(fixture.calls.some(call => call.op === "context" && call.id === second.id),
    "web remote preloads the next message shell");
  fixture.heldOps.add("context");
  window.nfn.receive({ type: "open_record", id: second.id });
  const surface = document.getElementById("surface");
  assert(surface.classList.contains("details-open") && surface.querySelector(".logs").textContent.includes(fixture.log),
    "opening a message shows its cached shell before a fresh context response");
  const buttons = [...surface.querySelectorAll(".footer-actions button")];
  assert(buttons.map(button => button.textContent).join("|") === "Open|Go to job|Got it|Reply", "all four footer actions are present");
  const styles = buttons.map(button => { const style = getComputedStyle(button); return { font: style.font, color: style.color, borderRadius: style.borderRadius }; });
  assert(styles.every(style => style.font === styles[0].font && style.color === styles[0].color),
    "footer actions share one font and text color");
  assert(styles.every(style => style.borderRadius === "0px"), "footer actions form flat segments");
  assert(buttons.every(button => button.scrollWidth <= button.clientWidth && button.getBoundingClientRect().right <= innerWidth),
    "every footer label fits within its segment and viewport");
  assert(getComputedStyle(surface.querySelector(".details-toggle")).display === "none", "web remote hides the bottom details chevron");
  const job = fixture.record("footer-job", 0); delete job.request.source.pane_id; job.request.source.job_id = "outreach";
  fixture.records.set(job.id, job);
  window.nfn.receive({ ...fixture.snapshot(), remote: true });
  window.nfn.receive({ type: "open_record", id: job.id });
  const nextStyles = [...surface.querySelectorAll(".footer-actions button")].map(button => getComputedStyle(button));
  assert(nextStyles.every(style => style.font === styles[0].font && style.color === styles[0].color),
    "job messages retain the same footer typography and color");
  fixture.heldOps.delete("context"); fixture.deferred.splice(0).forEach(request => request.complete());
  window.nfn.receive({ type: "hide" });
  return { passed: checks.length, checks, viewport: { width: innerWidth, height: innerHeight } };
})()
