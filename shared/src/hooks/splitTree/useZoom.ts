import { useCallback, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
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

  const [zoomSnapshot, setZoomSnapshot] = useState<ZoomSnapshot | null>(null);

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

  return { zoomSnapshot, setZoomSnapshot, toggleZoomLeaf };
}
