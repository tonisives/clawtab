import { useEffect, useRef, useState } from "react";
import { Platform } from "react-native";
import type { SplitNode } from "../../types/splitTree";
import { useControlledSync } from "./useControlledSync";
import { useDerivedData } from "./useDerivedData";
import { useDragDrop } from "./useDragDrop";
import { useFocusTracking } from "./useFocusTracking";
import { useTreeMutations } from "./useTreeMutations";
import { useTreePersistence } from "./useTreePersistence";
import { useZoom } from "./useZoom";
import type { UseSplitTreeOptions } from "./types";

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

  const onCollapseRef = useRef(onCollapse);
  onCollapseRef.current = onCollapse;
  const onReplaceSingleRef = useRef(onReplaceSingle);
  onReplaceSingleRef.current = onReplaceSingle;
  const currentContentRef = useRef(currentContent);
  currentContentRef.current = currentContent;
  const controlledRef = useRef(controlled);
  controlledRef.current = controlled;

  // Tracks the last tree/focus we hydrated from controlled. Used to suppress
  // the persist effects from echoing a value that came from sync. Without this,
  // sync (external -> internal) and persist (internal -> external) form a
  // ping-pong loop whenever the two sides start out of agreement.
  const lastSyncedTreeRef = useRef<SplitNode | null>(controlled?.tree ?? null);
  const lastSyncedFocusRef = useRef<string | null>(controlled?.focusedLeafId ?? null);

  const detailPaneRef = useRef<HTMLDivElement>(null);
  const [detailSize, setDetailSize] = useState({ w: 0, h: 0 });

  useEffect(() => {
    if (Platform.OS !== "web") return;
    const el = detailPaneRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setDetailSize({ w: entry.contentRect.width, h: entry.contentRect.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const persistence = useTreePersistence({ storageKey, controlledRef, lastSyncedTreeRef, lastSyncedFocusRef });
  const { splitTree, splitTreeRef, setSplitTree, setSplitTreeChecked, focusedLeafId, setFocusedLeafId } = persistence;

  const zoom = useZoom({
    splitTreeRef,
    currentContentRef,
    onCollapseRef,
    focusedLeafId,
    setSplitTreeChecked,
    setFocusedLeafId,
  });

  useControlledSync({
    controlled,
    setSplitTree,
    setFocusedLeafId,
    setZoomSnapshot: zoom.setZoomSnapshot,
    lastSyncedTreeRef,
    lastSyncedFocusRef,
  });

  useFocusTracking({ detailPaneRef, setFocusedLeafId });

  const dnd = useDragDrop({
    splitTreeRef,
    currentContentRef,
    onReplaceSingleRef,
    detailPaneRef,
    minPaneSize,
    setSplitTreeChecked,
    setFocusedLeafId,
  });

  const mutations = useTreeMutations({
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
    zoomSnapshotRef: zoom.zoomSnapshotRef,
    setZoomSnapshot: zoom.setZoomSnapshot,
  });

  const derived = useDerivedData({ splitTree, focusedLeafId, currentContent });

  return {
    tree: splitTree,
    focusedLeafId,
    setFocusedLeafId,
    isDragging: dnd.isDragging,
    dragActiveZone: dnd.dragActiveZone,
    dragOverlayData: dnd.dragOverlayData,
    detailPaneRef,
    detailSize,
    sensors: dnd.sensors,
    handleDragStart: dnd.handleDragStart,
    handleDragMove: dnd.handleDragMove,
    handleDragEnd: dnd.handleDragEnd,
    handleDragCancel: dnd.handleDragCancel,
    handleSplitRatioChange: mutations.handleSplitRatioChange,
    handleClosePane: mutations.handleClosePane,
    handleSelectInTree: mutations.handleSelectInTree,
    cleanStaleLeaves: mutations.cleanStaleLeaves,
    addSplitLeaf: mutations.addSplitLeaf,
    openContent: mutations.openContent,
    replaceContent: mutations.replaceContent,
    toggleZoomLeaf: zoom.toggleZoomLeaf,
    zoomSnapshot: zoom.zoomSnapshot,
    getZoomedLeafId: zoom.getZoomedLeafId,
    selectedItems: derived.selectedItems,
    focusedItemKey: derived.focusedItemKey,
    paneColors: derived.paneColors,
    effectiveTreeForOverlay: derived.effectiveTreeForOverlay,
  };
}
