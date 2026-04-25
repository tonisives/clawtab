import { memo, useEffect, useRef } from "react";
import { acquirePane, releasePane } from "./paneInstance";
import { debugXtermPane, isFocusPending, requestXtermPaneFocus } from "./paneRegistry";
import type { XtermPaneProps } from "./types";

export { requestXtermPaneFocus } from "./paneRegistry";

export const XtermPane = memo(function XtermPane({ paneId, tmuxSession, group, onExit }: XtermPaneProps) {
  const slotRef = useRef<HTMLDivElement>(null);
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;
  const resolvedGroup = group ?? "default";

  useEffect(() => {
    if (!slotRef.current) return;
    const slot = slotRef.current;
    const inst = acquirePane(paneId, tmuxSession, resolvedGroup);
    inst.onExitRef = onExitRef;
    const slotId = slot.closest("[data-leaf-id]")?.getAttribute("data-leaf-id") ?? "?";
    const prevParent = inst.container.parentNode;
    if (prevParent === slot) {
      debugXtermPane(paneId, `same-slot remount into leaf ${slotId}, skipping appendChild`);
    } else {
      if (prevParent) {
        const prevSlotId = (prevParent as HTMLElement).closest("[data-leaf-id]")?.getAttribute("data-leaf-id") ?? "?";
        debugXtermPane(paneId, `container moving leaf ${prevSlotId} -> ${slotId}`);
      } else {
        debugXtermPane(paneId, `mount into leaf ${slotId} (prevParent=none)`);
      }
      slot.appendChild(inst.container);
    }
    // Fit synchronously now, then again on the next frame after layout settles.
    // Split-tree restructure can move the container into a slot whose width/height
    // is still mid-reflow; the second fit ensures the terminal matches the final
    // visible size and avoids the "stale content" symptom that zoom-out/in fixes.
    inst.fit.fit();
    const fitRaf = requestAnimationFrame(() => {
      if (inst.cancelled) return;
      inst.fit.fit();
    });

    if (isFocusPending(paneId)) {
      requestXtermPaneFocus(paneId);
    }

    return () => {
      cancelAnimationFrame(fitRaf);
      const curLeafId = slot.closest("[data-leaf-id]")?.getAttribute("data-leaf-id") ?? "?";
      debugXtermPane(
        paneId,
        `unmount from leaf ${curLeafId} (containerParent=${
          inst.container.parentNode === slot ? "same" : inst.container.parentNode ? "other" : "none"
        })`,
      );
      if (inst.container.parentNode === slot) {
        slot.removeChild(inst.container);
      }
      releasePane(paneId);
    };
  }, [paneId, tmuxSession, resolvedGroup]);

  return (
    <div
      ref={slotRef}
      style={{
        flex: 1,
        minHeight: 0,
        overflow: "hidden",
        display: "flex",
      }}
    />
  );
});
