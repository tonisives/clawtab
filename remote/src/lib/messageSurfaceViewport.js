// Mobile document only: keep keyboard geometry out of the desktop renderer.
(() => {
  const root = document.documentElement;
  let safeBottom = null, nativeKeyboard = false, pointer = null;
  let scheduled = false;
  let selectionTarget = null;
  const editable = element => element?.matches?.("textarea,input,select,[contenteditable='true']");
  function layout() {
    if (selectionTarget?.isConnected) return;
    const viewport = window.visualViewport;
    const height = Math.min(innerHeight, viewport?.height ?? innerHeight);
    const keyboard = nativeKeyboard || innerHeight - height > 100;
    root.style.setProperty("--message-height", `${height}px`);
    root.style.setProperty("--message-safe-bottom", keyboard ? "0px" : safeBottom === null ? "env(safe-area-inset-bottom,0px)" : `${safeBottom}px`);
    window.dispatchEvent(new Event("message_layout"));
    const field = document.activeElement;
    if (!editable(field) || field.classList?.contains("shell-keyboard")) return;
    const composer = field.closest(".reply") ?? field;
    const target = composer.getBoundingClientRect().height < height - 16 ? composer : field;
    target.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
  function schedule() {
    if (!scheduled) {
      scheduled = true;
      requestAnimationFrame(() => { scheduled = false; layout(); });
    }
  }
  window.nfnMobile = {
    selectText(target, x, y) {
      const text = target.textContent || "";
      const caret = document.caretRangeFromPoint?.(x, y);
      let offset = 0;
      if (caret && target.contains(caret.startContainer)) {
        const prefix = document.createRange();
        prefix.selectNodeContents(target);
        prefix.setEnd(caret.startContainer, caret.startOffset);
        offset = prefix.toString().length;
      }
      // DOM ranges and UITextView both use UTF-16 offsets.
      offset = Math.min(offset, Math.max(0, text.length - 1));
      while (offset < text.length - 1 && /\s/.test(text[offset])) offset++;
      while (offset > 0 && /\s/.test(text[offset])) offset--;
      let start = offset, end = offset;
      while (start > 0 && /\S/.test(text[start - 1])) start--;
      while (end < text.length && /\S/.test(text[end])) end++;
      window.ReactNativeWebView?.postMessage(JSON.stringify({ nfn: {
        native: "selection_text", gesture: true, text, selection: { start, end },
      } }));
    },
    holdSelection(target) {
      if (selectionTarget === target) return;
      selectionTarget = target;
      window.ReactNativeWebView?.postMessage(JSON.stringify({ nfn: { native: "selection_gesture", active: true } }));
    },
    releaseSelection(target) {
      if (!selectionTarget || target && target !== selectionTarget) return;
      selectionTarget = null;
      window.ReactNativeWebView?.postMessage(JSON.stringify({ nfn: { native: "selection_gesture", active: false } }));
      schedule();
    },
    setActive(active) {
      this.releaseSelection();
      pointer = null; swipe = null;
      window.nfnPaging?.finish();
      window.getSelection?.()?.removeAllRanges();
      for (const logs of document.querySelectorAll?.(".logs") || []) {
        logs._cancelSelection?.(); logs._selecting = false;
      }
      if (!active) document.activeElement?.blur?.();
      const reset = () => {
        window.scrollTo?.(0, 0);
        if (document.scrollingElement) document.scrollingElement.scrollTop = 0;
        schedule();
      };
      reset(); requestAnimationFrame(reset);
    },
    setInsets(bottom, keyboard) {
      safeBottom = Math.max(0, bottom);
      nativeKeyboard = keyboard;
      layout();
      schedule();
    },
  };
  window.addEventListener("resize", schedule);
  window.visualViewport?.addEventListener("resize", schedule);
  window.visualViewport?.addEventListener("scroll", schedule);
  document.addEventListener("focusin", schedule);
  let swipe = null;
  const swipeControl = "button,a,input,textarea,select,label,video,audio,[contenteditable='true'],[role='slider']";
  const selecting = () => window.getSelection()?.isCollapsed === false;
  document.addEventListener("touchstart", event => {
    window.nfnPaging?.finish();
    swipe = null;
    if (event.touches.length !== 1 || selecting()) return;
    const card = event.target.closest("#surface:not(.menu-open) > .card");
    if (!card || event.target.closest(swipeControl)) return;
    for (let node = event.target; node && node !== card; node = node.parentElement) {
      if (node.scrollWidth > node.clientWidth + 1 && /auto|scroll/.test(getComputedStyle(node).overflowX)) return;
    }
    const touch = event.touches[0];
    swipe = { card, id: touch.identifier, x: touch.clientX, y: touch.clientY, horizontal: false,
      lastX: touch.clientX, lastAt: performance.now(), at: performance.now(), velocity: 0 };
  }, { passive: true, capture: true });
  document.addEventListener("touchmove", event => {
    if (!swipe) return;
    const touch = event.touches[0];
    if (event.touches.length !== 1 || touch.identifier !== swipe.id || selecting()) {
      window.nfnPaging?.cancel(); swipe = null; return;
    }
    const dx = Math.abs(touch.clientX - swipe.x), dy = Math.abs(touch.clientY - swipe.y);
    if (!swipe.horizontal && performance.now() - swipe.at >= 350) { swipe = null; return; }
    if (!swipe.horizontal && dy > 12 && dy >= dx) { swipe = null; return; }
    if (!swipe.horizontal && dx > 12 && dx > dy * 1.5) {
      swipe.horizontal = true;
      window.nfnPaging?.begin(swipe.card);
    }
    if (swipe.horizontal) {
      event.preventDefault();
      const now = performance.now();
      swipe.velocity = (touch.clientX - swipe.lastX) / Math.max(1, now - swipe.lastAt);
      swipe.lastX = touch.clientX; swipe.lastAt = now;
      window.nfnPaging?.move(touch.clientX - swipe.x);
    }
  }, { passive: false, capture: true });
  document.addEventListener("touchcancel", () => { window.nfnPaging?.cancel(); swipe = null; }, { passive: true, capture: true });
  document.addEventListener("touchend", event => {
    const start = swipe; swipe = null;
    if (!start || event.touches.length || selecting()
      || !start.card.isConnected || !start.card.matches("#surface:not(.menu-open) > .card")) { window.nfnPaging?.cancel(); return; }
    const touch = Array.from(event.changedTouches).find(touch => touch.identifier === start.id);
    if (!touch) return;
    const dx = touch.clientX - start.x, dy = touch.clientY - start.y;
    if (!start.horizontal || Math.abs(dx) <= Math.abs(dy) * 1.5) { window.nfnPaging?.cancel(); return; }
    window.nfnPaging?.release(dx, performance.now() - start.lastAt < 100 ? start.velocity : 0);
  }, { passive: true, capture: true });
  document.addEventListener("pointerdown", event => { pointer = { x: event.clientX, y: event.clientY }; }, true);
  document.addEventListener("pointercancel", () => { pointer = null; }, true);
  document.addEventListener("pointerup", event => {
    const start = pointer; pointer = null;
    if (!start || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8) return;
    if (event.target.closest("button,a,input,textarea,select,label,video,audio,[contenteditable='true']")) return;
    if (editable(document.activeElement) && !document.activeElement.classList?.contains("shell-keyboard")) document.activeElement.blur();
  }, true);
  schedule();
})();
