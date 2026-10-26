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
  let geometry = {}, layoutAnimation = null, animationBounds = null, lastSize = "";
  const autoYesBusy = new Set();
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
  function pending(record) { return record.status === "pending" || record.status === "delivering"; }
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
    const bounds = animationBounds || host.getBoundingClientRect(), hidden = host.classList.contains("empty");
    const width = hidden ? 0 : bounds.width, height = hidden ? 0 : Math.ceil(bounds.height);
    const signature = `${width}:${height}`;
    if (signature === lastSize) return;
    lastSize = signature; native({ native: "surface", width, height });
  }
  function animateLayout(before) {
    layoutAnimation?.cancel(); layoutAnimation = null; animationBounds = null;
    if (host.classList.contains("empty")) { size(); return; }
    const after = host.getBoundingClientRect();
    if (!reducedMotion.matches && !geometry.reduce_motion &&
        (Math.abs(before.width - after.width) > 1 || Math.abs(before.height - after.height) > 1)) {
      // Keep one transparent native viewport around both sizes while the shape animates.
      // Shrinking the viewport on every frame can stall WebKit underneath the notch.
      animationBounds = { width: Math.max(before.width, after.width), height: Math.max(before.height, after.height) };
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
        if (animation.currentTime >= 360) animation.finish(); else setTimeout(advance, 16);
      }
      advance();
      animation.finished.then(() => { if (layoutAnimation === animation) { layoutAnimation = null; animationBounds = null; size(); } }).catch(() => {});
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
    clearTimeout(completionTimer); pauseTimer(); stopContext(); expanded = true; details = false; queue = true; current = null; renderedId = null; menu = null; render();
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
    const status = el("span", "status"); heading.append(status); node._status = status; node.append(heading);
    const sub = el("div", "sub", sourceText(record.request.source)); node._sub = sub; node.append(sub);
    const message = el("div", "message", messageText(record)); node.append(message);
    const layout = template(record).layout, primitives = {};
    const content = el("div", "details-content"); node._content = content;
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
      const agentButton = button("Agent controls", () => toggleMenu("agent"), "utility agent-toggle");
      agentButton.setAttribute("aria-expanded", String(menu === "agent")); agentButton.setAttribute("aria-haspopup", "dialog");
      utilities.append(agentButton);
      const openAgent = button("Open agent", async () => {
        openAgent.disabled = true;
        try { await call({ op: "focus", id: record.id }); node._clientError = ""; updateCard(); }
        catch (error) { showError(error); }
        finally { openAgent.disabled = false; }
      }, "utility");
      openAgent.title = "Switch to this agent's terminal"; utilities.append(openAgent);
    }
    node.append(utilities);
    if (details) {
      content.append(el("div", "meta", metaText(record.request.source || {})));
      if (hasBlock(layout, "logs")) { const section = el("div"); section.append(el("div", "block-label", "Recent output")); const logs = el("pre", "logs", "Loading recent output..."); node._logs = logs; section.append(logs); primitives.logs = section; }
      renderBlocks(layout, content, record, true, primitives);
      node.append(content);
    }
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
    card._status.textContent = record.status === "delivering" || busy ? "Sending..." : isPending ? (alert ? "! Alert" : update ? "Update" : "") : record.status === "resolved" ? (alert ? "Recovered" : update ? "Seen" : "Sent") : record.status;
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
      if (card._logs && card._logs.textContent !== stripAnsi(value.log)) {
        const logs = card._logs, atBottom = logs.scrollHeight - logs.scrollTop - logs.clientHeight < 30;
        logs.textContent = stripAnsi(value.log) || "No output yet"; if (atBottom) logs.scrollTop = logs.scrollHeight;
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
  function renderQueue() {
    const list = el("div", "queue");
    const items = history ? historyItems : pendingRecords();
    const segments = el("div", "segments"); segments.setAttribute("role", "tablist"); segments.setAttribute("aria-label", "Notifications");
    for (const [label, isHistory] of [["Pending", false], ["History", true]]) {
      const tab = button(label, () => {
        if (history === isHistory) return;
        history = isHistory; render();
        if (history && !historyItems.length) loadHistory();
      });
      tab.setAttribute("role", "tab"); tab.setAttribute("aria-selected", String(history === isHistory)); segments.append(tab);
    }
    list.append(segments);
    for (const record of items) {
      const item = button("", () => { records.set(record.id, record); openRecord(record.id); }, `queue-item ${record.read_at ? "" : "unread"}`);
      item.append(el("strong", "", record.request.title), el("div", "meta", sourceText(record.request.source))); list.append(item);
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
    if (!menu || !current) { existing?.remove(); return; }
    if (existing?.dataset.menu === menu && existing.dataset.id === current) return;
    existing?.remove();
    const record = records.get(current), overlay = el("div", "menu-overlay");
    overlay.dataset.menu = menu; overlay.dataset.id = current;
    const panel = el("div", "menu-panel"); panel.setAttribute("role", "dialog"); panel.setAttribute("aria-label", menu === "agent" ? "Agent controls" : "Notification options");
    const heading = el("div", "menu-heading"); heading.append(el("span", "", menu === "agent" ? "Agent controls" : "Options"));
    const close = button("×", () => toggleMenu(menu), "utility close"); close.setAttribute("aria-label", "Close menu"); heading.append(close); panel.append(heading);
    if (menu === "options") {
      if (record.request.source?.pane_id) panel.append(autoYesControl(record));
      const dismiss = button("Dismiss notification", async () => {
        try { await call({ op: "dismiss", id: record.id }); collapse(); } catch (error) { showError(error); }
      }, "utility dismiss"); dismiss.title = "Remove this card from Pending"; panel.append(dismiss);
    } else panel.append(el("div", "agent-controls", "Loading..."));
    const notice = el("div", "notice menu-notice"); notice.setAttribute("role", "status"); panel.append(notice);
    overlay.append(panel); overlay.addEventListener("click", event => { if (event.target === overlay) toggleMenu(menu); }); host.append(overlay);
    updateAutoYes();
  }
  function render() {
    const before = host.getBoundingClientRect();
    layoutAnimation?.cancel(); layoutAnimation = null; animationBounds = null;
    const count = pendingCount();
    if (!preview && (!snapshot.visible || (!current && !queue && !count))) { host.className = "empty"; host.replaceChildren(); renderedId = null; card = null; stopContext(); size(); return; }
    host.className = `${placement} ${expanded ? "expanded" : !current ? "pill" : ""} ${details ? "details-open" : ""}`;
    let top = host.querySelector(".top");
    if (!top) { top = el("div", "top"); host.prepend(top); }
    const items = pendingRecords(), index = items.findIndex(record => record.id === current);
    const topSignature = JSON.stringify([count, index, queue, current, expanded, menu]);
    if (top.dataset.signature !== topSignature) {
      top.dataset.signature = topSignature; top.replaceChildren();
      const openFirst = () => { const first = pendingRecords()[0]; if (first) openRecord(first.id); else showQueue(); };
      top.append(button("Notifications", current || queue ? showQueue : openFirst, "utility brand"));
      const controls = el("div", "top-actions");
      if (current && count > 1) {
        const previous = button("‹", () => navigate(-1), "utility nav-step");
        previous.setAttribute("aria-label", "Previous notification"); previous.title = "Previous notification (Command + Shift + [)";
        controls.append(previous);
      }
      const counter = button(current && index >= 0 ? `${index + 1} / ${count}` : `${count} pending`, current || queue ? showQueue : openFirst, "utility count");
      counter.setAttribute("aria-label", "All notifications"); controls.append(counter);
      if (current && count > 1) {
        const next = button("›", () => navigate(1), "utility nav-step");
        next.setAttribute("aria-label", "Next notification"); next.title = "Next notification (Command + Shift + ])";
        controls.append(next);
      }
      if (current) {
        const options = button("…", () => toggleMenu("options"), "utility options-toggle");
        options.title = "Options"; options.setAttribute("aria-label", "Notification options"); options.setAttribute("aria-haspopup", "dialog"); options.setAttribute("aria-expanded", String(menu === "options")); controls.append(options);
      }
      if (current || queue) {
        const close = button("×", collapse, "utility close"); close.setAttribute("aria-label", "Close notifications"); close.title = "Close"; controls.append(close);
      }
      top.append(controls);
    }
    if (queue) {
      host.querySelector(".card")?.remove(); host.querySelector(".queue")?.remove(); host.append(renderQueue()); card = null; renderedId = null;
    } else if (current && records.has(current)) {
      host.querySelector(".queue")?.remove();
      if (renderedId !== `${current}:${expanded}`) {
        host.querySelector(".card")?.remove(); card = createCard(records.get(current)); host.append(card); renderedId = `${current}:${expanded}`;
      }
      updateCard();
    } else { host.querySelector(".card")?.remove(); host.querySelector(".queue")?.remove(); renderedId = null; card = null; }
    const agentButton = card?.querySelector(".agent-toggle"); agentButton?.setAttribute("aria-expanded", String(menu === "agent"));
    renderMenu(); animateLayout(before);
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
    for (const id of records.keys()) if (id !== current && !incoming.has(id)) records.delete(id);
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
