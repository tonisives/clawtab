(async () => {
  const fixture = window.fixture, checks = [];
  const assert = (ok, label) => { if (!ok) throw Error(label); checks.push(label); };
  const wait = () => new Promise(resolve => setTimeout(resolve, 100));
  function open(id, mobile = false) {
    window.nfn.collapse();
    if (mobile) window.ReactNativeWebView = { postMessage() {} };
    else delete window.ReactNativeWebView;
    const record = fixture.record(id);
    record.request = { title: "Review launch post", template: "social-review", source: { pane_id: "demo-codex" },
      data: { targets: [{ id: "x", platform: "x", account: "@clawtab", body: "A draft launch post.", revision: "a".repeat(64), media_indices: [] }] },
      actions: [{ id: "decide", kind: "choice", label: "Send platform decisions" }] };
    fixture.records.clear(); fixture.records.set(id, record);
    window.nfn.receive({ ...fixture.snapshot(), remote: mobile });
    window.nfn.receive({ type: "open_record", id });
    return record;
  }
  fixture.calls.length = 0;
  for (const mobile of [false, true]) {
    const id = `approve-${mobile}`;
    open(id, mobile);
    assert(document.querySelectorAll(".social-footer button").length === 1 && !document.querySelector(".social-deny"), "Approve is the only extra review button");
    assert(parseFloat(getComputedStyle(document.querySelector(".social-footer")).paddingBottom) >= 16, "Approve has bottom padding");
    document.querySelector(".social-submit").click(); await wait();
    assert(fixture.calls.find(call => call.id === id && call.op === "respond")?.decisions[0].decision === "approve", "Approve sends approval");
    const replyId = `reply-${mobile}`;
    open(replyId, mobile);
    if (mobile) window.nfn.receive({ type: "mobile_action", action: "reply" });
    else document.querySelector(".reply-toggle").click();
    const comment = document.querySelector(".reply textarea");
    assert(!document.querySelector(".reply").hidden && document.querySelector(".send").disabled, "Reply opens feedback and requires text");
    comment.value = "Make the first sentence shorter."; comment.dispatchEvent(new Event("input"));
    document.querySelector(".send").click(); await wait();
    const response = fixture.calls.find(call => call.id === replyId && call.op === "respond");
    assert(response?.decisions[0].decision === "revise" && response.decisions[0].comment === comment.value && response.decisions[0].revision === "a".repeat(64), "Reply requests changes against the original revision");
    const denyId = `deny-${mobile}`;
    open(denyId, mobile);
    if (mobile) window.nfn.receive({ type: "mobile_action", action: "got_it" });
    else document.querySelector(".acknowledge").click();
    await wait();
    assert(fixture.calls.find(call => call.id === denyId && call.op === "respond")?.decisions[0].decision === "deny", "Got it denies the review through the existing control");
  }
  open("final-review");
  return { passed: checks.length, checks };
})()
