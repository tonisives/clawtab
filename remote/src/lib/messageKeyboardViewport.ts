// Safari can dismiss its keyboard without blurring the iframe's input.
// Measure the outer viewport; an iframe's viewport does not shrink on iOS.
export function observeMessageKeyboard(
  browser: Window,
  target: () => HTMLElement | null,
  onChange: (visible: boolean, dismissed: boolean) => void,
) {
  const viewport = browser.visualViewport;
  if (!viewport) return;
  let pending = 0;
  let visible = false;
  const resize = () => {
    browser.cancelAnimationFrame(pending);
    pending = browser.requestAnimationFrame(() => {
      // Pinch zoom also shrinks the visual viewport; it is not a keyboard.
      if (Math.abs(viewport.scale - 1) > 0.05) return;
      const next = browser.innerHeight - viewport.height > 100;
      const element = target();
      // Constrain the entire shell, including its action bar, to the area
      // above Safari's keyboard and form controls.
      if (element) element.style.maxHeight = next
        ? `${Math.max(0, viewport.offsetTop + viewport.height - element.getBoundingClientRect().top)}px` : "";
      if (next !== visible) {
        const dismissed = visible && !next;
        visible = next;
        onChange(visible, dismissed);
      }
    });
  };
  resize();
  viewport.addEventListener("resize", resize);
  viewport.addEventListener("scroll", resize);
  browser.addEventListener("resize", resize);
  return () => {
    browser.cancelAnimationFrame(pending);
    viewport.removeEventListener("resize", resize);
    viewport.removeEventListener("scroll", resize);
    browser.removeEventListener("resize", resize);
    const element = target();
    if (element) element.style.maxHeight = "";
  };
}
