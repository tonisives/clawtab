(async () => {
  const checks = [];
  const assert = (ok, label) => { if (!ok) throw new Error(label); checks.push(label); };
  const settle = () => new Promise(resolve => setTimeout(resolve, 120));
  fixture.open("question"); await settle();
  const buttons = [...document.querySelectorAll(".answer-row .actions button")];
  const auto = document.querySelector(".answer-auto-yes");
  assert(buttons.length >= 2, "Claude renders its actual answer choices");
  assert(auto.getBoundingClientRect().bottom <= innerHeight - 34, "Auto Yes clears the home indicator safe area");
  assert(buttons.every(button => button.getBoundingClientRect().left >= 0 && button.getBoundingClientRect().right <= innerWidth), "Answer choices stay within the phone width");
  assert(Math.max(...buttons.map(button => button.offsetWidth)) - Math.min(...buttons.map(button => button.offsetWidth)) <= 1, "Answer choices share the available width equally");
  fixture.open("post"); await settle();
  const approve = document.querySelector(".social-submit"), rect = approve.getBoundingClientRect();
  const card = document.querySelector(".card").getBoundingClientRect();
  assert(Math.abs((rect.left + rect.right) / 2 - (card.left + card.right) / 2) < 2, "Approve is centered in the draft");
  assert(rect.bottom <= innerHeight - 34, "Approve stays above the bottom safe area");
  assert(!document.querySelector(".logs"), "The draft contains no shell output");
  assert(!document.querySelector(".reply"), "The demo draft has no editable reply composer");
  fixture.calls.length = 0;
  approve.click();
  for (const action of ["reply", "open", "got_it"]) window.nfn.receive({type:"mobile_action", action});
  await settle();
  assert(!fixture.calls.some(command => ["respond", "dismiss", "focus", "shell_input"].includes(command.op)), "Demo notification controls send no action commands");
  assert(fixture.record.status === "pending" && !document.querySelector(".shell-keyboard"), "The sample remains pending without opening a keyboard");
  return { passed: checks.length, checks, viewport: { width: innerWidth, height: innerHeight } };
})()
