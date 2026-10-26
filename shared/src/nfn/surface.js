/* Shared by the daemon's WKWebView and the settings preview iframe. */
(() => {
  "use strict";
  const host = document.getElementById("surface");
  const records = new Map(), drafts = new Map(), promises = new Map();
  let snapshot = {}, current = null, expanded = false, details = false, allChoices = false, queue = false, history = false, preview = false;
  let renderedId = null, card = null, logTimer = null, collapseTimer = null, remaining = 8000, timerStarted = 0;
  let hovering = false, focused = false, busy = false, contextBusy = false, serial = 0, placement = "right";
  let historyOffset = 0, historyItems = [], pendingOffset = 50, hasMoreHistory = false, loadingQueue = false;
  let completionTimer = null, navigating = false, unseenPending = 0;
  let menu = null;
  let geometry = {}, layoutAnimation = null, contentAnimations = [], lastSize = "", renderedLayout = "";
  const autoYesBusy = new Set();
  const selectedNotifications = new Set();
  let bulkBusy = false, queueError = "";
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  function native(value) {
    if (window.webkit?.messageHandlers?.nfn) window.webkit.messageHandlers.nfn.postMessage(value);
    else if (window.parent !== window) window.parent.postMessage({ nfn: value }, "*");
  }
  function call(command) {
    if (preview) {
      if (command.op === "context") return Promise.resolve({ id: command.id, log: "Reviewing the draft...\nPreview ready for your decision.", source: records.get(command.id)?.request.source || {}, models: [], plugins: [] });
      if (["read", "dismiss"].includes(command.op)) return Promise.resolve({});
      native({ preview_action: command }); return Promise.resolve({ preview: true });
    }
    const token = String(++serial);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { promises.delete(token); reject(new Error("No response from daemon; check the request before trying again")); }, 65000);
      promises.set(token, { resolve, reject, timer }); native({ token, command });
    });
  }
  function el(tag, className, text) {
    const node = document.createElement(tag); if (className) node.className = className;
    if (text != null) node.textContent = text; return node;
  }
  function button(text, action, className = "") {
    const node = el("button", className, text); node.type = "button";
    node.addEventListener("click", action); return node;
  }
  function iconButton(label, path, action, className = "") {
    const control = button("", action, `utility icon-button ${className}`);
    control.setAttribute("aria-label", label); control.title = label;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("fill", "none"); svg.setAttribute("stroke", "currentColor"); svg.setAttribute("stroke-width", "2"); svg.setAttribute("stroke-linecap", "round"); svg.setAttribute("stroke-linejoin", "round"); svg.setAttribute("aria-hidden", "true");
    const shape = document.createElementNS(svg.namespaceURI, "path"); shape.setAttribute("d", path); svg.append(shape); control.append(svg);
    return control;
  }
  function pending(record) { return record.status === "pending" || record.status === "delivering"; }
  function hasAgent(record) { const source = record.request.source; return Boolean(source?.pane_id && (source.agent_pid || source.provider || record.question_id)); }
  function pendingRecords() { return [...records.values()].filter(r => pending(r) && !r.dismissed_at).sort((a, b) => a.created_at - b.created_at); }
  function pendingCount() { return pendingRecords().length + unseenPending; }
  function addPendingPage(result) {
    const before = pendingRecords().length;
    for (const record of result.records || []) records.set(record.id, record);
    unseenPending = Math.max(0, unseenPending - (pendingRecords().length - before));
    pendingOffset = result.next_offset || pendingOffset + 50;
    if (!result.records?.length) unseenPending = 0;
  }
  function stripAnsi(text) { return String(text || "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, ""); }
  function renderAnsi(parent, raw) {
    // Match the palette in shared/util/ansi.ts, using text nodes for terminal output.
    const palette = ["#4a4a4a", "#ff6b6b", "#69db7c", "#ffd43b", "#74c0fc", "#da77f2", "#66d9e8", "#dee2e6", "#868e96", "#ff8787", "#8ce99a", "#ffe066", "#a5d8ff", "#e599f7", "#99e9f2", "#f8f9fa"];
    const color256 = n => {
      if (!Number.isInteger(n) || n < 0 || n > 255) return undefined;
      if (n < 16) return palette[n];
      if (n >= 232) { const gray = 8 + (n - 232) * 10; return `rgb(${gray},${gray},${gray})`; }
      const cube = n - 16, channel = value => value ? 55 + value * 40 : 0;
      return `rgb(${channel(Math.floor(cube / 36))},${channel(Math.floor(cube % 36 / 6))},${channel(cube % 6)})`;
    };
    // A pane capture includes unused screen rows after its last output.
    const lines = String(raw).replace(/\r\n?/g, "\n").split("\n");
    while (lines.length && !stripAnsi(lines[lines.length - 1]).trim()) lines.pop();
    const text = lines.join("\n"), fragment = document.createDocumentFragment();
    let last = 0, foreground, background, bold = false, dim = false, italic = false, underline = false, inverse = false;
    const append = value => {
      if (!value) return;
      const node = el("span", "", value);
      Object.assign(node.style, { color: inverse ? background || "#000" : foreground || "", backgroundColor: inverse ? foreground || "#dee2e6" : background || "", fontWeight: bold ? "bold" : "", opacity: dim ? ".6" : "", fontStyle: italic ? "italic" : "", textDecoration: underline ? "underline" : "" });
      fragment.append(node);
    };
    for (const match of text.matchAll(/\x1b\[([0-?]*[ -/]*)([@-~])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[ -/]*[@-~]/g)) {
      append(text.slice(last, match.index)); last = match.index + match[0].length;
      if (match[2] !== "m") continue;
      const params = (match[1] || "0").split(";");
      for (let i = 0; i < params.length; i++) {
        const parts = params[i].split(":").map(Number), code = parts[0];
        if (code === 0) { foreground = background = undefined; bold = dim = italic = underline = inverse = false; }
        else if (code === 1) bold = true;
        else if (code === 2) dim = true;
        else if (code === 3) italic = true;
        else if (code === 4) underline = true;
        else if (code === 7) inverse = true;
        else if (code === 22) bold = dim = false;
        else if (code === 23) italic = false;
        else if (code === 24) underline = false;
        else if (code === 27) inverse = false;
        else if (code === 39) foreground = undefined;
        else if (code === 49) background = undefined;
        else if (code >= 30 && code <= 37) foreground = palette[code - 30];
        else if (code >= 90 && code <= 97) foreground = palette[code - 90 + 8];
        else if (code >= 40 && code <= 47) background = palette[code - 40];
        else if (code >= 100 && code <= 107) background = palette[code - 100 + 8];
        else if (code === 38 || code === 48) {
          const colon = parts.length > 1, mode = colon ? parts[1] : Number(params[i + 1]);
          let color;
          if (mode === 5) { color = color256(colon ? parts[2] : Number(params[i + 2])); if (!colon) i += 2; }
          else if (mode === 2) {
            const rgb = colon ? parts.slice(parts.length >= 6 ? 3 : 2) : params.slice(i + 2, i + 5).map(Number);
            if (rgb.length === 3 && rgb.every(n => Number.isInteger(n) && n >= 0 && n <= 255)) color = `rgb(${rgb.join(",")})`;
            if (!colon) i += 4;
          }
          if (color) { if (code === 38) foreground = color; else background = color; }
        }
      }
    }
    append(text.slice(last)); parent.replaceChildren(fragment);
  }
  function field(request, path) {
    let value = request;
    for (const key of String(path || "body").split(".")) {
      if (!value || typeof value !== "object" || !Object.prototype.hasOwnProperty.call(value, key)) return "";
      value = value[key];
    }
    return typeof value === "string" ? value : value == null ? "" : JSON.stringify(value, null, 2);
  }
  function metaText(source) {
    return [source.provider, source.model, source.branch, source.cwd].filter(Boolean).join(" · ");
  }
  function sourceText(source = {}) {
    const provider = { codex: "Codex", claude: "Claude", hermes: "Hermes" }[source.provider] || source.provider;
    const project = source.cwd?.replace(/\/$/, "").split("/").pop();
    return [provider, project].filter(Boolean).join(" · ");
  }
  function messageText(record) {
    const body = stripAnsi(record.request.body).trim();
    if (!record.question_id) return body;
    const lines = body.split(/\r?\n/).map(line => line.trim()).filter(line => line && !/^[-─━═_]{3,}$/.test(line));
    let question = -1;
    lines.forEach((line, index) => { if (line.endsWith("?")) question = index; });
    return (question >= 0 ? lines.slice(question) : lines.slice(-6))
      .filter(line => !/^[>❯]?\s*\d+[.)]\s/.test(line)).join("\n");
  }
  function template(record) {
    return snapshot.templates?.templates?.find(t => t.id === record.request.template) || { layout: [{ type: "text", field: "body" }, { type: "media" }, { type: "reply" }, { type: "logs" }] };
  }
  function size() {
    const bounds = host.getBoundingClientRect(), hidden = host.classList.contains("empty");
    const width = hidden ? 0 : bounds.width, height = hidden ? 0 : Math.ceil(bounds.height);
    const signature = `${width}:${height}`;
    if (signature === lastSize) return;
    lastSize = signature; native({ native: "surface", width, height });
  }
  function stopAnimation() {
    layoutAnimation?.cancel(); layoutAnimation = null;
    contentAnimations.forEach(animation => animation.cancel()); contentAnimations = [];
    for (const node of host.children) node.style.width = "";
  }
  function animateLayout(before, fadeContent = true) {
    if (host.classList.contains("empty")) { size(); return; }
    const after = host.getBoundingClientRect();
    if (!reducedMotion.matches && !geometry.reduce_motion &&
        (Math.abs(before.width - after.width) > 1 || Math.abs(before.height - after.height) > 1)) {
      // Keep text at its final reading width while the surrounding shape grows.
      // Reflowing every animation frame makes the controls and output jump.
      for (const node of host.querySelectorAll(":scope > .top, :scope > .card, :scope > .queue")) {
        node.style.width = `${after.width - (placement === "notch" ? 0 : 2)}px`;
        if (fadeContent) {
          const fade = node.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 280, delay: 60, fill: "backwards" });
          fade.pause(); contentAnimations.push(fade);
        }
      }
      const opening = !before.height;
      const pillWidth = placement === "notch" ? (geometry.notch_width || 220) : 224;
      const pillHeight = placement === "notch" ? (geometry.overlap || 38) + 32 : 36;
      layoutAnimation = host.animate([
        { width: `${Math.max(before.width, Math.min(after.width, pillWidth))}px`, height: `${Math.max(before.height, Math.min(after.height, pillHeight))}px`, opacity: opening ? 0 : 1 },
        { width: `${after.width}px`, height: `${after.height}px`, opacity: 1 }
      ], { duration: 360, easing: "cubic-bezier(.22, 1, .36, 1)" });
      const animation = layoutAnimation;
      // WebKit may stop its animation timeline for a nonactivating notch panel.
      // Advance this short transition from elapsed time so it always completes.
      animation.pause();
      const started = performance.now();
      function advance() {
        if (layoutAnimation !== animation || animation.playState === "finished") return;
        animation.currentTime = Math.min(360, performance.now() - started);
        contentAnimations.forEach(fade => { fade.currentTime = animation.currentTime; });
        if (animation.currentTime >= 360) animation.finish(); else setTimeout(advance, 16);
      }
      advance();
      animation.finished.then(() => {
        if (layoutAnimation === animation) {
          layoutAnimation = null;
          contentAnimations.forEach(fade => fade.cancel()); contentAnimations = [];
          for (const node of host.children) node.style.width = "";
          if (card?._followLogs) card._content.scrollTop = card._content.scrollHeight;
          size();
        }
      }).catch(() => {});
    }
    size();
  }
  new ResizeObserver(size).observe(host);
  function stopMedia() {
    host.querySelectorAll("video").forEach(video => { video.pause(); video.removeAttribute("src"); video.load(); });
  }
  function stopContext() { clearInterval(logTimer); logTimer = null; stopMedia(); }
  function pauseTimer() {
    if (collapseTimer) { clearTimeout(collapseTimer); collapseTimer = null; remaining = Math.max(0, remaining - (performance.now() - timerStarted)); }
  }
  function resumeTimer() {
    if (expanded || queue || hovering || focused || busy || !current || collapseTimer) return;
    const record = records.get(current);
    if (record?.request.template !== "update") return;
    if (record.request.data?.event === "agent_alert" && pending(record)) return;
    timerStarted = performance.now(); collapseTimer = setTimeout(collapse, Math.max(100, remaining));
  }
  function collapse() {
    clearTimeout(completionTimer); pauseTimer(); stopContext(); expanded = false; details = false; allChoices = false; queue = false; current = null; focused = false; menu = null;
    native({ native: "text_focus", active: false }); render();
  }
  function openRecord(id) {
    if (busy) return;
    const replyFocused = card?._reply && document.activeElement === card._reply;
    clearTimeout(completionTimer); pauseTimer(); stopContext(); current = id; expanded = true; details = false; allChoices = false; queue = false; renderedId = null; menu = null;
    call({ op: "read", id }).catch(showError); render();
    if (replyFocused && card?._reply) card._reply.focus({ preventScroll: true });
  }
  async function openLatest() {
    let latest = pendingRecords().at(-1);
    if (!latest) {
      try { latest = (await call({ op: "list", offset: 0, pending_only: false })).records?.[0]; }
      catch (error) { showError(error); return; }
    }
    if (latest) { records.set(latest.id, latest); openRecord(latest.id); } else showQueue();
  }
  async function navigate(step) {
    if (busy || navigating) return;
    navigating = true;
    try {
      let items = pendingRecords(), index = items.findIndex(record => record.id === current);
      while (unseenPending > 0 && (index + step >= items.length || index + step < 0)) {
        const result = await call({ op: "list", offset: pendingOffset, pending_only: true });
        addPendingPage(result);
        items = pendingRecords(); index = items.findIndex(record => record.id === current);
      }
      if (items.length) openRecord(items[(Math.max(index, 0) + step + items.length) % items.length].id);
    } catch (error) { showError(error); }
    finally { navigating = false; }
  }
  function startContext() {
    if (!details || !current || queue || document.hidden) return;
    refreshContext();
    if (!logTimer) logTimer = setInterval(refreshContext, 1000);
  }
  function toggleDetails() {
    pauseTimer(); stopContext(); expanded = true; details = !details; menu = null; renderedId = null; render(); startContext();
  }
  function toggleMenu(next) {
    pauseTimer(); expanded = true; menu = menu === next ? null : next; render();
    if (menu === "agent") refreshContext();
  }
  function showQueue() {
    if (busy) return;
    clearTimeout(completionTimer); pauseTimer(); stopContext(); expanded = true; details = false; queue = true; current = null; renderedId = null; menu = null; selectedNotifications.clear(); queueError = ""; render();
  }
  function showError(error) {
    const message = String(error.message || error);
    if (card) card._clientError = message;
    const notice = host.querySelector(".notice"); if (notice) notice.textContent = message;
    const menuNotice = host.querySelector(".menu-notice"); if (menuNotice) menuNotice.textContent = message;
  }
  async function act(action_id, text) {
    if (busy || !current) return;
    const id = current; busy = true; if (card) card._clientError = ""; pauseTimer(); updateCard();
    const items = pendingRecords(), index = items.findIndex(record => record.id === id);
    const nextId = items.length > 1 ? items[(index + 1) % items.length].id : null;
    try {
      const value = await call({ op: "respond", id, action_id, text: text || null });
      if (value.id) records.set(value.id, value);
      if (!preview && value.status === "resolved") {
        drafts.delete(id); if (current === id && card?._reply) card._reply.value = "";
        completionTimer = setTimeout(() => {
          if (current !== id) return;
          const next = (nextId && pending(records.get(nextId) || {})) ? nextId : pendingRecords()[0]?.id;
          if (next) openRecord(next); else collapse();
        }, 700);
      }
      updateCard();
    } catch (error) { showError(error); }
    finally { busy = false; updateCard(); resumeTimer(); }
  }
  function renderBlocks(blocks, parent, record, detail, controls = {}) {
    for (const block of blocks || []) {
      const kind = block.type;
      if (["row", "column"].includes(kind)) {
        const node = el("div", kind); parent.append(node); renderBlocks(block.children, node, record, detail, controls); continue;
      }
      if (["choices", "reply", "logs", "media"].includes(kind)) { if (controls[kind] && (detail || kind === "choices")) parent.append(controls[kind]); continue; }
      if (!detail && kind !== "text") continue;
      const text = kind === "metadata" ? metaText(record.request.source || {}) : field(record.request, block.field || (kind === "text" ? "body" : `data.${kind}`));
      if (!text) continue;
      const section = el("div", "block");
      if (block.label || ["command", "diff", "plan"].includes(kind)) section.append(el("div", "block-label", block.label || kind));
      const node = el(kind === "text" || kind === "metadata" ? "div" : "pre", kind === "text" ? "body" : kind === "metadata" ? "meta" : "code");
      if (kind === "diff") {
        for (const line of text.split("\n")) node.append(el("span", `diff-line ${line.startsWith("+") ? "diff-add" : line.startsWith("-") ? "diff-remove" : ""}`, line));
      } else node.textContent = stripAnsi(text);
      section.append(node); parent.append(section);
    }
  }
  function hasBlock(layout, kind) { return (layout || []).some(b => b.type === kind || hasBlock(b.children, kind)); }
  function autoYesControl(record) {
    const row = el("div", "auto-yes"); row.append(el("span", "", "Auto-yes"));
    const control = button("", async () => {
      const pane = record.request.source.pane_id;
      if (autoYesBusy.has(pane)) return;
      autoYesBusy.add(pane); updateAutoYes();
      try {
        const value = await call({ op: "auto_yes", id: record.id });
        if (typeof value.auto_yes === "boolean") {
          const panes = new Set(snapshot.auto_yes_panes || []);
          if (value.auto_yes) panes.add(pane); else panes.delete(pane);
          snapshot.auto_yes_panes = [...panes];
        }
      } catch (error) { if (record.id === current) showError(error); }
      finally { autoYesBusy.delete(pane); updateAutoYes(); }
    }, "auto-yes-switch");
    control.setAttribute("role", "switch"); control.setAttribute("aria-label", "Auto-yes for this agent");
    control.title = "Automatically answers this agent's prompts until you turn it off";
    control.dataset.pane = record.request.source.pane_id;
    control.append(el("span", "switch-state"), el("span", "switch-track")); row.append(control);
    return row;
  }
  function updateAutoYes() {
    for (const control of host.querySelectorAll(".auto-yes-switch")) {
      const enabled = (snapshot.auto_yes_panes || []).includes(control.dataset.pane);
      control.setAttribute("aria-checked", String(enabled));
      control.querySelector(".switch-state").textContent = enabled ? "On" : "Off";
      control.disabled = autoYesBusy.has(control.dataset.pane);
    }
  }
  function createCard(record) {
    const node = el("article", "card");
    node._signature = JSON.stringify([record.request, template(record)]);
    const heading = el("div", "heading"); heading.append(el("h1", "", record.request.title));
    const status = el("span", "status"); heading.append(status); node._status = status;
    if (hasAgent(record)) {
      const options = button("…", () => toggleMenu("options"), "utility options-toggle");
      options.title = "Agent options"; options.setAttribute("aria-label", "Notification options"); options.setAttribute("aria-haspopup", "dialog"); node._options = options; heading.append(options);
    }
    node.append(heading);
    const sub = el("div", "sub", sourceText(record.request.source)); node._sub = sub; node.append(sub);
    const message = el("div", "message", messageText(record)); node.append(message);
    const layout = template(record).layout, primitives = {};
    const content = el("div", "details-content"); node._content = content;
    content.addEventListener("scroll", () => { node._followLogs = content.scrollHeight - content.scrollTop - content.clientHeight < 30; });
    if (details && hasBlock(layout, "media") && record.request.media?.length) {
      const media = el("div", "media");
      record.request.media.forEach((item, index) => {
        const element = el(item.kind === "video" ? "video" : "img");
        element.src = item.src.startsWith("/") ? `clawtab-nfn://media/${record.id}/${index}` : item.src;
        if (item.kind === "video") { element.controls = true; element.preload = "metadata"; }
        else { element.alt = item.alt || record.request.title; element.loading = "lazy"; }
        element.addEventListener("error", () => { element.replaceWith(el("div", "hint", `${item.kind === "video" ? "Video" : "Image"} unavailable`)); });
        media.append(element);
      }); primitives.media = media;
    }
    const actions = el("div", "actions"); node._actions = actions;
    const choices = record.request.actions || [];
    for (const [index, action] of choices.entries()) {
      if (!allChoices && index > 2) break;
      const control = button(action.label, () => act(action.id, drafts.get(record.id) || ""), index === 0 ? "primary" : "");
      actions.append(control);
    }
    if (choices.some(action => action.label.length > 55)) actions.classList.add("long-choices");
    node.append(actions);
    if (choices.length > 3) {
      node.append(button(allChoices ? "Fewer choices" : `More choices (${choices.length - 3})`, () => {
        pauseTimer(); expanded = true; allChoices = !allChoices; renderedId = null; render();
      }, "utility more-choices"));
    }
    if (record.request.template !== "update" && (hasBlock(layout, "reply") || record.request.source?.pane_id)) {
      const toAgent = Boolean(record.question_id || record.request.response_destination === "agent_message");
      const reply = el("div", "reply");
      const label = el("label", "reply-label", toAgent ? "Reply to agent" : "Your reply"); label.htmlFor = "notification-reply"; reply.append(label);
      const row = el("div", "reply-row");
      const input = el("textarea"); input.id = "notification-reply"; input.rows = 2;
      input.placeholder = "Message...";
      input.value = drafts.get(record.id) || "";
      input.addEventListener("pointerdown", () => native({ native: "text_focus", active: true }));
      input.addEventListener("input", () => { drafts.set(record.id, input.value); updateCard(); });
      input.addEventListener("keydown", event => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); act("reply", input.value); } });
      node._reply = input; row.append(input);
      const send = button("Send", () => act("reply", input.value), "primary send");
      send.title = "Send reply (Command + Enter)"; node._send = send; row.append(send); reply.append(row); node.append(reply);
    }
    const notice = el("div", "notice"); notice.setAttribute("role", "status"); node._notice = notice; node.append(notice);
    const utilities = el("div", "controls");
    const detailButton = button(details ? "Hide details" : (record.request.media?.length ? "View attachment" : "Details"), toggleDetails, "utility details-toggle");
    detailButton.setAttribute("aria-expanded", String(details)); utilities.append(detailButton);
    if (record.request.source?.pane_id) {
      const openAgent = button("Open agent", async () => {
        openAgent.disabled = true;
        try { await call({ op: "focus", id: record.id }); node._clientError = ""; updateCard(); }
        catch (error) { showError(error); }
        finally { openAgent.disabled = false; }
      }, "utility");
      openAgent.title = "Switch to this agent's terminal"; utilities.append(openAgent);
    } else if (record.request.source?.job_id) {
      const openJob = button("Go to job", async () => {
        openJob.disabled = true;
        try { await call({ op: "open_job", id: record.id }); }
        catch (error) { showError(error); }
        finally { openJob.disabled = false; }
      }, "utility");
      openJob.title = "Show job folder in Finder"; utilities.append(openJob);
    }
    if (details) {
      content.append(el("div", "meta", metaText(record.request.source || {})));
      if (hasBlock(layout, "logs")) { const section = el("div"); section.append(el("div", "block-label", "Recent output")); const logs = el("pre", "logs", "Loading recent output..."); node._logs = logs; section.append(logs); primitives.logs = section; }
      renderBlocks(layout, content, record, true, primitives);
      node.append(content);
    }
    node.append(utilities);
    return node;
  }
  function updateCard() {
    if (!card || !current) return;
    const record = records.get(current); if (!record) return;
    if (card._signature !== JSON.stringify([record.request, template(record)])) {
      const scroll = card._content.scrollTop, active = document.activeElement === card._reply;
      const selection = card._reply ? [card._reply.selectionStart, card._reply.selectionEnd] : null;
      stopMedia();
      const replacement = createCard(record); card.replaceWith(replacement); card = replacement;
      card._content.scrollTop = scroll;
      if (active && card._reply) { card._reply.focus({ preventScroll: true }); if (selection) card._reply.setSelectionRange(...selection); }
      startContext();
    }
    const isPending = pending(record);
    const update = record.request.template === "update";
    const alert = record.request.data?.event === "agent_alert";
    card._status.classList.toggle("alert", alert && isPending);
    card._status.textContent = record.status === "delivering" || busy ? "Sending..." : isPending ? (alert ? "! Alert" : "") : record.status === "resolved" ? (alert ? "Recovered" : update ? "Seen" : "Sent") : record.status;
    card._options?.setAttribute("aria-expanded", String(menu === "options" || menu === "agent"));
    for (const control of card._actions.querySelectorAll("button")) control.disabled = !isPending || busy || Boolean(record.question_id && drafts.get(record.id)?.trim());
    if (card._send) card._send.disabled = !isPending || busy || !card._reply.value.trim();
    if (card._reply) card._reply.readOnly = !isPending || busy;
    if (card._clientError) card._notice.textContent = card._clientError;
    else if (record.error) card._notice.textContent = record.error;
    else if (!isPending) card._notice.textContent = record.response ? (update ? "Acknowledged" : "Reply sent") : `Request ${record.status}`;
    else card._notice.textContent = "";
    updateAutoYes();
  }
  async function refreshContext() {
    if ((!details && menu !== "agent") || queue || !current || contextBusy) return;
    const id = current; contextBusy = true;
    try {
      const value = await call({ op: "context", id });
      if (id !== current || !card) return;
      const changedLogs = card._logs && card._logs._raw !== value.log;
      const before = changedLogs ? host.getBoundingClientRect() : null;
      if (changedLogs) {
        stopAnimation();
        const logs = card._logs, scroller = card._content;
        const atBottom = logs._raw == null || scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 30;
        logs._raw = value.log; renderAnsi(logs, value.log || "No output yet");
        card._followLogs = atBottom;
        if (atBottom) scroller.scrollTop = scroller.scrollHeight;
      }
      if (value.source) card._sub.textContent = sourceText(value.source);
      const agent = host.querySelector(".agent-controls");
      if (agent && agent.dataset.built !== "yes") {
        agent.replaceChildren();
        agent.dataset.built = "yes";
        if (value.source?.provider === "codex" && value.models?.length) {
          const row = el("div", "model-controls"), models = el("select"), effort = el("select"); models.setAttribute("aria-label", "Model"); effort.setAttribute("aria-label", "Reasoning effort");
          for (const model of value.models) { const option = el("option", "", model); option.value = model; models.append(option); }
          if (value.source.model) models.value = value.source.model;
          for (const level of ["low", "medium", "high", "xhigh", "max"]) { const option = el("option", "", level); option.value = level; effort.append(option); } effort.value = "high";
          row.append(models, effort, button("Set model", async () => { try { await call({ op: "model", id, model: models.value, effort: effort.value }); } catch (error) { showError(error); } })); agent.append(row);
        }
        buildPlugins(agent, value.plugins || [], value.models || [], id);
        if (!agent.childElementCount) agent.append(el("div", "meta", "No controls available"));
      }
      if (before) animateLayout(before, false);
    } catch (error) { if (id === current) { if (card?._logs) card._logs.textContent = String(error.message || error); showError(error); } }
    finally { contextBusy = false; }
  }
  function buildPlugins(parent, plugins, models, id) {
    if (!plugins.length) return;
    const group = el("div", "plugin-controls"), select = el("select"), fields = el("div", "plugin-fields");
    select.setAttribute("aria-label", "Agent action");
    for (const plugin of plugins) { const option = el("option", "", plugin.title); option.value = plugin.id; option.disabled = !plugin.available; select.append(option); }
    const inputs = new Map();
    function renderFields() {
      fields.replaceChildren(); inputs.clear(); const plugin = plugins.find(p => p.id === select.value); if (!plugin) return;
      for (const parameter of plugin.parameters || []) {
        const label = el("label", "", parameter.title);
        const options = parameter.options?.length ? parameter.options : parameter.kind === "model" ? models : parameter.kind === "effort" ? ["low", "medium", "high", "xhigh", "max"] : parameter.kind === "boolean" ? ["false", "true"] : [];
        const input = el(options.length ? "select" : "input");
        for (const option of options) { const element = el("option", "", option); element.value = option; input.append(element); }
        if (parameter.default_value) input.value = parameter.default_value;
        input.addEventListener("pointerdown", () => native({ native: "text_focus", active: true }));
        inputs.set(parameter.name, input); label.append(input); fields.append(label);
      }
    }
    select.addEventListener("change", renderFields); renderFields();
    group.append(select, fields, button("Run action", async () => {
      const parameters = Object.fromEntries([...inputs].map(([key, input]) => [key, input.value]));
      try { const value = await call({ op: "plugin", id, action_id: select.value, parameters }); if (card?._notice) card._notice.textContent = value.run?.progress || "Action started"; } catch (error) { showError(error); }
    })); parent.append(group);
  }
  async function selectAllNotifications(checked) {
    if (bulkBusy) return;
    selectedNotifications.clear();
    if (!checked) { render(); return; }
    bulkBusy = true; queueError = ""; render();
    try {
      while (unseenPending > 0) addPendingPage(await call({ op: "list", offset: pendingOffset, pending_only: true }));
      for (const record of pendingRecords()) selectedNotifications.add(record.id);
    } catch (error) { queueError = String(error.message || error); }
    finally { bulkBusy = false; render(); }
  }
  async function dismissNotifications(ids) {
    if (bulkBusy || !ids.length) return;
    bulkBusy = true; queueError = ""; render();
    try {
      const result = await call({ op: "dismiss_many", ids });
      for (const record of result.records || []) { records.set(record.id, record); selectedNotifications.delete(record.id); }
      pendingOffset = pendingRecords().length;
      historyItems = []; historyOffset = 0;
    } catch (error) { queueError = String(error.message || error); }
    finally { bulkBusy = false; render(); }
  }
  function renderQueue() {
    const list = el("div", "queue");
    const items = history ? historyItems : pendingRecords();
    const segments = el("div", "segments"); segments.setAttribute("role", "tablist"); segments.setAttribute("aria-label", "Notifications");
    for (const [label, isHistory] of [["Pending", false], ["History", true]]) {
      const tab = button(label, () => {
        if (history === isHistory) return;
        history = isHistory; selectedNotifications.clear(); queueError = ""; render();
        if (history && !historyItems.length) loadHistory();
      });
      tab.setAttribute("role", "tab"); tab.setAttribute("aria-selected", String(history === isHistory)); segments.append(tab);
    }
    list.append(segments);
    if (!history && items.length) {
      const toolbar = el("div", "queue-selection");
      const label = el("label"); const selectAll = el("input"); selectAll.type = "checkbox"; selectAll.setAttribute("aria-label", "Select all notifications");
      selectAll.checked = unseenPending === 0 && items.every(record => selectedNotifications.has(record.id));
      selectAll.indeterminate = selectedNotifications.size > 0 && !selectAll.checked; selectAll.disabled = bulkBusy;
      selectAll.addEventListener("change", () => selectAllNotifications(selectAll.checked));
      label.append(selectAll, el("span", "", bulkBusy ? "Updating..." : "Select all")); toolbar.append(label);
      if (selectedNotifications.size) {
        const dismiss = button(`Dismiss (${selectedNotifications.size})`, () => dismissNotifications([...selectedNotifications]), "utility dismiss-selected");
        dismiss.disabled = bulkBusy; toolbar.append(dismiss);
      }
      list.append(toolbar);
    }
    if (queueError) { const notice = el("div", "notice", queueError); notice.setAttribute("role", "status"); list.append(notice); }
    for (const record of items) {
      const row = el("div", "queue-row");
      if (!history) {
        const checkbox = el("input"); checkbox.type = "checkbox"; checkbox.checked = selectedNotifications.has(record.id); checkbox.disabled = bulkBusy;
        checkbox.setAttribute("aria-label", `Select ${record.request.title}`);
        checkbox.addEventListener("change", () => { if (checkbox.checked) selectedNotifications.add(record.id); else selectedNotifications.delete(record.id); render(); }); row.append(checkbox);
      }
      const item = button("", () => { records.set(record.id, record); openRecord(record.id); }, `queue-item ${record.read_at ? "" : "unread"}`);
      item.append(el("strong", "", record.request.title), el("div", "meta", sourceText(record.request.source))); row.append(item);
      if (!history) {
        const dismiss = iconButton(`Dismiss ${record.request.title}`, "M6 6l12 12M18 6L6 18", () => dismissNotifications([record.id]), "dismiss-item");
        dismiss.disabled = bulkBusy; row.append(dismiss);
      }
      list.append(row);
    }
    if (!items.length) list.append(el("div", "empty-state", loadingQueue ? "Loading..." : history ? "No notification history" : "No pending requests"));
    if ((history && hasMoreHistory) || (!history && unseenPending > 0)) list.append(button(loadingQueue ? "Loading..." : "Load more", loadHistory, "utility"));
    return list;
  }
  async function loadHistory() {
    if (loadingQueue) return;
    loadingQueue = true; render();
    try {
      const isHistory = history;
      const result = await call({ op: "list", offset: isHistory ? historyOffset : pendingOffset, pending_only: !isHistory });
      if (isHistory) { historyItems.push(...(result.records || [])); historyOffset = result.next_offset || historyOffset + 50; hasMoreHistory = result.records?.length === 50; }
      else addPendingPage(result);
    } catch (error) { showError(error); }
    finally { loadingQueue = false; render(); }
  }
  function renderMenu() {
    const existing = host.querySelector(".menu-overlay");
    if (!menu || (!current && menu !== "settings")) { existing?.remove(); return; }
    if (existing?.dataset.menu === menu && existing.dataset.id === (current || "")) return;
    existing?.remove();
    const record = records.get(current), overlay = el("div", "menu-overlay");
    overlay.dataset.menu = menu; overlay.dataset.id = current || "";
    const panel = el("div", "menu-panel"); panel.setAttribute("role", "dialog"); panel.setAttribute("aria-label", menu === "agent" ? "Agent controls" : menu === "settings" ? "Notification settings menu" : "Notification options");
    const heading = el("div", "menu-heading");
    if (menu === "agent") { const back = button("‹", () => toggleMenu("options"), "utility nav-step"); back.setAttribute("aria-label", "Back to options"); heading.append(back); }
    heading.append(el("span", "", menu === "agent" ? "Agent controls" : menu === "settings" ? "Notifications" : "Options"));
    const close = button("×", () => toggleMenu(menu), "utility close"); close.setAttribute("aria-label", "Close menu"); heading.append(close); panel.append(heading);
    if (menu === "options") {
      if (hasAgent(record)) {
        panel.append(autoYesControl(record));
        const controls = button("Agent controls", () => toggleMenu("agent"), "utility menu-link");
        controls.setAttribute("aria-haspopup", "dialog"); panel.append(controls);
      }
      const dismiss = button("Dismiss notification", async () => {
        try { await call({ op: "dismiss", id: record.id }); collapse(); } catch (error) { showError(error); }
      }, "utility dismiss"); dismiss.title = "Remove this card from Pending"; panel.append(dismiss);
    } else if (menu === "agent") panel.append(el("div", "agent-controls", "Loading..."));
    if (menu !== "agent") panel.append(button("Notification settings...", async () => {
      try { await call({ op: "settings" }); menu = null; native({ native: "text_focus", active: false }); render(); }
      catch (error) { showError(error); }
    }, "utility menu-link"));
    const notice = el("div", "notice menu-notice"); notice.setAttribute("role", "status"); panel.append(notice);
    overlay.append(panel); overlay.addEventListener("click", event => { if (event.target === overlay) toggleMenu(menu); }); host.append(overlay);
    updateAutoYes();
  }
  function render() {
    const before = host.getBoundingClientRect();
    const signature = JSON.stringify([current, expanded, details, allChoices, queue, history, menu, geometry, snapshot.visible, records.get(current)?.request]);
    const continuingAnimation = layoutAnimation && signature === renderedLayout;
    if (!continuingAnimation) stopAnimation();
    renderedLayout = signature;
    const count = pendingCount();
    if (!preview && (!snapshot.visible || (!current && !queue && !count))) { host.className = "empty"; host.replaceChildren(); renderedId = null; card = null; stopContext(); size(); return; }
    host.className = `${placement} ${expanded ? "expanded" : !current ? "pill" : ""} ${details ? "details-open" : ""} ${menu === "settings" && !current && !queue ? "settings-menu-open" : ""}`;
    let top = host.querySelector(".top");
    if (!top) {
      top = el("div", "top"); host.prepend(top);
      top.addEventListener("contextmenu", event => { event.preventDefault(); toggleMenu("settings"); });
    }
    const items = pendingRecords(), index = items.findIndex(record => record.id === current);
    const topSignature = JSON.stringify([count, index, queue, current, expanded, menu]);
    if (top.dataset.signature !== topSignature) {
      top.dataset.signature = topSignature; top.replaceChildren();
      const isOpen = Boolean(current || queue || expanded);
      const toggle = button("", () => isOpen ? collapse() : openLatest(), "bar-toggle");
      toggle.setAttribute("aria-label", isOpen ? "Collapse notifications" : "Expand notifications"); toggle.setAttribute("aria-expanded", String(isOpen));
      toggle.title = `${isOpen ? "Collapse" : "Open"} notifications. Right-click for settings.`; top.append(toggle);
      const latest = button("", openLatest, "utility brand icon-button"); latest.title = "Latest notification"; latest.setAttribute("aria-label", "Latest notification");
      const logo = el("img"); logo.src = "https://cdn.clawtab.cc/assets/app-icon.png"; logo.alt = ""; latest.append(logo); top.append(latest);
      const controls = el("div", "top-actions");
      if (current && count > 1) controls.append(iconButton("Previous notification", "M14 6l-6 6 6 6", () => navigate(-1), "nav-step"));
      controls.append(el("span", "count", current && index >= 0 ? `${index + 1} / ${count}` : `${count} pending`));
      if (current && count > 1) controls.append(iconButton("Next notification", "M10 6l6 6-6 6", () => navigate(1), "nav-step"));
      top.append(controls);
      const list = iconButton("Notification list", "M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01", showQueue, "list-toggle");
      list.setAttribute("aria-pressed", String(queue)); top.append(list);
    }
    if (queue) {
      const scroll = host.querySelector(".queue")?.scrollTop || 0;
      host.querySelector(".card")?.remove(); host.querySelector(".queue")?.remove();
      const list = renderQueue(); host.append(list); list.scrollTop = scroll; card = null; renderedId = null;
    } else if (current && records.has(current)) {
      host.querySelector(".queue")?.remove();
      if (renderedId !== `${current}:${expanded}`) {
        host.querySelector(".card")?.remove(); card = createCard(records.get(current)); host.append(card); renderedId = `${current}:${expanded}`;
      }
      updateCard();
    } else { host.querySelector(".card")?.remove(); host.querySelector(".queue")?.remove(); renderedId = null; card = null; }
    renderMenu(); if (!continuingAnimation) animateLayout(before);
  }
  function receive(value) {
    if (value.type === "response") {
      const promise = promises.get(String(value.token)); if (!promise) return;
      clearTimeout(promise.timer); promises.delete(String(value.token));
      if (value.error) promise.reject(new Error(value.error)); else promise.resolve(value.value); return;
    }
    if (value.type === "show") { showQueue(); return; }
    if (value.type !== "snapshot") return;
    snapshot = value; preview = Boolean(value.preview);
    const incoming = new Set();
    for (const record of value.records || []) { records.set(record.id, record); incoming.add(record.id); }
    for (const id of records.keys()) if (id !== current && !incoming.has(id) && !selectedNotifications.has(id)) records.delete(id);
    unseenPending = Math.max(0, (value.pending_count || 0) - pendingRecords().length);
    pendingOffset = 50;
    if (current && !incoming.has(current) && !preview) {
      const id = current;
      call({ op: "get", id }).then(record => { records.set(id, record); if (id === current) updateCard(); }).catch(showError);
    }
    if (value.arrival && records.has(value.arrival) && !current && !queue && !expanded && !hovering && !focused && !busy) {
      pauseTimer(); current = value.arrival; remaining = (value.settings?.preview_seconds || 8) * 1000; renderedId = null;
    }
    render(); resumeTimer();
    if (value.visible) startContext();
  }
  host.addEventListener("mouseenter", () => { hovering = true; pauseTimer(); if (snapshot.settings?.hover_expand && current && !expanded) openRecord(current); });
  host.addEventListener("mouseleave", () => { hovering = false; resumeTimer(); });
  document.addEventListener("pointerdown", event => { if (event.target.closest("input,textarea,select")) native({ native: "text_focus", active: true }); });
  document.addEventListener("focusin", event => { if (event.target.matches("input,textarea,select")) { focused = true; pauseTimer(); } });
  document.addEventListener("focusout", () => requestAnimationFrame(() => {
    focused = Boolean(document.activeElement?.matches("input,textarea,select"));
    if (!focused) { native({ native: "text_focus", active: false }); resumeTimer(); }
  }));
  document.addEventListener("keydown", event => {
    if (event.key === "Escape") { event.preventDefault(); if (menu) toggleMenu(menu); else collapse(); }
    if ((event.metaKey || event.ctrlKey) && event.shiftKey && ["[", "]", "{", "}"].includes(event.key)) {
      event.preventDefault(); navigate(event.key === "[" || event.key === "{" ? -1 : 1);
    }
  });
  window.addEventListener("message", event => { if (event.source === window.parent) receive(event.data || {}); });
  document.addEventListener("visibilitychange", () => { if (document.hidden) stopContext(); else startContext(); });
  window.nfn = { receive, collapse, outsideClick() {
    const request = records.get(current)?.request;
    if (!expanded && request?.template === "update" && request.data?.event !== "agent_alert") collapse();
  }, setPlacement(value) {
    const next = typeof value === "string" ? { placement: value } : value;
    if (JSON.stringify(next) === JSON.stringify(geometry)) return;
    geometry = next; placement = next.placement;
    document.body.style.justifyContent = placement === "notch" ? "center" : "flex-end";
    for (const [key, property] of [["overlap", "--notch-overlap"], ["notch_width", "--notch-width"], ["max_width", "--surface-max-width"], ["max_height", "--surface-max-height"]]) {
      if (Number.isFinite(next[key])) host.style.setProperty(property, `${next[key]}px`);
    }
    render();
  } };
  host.className = "empty";
  native({ preview_ready: true });
})();
