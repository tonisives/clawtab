import { useEffect, type Dispatch, type RefObject, type SetStateAction } from "react";

/** Keep focusedLeafId in sync with real DOM focus: when any element inside a
 *  pane leaf gains focus (mouse, keyboard nav, programmatic xterm focus), the
 *  enclosing leaf becomes the focused leaf.
 *
 *  Coalesces bursts of focusin events: on workspace switch / mount, multiple
 *  xterm panes' containers reattach within the same task and each fires
 *  focusin (their internal attachFocusTracking handlers chain into the
 *  detail-pane container via bubbling). Without coalescing, two panes ping-
 *  pong setFocusedLeafId between their leaf ids. Reading
 *  document.activeElement at the end of the tick gives us the leaf that
 *  actually ended up focused, not whichever fired first. */
export function useFocusTracking(opts: {
  detailPaneRef: RefObject<HTMLDivElement | null>;
  setFocusedLeafId: Dispatch<SetStateAction<string | null>>;
}) {
  const { detailPaneRef, setFocusedLeafId } = opts;

  useEffect(() => {
    const el = detailPaneRef.current;
    if (!el) return;
    let scheduled = false;
    const flush = () => {
      scheduled = false;
      const active = document.activeElement;
      if (!(active instanceof HTMLElement)) return;
      if (!el.contains(active)) return;
      const leafEl = active.closest<HTMLElement>("[data-leaf-id]");
      const leafId = leafEl?.dataset.leafId ?? null;
      if (!leafId) return;
      setFocusedLeafId((prev) => (prev === leafId ? prev : leafId));
    };
    const handleFocusIn = (e: FocusEvent) => {
      const target = e.target;
      if (!(target instanceof HTMLElement)) return;
      const leafEl = target.closest<HTMLElement>("[data-leaf-id]");
      if (!leafEl) return;
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(flush);
    };
    el.addEventListener("focusin", handleFocusIn);
    return () => el.removeEventListener("focusin", handleFocusIn);
  }, [detailPaneRef, setFocusedLeafId]);
}
