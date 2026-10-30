// Uses a real local product clip through the same attachment-range bridge as the app.
(async () => {
  const checks = [], fixture = window.fixture;
  const assert = (ok, label) => { if (!ok) throw Error(label); checks.push(label); };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const wait = async (condition, label) => {
    for (let n = 0; n < 150; n++) { if (condition()) return; await sleep(100); }
    throw Error(label);
  };
  const mobile = Boolean(window.nfnMobile);
  const open = (id, remote = mobile) => {
    window.nfn.collapse();
    window.nfn.receive({ ...fixture.snapshot(id), remote });
    window.nfn.receive({ type: "open_record", id });
  };
  const post = id => {
    const record = fixture.record(id);
    record.request = { title: "Review the bmux post", body: "Agent note: review this screen recording before posting.", template: "social-review", response_destination: "result",
      source: { pane_id: "%video-review", provider: "codex" },
      media: [{ kind: "video", src: "/fixture/review.mp4", alt: "Real bmux session preview and agent handoff" }],
      data: { targets: [{ id: "x", platform: "x", account: "@totovoto", body: "In bmux I can preview browser sessions and jump to the agent's tmux pane.\n\nhttps://bmux.cc", revision: "a".repeat(64), media_indices: [0] }] },
      actions: [{ id: "decide", kind: "choice", label: "Send platform decisions" }] };
    fixture.records.set(id, record); return record;
  };
  fixture.records.clear(); fixture.calls.length = 0;
  const record = post("video-review");
  fixture.log = "Earlier shell output\n".repeat(80) + "Latest shell output";
  window.nfn.setPlacement({ placement: "right", max_width: 1000, max_height: 860, reduce_motion: true });
  open(record.id);
  const video = document.querySelector("video"), preview = document.querySelector(".x-post"), body = document.querySelector(".message-content");
  assert(!document.querySelector(".logs"), "opening a media review does not automatically open shell output");
  assert(preview && preview.textContent.includes("@totovoto"), "the X card shows the exact account and post copy separately from the agent note");
  assert(!preview.textContent.includes("Agent note") && !document.querySelector(".social-tabs"), "a single X draft has no full-width platform selector or agent text inside the post");
  assert(document.querySelector(".social-feedback").hidden && document.querySelector(".social-submit").textContent === "Approve", "single-post review starts with Approve and a hidden feedback field");
  const thumbnail = document.querySelector(".video-thumbnail");
  await wait(() => video.readyState >= 2 && video.poster.startsWith("data:image/jpeg") && thumbnail.naturalWidth > 0, "the real local clip did not decode a thumbnail");
  assert(video.src.startsWith("blob:") && video.videoWidth === 1920 && video.videoHeight === 1080, "desktop video uses the bounded attachment bridge and decodes the reviewed landscape file");
  assert(video.muted && video.poster.length > 1000 && document.querySelector(".media-play").disabled === false, "a real video frame is visible before playback and preview starts muted");
  assert(!thumbnail.hidden && thumbnail.src === video.poster, "the thumbnail is a decoded image layer above the video before playback");
  const src = video.src, poster = video.poster, beforeWidth = video.getBoundingClientRect().width;
  if (!mobile) {
    const resize = document.querySelector('[data-resize="se"]'); resize.setPointerCapture = () => {}; resize.hasPointerCapture = () => false;
    resize.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 9, screenX: 700, screenY: 400 }));
    document.dispatchEvent(new PointerEvent("pointermove", { pointerId: 9, screenX: 1000, screenY: 650 }));
    document.dispatchEvent(new PointerEvent("pointerup", { pointerId: 9 }));
  }
  await sleep(100);
  assert(!document.querySelector(".logs") && !body.hidden && (mobile || video.getBoundingClientRect().width > beforeWidth + 150), "the content view retains the video and desktop resizing enlarges it without opening shell output");
  await video.play(); await sleep(350);
  assert(!video.paused && video.currentTime > .2 && !video.error && thumbnail.hidden, "the actual reviewed video plays and advances with the thumbnail layer hidden");
  const time = video.currentTime, scroll = body.scrollTop;
  document.querySelector(".details-toggle").click(); await sleep(100);
  assert(document.querySelector("video") === video && video.src === src && video.poster === poster && !video.paused, "Details retains the same playing video, source and thumbnail");
  assert(body.contains(document.querySelector(".details-content")) && !body.hidden && body.scrollTop === scroll, "Details appends shell output below the preview without scrolling away from it");
  assert(video.currentTime > time, "opening Details does not interrupt playback");
  document.querySelector(".details-toggle").click(); video.pause();
  document.querySelector('[aria-label="Request changes for x"]').click();
  const feedback = document.querySelector(".social-feedback"), comment = feedback.querySelector("textarea");
  assert(!feedback.hidden && document.querySelector(".social-submit").textContent === "Send feedback" && document.querySelector(".social-submit").disabled, "Request changes reveals feedback and requires text before sending");
  comment.value = "Start at the session preview and make the terminal easier to read."; comment.dispatchEvent(new Event("input"));
  document.querySelector(".details-toggle").click(); document.querySelector(".details-toggle").click();
  assert(comment.value.includes("terminal") && !feedback.hidden && !document.querySelector(".social-submit").disabled, "feedback survives Details toggles with its send control available");
  document.querySelector(".social-submit").click(); await sleep(100);
  const sent = fixture.calls.filter(call => call.op === "respond");
  assert(sent.length === 1 && sent[0].decisions[0].decision === "revise" && sent[0].decisions[0].revision === "a".repeat(64) && sent[0].decisions[0].comment === comment.value, "feedback sends the exact original revision as a revision request, never an approval");
  for (const [id, action, expected] of [["approve-review", ".social-submit", "approve"], ["deny-review", ".social-deny", "deny"]]) {
    post(id); open(id, true); await sleep(50);
    document.querySelector(action).click(); await sleep(80);
    const response = fixture.calls.find(call => call.op === "respond" && call.id === id);
    assert(response?.decisions[0].decision === expected && !response.decisions[0].comment, `${expected} sends an explicit decision without feedback`);
  }
  post("final-preview"); open("final-preview", true);
  await wait(() => document.querySelector(".video-thumbnail")?.naturalWidth > 0, "mobile thumbnail did not load");
  assert(!document.querySelector(".social-tabs") && document.querySelector(".x-post") && !document.querySelector(".logs"), "mobile uses the same X card and thumbnail without an extra platform box or shell output");
  return { passed: checks.length, checks, video: { width: video.videoWidth, height: video.videoHeight, poster: poster.length } };
})()
