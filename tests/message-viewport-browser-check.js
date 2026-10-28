async () => {
  const checks = [];
  const assert = (value, label) => { if (!value) throw new Error(label); checks.push(label); };
  const settle = async () => {
    const started = Date.now();
    do {
      await new Promise(resolve => setTimeout(resolve, 40));
      if (!document.getAnimations().some(animation => ["running", "paused"].includes(animation.playState))) return;
    } while (Date.now() - started < 2000);
    throw new Error("Message layout animation did not settle");
  };
  const bounds = selector => document.querySelector(selector).getBoundingClientRect();
  const receive = value => window.nfn.receive(value);
  window.nfnMobile.setInsets(34, false);
  receive({ type: "show" }); await settle();
  assert(Math.abs(bounds("#surface").height - innerHeight) <= 1, "message list fills its host viewport");
  assert(Math.abs(bounds(".queue").bottom - innerHeight) <= 1, "list background extends through the bottom safe area");
  assert(getComputedStyle(document.querySelector(".queue")).paddingBottom === "34px", "home-indicator spacing belongs to the list content");
  assert(document.documentElement.scrollWidth <= innerWidth, "mobile list has no horizontal overflow");
  const list = document.querySelector(".queue-content");
  list.scrollTop = list.scrollHeight;
  assert(list.lastElementChild.getBoundingClientRect().bottom <= bounds(".queue").bottom - 33, "last message scrolls above the home indicator");
  receive({ type: "open_record", id: "message-0" }); await settle();
  const toggle = document.querySelector(".reply-toggle");
  if (toggle?.getAttribute("aria-expanded") === "false") toggle.click();
  const field = document.querySelector("textarea"); field.focus();
  field.value = "Continue with the remaining checks";
  field.dispatchEvent(new Event("input", { bubbles: true }));
  window.nfnMobile.setInsets(34, true); await settle();
  assert(bounds("textarea").top >= bounds(".card").top && bounds("textarea").bottom <= innerHeight, "focused reply field stays above the keyboard-sized viewport edge");
  assert(bounds(".send").bottom <= innerHeight + 1, "Send remains reachable with the reply field");
  assert(getComputedStyle(document.querySelector(".card")).paddingBottom === "12px", "keyboard removes the home-indicator spacer");
  assert(document.documentElement.scrollWidth <= innerWidth, "reply layout stays within the narrow viewport");
  const pointer = (type, target, x, y) => target.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: y }));
  const background = document.querySelector(".message");
  pointer("pointerdown", background, 20, 100); pointer("pointerup", background, 20, 100);
  assert(document.activeElement !== field, "a background tap dismisses editing");
  assert(field.value === "Continue with the remaining checks", "keyboard dismissal retains the reply draft");
  field.focus();
  pointer("pointerdown", background, 20, 100); pointer("pointerup", background, 20, 150);
  assert(document.activeElement === field, "scrolling content does not dismiss the keyboard");
  window.nfnMobile.setInsets(34, false); field.blur(); await settle();
  assert(getComputedStyle(document.querySelector(".card")).paddingBottom === "46px", "keyboard dismissal restores safe-area spacing without a second spacer");
  if (document.querySelector(".card-footer")) {
    const completion = window.fixture.record("completion", 0);
    completion.request.template = "update";
    completion.request.actions = [{ id: "acknowledge", label: "Got it", kind: "choice" }];
    window.fixture.records.set(completion.id, completion);
    receive({ ...window.fixture.snapshot(), remote: true });
    receive({ type: "open_record", id: completion.id }); await settle();
    const toolbar = bounds(".controls");
    assert([...document.querySelectorAll(".controls button")].every(button => {
      const rect = button.getBoundingClientRect(); return rect.left >= toolbar.left - 1 && rect.right <= toolbar.right + 1;
    }), "completion footer controls stay inside a narrow mobile toolbar");
    document.querySelector(".reply-toggle").click(); await settle();
    document.querySelector("textarea").focus(); window.nfnMobile.setInsets(34, true); await settle();
    assert(bounds("textarea").bottom <= innerHeight && bounds(".send").bottom <= innerHeight + 1, "new footer composer remains reachable in the keyboard-sized viewport");
  }
  return { width: innerWidth, height: innerHeight, passed: checks.length, checks };
}
