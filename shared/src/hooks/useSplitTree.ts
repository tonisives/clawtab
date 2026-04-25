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
  dedupeIds,
  findDuplicateIds,
  findDuplicateLeafContents,
  collectLeaves,
  replaceNode,
  removeLeaf,
  splitLeaf,
  updateRatio,
  removeStaleLeaves,
} from "../util/splitTree";
import { assignPaneColors } from "../theme/paneColors";
import { colors } from "../theme/colors";

type LeafRect = { id: string; content: PaneContent; x: number; y: number; w: number; h: number };

/** Minimal drag data - both apps use { kind, slug?, paneId? } */
export interface SplitDragData {
  kind: "job" | "process" | "terminal" | "agent";
  slug?: string;
  paneId?: string;
  tmuxSession?: string;
  source?: "sidebar" | "detail-pane";
  /** Source workspace id when dragging a pane from a detail view. Used by the
   *  WorkspaceManager to MOVE (not copy) across workspaces. */
  sourceWorkspaceId?: string;
}

/** Controlled mode: caller owns tree/focus state and persistence.
 *  The hook treats `controlled.tree` / `controlled.focusedLeafId` as inputs
 *  and calls `onChange` whenever it wants to mutate either. Used by the
 *  desktop WorkspaceManager to drive multiple workspaces from a single
 *  active hook instance. `id` scopes the active workspace so the hook can
 *  reset its internal refs when the caller switches workspaces. */
export interface UseSplitTreeControlled {
  id: string;
  tree: SplitNode | null;
  focusedLeafId: string | null;
  onChange: (patch: { tree?: SplitNode | null; focusedLeafId?: string | null }) => void;
}

export interface UseSplitTreeOptions {
  /** localStorage key for tree persistence. Mutually exclusive with `controlled`. */
  storageKey?: string;
  /** Controlled mode. Mutually exclusive with `storageKey`. */
  controlled?: UseSplitTreeControlled;
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
      const parsed = JSON.parse(saved) as SplitNode;
      restoreIdCounter(parsed);
      return dedupeIds(parsed);
    } catch { /* ignore corrupt data */ }
  }
  return null;
}

function saveTree(storageKey: string, tree: SplitNode | null) {
  if (typeof localStorage === "undefined") return;
  if (tree) localStorage.setItem(storageKey, JSON.stringify(tree));
  else localStorage.removeItem(storageKey);
}

function loadFocusedLeaf(storageKey: string): string | null {
  if (typeof localStorage === "undefined") return null;
  return localStorage.getItem(storageKey + "_focused_leaf");
}

function saveFocusedLeaf(storageKey: string, id: string | null) {
  if (typeof localStorage === "undefined") return;
  const key = storageKey + "_focused_leaf";
  if (id) localStorage.setItem(key, id);
  else localStorage.removeItem(key);
}

function dragDataToContent(data: SplitDragData): PaneContent {
  if (data.kind === "job") return { kind: "job", slug: data.slug ?? "" };
  if (data.kind === "agent") return { kind: "agent" };
  if (data.kind === "terminal") {
    return { kind: "terminal", paneId: data.paneId ?? "", tmuxSession: data.tmuxSession ?? "" };
  }
  return { kind: "process", paneId: data.paneId ?? "" };
}

function contentKey(content: PaneContent): string {
  if (content.kind === "job") return content.slug;
  if (content.kind === "agent") return "_agent";
  if (content.kind === "terminal") return `_term_${content.paneId}`;
  return content.paneId;
}

function contentEquals(a: PaneContent, b: PaneContent): boolean {
  if (a.kind !== b.kind) return false;
  return contentKey(a) === contentKey(b);
}

function createVirtualRoot(content: PaneContent | null): SplitNode {
  return {
    type: "leaf",
    id: "_root",
    // Placeholder content is only used for overlay geometry when the detail pane is empty.
    content: content ?? { kind: "agent" },
  };
}

