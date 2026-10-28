// Mobile document only: keep keyboard geometry out of the desktop renderer.
(() => {
  const root = document.documentElement;
  let safeBottom = null, nativeKeyboard = false, pointer = null;
  let scheduled = false;
  const editable = element => element?.matches?.("textarea,input,select,[contenteditable='true']");
  function layout() {
    scheduled = false;
    const viewport = window.visualViewport;
    const height = Math.min(innerHeight, viewport?.height ?? innerHeight);
    const keyboard = nativeKeyboard || innerHeight - height > 100;
    root.style.setProperty("--message-height", `${height}px`);
    root.style.setProperty("--message-safe-bottom", keyboard ? "0px" : safeBottom === null ? "env(safe-area-inset-bottom,0px)" : `${safeBottom}px`);
    const field = document.activeElement;
    if (!editable(field)) return;
    const composer = field.closest(".reply") ?? field;
    const target = composer.getBoundingClientRect().height < height - 16 ? composer : field;
    target.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
  function schedule() {
    if (!scheduled) { scheduled = true; requestAnimationFrame(layout); }
  }
  window.nfnMobile = {
    setInsets(bottom, keyboard) {
      safeBottom = Math.max(0, bottom);
      nativeKeyboard = keyboard;
      schedule();
    },
  };
  window.addEventListener("resize", schedule);
  window.visualViewport?.addEventListener("resize", schedule);
  window.visualViewport?.addEventListener("scroll", schedule);
  document.addEventListener("focusin", schedule);
  document.addEventListener("pointerdown", event => { pointer = { x: event.clientX, y: event.clientY }; }, true);
  document.addEventListener("pointercancel", () => { pointer = null; }, true);
  document.addEventListener("pointerup", event => {
    const start = pointer; pointer = null;
    if (!start || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8) return;
    if (event.target.closest("button,a,input,textarea,select,label,video,audio,[contenteditable='true']")) return;
    if (editable(document.activeElement)) document.activeElement.blur();
  }, true);
  schedule();
})();
