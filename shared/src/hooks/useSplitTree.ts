import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  PointerSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragMoveEvent,
  type DragEndEvent,
} from "@dnd-kit/core";
import type { PaneContent, SplitNode } from "../types/splitTree";
import type { DropZoneId } from "../components/DropZoneOverlay";
import { computeDropZone } from "../components/DropZoneOverlay";
import {
  genPaneId,
  restoreIdCounter,
  collectLeaves,
  replaceNode,
  removeLeaf,
  splitLeaf,
  updateRatio,
  removeStaleLeaves,
} from "../util/splitTree";
import { assignPaneColors } from "../theme/paneColors";
import { colors } from "../theme/colors";

/** Minimal drag data - both apps use { kind, slug?, paneId? } */
export interface SplitDragData {
  kind: "job" | "process" | "agent";
  slug: string;
  paneId: string;
}

export interface UseSplitTreeOptions {
  /** localStorage key for tree persistence */
  storageKey: string;
  /** Minimum pane size in pixels (default 200) */
  minPaneSize?: number;
  /** Called when tree collapses to a single leaf - restore single-selection mode */
  onCollapse: (content: PaneContent) => void;
  /** Called when a "replace" drop happens with no tree (single view mode) */
  onReplaceSingle: (data: SplitDragData) => void;
  /** Current single selection content (for virtual root when no tree) */
  currentContent: PaneContent | null;
}

function loadTree(storageKey: string): SplitNode | null {
  if (typeof localStorage === "undefined") return null;
  const saved = localStorage.getItem(storageKey);
  if (saved) {
    try {
      const tree = JSON.parse(saved) as SplitNode;
      restoreIdCounter(tree);
      return tree;
    } catch { /* ignore corrupt data */ }
  }
  return null;
}

function saveTree(storageKey: string, tree: SplitNode | null) {
  if (typeof localStorage === "undefined") return;
  if (tree) localStorage.setItem(storageKey, JSON.stringify(tree));
  else localStorage.removeItem(storageKey);
}

function dragDataToContent(data: SplitDragData): PaneContent {
  if (data.kind === "job") return { kind: "job", slug: data.slug };
  if (data.kind === "agent") return { kind: "agent" };
  return { kind: "process", paneId: data.paneId };
}

function contentKey(content: PaneContent): string {
  if (content.kind === "job") return content.slug;
  if (content.kind === "agent") return "_agent";
  return content.paneId;
}

function contentEquals(a: PaneContent, b: PaneContent): boolean {
  if (a.kind !== b.kind) return false;
  return contentKey(a) === contentKey(b);
}

