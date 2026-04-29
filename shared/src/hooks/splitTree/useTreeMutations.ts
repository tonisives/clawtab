import { useCallback, type Dispatch, type MutableRefObject, type RefObject, type SetStateAction } from "react";
import type { PaneContent, SplitNode } from "../../types/splitTree";
import {
  collectLeaves,
  genPaneId,
  removeLeaf,
  removeStaleLeaves,
  replaceNode,
  splitLeaf,
  updateRatio,
} from "../../util/splitTree";
import { chooseSplitDirection, collectLeafRects, contentEquals, contentKey } from "./helpers";

export function useTreeMutations(opts: {
  splitTree: SplitNode | null;
  splitTreeRef: MutableRefObject<SplitNode | null>;
  currentContentRef: MutableRefObject<PaneContent | null>;
  detailPaneRef: RefObject<HTMLDivElement | null>;
  detailSize: { w: number; h: number };
  minPaneSize: number;
  focusedLeafId: string | null;
  onCollapseRef: MutableRefObject<(content: PaneContent) => void>;
  setSplitTreeChecked: (
    updater: SplitNode | null | ((prev: SplitNode | null) => SplitNode | null),
    site: string,
  ) => void;
  setFocusedLeafId: Dispatch<SetStateAction<string | null>>;
}) {
  const {
    splitTree,
    splitTreeRef,
    currentContentRef,
    detailPaneRef,
    detailSize,
    minPaneSize,
    focusedLeafId,
    onCollapseRef,
    setSplitTreeChecked,
    setFocusedLeafId,
  } = opts;

  const handleSplitRatioChange = useCallback((splitNodeId: string, ratio: number) => {
    setSplitTreeChecked(prev => prev ? updateRatio(prev, splitNodeId, ratio) : null, "ratioChange");
  }, [setSplitTreeChecked]);

  const handleClosePane = useCallback((leafId: string) => {
    setSplitTreeChecked(prev => {
      if (!prev) return null;
      const result = removeLeaf(prev, leafId);
      if (result && result.type === "leaf") {
        onCollapseRef.current(result.content);
        return null;
      }
      return result;
    }, "closePane");
    setFocusedLeafId(prev => prev === leafId ? null : prev);
  }, [setSplitTreeChecked, setFocusedLeafId, onCollapseRef]);

  const handleSelectInTree = useCallback((content: PaneContent) => {
    if (!splitTree) return false;
    const leaves = collectLeaves(splitTree);
    const existingLeaf = leaves.find(l => contentEquals(l.content, content));
    if (existingLeaf) {
      setFocusedLeafId(existingLeaf.id);
      return true;
    }
    setSplitTreeChecked(prev => {
      if (!prev) return prev;
      const target = focusedLeafId ?? collectLeaves(prev)[0]?.id;
      if (target) {
        return replaceNode(prev, target, { type: "leaf", id: target, content });
      }
      return prev;
    }, "selectInTree");
    return true;
  }, [splitTree, focusedLeafId, setSplitTreeChecked, setFocusedLeafId]);

  const cleanStaleLeaves = useCallback((isStale: (content: PaneContent) => boolean) => {
    setSplitTreeChecked(prev => {
      if (!prev) return prev;
      const cleaned = removeStaleLeaves(prev, isStale);
      if (!cleaned) return null;
      return cleaned !== prev ? cleaned : prev;
    }, "cleanStaleLeaves");
  }, [setSplitTreeChecked]);

  const addSplitLeaf = useCallback((
    targetLeafId: string,
    newContent: PaneContent,
    direction: "horizontal" | "vertical",
  ): string | null => {
    const snapshot = splitTreeRef.current;
    let insertedLeafId: string | null = null;

    if (!snapshot) {
      const cc = currentContentRef.current;
      if (!cc || contentEquals(cc, newContent)) return null;
      const rootLeafId = genPaneId();
      const newLeafId = genPaneId();
      const splitId = genPaneId();
      insertedLeafId = newLeafId;
      const fallbackNewLeafId = genPaneId();
      const fallbackSplitNodeId = genPaneId();
      const capturedCc = cc;
      setSplitTreeChecked((prev) => {
        if (prev) {
          const existing = collectLeaves(prev).find((leaf) => contentEquals(leaf.content, newContent));
          if (existing) return prev;
          const next = splitLeaf(prev, targetLeafId, newContent, direction, "after", fallbackNewLeafId, fallbackSplitNodeId);
          return next !== prev ? next : prev;
        }
        if (!capturedCc || contentEquals(capturedCc, newContent)) return prev;
        const rootLeaf: SplitNode = { type: "leaf", id: rootLeafId, content: capturedCc };
        const newLeaf: SplitNode = { type: "leaf", id: newLeafId, content: newContent };
        return { type: "split", id: splitId, direction, ratio: 0.5, first: rootLeaf, second: newLeaf };
      }, "addSplitLeaf");
    } else {
      const existing = collectLeaves(snapshot).find((leaf) => contentEquals(leaf.content, newContent));
      if (existing) {
        insertedLeafId = existing.id;
      } else {
        const stableNewLeafId = genPaneId();
        const stableSplitNodeId = genPaneId();
        const next = splitLeaf(snapshot, targetLeafId, newContent, direction, "after", stableNewLeafId, stableSplitNodeId);
        if (next !== snapshot) {
          insertedLeafId = collectLeaves(next).find((leaf) => contentEquals(leaf.content, newContent))?.id ?? null;
          setSplitTreeChecked((prev) => {
            if (!prev) return prev;
            const alreadyIn = collectLeaves(prev).find((leaf) => contentEquals(leaf.content, newContent));
            if (alreadyIn) return prev;
            const updated = splitLeaf(prev, targetLeafId, newContent, direction, "after", stableNewLeafId, stableSplitNodeId);
            return updated !== prev ? updated : prev;
          }, "addSplitLeaf");
        }
      }
    }

    if (insertedLeafId) setFocusedLeafId(insertedLeafId);
    return insertedLeafId;
  }, [setSplitTreeChecked, setFocusedLeafId, splitTreeRef, currentContentRef]);

  const openContent = useCallback((content: PaneContent): string | null => {
    const snapshot = splitTreeRef.current;
    if (!snapshot) return null;

    const existingLeaf = collectLeaves(snapshot).find((leaf) => contentEquals(leaf.content, content));
    if (existingLeaf) {
      setFocusedLeafId(existingLeaf.id);
      return existingLeaf.id;
    }

    const containerW = detailPaneRef.current?.clientWidth ?? detailSize.w;
    const containerH = detailPaneRef.current?.clientHeight ?? detailSize.h;
    const leafRects = collectLeafRects(snapshot, 0, 0, containerW, containerH);
    const candidate = leafRects
      .map((leaf) => ({ leafId: leaf.id, direction: chooseSplitDirection(leaf, minPaneSize), area: leaf.w * leaf.h }))
      .filter((leaf): leaf is { leafId: string; direction: "horizontal" | "vertical"; area: number } => !!leaf.direction)
      .sort((a, b) => b.area - a.area)[0];
    const target = candidate ?? (() => {
      const bottomLeaf = leafRects.slice().sort((a, b) => (b.y + b.h) - (a.y + a.h))[0];
      return bottomLeaf ? { leafId: bottomLeaf.id, direction: "vertical" as const } : null;
    })();
    if (!target) return null;

    const next = splitLeaf(snapshot, target.leafId, content, target.direction, "after");
    if (next === snapshot) return null;
    const inserted = collectLeaves(next).find((leaf) => contentEquals(leaf.content, content));
    const insertedLeafId = inserted?.id ?? null;

    const { leafId: targetLeafId, direction: targetDirection } = target;
    const stableNewLeafId = genPaneId();
    const stableSplitNodeId = genPaneId();
    setSplitTreeChecked((prev) => {
      if (!prev) return prev;
      const alreadyIn = collectLeaves(prev).find((leaf) => contentEquals(leaf.content, content));
      if (alreadyIn) return prev;
      const updated = splitLeaf(prev, targetLeafId, content, targetDirection, "after", stableNewLeafId, stableSplitNodeId);
      return updated !== prev ? updated : prev;
    }, "openContent");
    if (insertedLeafId) setFocusedLeafId(insertedLeafId);
    return insertedLeafId;
  }, [detailSize.h, detailSize.w, minPaneSize, setSplitTreeChecked, setFocusedLeafId, splitTreeRef, detailPaneRef]);

  const replaceContent = useCallback((from: PaneContent, to: PaneContent, options?: { focus?: boolean }) => {
    const currentTree = splitTreeRef.current;
    if (!currentTree) return false;
    const peek = collectLeaves(currentTree).find((leaf) => contentEquals(leaf.content, from));
    if (!peek) return false;
    let appliedLeafId: string | null = null;
    setSplitTreeChecked((prev) => {
      if (!prev) return prev;
      const existingTo = collectLeaves(prev).find((leaf) => contentEquals(leaf.content, to));
      if (existingTo) {
        const fromLeaf = collectLeaves(prev).find((leaf) => contentEquals(leaf.content, from));
        if (!fromLeaf || fromLeaf.id === existingTo.id) {
          appliedLeafId = existingTo.id;
          return prev;
        }
        console.log(`[splitTree] replaceContent collapse: removing ${fromLeaf.id}, keeping ${existingTo.id}`, { from, to });
        appliedLeafId = existingTo.id;
        return removeLeaf(prev, fromLeaf.id) ?? prev;
      }
      const fromLeaf = collectLeaves(prev).find((leaf) => contentEquals(leaf.content, from));
      if (!fromLeaf) return prev;
      console.log(`[splitTree] replaceContent: leaf ${fromLeaf.id} ${contentKey(from)} -> ${contentKey(to)}`);
      appliedLeafId = fromLeaf.id;
      return replaceNode(prev, fromLeaf.id, { type: "leaf", id: fromLeaf.id, content: to });
    }, "replaceContent");
    if (options?.focus !== false && appliedLeafId) setFocusedLeafId(appliedLeafId);
    return true;
  }, [setSplitTreeChecked, setFocusedLeafId, splitTreeRef]);

  return {
    handleSplitRatioChange,
    handleClosePane,
    handleSelectInTree,
    cleanStaleLeaves,
    addSplitLeaf,
    openContent,
    replaceContent,
  };
}
