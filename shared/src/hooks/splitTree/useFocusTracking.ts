import { useEffect, type Dispatch, type RefObject, type SetStateAction } from "react";
import { Platform } from "react-native";

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
 *  actually ended up focused, not whichever fired first.
 *
 *  Only commits a change when the DOM is *stable* on a single leaf for two
 *  consecutive paint frames. Two terminals that both call .focus() in close
 *  succession (xterm self-focus on mount, requestAnimationFrame retries in
 *  requestXtermPaneFocus, SplitDetailArea's auto-focus effect) flap focus
 *  between leaves several times within a single frame. Without the stability
 *  gate, every flap commits a setFocusedLeafId, which triggers the persist
 *  effect to push to controlled, which round-trips back through focus-sync
 *  and re-renders SplitDetailArea, which re-runs its auto-focus rAF — feeding
 *  more focus changes back in. The result is an unbounded ping-pong loop. */
export function useFocusTracking(opts: {
  detailPaneRef: RefObject<HTMLDivElement | null>;
  setFocusedLeafId: Dispatch<SetStateAction<string | null>>;
}) {
  const { detailPaneRef, setFocusedLeafId } = opts;

  useEffect(() => {
    if (Platform.OS !== "web") return;
    const el = detailPaneRef.current;
    if (!el) return;
    let raf1: number | null = null;
    let raf2: number | null = null;
    let pendingLeafId: string | null = null;
    const cancel = () => {
      if (raf1 !== null) cancelAnimationFrame(raf1);
      if (raf2 !== null) cancelAnimationFrame(raf2);
      raf1 = null;
      raf2 = null;
    };
    const sample = (): string | null => {
      const active = document.activeElement;
      if (!(active instanceof HTMLElement)) return null;
      if (!el.contains(active)) return null;
      const leafEl = active.closest<HTMLElement>("[data-leaf-id]");
      return leafEl?.dataset.leafId ?? null;
    };
    const handleFocusIn = (e: FocusEvent) => {
      const target = e.target;
      if (!(target instanceof HTMLElement)) return;
      const leafEl = target.closest<HTMLElement>("[data-leaf-id]");
      if (!leafEl) return;
      cancel();
      raf1 = requestAnimationFrame(() => {
        raf1 = null;
        pendingLeafId = sample();
        if (!pendingLeafId) return;
        raf2 = requestAnimationFrame(() => {
          raf2 = null;
          const stable = sample();
          if (stable !== null && stable === pendingLeafId) {
            setFocusedLeafId((prev) => (prev === stable ? prev : stable));
          }
        });
      });
    };
    el.addEventListener("focusin", handleFocusIn);
    return () => {
      cancel();
      el.removeEventListener("focusin", handleFocusIn);
    };
  }, [detailPaneRef, setFocusedLeafId]);
}
