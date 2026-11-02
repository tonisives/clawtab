(async () => {
  const checks = [];
  const assert = (ok, label) => { if (!ok) throw Error(label); checks.push(label); };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const click = text => {
    const button = [...document.querySelectorAll("button")].find(button => button.textContent === text || button.getAttribute("aria-label") === text);
    assert(button && !button.disabled, `Available action: ${text}`); button.click();
  };
  const reset = () => {
    window.nfn.collapse(); window.fixture.records.clear(); window.fixture.calls.length = 0;
    window.fixture.heldOps.clear(); window.nfn.receive(window.fixture.snapshot());
  };
  const reminder = (id, user = false) => {
    const record = window.fixture.record(id, 0);
    record.request = { title: "Check embedding budget and backlog", body: "Verify the $0.30 daily cap, backlog progress, and fresh signals.", template: "update", response_destination: "result", deliver_at: Date.now() - 1000,
      source: user ? {} : { session_id: "saved-session", provider: "codex" },
      data: { reminder: { creator_label: user ? "You" : "Website repair", creator: user ? "user" : "agent" } },
      actions: [...(user ? [] : [{ id: "focus", label: "Open", kind: "focus" }]), { id: "acknowledge", label: "Got it", kind: "choice" }],
    };
    window.fixture.records.set(id, record); window.nfn.receive(window.fixture.snapshot(id)); return record;
  };
  window.nfn.setPlacement({ placement: "right", max_width: 1000, max_height: 860, reduce_motion: true });
  reset();
  const linked = reminder("linked-reminder");
  assert(document.querySelector(".source-attribution").textContent === "Scheduled by Website repair", "Creator attribution is visible");
  assert(!document.querySelector(".open-session").disabled && document.querySelector(".reply-toggle"), "Closed sessions retain Open and Reply");
  click("Open"); await sleep(30);
  assert(window.fixture.calls.some(command => command.op === "respond" && command.action_id === "focus"), "Open uses the saved-session action");
  click("Reply");
  const input = document.querySelector("textarea"); input.value = "Check the cap now"; input.dispatchEvent(new Event("input"));
  click("Send"); await sleep(30);
  assert(window.fixture.calls.some(command => command.id === linked.id && command.op === "respond" && command.action_id === "reply" && command.text === "Check the cap now"), "Reply submits text through the host handler");
  reset();
  const acknowledged = reminder("acknowledged-reminder");
  acknowledged.request.source.pane_id = "%saved";
  click("Got it"); await sleep(30);
  assert(acknowledged.dismissed_at && !window.fixture.calls.some(command => ["focus", "respond"].includes(command.op)), "Got it completes without resuming or replying");
  reset();
  const personal = reminder("personal-reminder", true);
  assert(document.querySelector(".open-session").disabled && !document.querySelector(".reply-toggle"), "User reminders have no linked agent controls");
  click("Got it"); await sleep(30);
  assert(personal.dismissed_at, "User reminders can be completed");
  reset(); reminder("reminder-preview");
  return { checks };
})()
