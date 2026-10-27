async () => {
  const checks = [];
  const assert = (value, label) => { if (!value) throw new Error(label); checks.push(label); };
  const wait = async predicate => {
    const start = Date.now();
    while (!predicate()) { if (Date.now() - start > 30000) throw new Error("Timed out waiting for remote media"); await new Promise(resolve => setTimeout(resolve, 40)); }
  };
  await wait(() => document.querySelector(".media img")?.complete && document.querySelector(".media img")?.naturalWidth > 0);
  assert(document.querySelector(".message").textContent.includes("Your agents, wherever you are"), "deep link selects the message on the correct machine");
  assert(!window.unsafeMarkup && !document.querySelector(".message img"), "social caption renders as text");
  assert(document.querySelector(".actions").textContent.includes("Post to X") && document.querySelector(".actions").textContent.includes("Request changes"), "social confirmation preserves action labels");
  assert(document.querySelector(".media img").src.startsWith("blob:"), "local photo loads through the bounded host media bridge");
  assert(document.querySelector(".media img").alt === "ClawTab terminal and agent", "photo description survives relay presentation");
  const video = document.querySelector(".media video");
  if (video) {
    await wait(() => video.readyState >= 1);
    assert(video.controls && video.playsInline, "video uses inline native playback controls");
    assert(Number.isFinite(video.duration) && video.duration > 0, "local video metadata is playable");
    const position = Math.min(1, video.duration / 2); video.currentTime = position;
    await wait(() => !video.seeking && Math.abs(video.currentTime - position) < .2);
    assert(true, "local video supports seeking after ranged transfer");
  }
  assert(document.documentElement.scrollWidth <= innerWidth, "shared card fits the mobile viewport without horizontal overflow");
  const reply = document.querySelector("textarea");
  reply.value = "Keep this caption edit"; reply.dispatchEvent(new Event("input", { bubbles: true }));
  window.nfn.receive({ ...window.lastSnapshot, records: window.lastSnapshot.records.map(record => ({ ...record, updated_at: Date.now() })) });
  assert(document.querySelector("textarea").value === "Keep this caption edit", "live relay updates preserve the reply draft");
  window.nfn.receive({ type: "open_record", id: "mac-a::launch-review" });
  await wait(() => document.querySelector(".message")?.textContent === "Caption from Mac A");
  assert(true, "equal message IDs on two hosts remain independently selectable");
  window.nfn.receive({ type: "open_record", id: "mac-b::launch-review" });
  await wait(() => document.querySelector(".message")?.textContent.includes("Your agents, wherever you are"));
  assert(document.querySelector("textarea").value === "Keep this caption edit", "changing messages restores the original draft");
  const original = window.lastSnapshot;
  const message = original.records.find(record => record.id === "mac-b::launch-review");
  const update = { ...message, request: { ...message.request, template: "update", media: [], source: {}, actions: [] } };
  window.nfn.receive({ ...original, records: original.records.map(record => record.id === update.id ? update : record), settings: { preview_seconds: .15 } });
  window.nfn.receive({ type: "open_record", id: update.id, popup: true });
  assert(!document.querySelector("#surface").classList.contains("expanded"), "status arrivals use the desktop timed preview");
  await wait(() => !document.querySelector(".card"));
  assert(true, "status popup collapses after its preview interval");
  window.nfn.receive(original);
  window.nfn.receive({ type: "open_record", id: message.id, popup: true });
  await new Promise(resolve => setTimeout(resolve, 200));
  assert(Boolean(document.querySelector(".card textarea")), "social approvals remain open for a decision");
  await wait(() => document.querySelector(".media img")?.naturalWidth > 0);
  if (video) await wait(() => document.querySelector(".media video")?.readyState >= 1);
  return checks;
}
