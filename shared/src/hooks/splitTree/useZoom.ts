import { useCallback, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { PaneContent, SplitNode } from "../../types/splitTree";
import { collectLeaves } from "../../util/splitTree";
import { contentEquals } from "./helpers";
import type { ZoomSnapshot } from "./types";

export function useZoom(opts: {
  splitTreeRef: MutableRefObject<SplitNode | null>;
  currentContentRef: MutableRefObject<PaneContent | null>;
  onCollapseRef: MutableRefObject<(content: PaneContent) => void>;
  focusedLeafId: string | null;
  setSplitTreeChecked: (
    updater: SplitNode | null | ((prev: SplitNode | null) => SplitNode | null),
    site: string,
  ) => void;
  setFocusedLeafId: Dispatch<SetStateAction<string | null>>;
}) {
  const {
    splitTreeRef,
    currentContentRef,
    onCollapseRef,
    focusedLeafId,
    setSplitTreeChecked,
    setFocusedLeafId,
  } = opts;

  const [zoomSnapshot, setZoomSnapshotState] = useState<ZoomSnapshot | null>(null);
  const zoomSnapshotRef = useRef<ZoomSnapshot | null>(null);
  const setZoomSnapshot = useCallback<Dispatch<SetStateAction<ZoomSnapshot | null>>>((value) => {
    setZoomSnapshotState((prev) => {
      const next = typeof value === "function" ? (value as (p: ZoomSnapshot | null) => ZoomSnapshot | null)(prev) : value;
      zoomSnapshotRef.current = next;
      return next;
    });
  }, []);

  const toggleZoomLeaf = useCallback((leafId: string) => {
    const currentTree = splitTreeRef.current;
    if (!currentTree) {
      const content = currentContentRef.current;
      if (!zoomSnapshot || !content || !contentEquals(content, zoomSnapshot.content)) return false;
      setSplitTreeChecked(zoomSnapshot.tree, "zoom:restore");
      setFocusedLeafId(zoomSnapshot.focusedLeafId);
      setZoomSnapshot(null);
      return true;
    }
    const leaf = collectLeaves(currentTree).find((entry) => entry.id === leafId);
    if (!leaf) return false;
    setZoomSnapshot({ tree: currentTree, focusedLeafId, content: leaf.content });
    setSplitTreeChecked(null, "zoom:enter");
    setFocusedLeafId(null);
    onCollapseRef.current(leaf.content);
    return true;
  }, [focusedLeafId, zoomSnapshot, setSplitTreeChecked, setFocusedLeafId, splitTreeRef, currentContentRef, onCollapseRef]);

  const getZoomedLeafId = useCallback(() => {
    const snap = zoomSnapshotRef.current;
    if (!snap || splitTreeRef.current) return null;
    const leaves = collectLeaves(snap.tree);
    const match = leaves.find((leaf) => contentEquals(leaf.content, snap.content));
    return match?.id ?? snap.focusedLeafId ?? leaves[0]?.id ?? null;
  }, [splitTreeRef]);

  return { zoomSnapshot, zoomSnapshotRef, setZoomSnapshot, toggleZoomLeaf, getZoomedLeafId };
}
