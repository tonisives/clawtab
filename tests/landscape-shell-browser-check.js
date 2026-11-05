(async () => {
  const snapshot = window.fixture.snapshot();
  snapshot.shell_only = true;
  snapshot.shell_answers = true;
  snapshot.demo = true;
  snapshot.records[0].request.actions = [{ id: "1", kind: "choice", label: "Yes" }];
  const compact = window.fixture.phoneLandscape ?? innerWidth > innerHeight;
  window.nfnMobile.setInsets(0, false, compact);
  window.nfn.receive(snapshot);
  window.nfn.receive({ type: "open_record", id: snapshot.records[0].id });
  await new Promise(resolve => setTimeout(resolve, 200));
  const logs = getComputedStyle(document.querySelector(".logs"));
  const card = getComputedStyle(document.querySelector(".card"));
  const assert = (condition, message) => { if (!condition) throw Error(message); };
  assert(logs.fontSize === (compact ? "8px" : "12px"), "shell text follows the portrait/landscape size");
  assert(logs.lineHeight === (compact ? "12px" : "16px"), "shell line spacing follows its text size");
  assert(card.paddingBottom === (compact ? "0px" : "12px"), "landscape shell has no extra footer padding");
  assert(document.documentElement.scrollWidth <= innerWidth, "shell stays within its viewport");
  return { passed: 4, width: innerWidth, height: innerHeight, fontSize: logs.fontSize, paddingBottom: card.paddingBottom };
})()
