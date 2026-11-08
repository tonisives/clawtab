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
  const jobOnly = fixture.record("footer-job-prefetch", 0);
  delete jobOnly.request.source.pane_id; jobOnly.request.source.job_id = "job-only";
  jobOnly.created_at = first.created_at + 1000;
  first.request.source.job_id = "outreach";
  second.request.source.job_id = "outreach-second";
  fixture.records.set(first.id, first); fixture.records.set(second.id, second); fixture.records.set(jobOnly.id, jobOnly);
  window.nfn.receive({ ...fixture.snapshot(), remote: true });
  window.nfn.receive({ type: "open_record", id: first.id });
  await wait(100);
  assert(fixture.calls.some(call => call.op === "context" && call.id === second.id),
    "web remote preloads the next message shell");
  assert(fixture.calls.some(call => call.op === "context" && call.id === jobOnly.id),
    "job output is prefetched even when the job has no live shell pane");
  const secondCaptures = () => fixture.calls.filter(call => call.op === "context" && call.id === second.id).length;
  const capturesBeforeSwipe = secondCaptures();
  fixture.heldOps.add("context");
  const preview = window.nfn.pagePreview(1);
  assert(preview.node.querySelector(".logs").textContent.includes(fixture.log), "the swipe preview already contains prefetched output");
  window.nfnPaging.begin(document.querySelector("#surface > .card"));
  window.nfnPaging.move(-160);
  window.nfnPaging.release(-160, -1);
  await wait(20);
  assert(secondCaptures() === capturesBeforeSwipe, "opening a prefetched card reuses its capture without another request");
  const surface = document.getElementById("surface");
  window.nfnPaging.finish();
  const logsBounds = surface.querySelector(".logs").getBoundingClientRect();
  assert(logsBounds.left === 0 && logsBounds.right === innerWidth, "shell output spans the viewport without card side padding");
  assert(surface.classList.contains("details-open") && surface.querySelector(".logs").textContent.includes(fixture.log),
    "opening a message shows its cached shell before a fresh context response");
  const buttons = [...surface.querySelectorAll(".footer-actions button")];
  assert(buttons.map(button => button.textContent).join("|") === "Open|Go to job|Got it|Reply", "all four footer actions are present");
  const styles = buttons.map(button => { const style = getComputedStyle(button); return { font: style.font, color: style.color, borderRadius: style.borderRadius }; });
  assert(styles.every(style => style.font === styles[0].font && style.color === styles[0].color),
    "footer actions share one font and text color");
  assert(styles.every(style => style.borderRadius === "0px"), "footer actions form flat segments");
  assert(getComputedStyle(surface.querySelector(".footer-actions")).borderRadius === "999px", "the segmented control has fully rounded outer ends");
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
