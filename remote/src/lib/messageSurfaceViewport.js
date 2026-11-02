// Mobile document only: keep keyboard geometry out of the desktop renderer.
(() => {
  const root = document.documentElement;
  let safeBottom = null, nativeKeyboard = false, pointer = null;
  let scheduled = false;
  const editable = element => element?.matches?.("textarea,input,select,[contenteditable='true']");
  function layout() {
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
    setActive(active) {
      pointer = null; swipe = null;
      window.getSelection?.()?.removeAllRanges();
      for (const logs of document.querySelectorAll?.(".logs") || []) logs._selecting = false;
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
    swipe = null;
    if (event.touches.length !== 1 || selecting()) return;
    const card = event.target.closest("#surface:not(.menu-open) > .card");
    if (!card || event.target.closest(swipeControl)) return;
    for (let node = event.target; node && node !== card; node = node.parentElement) {
      if (node.scrollWidth > node.clientWidth + 1 && /auto|scroll/.test(getComputedStyle(node).overflowX)) return;
    }
    const touch = event.touches[0];
    swipe = { card, id: touch.identifier, x: touch.clientX, y: touch.clientY, horizontal: false };
  }, { passive: true, capture: true });
  document.addEventListener("touchmove", event => {
    if (!swipe) return;
    const touch = event.touches[0];
    if (event.touches.length !== 1 || touch.identifier !== swipe.id || selecting()) {
      swipe = null; return;
    }
    const dx = Math.abs(touch.clientX - swipe.x), dy = Math.abs(touch.clientY - swipe.y);
    if (!swipe.horizontal && dy > 12 && dy >= dx) { swipe = null; return; }
    if (dx > 12 && dx > dy * 1.5) swipe.horizontal = true;
    if (swipe.horizontal) event.preventDefault();
  }, { passive: false, capture: true });
  document.addEventListener("touchcancel", () => { swipe = null; }, { passive: true, capture: true });
  document.addEventListener("touchend", event => {
    const start = swipe; swipe = null;
    if (!start || event.touches.length || selecting()
      || !start.card.isConnected || !start.card.matches("#surface:not(.menu-open) > .card")) return;
    const touch = Array.from(event.changedTouches).find(touch => touch.identifier === start.id);
    if (!touch) return;
    const dx = touch.clientX - start.x, dy = touch.clientY - start.y;
    if (Math.abs(dx) < 60 || Math.abs(dx) <= Math.abs(dy) * 1.5) return;
    const step = start.card.parentElement.querySelector(dx < 0 ? ".nav-step.next" : ".nav-step.previous");
    if (step && !step.hidden) step.click();
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
