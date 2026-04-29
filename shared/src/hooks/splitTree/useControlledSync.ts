import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import type { SplitNode } from "../../types/splitTree";
import { restoreIdCounter } from "../../util/splitTree";
import type { UseSplitTreeControlled, ZoomSnapshot } from "./types";

/** Bridges controlled-mode inputs (tree/focus from a workspace manager) to the
 *  hook's internal state. Two effects:
 *
 *    1. ws-switch: when controlled.id changes, hydrate state from the new
 *       workspace's controlled inputs. Tracked via lastControlledIdRef so we
 *       don't repeatedly reset on every render.
 *
 *    2. focus-sync: within the same workspace, accept external focusedLeafId
 *       updates (focus history navigation, cross-pane selection). Without
 *       this, programmatic focus changes via controlled.onChange round-trip
 *       back as controlled.focusedLeafId but never reach internal state.
 *
 *  Deps intentionally exclude `controlled` itself — consumers rebuild it on
 *  every render (see useJobsSplitTree), so depending on the object reference
 *  would re-run effects every commit. */
export function useControlledSync(opts: {
  controlled: UseSplitTreeControlled | undefined;
  setSplitTree: Dispatch<SetStateAction<SplitNode | null>>;
  setFocusedLeafId: Dispatch<SetStateAction<string | null>>;
  setZoomSnapshot: Dispatch<SetStateAction<ZoomSnapshot | null>>;
}) {
  const { controlled, setSplitTree, setFocusedLeafId, setZoomSnapshot } = opts;

  const lastControlledIdRef = useRef<string | null>(controlled?.id ?? null);
  const controlledTree = controlled?.tree ?? null;
  const controlledFocusedLeafId = controlled?.focusedLeafId ?? null;
  const controlledId = controlled?.id ?? null;

  useEffect(() => {
    if (controlledId === null) return;
    if (lastControlledIdRef.current === controlledId) return;
    lastControlledIdRef.current = controlledId;
    if (controlledTree) restoreIdCounter(controlledTree);
    setSplitTree((prev) => (prev === controlledTree ? prev : controlledTree));
    setFocusedLeafId((prev) => (prev === controlledFocusedLeafId ? prev : controlledFocusedLeafId));
    setZoomSnapshot((prev) => (prev === null ? prev : null));
  }, [controlledId, controlledTree, controlledFocusedLeafId, setSplitTree, setFocusedLeafId, setZoomSnapshot]);

  useEffect(() => {
    if (controlledId === null) return;
    if (controlledId !== lastControlledIdRef.current) return;
    setFocusedLeafId((prev) => (prev === controlledFocusedLeafId ? prev : controlledFocusedLeafId));
  }, [controlledId, controlledFocusedLeafId, setFocusedLeafId]);
}
