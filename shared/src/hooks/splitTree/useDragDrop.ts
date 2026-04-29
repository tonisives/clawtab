import { useCallback, useRef, useState, type Dispatch, type MutableRefObject, type RefObject, type SetStateAction } from "react";
import {
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import type { PaneContent, SplitNode } from "../../types/splitTree";
import {
  collectLeaves,
  genPaneId,
  removeLeaf,
  replaceNode,
  splitLeaf,
} from "../../util/splitTree";
import { computeDropZone, type DropZoneId } from "../../components/DropZoneOverlay";
import { contentEquals, createVirtualRoot, dragDataToContent } from "./helpers";
import type { SplitDragData } from "./types";

export function useDragDrop(opts: {
  splitTreeRef: MutableRefObject<SplitNode | null>;
  currentContentRef: MutableRefObject<PaneContent | null>;
  onReplaceSingleRef: MutableRefObject<(data: SplitDragData) => void>;
  detailPaneRef: RefObject<HTMLDivElement | null>;
  minPaneSize: number;
  setSplitTreeChecked: (
    updater: SplitNode | null | ((prev: SplitNode | null) => SplitNode | null),
    site: string,
  ) => void;
  setFocusedLeafId: Dispatch<SetStateAction<string | null>>;
}) {
  const {
    splitTreeRef,
    currentContentRef,
    onReplaceSingleRef,
    detailPaneRef,
    minPaneSize,
    setSplitTreeChecked,
    setFocusedLeafId,
  } = opts;

  const [isDragging, setIsDragging] = useState(false);
  const [dragActiveZone, setDragActiveZone] = useState<DropZoneId | null>(null);
  const dragActiveZoneRef = useRef<DropZoneId | null>(null);
  const [dragOverlayData, setDragOverlayData] = useState<SplitDragData | null>(null);

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
  }, [minPaneSize, detailPaneRef, splitTreeRef, currentContentRef]);

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

    if (!currentTree) {
      const cc = currentContentRef.current;

      if (zone.action === "replace") {
        onReplaceSingleRef.current(data);
        return;
      }

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

    const stableNewLeafId = genPaneId();
    const stableSplitNodeId = genPaneId();

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
        if (!removed) return prev;
        return splitLeaf(removed, zone.leafId, newContent, zone.direction, zone.position, stableNewLeafId, stableSplitNodeId);
      }

      if (zone.action === "replace") {
        return replaceNode(prev, zone.leafId, { type: "leaf", id: zone.leafId, content: newContent });
      }
      return splitLeaf(prev, zone.leafId, newContent, zone.direction, zone.position, stableNewLeafId, stableSplitNodeId);
    }, "dragEnd:treeMutation");
  }, [setSplitTreeChecked, setFocusedLeafId, splitTreeRef, currentContentRef, onReplaceSingleRef]);

  const handleDragCancel = useCallback(() => {
    setIsDragging(false);
    setDragOverlayData(null);
    dragActiveZoneRef.current = null;
    setDragActiveZone(null);
  }, []);

  return {
    isDragging,
    dragActiveZone,
    dragOverlayData,
    sensors,
    handleDragStart,
    handleDragMove,
    handleDragEnd,
    handleDragCancel,
  };
}
