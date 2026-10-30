// Real product media in each platform preview; all responses stay in this fixture.
(async () => {
  const checks = [], fixture = window.fixture, mobile = Boolean(window.nfnMobile);
  const assert = (ok, label) => { if (!ok) throw Error(label); checks.push(label); };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const wait = async (condition, label) => {
    for (let n = 0; n < 150; n++) { if (condition()) return; await sleep(100); }
    throw Error(label);
  };
  const targets = [
    ["x", "@totovoto", "Browser sessions, previews and agent handoffs in bmux. https://bmux.cc"],
    ["instagram", "tonisdev", "A browser session you can preview before jumping back to the agent.\n\nA quick look at bmux."],
    ["tiktok", "tonisdev", "Preview the browser. Find the agent. Keep building."],
    ["youtube", "tonisdev", "A quick tour of browser previews and agent handoffs in bmux."],
    ["threads", "tonisdev", "Built a small way to see what the browser agent is doing before jumping into its terminal."],
    ["linkedin", "Tõnis Ives", "Reviewing browser sessions and moving directly to the responsible agent makes it easier to follow several tasks."],
    ["bluesky", "tonis.dev", "A quick bmux demo: preview a browser session, then jump to its agent. https://bmux.cc"],
    ["mastodon", "tonis@mastodon.social", "A quick look at browser previews and agent handoffs in bmux. https://bmux.cc"]
  ].map(([platform, account, body], index) => ({ id: platform, platform, account, display_name: "Tõnis Ives", body,
    title: platform === "youtube" ? "Browser session previews in bmux" : "", revision: String(index + 1).repeat(64),
    media_indices: [["instagram", "tiktok", "youtube"].includes(platform) ? 0 : 1] }));
  const open = (id, selected = targets) => {
    window.nfn.collapse(); fixture.records.clear(); fixture.calls.length = 0;
    const record = fixture.record(id);
    record.request = { title: "Review platform drafts", body: "Agent note: each platform has its own copy and selected media.", template: "social-review", response_destination: "result",
      source: { pane_id: "%platform-preview", provider: "codex" },
      media: [{ kind: "video", src: "/fixture/review-portrait.mp4", alt: "Portrait test presentation of the real bmux recording" }, { kind: "image", src: fixture.reviewImage, alt: "Real ClawTab agent and shell screenshot" }],
      data: { targets: selected }, actions: [{ id: "decide", kind: "choice", label: "Send platform decisions" }] };
    fixture.records.set(id, record); window.nfn.receive({ ...fixture.snapshot(id), remote: mobile }); window.nfn.receive({ type: "open_record", id });
  };
  const panel = () => document.querySelector('.social-platform:not([hidden])');
  const brandNames = { x: "X", instagram: "Instagram", youtube: "YouTube", threads: "Threads", linkedin: "LinkedIn", bluesky: "Bluesky", mastodon: "Mastodon" };
  const ready = async target => {
    const current = panel(), video = current.querySelector("video");
    const brand = current.querySelector(".social-platform-mark,.social-video-brand");
    if (Object.hasOwn(brandNames, target.platform)) {
      await wait(() => brand.querySelector(".social-brand-icon")?.naturalWidth > 0, `${target.platform} brand asset did not load`);
      const icon = brand.querySelector(".social-brand-icon"), rect = icon.getBoundingClientRect();
      assert(new URL(icon.src).origin === "https://cdn.clawtab.cc" && getComputedStyle(icon).objectFit === "contain" && rect.width === 24 && rect.height === 24, `${target.platform} loads its official CDN icon without stretching or changing the review layout`);
      assert((icon.alt || brand.textContent) === brandNames[target.platform], `${target.platform} retains an accessible platform name`);
    } else assert(!brand.querySelector("img") && brand.textContent === (target.platform === "tiktok" ? "TikTok" : target.platform), `${target.platform} retains its platform name label`);
    if (video) {
      await wait(() => video.readyState >= 2 && current.querySelector(".video-thumbnail")?.naturalWidth > 0, "portrait video did not decode a thumbnail");
      assert(video.videoWidth === 360 && video.videoHeight === 640 && video.muted, "portrait preview decodes the selected 360 by 640 media and starts muted");
      const thumbnail = current.querySelector(".video-thumbnail"), canvas = document.createElement("canvas"); canvas.width = 36; canvas.height = 64;
      const ctx = canvas.getContext("2d"); ctx.drawImage(thumbnail, 0, 0, 36, 64);
      const pixels = ctx.getImageData(0, 0, 36, 64).data;
      assert(pixels.some((channel, index) => index % 4 !== 3 && channel > 24), "portrait thumbnail contains decoded product footage");
      const rect = current.querySelector(".video-preview").getBoundingClientRect();
      assert(Math.abs(rect.width / rect.height - 9 / 16) < .01, "portrait preview preserves the actual video aspect ratio");
    } else await wait(() => current.querySelector(".media img")?.naturalWidth > 0, "the real product screenshot did not load");
    await sleep(100);
  };
  window.nfn.setPlacement({ placement: "right", max_width: 1000, max_height: 860, reduce_motion: true });
  if (window.platformCapture) {
    const target = targets.find(target => target.platform === window.platformCapture);
    open("platform-capture", [target]); await ready(target);
    assert(!document.querySelector(".social-tabs") && panel().querySelector(`.${target.platform}-post`), "a single platform preview omits the selector and shows its platform card");
    return { passed: checks.length, checks, platform: target.platform };
  }
  open("all-platforms");
  const tabs = [...document.querySelectorAll('.social-tabs [role="tab"]')], host = document.getElementById("surface");
  assert(tabs.length === targets.length, "all eight configured platforms have a selectable preview");
  assert(!document.querySelector("video") && !fixture.calls.some(call => call.op === "media"), "unopened platform drafts do not download or initialize hidden videos");
  let previousVideo = null;
  for (const [index, target] of targets.entries()) {
    tabs[index].click();
    if (previousVideo) assert(previousVideo.paused, "switching platforms pauses the previous video");
    await ready(target);
    const current = panel(), post = current.querySelector(`.${target.platform}-post`), body = document.querySelector(".message-content");
    assert(post?.querySelector(".social-body").textContent === target.body && !post.textContent.includes("Agent note"), `${target.platform} retains its exact tailored copy separately from agent text`);
    assert(post.querySelector(".social-account").textContent === (target.platform === "linkedin" || target.account.startsWith("@") ? target.account : `@${target.account}`), `${target.platform} shows the account without inventing a LinkedIn handle`);
    assert(Boolean(post.querySelector("video")) === (target.media_indices[0] === 0) && post.querySelectorAll(".media-item").length === 1, `${target.platform} shows only its selected media`);
    assert(post.scrollWidth <= post.clientWidth + 1 && body.scrollWidth <= body.clientWidth + 1 && host.scrollWidth <= host.clientWidth + 1, `${target.platform} fits horizontally on this screen`);
    assert(body.getBoundingClientRect().right - post.getBoundingClientRect().right >= 12, `${target.platform} leaves space between the card and scrollbar`);
    assert(!post.querySelector("button:not(.media-play),a,input,textarea") && (!post.querySelector(".social-engagement") || post.querySelector(".social-engagement").getAttribute("aria-hidden") === "true"), `${target.platform} keeps preview decoration separate from review actions`);
    if (["tiktok", "youtube"].includes(target.platform)) assert(post.querySelector(".social-video-stage") && post.querySelector(".social-video-brand"), `${target.platform} uses a video-first platform layout`);
    if (target.platform === "instagram") assert(post.querySelector(".media").nextElementSibling.classList.contains("social-engagement"), "Instagram puts its caption after the media and action row");
    previousVideo = post.querySelector("video");
    if (previousVideo) {
      post.querySelector(".media-play").click();
      await wait(() => !previousVideo.paused, "the selected platform video did not start");
    }
    current.querySelector(`[aria-label="${target.platform === "threads" ? "Request changes for" : "Approve"} ${target.platform}"]`).click();
    if (target.platform === "threads") {
      const feedback = current.querySelector("textarea"); feedback.value = "Use a more conversational opening for Threads."; feedback.dispatchEvent(new Event("input"));
    }
  }
  tabs[4].click();
  assert(panel().querySelector("textarea").value.includes("conversational") && !panel().querySelector(".social-feedback").hidden, "per-platform feedback survives switching between previews");
  document.querySelector(".details-toggle").click(); await sleep(100);
  assert(document.querySelector(".details-content") && panel().querySelector(".threads-post") && document.querySelector(".social-submit").getBoundingClientRect().bottom <= host.getBoundingClientRect().bottom, "Details retains the platform preview, feedback and reachable submit control");
  document.querySelector(".details-toggle").click();
  document.querySelector(".social-submit").click(); await sleep(100);
  const sent = fixture.calls.find(call => call.op === "respond");
  assert(sent?.decisions.length === targets.length && sent.decisions.every((decision, index) => decision.revision === targets[index].revision && decision.target_id === targets[index].id && decision.decision === (index === 4 ? "revise" : "approve")) && sent.decisions[4].comment.includes("conversational"), "platform styling preserves exact revisions and scoped review decisions");
  const unknown = { ...targets[0], id: "future-plugin", platform: "future-plugin", account: "creator" };
  open("generic-platform", [unknown]); await ready(unknown);
  assert(panel().querySelector(".social-post") && panel().querySelector(".social-platform-mark").textContent === "future-plugin", "additional posting plugins keep a generic preview with their platform name");
  open("brand-fallback", [targets[0]]); await ready(targets[0]);
  const brand = panel().querySelector(".social-platform-mark");
  brand.querySelector("img").dispatchEvent(new Event("error"));
  assert(brand.textContent === "X" && !brand.querySelector("img"), "a failed brand image keeps a readable platform label");
  const longAccount = { ...targets[6], account: "a-long-creator-account.with-a-long-domain.example", display_name: "A creator with a longer display name" };
  open("long-account", [longAccount]); await ready(longAccount);
  assert(panel().querySelector(".social-account").textContent === `@${longAccount.account}` && panel().scrollWidth <= panel().clientWidth + 1, "long account names wrap without hiding the account or widening the card");
  open("portrait-final", [targets[2]]); await ready(targets[2]);
  return { passed: checks.length, checks };
})()