function collectLeafRects(
  node: SplitNode,
  x: number,
  y: number,
  w: number,
  h: number,
): LeafRect[] {
  if (node.type === "leaf") {
    return [{ id: node.id, content: node.content, x, y, w, h }];
  }

  if (node.direction === "horizontal") {
    const firstW = w * node.ratio;
    const secondW = w - firstW;
    return [
      ...collectLeafRects(node.first, x, y, firstW, h),
      ...collectLeafRects(node.second, x + firstW, y, secondW, h),
    ];
  }

  const firstH = h * node.ratio;
  const secondH = h - firstH;
  return [
    ...collectLeafRects(node.first, x, y, w, firstH),
    ...collectLeafRects(node.second, x, y + firstH, w, secondH),
  ];
}

function chooseSplitDirection(
  rect: Pick<LeafRect, "w" | "h">,
  minPaneSize: number,
): "horizontal" | "vertical" | null {
  const canSplitHorizontal = rect.w >= minPaneSize * 2;
  const canSplitVertical = rect.h >= minPaneSize * 2;
  if (canSplitHorizontal && canSplitVertical) {
    return rect.w >= rect.h ? "horizontal" : "vertical";
  }
  if (canSplitHorizontal) return "horizontal";
  if (canSplitVertical) return "vertical";
  return null;
}