export function useSplitTree(options: UseSplitTreeOptions) {
  const {
    storageKey,
    minPaneSize = 200,
    onCollapse,
    onReplaceSingle,
    currentContent,
  } = options;

  // Use refs for callbacks to avoid stale closures
  const onCollapseRef = useRef(onCollapse);
  onCollapseRef.current = onCollapse;
  const onReplaceSingleRef = useRef(onReplaceSingle);
  onReplaceSingleRef.current = onReplaceSingle;
  const currentContentRef = useRef(currentContent);
  currentContentRef.current = currentContent;

  // Split tree state
  const [splitTree, setSplitTree] = useState<SplitNode | null>(() => loadTree(storageKey));
  const [focusedLeafId, setFocusedLeafId] = useState<string | null>(null);

  // Persist tree on change
  useEffect(() => {
    saveTree(storageKey, splitTree);
  }, [storageKey, splitTree]);

  // DnD state
  const [isDragging, setIsDragging] = useState(false);
  const [dragActiveZone, setDragActiveZone] = useState<DropZoneId | null>(null);
  const dragActiveZoneRef = useRef<DropZoneId | null>(null);
  const [dragOverlayData, setDragOverlayData] = useState<SplitDragData | null>(null);
  const detailPaneRef = useRef<HTMLDivElement>(null);
  const [detailSize, setDetailSize] = useState({ w: 0, h: 0 });

  // Ref for split tree to avoid stale closures in drag handlers
  const splitTreeRef = useRef(splitTree);
  splitTreeRef.current = splitTree;

  // Track detail pane size for drop zone computation
  useEffect(() => {
    const el = detailPaneRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setDetailSize({ w: entry.contentRect.width, h: entry.contentRect.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setIsDragging(true);
    setDragOverlayData(event.active.data.current as SplitDragData);
  }, []);

  const handleDragMove = useCallback((event: DragMoveEvent) => {
    const el = detailPaneRef.current;
    if (!el) { dragActiveZoneRef.current = null; setDragActiveZone(null); return; }
    const rect = el.getBoundingClientRect();
    const act = event.activatorEvent as PointerEvent;
    const px = act.clientX + event.delta.x;
    const py = act.clientY + event.delta.y;

    if (px < rect.left || px > rect.right || py < rect.top || py > rect.bottom) {
      dragActiveZoneRef.current = null;
      setDragActiveZone(null);
      return;
    }

    // If no tree, create a synthetic single-leaf for initial drop zone computation
    const tree = splitTreeRef.current;
    const cc = currentContentRef.current;
    const effectiveTree = tree ?? (cc
      ? { type: "leaf" as const, id: "_root", content: cc }
      : null);

    const relX = px - rect.left;
    const relY = py - rect.top;
    const zone = computeDropZone(
      relX, relY, rect.width, rect.height,
      effectiveTree, minPaneSize,
    );
    // DEBUG
    if (Math.random() < 0.05) {
      console.log('[drag]', {
        hasTree: !!tree, treeType: tree?.type,
        cW: Math.round(rect.width), cH: Math.round(rect.height),
        rX: Math.round(relX), rY: Math.round(relY),
        zone: zone ? (zone.action === 'split' ? `split-${zone.direction}-${zone.position} @ ${zone.leafId}` : `replace @ ${zone.leafId}`) : 'null',
        minPaneSize,
      });
    }
    dragActiveZoneRef.current = zone;
    setDragActiveZone(zone);
  }, [minPaneSize]);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    setIsDragging(false);
    setDragOverlayData(null);
    const zone = dragActiveZoneRef.current;
    dragActiveZoneRef.current = null;
    setDragActiveZone(null);

    if (!zone) return;
    const data = event.active.data.current as SplitDragData;
    if (!data) return;

    const newContent = dragDataToContent(data);
    const currentTree = splitTreeRef.current;

    // No tree yet - the primary selection was shown as a virtual root
    if (!currentTree) {
      const cc = currentContentRef.current;

      if (zone.action === "replace") {
        onReplaceSingleRef.current(data);
        return;
      }

      // Split: create tree with current + new (skip if same item)
      if (cc) {
        if (contentEquals(cc, newContent)) return;

        const rootLeaf: SplitNode = { type: "leaf", id: genPaneId(), content: cc };
        const newLeaf: SplitNode = { type: "leaf", id: genPaneId(), content: newContent };
        const tree: SplitNode = {
          type: "split",
          id: genPaneId(),
          direction: zone.direction,
          ratio: 0.5,
          first: zone.position === "before" ? newLeaf : rootLeaf,
          second: zone.position === "after" ? newLeaf : rootLeaf,
        };
        setSplitTree(tree);
        setFocusedLeafId(rootLeaf.id);
      }
      return;
    }

    // Tree exists - check if item is already in a pane (move instead of duplicate)
    setSplitTree(prev => {
      if (!prev) return prev;
      const leaves = collectLeaves(prev);
      const existingLeaf = leaves.find(l => contentEquals(l.content, newContent));

      let tree = prev;
      if (existingLeaf) {
        const removed = removeLeaf(tree, existingLeaf.id);
        if (!removed) return prev; // was the only leaf
        tree = removed;
        if (existingLeaf.id === zone.leafId) return prev;
      }

      if (zone.action === "replace") {
        return replaceNode(tree, zone.leafId, { type: "leaf", id: zone.leafId, content: newContent });
      }
      return splitLeaf(tree, zone.leafId, newContent, zone.direction, zone.position);
    });
  }, []);

  const handleDragCancel = useCallback(() => {
    setIsDragging(false);
    setDragOverlayData(null);
    dragActiveZoneRef.current = null;
    setDragActiveZone(null);
  }, []);

  const handleSplitRatioChange = useCallback((splitNodeId: string, ratio: number) => {
    setSplitTree(prev => prev ? updateRatio(prev, splitNodeId, ratio) : null);
  }, []);

  const handleClosePane = useCallback((leafId: string) => {
    setSplitTree(prev => {
      if (!prev) return null;
      const result = removeLeaf(prev, leafId);
      // If only one leaf remains, extract back to single-selection mode
      if (result && result.type === "leaf") {
        onCollapseRef.current(result.content);
        return null;
      }
      return result;
    });
    setFocusedLeafId(prev => prev === leafId ? null : prev);
  }, []);

  /** When clicking a sidebar item with a tree active: focus if already in a pane, otherwise replace focused leaf */
  const handleSelectInTree = useCallback((content: PaneContent) => {
    if (!splitTree) return false;

    const leaves = collectLeaves(splitTree);
    const existingLeaf = leaves.find(l => contentEquals(l.content, content));
    if (existingLeaf) {
      setFocusedLeafId(existingLeaf.id);
      return true;
    }

    // Replace the focused leaf's content
    setSplitTree(prev => {
      if (!prev) return prev;
      const target = focusedLeafId ?? collectLeaves(prev)[0]?.id;
      if (target) {
        return replaceNode(prev, target, { type: "leaf", id: target, content });
      }
      return prev;
    });
    return true;
  }, [splitTree, focusedLeafId]);

  /** Remove stale leaves matching a predicate */
  const cleanStaleLeaves = useCallback((isStale: (content: PaneContent) => boolean) => {
    setSplitTree(prev => {
      if (!prev) return prev;
      const cleaned = removeStaleLeaves(prev, isStale);
      if (!cleaned) return null;
      return cleaned !== prev ? cleaned : prev;
    });
  }, []);

  /** Programmatically split a leaf to add new content next to it */
  const addSplitLeaf = useCallback((
    targetLeafId: string,
    newContent: PaneContent,
    direction: "horizontal" | "vertical",
  ) => {
    setSplitTree(prev => {
      if (!prev) {
        // No tree yet - create one from currentContent + newContent
        const cc = currentContentRef.current;
        if (!cc) return prev;
        const rootLeaf: SplitNode = { type: "leaf", id: genPaneId(), content: cc };
        const newLeaf: SplitNode = { type: "leaf", id: genPaneId(), content: newContent };
        return {
          type: "split",
          id: genPaneId(),
          direction,
          ratio: 0.5,
          first: rootLeaf,
          second: newLeaf,
        };
      }
      return splitLeaf(prev, targetLeafId, newContent, direction, "after");
    });
  }, []);

  // Compute selectedItems map for sidebar highlighting
  const selectedItems = useMemo((): Map<string, string> | null => {
    if (splitTree) {
      const colorMap = assignPaneColors(splitTree);
      const items = new Map<string, string>();
      for (const leaf of collectLeaves(splitTree)) {
        items.set(contentKey(leaf.content), colorMap.get(leaf.id) ?? colors.accent);
      }
      return items.size > 0 ? items : null;
    }
    // Single selection
    if (currentContent) {
      return new Map([[contentKey(currentContent), colors.accent]]);
    }
    return null;
  }, [splitTree, currentContent]);

  // The content key of the focused leaf (for sidebar to differentiate bright vs faded)
  const focusedItemKey = useMemo((): string | null => {
    if (!splitTree || !focusedLeafId) return null;
    const leaves = collectLeaves(splitTree);
    const leaf = leaves.find(l => l.id === focusedLeafId);
    return leaf ? contentKey(leaf.content) : null;
  }, [splitTree, focusedLeafId]);

  // Pane colors for the detail area
  const paneColors = useMemo(() => {
    if (!splitTree) return undefined;
    return assignPaneColors(splitTree);
  }, [splitTree]);

  // Effective tree for overlay (includes virtual root when no tree)
  const effectiveTreeForOverlay = useMemo(() => {
    if (splitTree) return splitTree;
    if (currentContent) {
      return { type: "leaf" as const, id: "_root", content: currentContent };
    }
    return null;
  }, [splitTree, currentContent]);

  return {
    tree: splitTree,
    focusedLeafId,
    setFocusedLeafId,
    // DnD
    isDragging,
    dragActiveZone,
    dragOverlayData,
    detailPaneRef,
    detailSize,
    sensors,
    handleDragStart,
    handleDragMove,
    handleDragEnd,
    handleDragCancel,
    // Tree operations
    handleSplitRatioChange,
    handleClosePane,
    handleSelectInTree,
    cleanStaleLeaves,
    addSplitLeaf,
    // Sidebar data
    selectedItems,
    focusedItemKey,
    paneColors,
    // For overlay
    effectiveTreeForOverlay,
  };
}
