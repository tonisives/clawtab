/* Shared by the daemon's WKWebView and the settings preview iframe. */
(() => {
  "use strict";
  const host = document.getElementById("surface");
  const records = new Map(), drafts = new Map(), promises = new Map();
  const replyStates = new Map();
  // Submitted cards stay out of this pass until the daemon confirms their state.
  const actionsInProgress = new Map(), actionErrors = new Map(), retryIds = new Set();
  let reviewVersion = 0;
  let snapshot = {}, current = null, expanded = false, details = false, queue = false, history = false, preview = false;
  let renderedId = null, card = null, logTimer = null, collapseTimer = null, remaining = 8000, timerStarted = 0;
  let hovering = false, focused = false, contextRequest = null, serial = 0, placement = "right";
  let historyOffset = 0, historyItems = [], pendingOffset = 50, hasMoreHistory = false, loadingQueue = false;
  let completionTimer = null, navigating = false, unseenPending = 0;
  let menu = null;
  let queueReturnId = null;
  let settingsOpen = false, settingsBusy = false, settingsReturnExpanded = false;
  let explicitOpen = false, presented = false, hiddenByUser = false;
  let geometry = {}, layoutAnimation = null, contentAnimations = [], lastSize = "", renderedLayout = "";
  const autoYesBusy = new Set();
  const remoteMedia = new Map();
  const selectedNotifications = new Set();
  let bulkBusy = false, queueError = "";
  let ignoredOpen = false, ignoredAgents = [], ignoredBusy = false;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let arrivalAnimations = [], arrivalTimer = null, lastArrivalId = null;

  function stopArrivalAnimation() {
    clearTimeout(arrivalTimer); arrivalTimer = null;
    arrivalAnimations.forEach(animation => animation.cancel()); arrivalAnimations = [];
  }
  function animateArrival() {
    stopArrivalAnimation();
    if (reducedMotion.matches || geometry.reduce_motion || host.classList.contains("empty")) return;
    for (const path of host.querySelectorAll(".brand .claw-slash path")) {
      const animation = path.animate([
        { strokeDashoffset: 1, opacity: 0, offset: 0 },
        { strokeDashoffset: 1, opacity: 1, offset: .08 },
        { strokeDashoffset: 0, opacity: 1, offset: .65 },
        { strokeDashoffset: 0, opacity: 0, offset: 1 }
      ], { duration: 200, easing: "ease-out" });
      animation.pause(); arrivalAnimations.push(animation);
    }
    // The passive WKWebView can suspend its animation timeline; drive the slash
    // from elapsed time just like the surface resize.
    const started = performance.now();
    function advance() {
      const elapsed = Math.min(200, performance.now() - started);
      arrivalAnimations.forEach(animation => { animation.currentTime = elapsed; });
      if (elapsed >= 200) stopArrivalAnimation(); else arrivalTimer = setTimeout(advance, 16);
    }
    advance();
  }
  reducedMotion.addEventListener("change", () => { if (reducedMotion.matches) stopArrivalAnimation(); });

  let todosOpen = false, todoData = { items: [] }, todoError = "", todoBusy = false, todoOptionsOpen = false;
  const todoDraft = { text: "", group: "", cwd: "", note: null, agents: null };
  function todoItems() { return todoData.items || []; }
  function toggleTodos() {
    if (todosOpen) { todosOpen = false; collapse(true); return; }
    leaveSettings(); pauseTimer(); stopContext();
    todosOpen = true; hiddenByUser = false; explicitOpen = true; expanded = true;
    queue = false; current = null; details = false; menu = null;
    native({ native: "presentation", active: true }); render();
    if (!preview) call({ op: "todos" }).then(value => { todoData = value; render(); }).catch(error => { todoError = error.message; render(); });
  }
  async function todoAction(command) {
    if (todoBusy) return;
    todoBusy = true; todoError = ""; render();
    try {
      const result = await call(command);
      if (result.items) todoData = result;
      if (command.op === "todo_add") todoDraft.text = "";
    } catch (error) { todoError = String(error.message || error); }
    finally { todoBusy = false; render(); }
  }
  function todoInput(label, key, placeholder) {
    if (todoDraft[key] == null) todoDraft[key] = todoData[key] || "";
    const input = el("input"); input.value = todoDraft[key]; input.placeholder = placeholder;
    input.setAttribute("aria-label", label);
    input.addEventListener("input", () => { todoDraft[key] = input.value; });
    return input;
  }
  function renderTodos() {
    let view = host.querySelector(".todo-view");
    const signature = JSON.stringify([todoData, todoBusy, todoError]);
    if (view?._signature === signature) return view;
    const scroll = view?.querySelector(".todo-items")?.scrollTop || 0;
    const focusedKey = document.activeElement?.getAttribute("aria-label"), selection = document.activeElement?.selectionStart;
    view?.remove(); view = el("section", "todo-view"); view._signature = signature;
    view.setAttribute("aria-label", "Tasks");
    const items = todoItems(), done = items.filter(item => item.checked).length;
    const heading = el("div", "todo-heading");
    heading.append(el("h1", "", "Tasks"), el("span", "hint", `${done} / ${items.length} complete`)); view.append(heading);
    if (todoData.linked) {
      const source = el("div", "hint todo-source", `Synced with ${todoData.note}`); source.title = todoData.note; view.append(source);
    }
    const notice = el("div", "notice", todoError || todoData.error); notice.setAttribute("role", "status"); view.append(notice);
    const list = el("div", "todo-items");
    let group = null;
    const stateNames = { working: "Working", started: "Agent started", done: "Agent finished · awaiting review", blocked: "Blocked" };
    for (const item of items) {
      if (item.group !== group) {
        group = item.group;
        const groupItems = items.filter(task => task.group === group);
        list.append(el("h2", "todo-group", `${group} · ${groupItems.filter(task => task.checked).length}/${groupItems.length}`));
      }
      const row = el("div", `todo-row ${item.checked ? "complete" : ""}`);
      row.style.paddingLeft = `${12 + Math.min(item.depth, 4) * 14}px`;
      const checkbox = el("input"); checkbox.type = "checkbox"; checkbox.checked = item.checked;
      checkbox.disabled = todoBusy; checkbox.setAttribute("aria-label", `Complete ${item.text}`);
      checkbox.addEventListener("change", () => todoAction({ op: "todo_update", id: item.id, checked: checkbox.checked }));
      const body = el("div", "todo-body"); body.append(el("div", "todo-title", item.text));
      const agent = item.agent;
      if (agent) {
        body.append(el("div", `todo-state ${agent.state || ""}`, item.checked ? "Complete" : stateNames[agent.state] || "Agent linked"));
        if (agent.summary || agent.blocker) body.append(el("div", "hint todo-summary", agent.blocker || agent.summary));
      }
      row.append(checkbox, body);
      if (agent?.pane) {
        const open = button("Open agent", () => todoAction({ op: "todo_focus", id: item.id }), "utility todo-agent"); open.disabled = todoBusy; row.append(open);
      } else if (!item.checked) {
        const start = button("Start agent", () => {
          if (!todoDraft.cwd.trim()) { todoOptionsOpen = true; todoError = "Enter the agent working directory below first"; render(); return; }
          todoAction({ op: "todo_start", id: item.id, cwd: todoDraft.cwd });
        }, "utility todo-agent"); start.disabled = todoBusy; row.append(start);
      }
      list.append(row);
    }
    if (!items.length) list.append(el("p", "hint", "Add a task or link a Markdown checklist below."));
    view.append(list);
    const form = el("form", "todo-add");
    const text = todoInput("New task", "text", "Add a task"); text.required = true;
    const groupInput = todoInput("Task group", "group", "ClawTab group / tmux session"); groupInput.required = true; groupInput.setAttribute("list", "todo-groups");
    const groups = el("datalist"); groups.id = "todo-groups";
    for (const name of new Set(items.map(item => item.group))) { const option = el("option"); option.value = name; groups.append(option); }
    const add = button(todoBusy ? "Saving..." : "Add task", () => {}, "primary"); add.type = "submit"; add.disabled = todoBusy;
    form.append(text, groupInput, groups, add);
    form.addEventListener("submit", event => { event.preventDefault(); todoAction({ op: "todo_add", text: todoDraft.text, group: todoDraft.group }); });
    view.append(form);
    const options = el("details", "todo-options"); options.open = todoOptionsOpen; options.addEventListener("toggle", () => { todoOptionsOpen = options.open; }); options.append(el("summary", "hint", "Source and agent settings"));
    options.append(el("label", "hint", "Working directory for new Codex agents"), todoInput("Agent working directory", "cwd", "/path/to/project"));
    options.append(el("p", "hint", "Start agent opens a tmux window in the task's group using Codex Sol 6.1 with high reasoning."));
    if (!snapshot.remote) {
      options.append(todoInput("Markdown source path", "note", todoData.note || "/path/to/tasks.md"), todoInput("Agent mapping path", "agents", "Optional /path/to/agents.json"));
      const link = button("Link Markdown checklist", () => todoAction({ op: "todo_link", note: todoDraft.note || "", agents: todoDraft.agents || null })); link.disabled = todoBusy; options.append(link);
    }
    view.append(options);
    view._restoreFocus = () => {
      list.scrollTop = scroll;
      if (focusedKey) {
        const input = [...view.querySelectorAll("input")].find(input => input.getAttribute("aria-label") === focusedKey);
        if (input && !input.disabled) { input.focus({ preventScroll: true }); if (input.type !== "checkbox" && selection != null) input.setSelectionRange(selection, selection); }
      }
    };
    return view;
  }
  function updateTodoRing(top) {
    let control = top.querySelector(".todo-toggle");
    if (!control) { control = button("", toggleTodos, "utility todo-toggle"); top.append(control); }
    const items = todoItems(), done = items.filter(item => item.checked).length;
    control.setAttribute("aria-label", `Tasks: ${done} of ${items.length} complete`);
    control.setAttribute("aria-pressed", String(todosOpen)); control.title = "Tasks";
    control.replaceChildren();
    const ring = el("span", "todo-ring"); ring.style.setProperty("--todo-progress", `${items.length ? done / items.length * 360 : 0}deg`);
    ring.append(el("span", "", String(items.length - done))); control.append(ring);
  }

  function native(value) {
    if (window.webkit?.messageHandlers?.nfn) window.webkit.messageHandlers.nfn.postMessage(value);
    else if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify({ nfn: value }));
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
  function pendingRecords(includeActions = false) { return [...records.values()].filter(r => pending(r) && !r.dismissed_at && !r.ignored && (includeActions || !actionsInProgress.has(r.id))).sort((a, b) => a.created_at - b.created_at); }
  function agentKey(record) {
    const source = record.request.source || {};
    if (!source.pane_id && !(source.job_id && source.run_id)) return null;
    return JSON.stringify([record.machine_id, source.pane_id, source.session_id, source.agent_pid,
      source.agent_started_at, source.job_id, source.run_id]);
  }
  function messageOrder(a, b) { return a.created_at - b.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0); }
  function pendingCards() {
    const agents = new Map();
    for (const record of pendingRecords().sort(messageOrder)) agents.set(agentKey(record) || record.id, record);
    return [...agents.values()].sort(messageOrder);
  }
  function cardMessages(record) {
    const key = agentKey(record);
    return [...records.values()].filter(item => item.id === record.id || (key && agentKey(item) === key
      && pending(item) && !item.dismissed_at && !item.ignored && messageOrder(item, record) < 0)).sort(messageOrder);
  }
  function cardSignature(record) { return JSON.stringify([cardMessages(record).map(item => [item.id, item.request]), template(record)]); }
  function pendingCount() { return pendingCards().length + unseenPending; }
  function addPendingPage(result) {
    const before = pendingRecords(true).length;
    for (const record of result.records || []) records.set(record.id, record);
    unseenPending = Math.max(0, unseenPending - (pendingRecords(true).length - before));
    pendingOffset = result.next_offset || pendingOffset + 50;
    if ((result.records?.length || 0) < 50) unseenPending = 0;
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
  function sourceHeading(record) {
    const source = record.request.source || {};
    const clean = value => typeof value === "string" ? stripAnsi(value).trim() : "";
    const group = source.group == null ? clean(source.cwd?.replace(/\/$/, "").split("/").pop()) : clean(source.group);
    const title = [source.agent_title, source.window_name, source.pane_title, source.task, record.request.title].map(clean).find(Boolean);
    return { group, title };
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
    const templates = snapshot.templates_by_machine?.[record.machine_id] || snapshot.templates;
    return templates?.templates?.find(t => t.id === record.request.template) || { layout: [{ type: "text", field: "body" }, { type: "media" }, { type: "reply" }, { type: "logs" }] };
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
      for (const node of host.querySelectorAll(":scope > .top, :scope > .card, :scope > .queue, :scope > .notification-settings, :scope > .todo-view, :scope > .menu-overlay")) {
        node.style.width = `${after.width - (placement === "notch" ? 0 : 2)}px`;
        if (fadeContent && !node.classList.contains("top")) {
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
    host.querySelectorAll("video").forEach(video => { video.pause(); if (!snapshot.remote) { video.removeAttribute("src"); video.load(); } });
    setTimeout(cleanupRemoteMedia, 0);
  }
  function cleanupRemoteMedia() {
    for (const [element, state] of remoteMedia) {
      if (element.isConnected) continue;
      state.cancelled = true;
      if (state.url) URL.revokeObjectURL(state.url);
      remoteMedia.delete(element);
    }
  }
  async function loadRemoteMedia(element, status, record, index) {
    const state = { cancelled: false, url: null }; remoteMedia.set(element, state);
    try {
      const metadata = await call({ op: "media", id: record.id, index, offset: 0, length: 0 });
      if (!Number.isSafeInteger(metadata.size) || metadata.size <= 0 || metadata.size > 128 * 1024 * 1024) throw new Error("Attachment is empty or exceeds 128 MiB");
      const parts = []; let offset = 0;
      while (offset < metadata.size) {
        if (state.cancelled || !element.isConnected) return;
        const chunk = await call({ op: "media", id: record.id, index, offset, length: Math.min(256 * 1024, metadata.size - offset) });
        if (chunk.offset !== offset || chunk.size !== metadata.size) throw new Error("Attachment changed during transfer. Open it again.");
        const bytes = Uint8Array.from(atob(chunk.data), character => character.charCodeAt(0));
        if (!bytes.length || bytes.length > 256 * 1024 || offset + bytes.length > metadata.size) throw new Error("Invalid attachment range");
        parts.push(bytes); offset += bytes.length;
        status.textContent = `Loading attachment ${Math.round(offset / metadata.size * 100)}%`;
      }
      if (state.cancelled || !element.isConnected) return;
      state.url = URL.createObjectURL(new Blob(parts, { type: metadata.mime }));
      element.src = state.url; element.hidden = false; status.remove();
    } catch (error) {
      if (!state.cancelled && element.isConnected) status.textContent = String(error.message || error);
    }
  }
  function stopContext() { clearInterval(logTimer); logTimer = null; contextRequest = null; stopMedia(); }
  function pauseTimer() {
    if (collapseTimer) { clearTimeout(collapseTimer); collapseTimer = null; remaining = Math.max(0, remaining - (performance.now() - timerStarted)); }
  }
  function resumeTimer() {
    if (expanded || queue || hovering || focused || actionsInProgress.has(current) || !current || collapseTimer) return;
    const record = records.get(current);
    if (record?.request.template !== "update") return;
    if (record.request.data?.event === "agent_alert" && pending(record)) return;
    timerStarted = performance.now(); collapseTimer = setTimeout(collapse, Math.max(100, remaining));
  }
  function collapse(keepVisible, finished = false) {
    if (!finished) reviewVersion++;
    if (typeof keepVisible !== "boolean") keepVisible = explicitOpen && !pendingCount();
    leaveSettings(); todosOpen = false;
    presented = false; explicitOpen = keepVisible === true; native({ native: "presentation", active: explicitOpen });
    clearTimeout(completionTimer); pauseTimer(); stopContext(); expanded = false; details = false; queue = false; current = null; focused = false; menu = null;
    native({ native: "text_focus", active: false }); render();
  }
  function hideBar() {
    hiddenByUser = true; queueReturnId = null; collapse(false);
  }
  function resetHandledActions() {
    for (const [id, action] of actionsInProgress) if (!action.pending) actionsInProgress.delete(id);
  }
  function toggleBar() {
    if (current || queue || expanded || todosOpen) collapse();
    else {
      resetHandledActions();
      if (pendingCount()) openLatest(); else showQueue(true);
    }
  }
  function openRecord(id) {
    const record = records.get(id), key = record && agentKey(record);
    if (record && pending(record) && !record.dismissed_at && !record.ignored && key) id = pendingCards().find(item => agentKey(item) === key)?.id || id;
    todosOpen = false;
    if (actionsInProgress.has(id)) return;
    leaveSettings();
    const replyFocused = card?._reply && document.activeElement === card._reply;
    clearTimeout(completionTimer); pauseTimer(); stopContext(); current = id; queueReturnId = id; expanded = true; details = false; queue = false; renderedId = null; menu = null;
    call({ op: "read", id }).catch(error => showError(error, id)); render();
    if (replyFocused && card?._reply) card._reply.focus({ preventScroll: true });
  }
  function openLatest() {
    resetHandledActions();
    const latest = pendingCards().at(-1);
    if (latest) openRecord(latest.id);
    else { queueReturnId = null; collapse(true); }
  }
  async function navigate(step) {
    if (navigating) return;
    const id = current, version = reviewVersion;
    navigating = true;
    try {
      let items = pendingCards(), index = items.findIndex(record => record.id === current);
      while (unseenPending > 0 && (index + step >= items.length || index + step < 0)) {
        const result = await call({ op: "list", offset: pendingOffset, pending_only: true });
        addPendingPage(result);
        if (current !== id || version !== reviewVersion || queue || settingsOpen) return;
        items = pendingCards(); index = items.findIndex(record => record.id === current);
      }
      const retry = step > 0 && items.find(record => record.id !== current && retryIds.has(record.id));
      if (items.length) openRecord((retry || items[(Math.max(index, 0) + step + items.length) % items.length]).id);
    } catch (error) { showError(error); }
    finally { navigating = false; }
  }
  function startContext() {
    if (!details || !current || queue || settingsOpen || document.hidden) return;
    refreshContext();
    if (!logTimer) logTimer = setInterval(refreshContext, 1000);
  }
  function toggleDetails() {
    pauseTimer(); stopContext(); expanded = true; details = !details; menu = null; renderedId = null; render(); startContext();
  }
  function toggleMenu(next) {
    if (menu === "agent") contextRequest = null;
    pauseTimer(); expanded = true; menu = menu === next ? null : next; render();
    if (menu === "agent") refreshContext(); else startContext();
  }
  function showQueue(showHistory = false) {
    todosOpen = false;
    resetHandledActions();
    leaveSettings();
    if (current) queueReturnId = current;
    clearTimeout(completionTimer); pauseTimer(); stopContext(); expanded = true; details = false; queue = true; history = showHistory === true; ignoredOpen = false; current = null; renderedId = null; menu = null; selectedNotifications.clear(); queueError = ""; render();
    if (history) loadHistory(true);
  }
  async function toggleQueue() {
    if (settingsOpen) { showQueue(); return; }
    if (!queue) { showQueue(); return; }
    if (queueReturnId) {
      try {
        const record = records.get(queueReturnId) || await call({ op: "get", id: queueReturnId });
        if (!record.dismissed_at) { records.set(record.id, record); openRecord(record.id); return; }
      } catch (error) { showError(error); }
    }
    if (pendingCount()) await openLatest(); else collapse();
  }
  function showError(error, id = current) {
    const message = String(error.message || error);
    if (id) actionErrors.set(id, message);
    if (id !== current) return;
    const notice = host.querySelector(".notice"); if (notice) notice.textContent = message;
    const menuNotice = host.querySelector(".menu-notice"); if (menuNotice) menuNotice.textContent = message;
  }
  async function advanceAfter(record) {
    const version = reviewVersion;
    const next = () => {
      const items = pendingCards();
      return items.find(item => retryIds.has(item.id)) || items.find(item => item.created_at >= record.created_at) || items[0];
    };
    // Reload from the front when draining a page: completed actions shift server offsets.
    let offset = 0;
    while (current === record.id && version === reviewVersion && !queue && !settingsOpen) {
      const item = next();
      if (item) { openRecord(item.id); return; }
      if (!unseenPending) { collapse(false, true); return; }
      try {
        const result = await call({ op: "list", offset, pending_only: true });
        addPendingPage(result); offset = result.next_offset ?? offset + 50;
      } catch (error) { showError(error, record.id); return; }
    }
  }
  async function performAction(id, command, accept = () => {}) {
    if (actionsInProgress.has(id)) return;
    if (preview) {
      try { accept(await call(command)); } catch (error) { showError(error, id); }
      return;
    }
    const record = records.get(id);
    if (!record) return;
    const version = reviewVersion, state = { pending: true };
    const handled = cardMessages(record);
    for (const item of handled) { actionsInProgress.set(item.id, state); actionErrors.delete(item.id); retryIds.delete(item.id); }
    pauseTimer();
    const response = call(command);
    if (current === id && !queue && !settingsOpen) advanceAfter(record);
    try {
      const value = await response;
      const updated = value.record || (value.id ? value : null);
      if (updated) records.set(id, updated);
      if (updated && (!pending(updated) || updated.dismissed_at)) {
        for (const item of handled) if (item.id !== id) records.set(item.id, { ...item, status: "superseded" });
      }
      if (value.status === "resolved") drafts.delete(id);
      accept(value);
    } catch (error) {
      for (const item of handled) { actionsInProgress.delete(item.id); if (!records.has(item.id)) records.set(item.id, item); }
      if (!records.has(id)) records.set(id, record);
      showError(error, id);
      const latest = records.get(id);
      if (pending(latest) && !latest.dismissed_at) {
        retryIds.add(id);
        if (version === reviewVersion && !current && !queue && !settingsOpen && !hiddenByUser) openRecord(id);
      }
    } finally {
      state.pending = false;
      render(); resumeTimer();
    }
  }
  function revisionChoice(record) {
    if (record?.request.template !== "social-review" || record.request.data?.platform !== "X") return null;
    const actions = record.request.actions || [];
    return actions.some(action => action.id === "post" && action.kind === "choice")
      ? actions.find(action => action.id === "revise" && action.kind === "choice") : null;
  }
  async function act(id, action_id, text) {
    const revision = revisionChoice(records.get(id));
    if (revision && (action_id === "reply" || action_id === "post" && text?.trim())) action_id = revision.id;
    const dismissOnly = records.get(id)?.request.template === "update" && action_id === "acknowledge";
    await performAction(id, dismissOnly ? { op: "dismiss", id } : { op: "respond", id, action_id, text: text || null });
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
  function autoYesControl(record, inCard = false) {
    const row = el("div", "auto-yes");
    if (inCard) row.classList.add("answer-auto-yes"); else row.append(el("span", "", "Auto-yes"));
    const control = button("", async () => {
      const pane = record.request.source.pane_id;
      if (autoYesBusy.has(pane)) return;
      autoYesBusy.add(pane); updateAutoYes();
      try {
        await performAction(record.id, { op: "auto_yes", id: record.id }, value => {
          if (typeof value.auto_yes === "boolean") {
            const panes = new Set(snapshot.auto_yes_panes || []);
            if (value.auto_yes) panes.add(pane); else panes.delete(pane);
            snapshot.auto_yes_panes = [...panes];
          }
        });
      } finally { autoYesBusy.delete(pane); updateAutoYes(); }
    }, `auto-yes-switch${inCard ? " auto-yes-button" : ""}`);
    control.setAttribute("role", "switch"); control.setAttribute("aria-label", "Auto-yes for this agent");
    control.title = "Automatically answers this agent's prompts until you turn it off";
    control.dataset.pane = record.request.source.pane_id;
    control.append(el("span", "switch-state"));
    if (!inCard) control.append(el("span", "switch-track"));
    row.append(control);
    return row;
  }
  function updateAutoYes() {
    for (const control of host.querySelectorAll(".auto-yes-switch")) {
      const enabled = (snapshot.auto_yes_panes || []).includes(control.dataset.pane);
      control.setAttribute("aria-checked", String(enabled));
      control.querySelector(".switch-state").textContent = control.classList.contains("auto-yes-button") ? enabled ? "! Auto ON" : "! Yes all" : enabled ? "On" : "Off";
      control.disabled = autoYesBusy.has(control.dataset.pane);
    }
  }
  function createCard(record) {
    const node = el("article", "card");
    node._wasPending = pending(record) && !record.dismissed_at;
    node._signature = cardSignature(record);
    const heading = el("div", "heading"), agent = hasAgent(record), identity = sourceHeading(record);
    const title = el("h1", "", agent ? identity.title : record.request.title); title.title = title.textContent;
    if (agent) { heading.classList.add("agent-heading"); const group = el("span", "source-group", identity.group); group.title = identity.group; heading.append(group); }
    heading.append(title);
    const tools = el("div", "heading-tools"); heading.append(tools);
    const status = el("span", "status"); tools.append(status); node._status = status;
    if (hasAgent(record)) {
      const options = iconButton("Notification options", "M5 12h.01M12 12h.01M19 12h.01", () => toggleMenu("options"), "options-toggle");
      options.title = "Agent options"; options.setAttribute("aria-label", "Notification options"); options.setAttribute("aria-haspopup", "dialog"); node._options = options; tools.append(options);
    }
    node.append(heading);
    if (agent && !record.question_id && record.request.title !== identity.group && record.request.title !== identity.title) node.append(el("div", "notification-title", record.request.title));
    const messages = cardMessages(record);
    if (messages.length > 1) {
      const thread = el("ol", "message-thread"); thread.setAttribute("aria-label", `${messages.length} messages from this agent`);
      for (const item of messages) {
        const entry = el("li", "message-thread-item"); entry.dataset.id = item.id;
        entry.append(el("div", "hint", `${item.id === record.id ? "Latest · " : ""}${item.request.title}`), el("div", "message", messageText(item)));
        thread.append(entry);
      }
      node._thread = thread; node.append(thread);
    } else node.append(el("div", "message", messageText(record)));
    const layout = template(record).layout, primitives = {};
    const content = el("div", "details-content"); node._content = content;
    content.addEventListener("scroll", () => { node._followLogs = content.scrollHeight - content.scrollTop - content.clientHeight < 30; });
    if (details && hasBlock(layout, "media") && record.request.media?.length) {
      const media = el("div", "media");
      record.request.media.forEach((item, index) => {
        const element = el(item.kind === "video" ? "video" : "img");
        if (snapshot.remote && item.src.startsWith("/")) {
          element.hidden = true;
          const status = el("div", "hint", "Loading attachment..."); status.setAttribute("role", "status"); media.append(status);
          loadRemoteMedia(element, status, record, index);
        } else element.src = item.src.startsWith("/") ? `clawtab-nfn://media/${record.id}/${index}` : item.src;
        if (item.kind === "video") { element.controls = true; element.playsInline = true; element.preload = "metadata"; }
        else { element.alt = item.alt || record.request.title; element.loading = snapshot.remote ? "eager" : "lazy"; }
        element.addEventListener("error", () => { element.replaceWith(el("div", "hint", `${item.kind === "video" ? "Video" : "Image"} unavailable`)); });
        media.append(element);
      }); primitives.media = media;
    }
    const actions = el("div", "actions"); node._actions = actions;
    const choices = record.request.actions || [];
    for (const [index, action] of choices.entries()) {
      const control = button(action.label, () => act(record.id, action.id, drafts.get(record.id) || ""), index === 0 ? "primary" : "");
      control.title = action.label;
      control.dataset.actionId = action.id;
      actions.append(control);
    }
    const answerRow = el("div", "answer-row"); answerRow.append(actions);
    node.append(answerRow);
    const questionOptions = agent && choices.length > 0 && (record.question_id || ["question", "permission", "agent-approval"].includes(record.request.template));
    if (questionOptions) {
      node.append(autoYesControl(record, true));
    }
    if (record.request.template !== "update" && (hasBlock(layout, "reply") || record.request.source?.pane_id)) {
      const toAgent = Boolean(record.question_id || record.request.response_destination === "agent_message");
      const reply = el("div", "reply");
      const revision = revisionChoice(record);
      const replyLabel = revision ? "Changes to the draft" : toAgent ? "Reply to agent" : "Your reply";
      if (questionOptions) {
        const open = replyStates.get(record.id) ?? Boolean(drafts.get(record.id));
        const toggle = button(replyLabel, () => {
          replyStates.set(record.id, !open); pauseTimer(); expanded = true; renderedId = null; render();
          if (!open) { native({ native: "text_focus", active: true }); card?._reply?.focus({ preventScroll: true }); }
        }, "utility reply-toggle");
        toggle.setAttribute("aria-expanded", String(open)); toggle.setAttribute("aria-controls", "notification-reply-row"); reply.append(toggle);
      } else {
        const label = el("label", "reply-label", replyLabel); label.htmlFor = "notification-reply"; reply.append(label);
      }
      const row = el("div", "reply-row");
      row.id = "notification-reply-row"; row.hidden = Boolean(questionOptions) && !(replyStates.get(record.id) ?? Boolean(drafts.get(record.id)));
      const input = el("textarea"); input.id = "notification-reply"; input.rows = 2;
      input.setAttribute("aria-label", replyLabel);
      input.placeholder = revision ? "Describe the changes..." : "Message...";
      input.value = drafts.get(record.id) || "";
      input.addEventListener("input", () => { drafts.set(record.id, input.value); updateCard(); });
      input.addEventListener("keydown", event => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); act(record.id, "reply", input.value); } });
      node._reply = input; row.append(input);
      const send = button(revision?.label || "Send", () => act(record.id, "reply", input.value), "primary send");
      send.title = `${revision?.label || "Send reply"} (Command + Enter)`; node._send = send; row.append(send); reply.append(row); node.append(reply);
    }
    const notice = el("div", "notice"); notice.setAttribute("role", "status"); node._notice = notice; node.append(notice);
    const utilities = el("div", "controls");
    const detailButton = button(details ? "Hide details" : (record.request.media?.length ? "View attachment" : "Details"), toggleDetails, "utility details-toggle");
    detailButton.setAttribute("aria-expanded", String(details)); utilities.append(detailButton);
    if (record.request.source?.pane_id) {
      const openAgent = button("Open agent", () => performAction(record.id, { op: "focus", id: record.id }), "utility");
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
    const wasPending = card._wasPending;
    if (card._signature !== cardSignature(record)) {
      const scroll = card._content.scrollTop, active = document.activeElement === card._reply;
      const selection = card._reply ? [card._reply.selectionStart, card._reply.selectionEnd] : null;
      stopContext();
      const replacement = createCard(record); card.replaceWith(replacement); card = replacement;
      card._content.scrollTop = scroll;
      if (active && card._reply) { card._reply.focus({ preventScroll: true }); if (selection) card._reply.setSelectionRange(...selection); }
      startContext();
    }
    const isPending = pending(record) && !record.dismissed_at && !record.ignored;
    if (card._thread && !card._thread._positioned) { card._thread.scrollTop = card._thread.scrollHeight; card._thread._positioned = true; }
    card._wasPending = isPending;
    if (wasPending && !isPending && !preview) {
      clearTimeout(completionTimer);
      const id = current;
      completionTimer = setTimeout(() => {
        if (current !== id || queue) return;
        advanceAfter(record);
      }, 180);
    }
    const update = record.request.template === "update";
    const alert = record.request.data?.event === "agent_alert";
    const busy = actionsInProgress.has(current);
    card._status.classList.toggle("alert", alert && isPending);
    card._status.textContent = record.ignored ? "Ignored" : record.status === "delivering" || busy ? "Sending..." : isPending ? (alert ? "! Alert" : "") : record.status === "resolved" ? (alert ? "Recovered" : update ? "Seen" : "Sent") : record.status;
    card._options?.setAttribute("aria-expanded", String(menu === "options" || menu === "agent"));
    const feedback = Boolean(drafts.get(record.id)?.trim());
    for (const control of card._actions.querySelectorAll("button")) control.disabled = !isPending || busy
      || Boolean(record.question_id && feedback) || Boolean(revisionChoice(record) && control.dataset.actionId === "post" && feedback);
    if (card._send) card._send.disabled = !isPending || busy || !card._reply.value.trim();
    if (card._reply) card._reply.readOnly = !isPending || busy;
    if (actionErrors.has(current)) card._notice.textContent = actionErrors.get(current);
    else if (record.error) card._notice.textContent = record.error;
    else if (record.ignored) card._notice.textContent = "Agent ignored";
    else if (!isPending) card._notice.textContent = record.response ? (update ? "Acknowledged" : "Reply sent") : `Request ${record.status}`;
    else card._notice.textContent = "";
    updateAutoYes();
  }
  async function refreshContext() {
    if ((!details && menu !== "agent") || queue || settingsOpen || !current || !card || contextRequest?.card === card) return;
    const id = current, request = { card }; contextRequest = request;
    const ownsContext = () => contextRequest === request && id === current && card === request.card
      && (details || menu === "agent") && !queue && !settingsOpen;
    try {
      const value = await call({ op: "context", id });
      if (!ownsContext()) return;
      const changedLogs = card._logs && card._logs._raw !== value.log;
      const before = changedLogs ? host.getBoundingClientRect() : null;
      if (changedLogs) {
        stopAnimation();
        const logs = card._logs, scroller = card._content;
        const mediaFirst = snapshot.remote && records.get(id)?.request.media?.length;
        const atBottom = (!mediaFirst && logs._raw == null) || (logs._raw != null && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 30);
        logs._raw = value.log; renderAnsi(logs, value.log || "No output yet");
        card._followLogs = atBottom;
        if (atBottom) scroller.scrollTop = scroller.scrollHeight;
      }
      const agent = host.querySelector(".agent-controls");
      if (agent && agent.dataset.built !== "yes") {
        const beforeMenu = host.getBoundingClientRect();
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
        animateLayout(beforeMenu, false);
      }
      if (before) animateLayout(before, false);
    } catch (error) { if (ownsContext()) { if (card._logs) card._logs.textContent = String(error.message || error); showError(error); } }
    finally { if (contextRequest === request) contextRequest = null; }
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
        inputs.set(parameter.name, input); label.append(input); fields.append(label);
      }
    }
    select.addEventListener("change", () => { const before = host.getBoundingClientRect(); renderFields(); animateLayout(before, false); }); renderFields();
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
      for (const record of pendingCards()) selectedNotifications.add(record.id);
    } catch (error) { queueError = String(error.message || error); }
    finally { bulkBusy = false; render(); }
  }
  async function dismissNotifications(ids) {
    if (bulkBusy || !ids.length) return;
    bulkBusy = true; queueError = ""; render();
    try {
      const previous = ids.flatMap(id => records.has(id) ? cardMessages(records.get(id)).filter(item => item.id !== id) : []);
      const result = await call({ op: "dismiss_many", ids });
      for (const record of previous) records.set(record.id, { ...record, status: "superseded" });
      for (const record of result.records || []) { records.set(record.id, record); selectedNotifications.delete(record.id); }
      pendingOffset = pendingRecords().length;
      historyItems = []; historyOffset = 0;
    } catch (error) { queueError = String(error.message || error); }
    finally { bulkBusy = false; render(); }
  }
  async function loadIgnoredAgents() {
    ignoredBusy = true; queueError = ""; render();
    try { ignoredAgents = (await call({ op: "ignored_agents" })).agents || []; }
    catch (error) { queueError = String(error.message || error); }
    finally { ignoredBusy = false; render(); }
  }
  async function setAgentIgnored(record, ignored) {
    if (ignoredBusy) return;
    ignoredBusy = true;
    try {
      const result = await call({ op: ignored ? "ignore" : "unignore", id: record.id });
      for (const item of result.records || []) records.set(item.id, item);
      if (ignored) {
        menu = null;
        if (current === record.id) await advanceAfter(record);
      } else {
        ignoredAgents = ignoredAgents.filter(agent => agent.id !== record.id);
      }
      queueError = "";
    } catch (error) {
      if (ignored) showError(error, record.id); else queueError = String(error.message || error);
    } finally { ignoredBusy = false; render(); }
  }
  function renderQueue() {
    let list = host.querySelector(".queue");
    if (!list) {
      list = el("div", "queue");
      const segments = el("div", "segments"); segments.setAttribute("role", "tablist"); segments.setAttribute("aria-label", "Notifications");
      for (const [label, isHistory] of [["Pending", false], ["History", true]]) {
        const tab = button(label, () => {
          if (history === isHistory && !ignoredOpen) return;
          list._scroll[history ? "history" : "pending"] = list._content.scrollTop;
          history = isHistory; ignoredOpen = false; selectedNotifications.clear(); queueError = ""; render();
          list._content.scrollTop = list._scroll[history ? "history" : "pending"] || 0;
          if (history) loadHistory(true);
        });
        tab.setAttribute("role", "tab"); tab.dataset.history = String(isHistory); segments.append(tab);
      }
      const ignored = button("Ignored agents", () => { ignoredOpen = true; selectedNotifications.clear(); loadIgnoredAgents(); });
      ignored.setAttribute("role", "tab"); ignored.dataset.ignored = "true"; segments.append(ignored);
      list._scroll = {};
      list._content = el("div", "queue-content");
      list.append(segments, list._content);
    }
    for (const tab of list.querySelectorAll('[role="tab"]')) tab.setAttribute("aria-selected", String(ignoredOpen ? tab.dataset.ignored === "true" : tab.dataset.history === String(history)));
    if (ignoredOpen) {
      const signature = JSON.stringify(["ignored", ignoredAgents, ignoredBusy, queueError]);
      if (list.dataset.signature === signature) return list;
      list.dataset.signature = signature; list._content.replaceChildren();
      if (queueError) list._content.append(el("div", "notice", queueError));
      for (const agent of ignoredAgents) {
        const row = el("div", "queue-row ignored-agent");
        const identity = sourceHeading({ request: { source: agent.source, title: agent.title } });
        const label = el("div", "queue-item"); label.append(el("strong", "", identity.title), el("div", "meta", [identity.group, agent.machine_id].filter(Boolean).join(" · ")));
        const restore = button("Stop ignoring", () => setAgentIgnored(agent, false), "utility"); restore.disabled = ignoredBusy;
        row.append(label, restore); list._content.append(row);
      }
      if (!ignoredAgents.length) list._content.append(el("div", "empty-state", ignoredBusy ? "Loading..." : "No ignored agents"));
      return list;
    }
    const items = history ? historyItems : pendingCards();
    const signature = JSON.stringify([history, items.map(record => [record.id, record.read_at, record.request.title, sourceText(record.request.source), history ? [] : cardMessages(record).map(item => item.id)]), [...selectedNotifications], bulkBusy, queueError, loadingQueue, hasMoreHistory, unseenPending]);
    if (list.dataset.signature === signature) return list;
    list.dataset.signature = signature;
    const content = list._content, scroll = content.scrollTop;
    content.replaceChildren();
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
      content.append(toolbar);
    }
    if (queueError) { const notice = el("div", "notice", queueError); notice.setAttribute("role", "status"); content.append(notice); }
    for (const record of items) {
      const row = el("div", "queue-row");
      if (!history) {
        const checkbox = el("input"); checkbox.type = "checkbox"; checkbox.checked = selectedNotifications.has(record.id); checkbox.disabled = bulkBusy;
        checkbox.setAttribute("aria-label", `Select ${record.request.title}`);
        checkbox.addEventListener("change", () => { if (checkbox.checked) selectedNotifications.add(record.id); else selectedNotifications.delete(record.id); render(); }); row.append(checkbox);
      }
      const item = button("", () => { records.set(record.id, record); openRecord(record.id); }, `queue-item ${record.read_at ? "" : "unread"}`);
      const messageCount = history ? 1 : cardMessages(record).length;
      item.append(el("strong", "", record.request.title), el("div", "meta", [sourceText(record.request.source), messageCount > 1 ? `${messageCount} messages` : ""].filter(Boolean).join(" · "))); row.append(item);
      if (!history) {
        const dismiss = iconButton(`Dismiss ${record.request.title}`, "M6 6l12 12M18 6L6 18", () => dismissNotifications([record.id]), "dismiss-item");
        dismiss.disabled = bulkBusy; row.append(dismiss);
      }
      content.append(row);
    }
    if (!items.length) content.append(el("div", "empty-state", loadingQueue ? "Loading..." : history ? "No notification history" : "No pending requests"));
    if ((history && hasMoreHistory) || (!history && unseenPending > 0)) content.append(button(loadingQueue ? "Loading..." : "Load more", () => loadHistory(), "utility"));
    content.scrollTop = scroll;
    return list;
  }
  async function loadHistory(reset = false) {
    if (loadingQueue) return;
    const isHistory = history;
    loadingQueue = true; render();
    try {
      const offset = isHistory ? reset ? 0 : historyOffset : pendingOffset;
      const result = await call({ op: "list", offset, pending_only: !isHistory });
      if (isHistory) { historyItems = reset ? result.records || [] : [...historyItems, ...(result.records || [])]; historyOffset = result.next_offset || offset + 50; hasMoreHistory = result.records?.length === 50; }
      else addPendingPage(result);
    } catch (error) { queueError = String(error.message || error); }
    finally { loadingQueue = false; render(); }
  }
  function renderMenu() {
    const existing = host.querySelector(".menu-overlay");
    if (!menu || !current || settingsOpen) { existing?.remove(); return; }
    if (existing?.dataset.menu === menu && existing.dataset.id === (current || "")) return;
    existing?.remove();
    const record = records.get(current), overlay = el("div", "menu-overlay");
    overlay.dataset.menu = menu; overlay.dataset.id = current || "";
    const panel = el("div", "menu-panel"); panel.setAttribute("role", "dialog"); panel.setAttribute("aria-label", menu === "agent" ? "Agent controls" : "Notification options");
    const heading = el("div", "menu-heading");
    if (menu === "agent") { const back = button("‹", () => toggleMenu("options"), "utility nav-step"); back.setAttribute("aria-label", "Back to options"); heading.append(back); }
    heading.append(el("span", "", menu === "agent" ? "Agent controls" : "Options"));
    const close = button("×", () => toggleMenu(menu), "utility close"); close.setAttribute("aria-label", "Close menu"); heading.append(close); panel.append(heading);
    if (menu === "options") {
      if (hasAgent(record)) {
        panel.append(autoYesControl(record));
        const controls = button("Agent controls", () => toggleMenu("agent"), "utility menu-link");
        controls.setAttribute("aria-haspopup", "dialog"); panel.append(controls);
      }
      if (agentKey(record)) {
        const ignore = button(record.ignored ? "Stop ignoring agent" : "Ignore agent", () => setAgentIgnored(record, !record.ignored), "utility menu-link");
        ignore.disabled = ignoredBusy; panel.append(ignore);
      }
      panel.append(button("Notification settings", openSettings, "utility menu-link"));
      const dismiss = button("Dismiss notification", () => performAction(record.id, { op: "dismiss", id: record.id }), "utility dismiss"); dismiss.title = "Remove this card from Pending"; panel.append(dismiss);
    } else if (menu === "agent") panel.append(el("div", "agent-controls", "Loading..."));
    const notice = el("div", "notice menu-notice"); notice.setAttribute("role", "status"); panel.append(notice);
    overlay.append(panel); overlay.addEventListener("click", event => { if (event.target === overlay) toggleMenu(menu); }); host.append(overlay);
    updateAutoYes();
  }
  function leaveSettings() {
    if (!settingsOpen) return;
    settingsOpen = false;
    focused = false;
    native({ native: "text_focus", active: false });
    native({ native: "settings", active: false });
  }
  function closeSettings() {
    leaveSettings(); expanded = settingsReturnExpanded; render(); startContext(); resumeTimer();
  }
  function openSettings() {
    if (snapshot.remote) return;
    todosOpen = false;
    if (settingsOpen) return;
    hiddenByUser = false;
    settingsReturnExpanded = expanded;
    clearTimeout(completionTimer); pauseTimer(); stopContext(); menu = null; settingsOpen = true; expanded = true;
    native({ native: "settings", active: true }); render();
  }
  async function saveSettings(patch, view) {
    if (settingsBusy) return;
    settingsBusy = true; view.setAttribute("aria-busy", "true"); view._notice.textContent = "";
    for (const input of view.querySelectorAll("input, select")) input.disabled = true;
    try {
      const result = await call({ op: "save_settings", patch });
      if (result.settings) snapshot.settings = result.settings;
    } catch (error) { view._notice.textContent = String(error.message || error); }
    finally { settingsBusy = false; view.setAttribute("aria-busy", "false"); render(); }
  }
  function renderSettings() {
    let view = host.querySelector(".notification-settings");
    if (!view) {
      view = el("section", "notification-settings"); view.setAttribute("aria-label", "Notification settings");
      const heading = el("div", "settings-heading");
      heading.append(el("h1", "", "Notifications"), button("Close bar", hideBar, "utility close-bar")); view.append(heading);
      const form = el("div", "settings-fields"); view.append(form);
      const fields = [
        ["placement", "Position", [["notch", "Notch"], ["right", "Right side"], ["custom", "Custom"]]],
        ["display", "Display", []],
        ["delivery", "Delivery", [["enhanced", "ClawTab"], ["native", "macOS"], ["both", "Both"]]],
        ["focus", "Focus", [["follow", "Follow macOS"], ["independent", "Always show"]]],
        ["preview_seconds", "Update duration", null],
        ["hover_expand", "Expand on hover", "checkbox"],
        ["sound", "Sound", "checkbox"],
        ["menu_bar_icon", "Menu bar icon", "checkbox"],
        ["mobile_when_idle", "Send to mobile when idle", "checkbox"],
        ["idle_seconds", "Idle time before mobile delivery", null],
      ];
      for (const [key, title, options] of fields) {
        const row = el("label", "setting-row"), input = el(Array.isArray(options) ? "select" : "input");
        input.dataset.setting = key; input.setAttribute("aria-label", title);
        if (Array.isArray(options)) for (const [value, text] of options) { const option = el("option", "", text); option.value = value; input.append(option); }
        else if (options === "checkbox") input.type = "checkbox";
        else { input.type = "number"; input.min = key === "idle_seconds" ? "10" : "2"; input.max = key === "idle_seconds" ? "3600" : "120"; input.step = "1"; input.required = true; input.title = key === "idle_seconds" ? "Seconds without keyboard or mouse activity before sending to mobile" : "Seconds before a status update collapses"; }
        input.addEventListener("change", () => {
          if (!input.checkValidity()) { view._notice.textContent = input.validationMessage; return; }
          const value = input.type === "checkbox" ? input.checked : input.type === "number" ? Number(input.value) : input.value;
          const patch = { [key]: value };
          if (key === "placement" && value === "custom") patch.position = snapshot.settings?.position || { right: 16, top: 12 };
          saveSettings(patch, view);
        });
        row.append(el("span", "", title), input); form.append(row);
        if (key === "placement") {
          const position = el("div", "setting-position"); view._position = position;
          for (const [axis, label] of [["right", "From right"], ["top", "From top"]]) {
            const row = el("label", "setting-row"), input = el("input"); input.type = "number"; input.min = "0"; input.step = "any"; input.required = true;
            input.dataset.position = axis; input.setAttribute("aria-label", label);
            input.addEventListener("change", () => {
              if (!input.checkValidity()) { view._notice.textContent = input.validationMessage; return; }
              saveSettings({ position: { ...snapshot.settings.position, [axis]: Number(input.value) } }, view);
            });
            row.append(el("span", "", label), input); position.append(row);
          }
          form.append(position);
        }
      }
      view._notice = el("div", "notice settings-notice"); view._notice.setAttribute("role", "status"); view.append(view._notice);
    }
    const values = { delivery: "enhanced", placement: "notch", display: "primary", focus: "follow", preview_seconds: 8, hover_expand: false, sound: true, menu_bar_icon: true, mobile_when_idle: true, idle_seconds: 60, ...snapshot.settings };
    const display = view.querySelector('[data-setting="display"]');
    const displays = [["primary", "Primary display"], ["built_in", "Built-in display"], ["pointer", "Follow pointer"], ...(snapshot.platform?.displays || []).map(item => [item.id, item.name])];
    if (!displays.some(([id]) => id === values.display)) displays.push([values.display, "Saved display"]);
    const displaySignature = JSON.stringify(displays);
    if (display.dataset.options !== displaySignature) {
      display.dataset.options = displaySignature; display.replaceChildren();
      for (const [value, text] of displays) { const option = el("option", "", text); option.value = value; display.append(option); }
    }
    for (const input of view.querySelectorAll("[data-setting]")) {
      input.disabled = settingsBusy;
      if (!settingsBusy && document.activeElement !== input) {
        if (input.type === "checkbox") input.checked = Boolean(values[input.dataset.setting]); else input.value = values[input.dataset.setting];
      }
    }
    view._position.hidden = values.placement !== "custom";
    for (const input of view.querySelectorAll("[data-position]")) {
      input.disabled = settingsBusy;
      if (!settingsBusy && document.activeElement !== input) input.value = values.position?.[input.dataset.position] || 0;
    }
    return view;
  }
  function draggableBar(control) {
    let origin = null, dragged = false;
    control.addEventListener("pointerdown", event => {
      if (event.button !== 0 || preview || snapshot.remote) return;
      origin = { x: event.screenX, y: event.screenY, pointerId: event.pointerId }; dragged = false;
      document.addEventListener("pointermove", move);
      document.addEventListener("pointerup", finish);
      document.addEventListener("pointercancel", finish);
    });
    const move = event => {
      if (!origin || event.pointerId !== origin.pointerId) return;
      const dx = event.screenX - origin.x, dy = event.screenY - origin.y;
      if (!dragged && Math.hypot(dx, dy) < 5) return;
      if (!dragged) { control.setPointerCapture(event.pointerId); pauseTimer(); stopAnimation(); native({ native: "drag", phase: "start" }); }
      dragged = true; native({ native: "drag", phase: "move", dx, dy });
    };
    const finish = () => {
      if (!origin) return;
      const pointerId = origin.pointerId;
      origin = null;
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", finish);
      document.removeEventListener("pointercancel", finish);
      if (dragged) native({ native: "drag", phase: "end" });
      if (control.hasPointerCapture(pointerId)) control.releasePointerCapture(pointerId);
      resumeTimer();
    };
    control.addEventListener("lostpointercapture", finish);
    control.addEventListener("click", event => {
      if (dragged) { event.preventDefault(); event.stopImmediatePropagation(); dragged = false; }
    }, true);
  }
  function render() {
    if (reducedMotion.matches || geometry.reduce_motion) stopArrivalAnimation();
    const before = host.getBoundingClientRect();
    const signature = JSON.stringify([current, expanded, details, queue, settingsOpen, todosOpen, menu, replyStates.get(current), geometry, snapshot.visible, records.get(current)?.request]);
    const continuingAnimation = layoutAnimation && signature === renderedLayout;
    if (!continuingAnimation) stopAnimation();
    renderedLayout = signature;
    const count = pendingCount();
    if (!presented && !hiddenByUser && current && records.has(current) && (snapshot.visible || explicitOpen) && !preview) {
      presented = true; native({ native: "presentation", active: true });
    }
    if (!preview && !settingsOpen && !todosOpen && (hiddenByUser || (!explicitOpen && !presented && (!snapshot.visible || (!current && !queue && !count && !todoItems().length))))) { stopArrivalAnimation(); host.className = "empty"; host.replaceChildren(); renderedId = null; card = null; stopContext(); size(); return; }
    host.className = `${placement} ${expanded ? "expanded" : !current ? "pill" : ""} ${details && !settingsOpen ? "details-open" : ""} ${settingsOpen ? "settings-open" : ""} ${queue && !settingsOpen ? "queue-open" : ""} ${menu ? "menu-open" : ""} ${todosOpen ? "todos-open" : ""}`;
    let top = host.querySelector(".top");
    if (!top) {
      top = el("div", "top"); host.prepend(top);
      top.addEventListener("contextmenu", event => { event.preventDefault(); openSettings(); });
      const toggle = button("", toggleBar, "bar-toggle");
      draggableBar(toggle); top.append(toggle);
      const latest = button("", openSettings, "utility brand icon-button"); latest.title = "Notification settings"; latest.setAttribute("aria-label", "Notification settings");
      const logo = el("img"); logo.src = "https://cdn.clawtab.cc/assets/app-icon.png"; logo.alt = ""; latest.append(logo); top.append(latest);
      const slash = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      slash.setAttribute("viewBox", "0 0 28 28"); slash.setAttribute("class", "claw-slash"); slash.setAttribute("aria-hidden", "true");
      for (const d of ["M17 3Q10 10 3 20", "M22 4Q14 13 6 24", "M26 8Q19 17 12 26"]) {
        const path = document.createElementNS(slash.namespaceURI, "path");
        path.setAttribute("d", d); path.setAttribute("pathLength", "1"); slash.append(path);
      }
      latest.append(slash);
      const controls = el("div", "top-actions");
      controls.append(iconButton("Previous notification", "M14 6l-6 6 6 6", () => navigate(-1), "nav-step previous"));
      controls.append(el("span", "count"));
      controls.append(iconButton("Next notification", "M10 6l6 6-6 6", () => navigate(1), "nav-step next"));
      top.append(controls);
      const list = iconButton("Notification list", "M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01", toggleQueue, "list-toggle");
      top.append(list);
    }
    updateTodoRing(top);
    const items = pendingCards(), index = items.findIndex(record => record.id === current);
    const isOpen = Boolean(current || queue || expanded), toggle = top.querySelector(".bar-toggle");
    toggle.setAttribute("aria-label", isOpen ? "Collapse notifications" : "Expand notifications"); toggle.setAttribute("aria-expanded", String(isOpen));
    toggle.title = `${isOpen ? "Collapse" : "Open"} notifications. Drag to move.`;
    let countButton = top.querySelector(".count");
    if (isOpen !== (countButton.tagName === "BUTTON")) {
      const label = isOpen ? button("", () => queue && !settingsOpen ? toggleQueue() : settingsOpen ? openLatest() : toggleBar(), "utility count") : el("span", "count");
      if (isOpen) draggableBar(label);
      countButton.replaceWith(label); countButton = label;
    }
    countButton.textContent = current && index >= 0 && !settingsOpen ? `${index + 1} / ${count}` : `${count} pending`;
    if (isOpen) countButton.title = queue || settingsOpen ? "Return to notification" : "Collapse notifications";
    for (const step of top.querySelectorAll(".nav-step")) step.hidden = !current || count < 2 || settingsOpen;
    top.querySelector(".list-toggle").setAttribute("aria-pressed", String(queue && !settingsOpen));
    if (!settingsOpen) host.querySelector(".notification-settings")?.remove();
    if (!todosOpen) host.querySelector(".todo-view")?.remove();
    if (todosOpen) {
      host.querySelector(".card")?.remove(); host.querySelector(".queue")?.remove(); host.querySelector(".notification-settings")?.remove();
      card = null; renderedId = null; const view = renderTodos(); if (!view.isConnected) host.append(view); view._restoreFocus?.(); view._restoreFocus = null;
    } else if (settingsOpen) {
      host.querySelector(".card")?.remove(); host.querySelector(".queue")?.remove(); card = null; renderedId = null;
      const view = renderSettings(); if (!view.isConnected) host.append(view);
    } else if (queue) {
      host.querySelector(".card")?.remove();
      const list = renderQueue(); if (!list.isConnected) host.append(list); card = null; renderedId = null;
    } else if (current && records.has(current)) {
      host.querySelector(".queue")?.remove();
      if (renderedId !== `${current}:${expanded}`) {
        host.querySelector(".card")?.remove(); card = createCard(records.get(current)); host.append(card); renderedId = `${current}:${expanded}`;
      }
      updateCard();
    } else { host.querySelector(".card")?.remove(); host.querySelector(".queue")?.remove(); renderedId = null; card = null; }
    renderMenu(); cleanupRemoteMedia(); if (!continuingAnimation) animateLayout(before, !queue && !menu && !settingsOpen);
  }
  function receive(value) {
    if (value.type === "todos") { todoData = value.todos; render(); return; }
    if (value.type === "response") {
      const promise = promises.get(String(value.token)); if (!promise) return;
      clearTimeout(promise.timer); promises.delete(String(value.token));
      if (value.error) promise.reject(new Error(value.error)); else promise.resolve(value.value); return;
    }
    if (value.type === "open_record" && typeof value.id === "string") {
      const version = ++reviewVersion;
      hiddenByUser = false; explicitOpen = true;
      const open = record => {
        if (reviewVersion !== version) return;
        records.set(record.id, record); openRecord(record.id);
        if (record.request.media?.length) toggleDetails();
        else if (value.popup && record.request.template === "update") { expanded = false; render(); resumeTimer(); }
      };
      if (records.has(value.id)) open(records.get(value.id));
      else call({ op: "get", id: value.id }).then(open).catch(error => {
        if (reviewVersion !== version) return;
        showQueue(); queueError = String(error.message || error); render();
      });
      return;
    }
    if (value.type === "show" || value.type === "latest") {
      resetHandledActions();
      if (value.type === "latest" && !pendingCount() && !host.classList.contains("empty")) { hideBar(); return; }
      hiddenByUser = false;
      explicitOpen = true; native({ native: "presentation", active: true });
      if (value.type === "latest") openLatest(); else showQueue();
      return;
    }
    if (value.type === "settings") { openSettings(); return; }
    if (value.type !== "snapshot") return;
    snapshot = value; preview = Boolean(value.preview);
    if (value.todos) todoData = value.todos;
    const incoming = new Set();
    for (const record of value.records || []) { records.set(record.id, record); incoming.add(record.id); }
    const activeRecord = records.get(current), activeKey = activeRecord && agentKey(activeRecord);
    if (activeRecord && pending(activeRecord) && !activeRecord.dismissed_at && !activeRecord.ignored && activeKey && !actionsInProgress.has(current)) {
      const latest = pendingCards().find(item => agentKey(item) === activeKey);
      if (latest && latest.id !== current) {
        pauseTimer(); stopContext(); current = latest.id; queueReturnId = current; renderedId = null; menu = null;
        remaining = (value.settings?.preview_seconds || 8) * 1000;
      }
    }
    for (const [id, action] of actionsInProgress) {
      const record = records.get(id);
      if (!action.pending && (!incoming.has(id) || !pending(record) || record.dismissed_at)) actionsInProgress.delete(id);
    }
    for (const id of retryIds) {
      const record = records.get(id);
      const noLongerPending = !incoming.has(id) && (value.pending_count || 0) <= incoming.size;
      if (noLongerPending || (record && (!pending(record) || record.dismissed_at))) { retryIds.delete(id); actionErrors.delete(id); }
    }
    for (const id of records.keys()) if (id !== current && !incoming.has(id) && !selectedNotifications.has(id) && !actionsInProgress.has(id) && !retryIds.has(id)) records.delete(id);
    const knownPending = pendingRecords(true).filter(record => incoming.has(record.id) || !actionsInProgress.has(record.id));
    unseenPending = Math.max(0, (value.pending_count || 0) - knownPending.length);
    pendingOffset = 50;
    if (current && !incoming.has(current) && !preview) {
      const id = current;
      call({ op: "get", id }).then(record => { records.set(id, record); if (id === current) updateCard(); }).catch(error => showError(error, id));
    }
    if (value.arrival && records.has(value.arrival)) hiddenByUser = false;
    if (value.arrival && records.has(value.arrival) && !actionsInProgress.has(value.arrival) && !current && !settingsOpen && !todosOpen && !bulkBusy && (!queue || !selectedNotifications.size)) {
      clearTimeout(completionTimer); pauseTimer(); stopContext();
      current = value.arrival; queueReturnId = current; queue = false; history = false; details = false; menu = null;
      remaining = (value.settings?.preview_seconds || 8) * 1000; renderedId = null;
    }
    render(); resumeTimer();
    if (value.arrival && records.has(value.arrival) && value.arrival !== lastArrivalId) {
      lastArrivalId = value.arrival; animateArrival();
    }
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
    if (event.key === "Escape") { event.preventDefault(); if (settingsOpen) closeSettings(); else if (menu) toggleMenu(menu); else collapse(); }
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
    host.style.setProperty("--notch-overlap", `${placement === "notch" ? next.overlap || 38 : 0}px`);
    document.body.style.justifyContent = placement === "notch" ? "center" : "flex-end";
    for (const [key, property] of [["overlap", "--notch-overlap"], ["notch_width", "--notch-width"], ["max_width", "--surface-max-width"], ["max_height", "--surface-max-height"]]) {
      if (Number.isFinite(next[key])) host.style.setProperty(property, `${next[key]}px`);
    }
    render();
  } };
  host.className = "empty";
  native({ preview_ready: true });
})();