export function useSplitTree(options: UseSplitTreeOptions) {
  const {
    storageKey,
    controlled,
    minPaneSize = 200,
    onCollapse,
    onReplaceSingle,
    currentContent,
  } = options;

  if (!storageKey && !controlled) {
    throw new Error("useSplitTree requires either storageKey or controlled");
  }

  // Use refs for callbacks to avoid stale closures
  const onCollapseRef = useRef(onCollapse);
  onCollapseRef.current = onCollapse;
  const onReplaceSingleRef = useRef(onReplaceSingle);
  onReplaceSingleRef.current = onReplaceSingle;
  const currentContentRef = useRef(currentContent);
  currentContentRef.current = currentContent;
  const controlledRef = useRef(controlled);
  controlledRef.current = controlled;

  // Split tree state. In controlled mode seed from controlled inputs, and
  // reset when controlled.id changes (workspace switch). Otherwise load from
  // storageKey and persist back to it via an effect.
  const [splitTree, setSplitTree] = useState<SplitNode | null>(() => {
    if (controlled) {
      if (controlled.tree) restoreIdCounter(controlled.tree);
      return controlled.tree;
    }
    return loadTree(storageKey!);
  });
  const [focusedLeafId, setFocusedLeafId] = useState<string | null>(() => {
    if (controlled) return controlled.focusedLeafId;
    const saved = loadFocusedLeaf(storageKey!);
    if (!saved) return null;
    const tree = loadTree(storageKey!);
    if (!tree) return null;
    return collectLeaves(tree).some(l => l.id === saved) ? saved : null;
  });
  const [zoomSnapshot, setZoomSnapshot] = useState<{ tree: SplitNode; focusedLeafId: string | null; content: PaneContent } | null>(null);

  // When the controlled id changes (workspace switch), hydrate state from the
  // new workspace's controlled input. Track lastId so we don't repeatedly
  // reset on every render.
  const lastControlledIdRef = useRef<string | null>(controlled?.id ?? null);
  useEffect(() => {
    if (!controlled) return;
    if (lastControlledIdRef.current === controlled.id) return;
    lastControlledIdRef.current = controlled.id;
    if (controlled.tree) restoreIdCounter(controlled.tree);
    setSplitTree(controlled.tree);
    setFocusedLeafId(controlled.focusedLeafId);
    setZoomSnapshot(null);
  }, [controlled?.id, controlled?.tree, controlled?.focusedLeafId, controlled]);

  // Within the same workspace, accept external focusedLeafId updates (e.g. focus
  // history navigation, cross-pane selection). Without this, programmatic focus
  // changes via controlled.onChange round-trip back as controlled.focusedLeafId
  // but never reach internal state, so the visible focus stays put.
  useEffect(() => {
    if (!controlled) return;
    if (controlled.id !== lastControlledIdRef.current) return;
    setFocusedLeafId((prev) => (prev === controlled.focusedLeafId ? prev : controlled.focusedLeafId));
  }, [controlled?.id, controlled?.focusedLeafId, controlled]);

  // Persist tree on change. Also assert there are no duplicate ids — if there
  // are, the tree is corrupt and any subsequent replaceNode/splitLeaf will hit
  // the wrong node. We auto-heal so the user isn't stuck, but log loudly so we
  // can find which mutation introduced the duplicate.
  useEffect(() => {
    if (splitTree) {
      const dupes = findDuplicateIds(splitTree);
      if (dupes.length > 0) {
        console.error("[splitTree] duplicate ids detected, healing:", dupes, splitTree);
        const healed = dedupeIds(splitTree);
        if (healed !== splitTree) {
          setSplitTree(healed);
          return;
        }
      }
      const dupeContents = findDuplicateLeafContents(splitTree);
      if (dupeContents.length > 0) {
        console.error("[splitTree] duplicate leaf contents detected:", dupeContents, splitTree);
      }
    }
    if (controlledRef.current) {
      if (splitTree !== controlledRef.current.tree) {
        controlledRef.current.onChange({ tree: splitTree });
      }
    } else if (storageKey) {
      saveTree(storageKey, splitTree);
    }
  }, [storageKey, splitTree]);

  // Wraps setSplitTree to validate every mutation. Logs which call site
  // produced a tree with duplicate ids so we can find the offending path.
  const setSplitTreeChecked = useCallback(
    (updater: SplitNode | null | ((prev: SplitNode | null) => SplitNode | null), site: string) => {
      setSplitTree((prev) => {
        const next = typeof updater === "function" ? updater(prev) : updater;
        if (next !== prev) {
          const summarize = (n: SplitNode | null) => n ? collectLeaves(n).map(l => `${l.id}:${contentKey(l.content)}`).join(",") : "null";
          console.log(`[splitTree] ${site}: ${summarize(prev)} -> ${summarize(next)}`);
        }
        if (next) {
          const dupes = findDuplicateIds(next);
          if (dupes.length > 0) {
            console.error(`[splitTree] ${site} produced duplicate ids:`, dupes, { prev, next });
          }
          const dupeContents = findDuplicateLeafContents(next);
          if (dupeContents.length > 0) {
            console.error(`[splitTree] ${site} produced duplicate leaf contents:`, dupeContents, { prev, next });
          }
        }
        return next;
      });
    },
    [],
  );

  // Persist focused leaf on change
  useEffect(() => {
    if (controlledRef.current) {
      if (focusedLeafId !== controlledRef.current.focusedLeafId) {
        controlledRef.current.onChange({ focusedLeafId });
      }
    } else if (storageKey) {
      saveFocusedLeaf(storageKey, focusedLeafId);
    }
  }, [storageKey, focusedLeafId]);

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

  // Keep focusedLeafId in sync with real DOM focus: when any element inside a
  // pane leaf gains focus (mouse, keyboard nav, programmatic xterm focus), the
  // enclosing leaf becomes the focused leaf. Without this, focusedLeafId only
  // tracks onMouseDown and programmatic selection, so keyboard-driven focus
  // changes leave shortcuts acting on the wrong pane.
  useEffect(() => {
    const el = detailPaneRef.current;
    if (!el) return;
    const handleFocusIn = (e: FocusEvent) => {
      const target = e.target;
      if (!(target instanceof HTMLElement)) return;
      const leafEl = target.closest<HTMLElement>("[data-leaf-id]");
      const leafId = leafEl?.dataset.leafId ?? null;
      if (!leafId) return;
      setFocusedLeafId((prev) => (prev === leafId ? prev : leafId));
    };
    el.addEventListener("focusin", handleFocusIn);
    return () => el.removeEventListener("focusin", handleFocusIn);
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

    const tree = splitTreeRef.current;
    const cc = currentContentRef.current;
    const effectiveTree = tree ?? (cc ? createVirtualRoot(cc) : null);

    const relX = px - rect.left;
    const relY = py - rect.top;
    const zone: DropZoneId | null = !tree && !cc
      ? { action: "replace", leafId: "_root" }
      : computeDropZone(
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
        setSplitTreeChecked(tree, "dragEnd:noTreeSplit");
        setFocusedLeafId(rootLeaf.id);
      }
      return;
    }

    // Pre-generate stable ids — the updater runs twice under StrictMode, so any
    // genPaneId() calls inside would produce different ids on each invocation.
    const stableNewLeafId = genPaneId();
    const stableSplitNodeId = genPaneId();

    // Tree exists - check if item is already in a pane (move instead of duplicate)
    setSplitTreeChecked(prev => {
      if (!prev) return prev;
      const leaves = collectLeaves(prev);
      const existingLeaf = leaves.find(l => contentEquals(l.content, newContent));

      if (existingLeaf) {
        if (existingLeaf.id === zone.leafId) return prev;

        if (zone.action === "replace") {
          const targetLeaf = leaves.find((leaf) => leaf.id === zone.leafId);
          if (!targetLeaf) return prev;
          return replaceNode(
            replaceNode(prev, existingLeaf.id, {
              type: "leaf",
              id: existingLeaf.id,
              content: targetLeaf.content,
            }),
            zone.leafId,
            { type: "leaf", id: zone.leafId, content: newContent },
          );
        }

        const removed = removeLeaf(prev, existingLeaf.id);
        if (!removed) return prev; // was the only leaf
        return splitLeaf(removed, zone.leafId, newContent, zone.direction, zone.position, stableNewLeafId, stableSplitNodeId);
      }

      if (zone.action === "replace") {
        return replaceNode(prev, zone.leafId, { type: "leaf", id: zone.leafId, content: newContent });
      }
      return splitLeaf(prev, zone.leafId, newContent, zone.direction, zone.position, stableNewLeafId, stableSplitNodeId);
    }, "dragEnd:treeMutation");
  }, [setSplitTreeChecked]);

  const handleDragCancel = useCallback(() => {
    setIsDragging(false);
    setDragOverlayData(null);
    dragActiveZoneRef.current = null;
    setDragActiveZone(null);
  }, []);

  const handleSplitRatioChange = useCallback((splitNodeId: string, ratio: number) => {
    setSplitTreeChecked(prev => prev ? updateRatio(prev, splitNodeId, ratio) : null, "ratioChange");
  }, [setSplitTreeChecked]);

  const handleClosePane = useCallback((leafId: string) => {
    setSplitTreeChecked(prev => {
      if (!prev) return null;
      const result = removeLeaf(prev, leafId);
      // If only one leaf remains, extract back to single-selection mode
      if (result && result.type === "leaf") {
        onCollapseRef.current(result.content);
        return null;
      }
      return result;
    }, "closePane");
    setFocusedLeafId(prev => prev === leafId ? null : prev);
  }, [setSplitTreeChecked]);

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
    setSplitTreeChecked(prev => {
      if (!prev) return prev;
      const target = focusedLeafId ?? collectLeaves(prev)[0]?.id;
      if (target) {
        return replaceNode(prev, target, { type: "leaf", id: target, content });
      }
      return prev;
    }, "selectInTree");
    return true;
  }, [splitTree, focusedLeafId, setSplitTreeChecked]);

  /** Remove stale leaves matching a predicate */
  const cleanStaleLeaves = useCallback((isStale: (content: PaneContent) => boolean) => {
    setSplitTreeChecked(prev => {
      if (!prev) return prev;
      const cleaned = removeStaleLeaves(prev, isStale);
      if (!cleaned) return null;
      return cleaned !== prev ? cleaned : prev;
    }, "cleanStaleLeaves");
  }, [setSplitTreeChecked]);

  /** Programmatically split a leaf to add new content next to it.
   *  Returns the id of the inserted (or existing) leaf so callers can re-assert
   *  focus after React commits — the internal setFocusedLeafId is best-effort
   *  but can race with other state updates around the same render. */
  const addSplitLeaf = useCallback((
    targetLeafId: string,
    newContent: PaneContent,
    direction: "horizontal" | "vertical",
  ): string | null => {
    // Pre-compute against the latest committed tree to derive insertedLeafId for
    // focus/return. Then pass an *updater function* (not a value) so that if
    // multiple addSplitLeaf/openContent calls are batched in the same React cycle
    // they chain correctly — each updater receives the already-mutated prev from
    // the previous updater rather than overwriting it.
    const snapshot = splitTreeRef.current;
    let insertedLeafId: string | null = null;

    if (!snapshot) {
      const cc = currentContentRef.current;
      if (!cc || contentEquals(cc, newContent)) return null;
      // Pre-generate stable ids so the updater produces the same leaf ids that we
      // return to the caller for focus. The updater must use these ids.
      const rootLeafId = genPaneId();
      const newLeafId = genPaneId();
      const splitId = genPaneId();
      insertedLeafId = newLeafId;
      // Also pre-generate ids for the fallback tree-branch path inside the updater.
      const fallbackNewLeafId = genPaneId();
      const fallbackSplitNodeId = genPaneId();
      // Capture cc from the synchronous snapshot — do NOT re-read currentContentRef
      // inside the updater. The caller (e.g. handleRunAgent) may clear viewing state
      // immediately after calling addSplitLeaf, so by the time React runs the updater
      // currentContentRef.current could already be null.
      const capturedCc = cc;
      setSplitTreeChecked((prev) => {
        if (prev) {
          // Tree was created by a preceding batched update — fall through to the
          // tree branch by re-using the updater logic inline.
          const existing = collectLeaves(prev).find((leaf) => contentEquals(leaf.content, newContent));
          if (existing) return prev; // already present
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
  }, [setSplitTreeChecked]);

  /** Open content in the current tree, preferring a split when any pane has room, otherwise replacing the largest pane.
   *  Returns the id of the inserted (or existing) leaf, or null if no tree exists. */
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

    // Pass an updater so batched openContent calls chain instead of overwrite.
    // Pre-generate stable ids outside the updater — StrictMode double-invokes
    // updaters, so calling genPaneId() inside would produce different ids each run.
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
  }, [detailSize.h, detailSize.w, minPaneSize, setSplitTreeChecked]);

  /** Replace an existing leaf's content, optionally focusing that pane.
   *  Resolves the target leaf inside the setter so we never use a stale id. */
  const replaceContent = useCallback((from: PaneContent, to: PaneContent, options?: { focus?: boolean }) => {
    const currentTree = splitTreeRef.current;
    if (!currentTree) return false;
    const peek = collectLeaves(currentTree).find((leaf) => contentEquals(leaf.content, from));
    if (!peek) return false;
    let appliedLeafId: string | null = null;
    setSplitTreeChecked((prev) => {
      if (!prev) return prev;
      // If `to` already exists, just remove the `from` leaf instead of producing
      // two leaves with the same content.
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
  }, [setSplitTreeChecked]);

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
  }, [focusedLeafId, zoomSnapshot, setSplitTreeChecked]);

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
    return createVirtualRoot(currentContent);
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
    openContent,
    replaceContent,
    toggleZoomLeaf,
    // Sidebar data
    selectedItems,
    focusedItemKey,
    paneColors,
    // For overlay
    effectiveTreeForOverlay,
  };
}
