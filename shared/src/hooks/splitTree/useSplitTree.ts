import { useEffect, useRef, useState } from "react";
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

  const detailPaneRef = useRef<HTMLDivElement>(null);
  const [detailSize, setDetailSize] = useState({ w: 0, h: 0 });

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

  const persistence = useTreePersistence({ storageKey, controlledRef });
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
    selectedItems: derived.selectedItems,
    focusedItemKey: derived.focusedItemKey,
    paneColors: derived.paneColors,
    effectiveTreeForOverlay: derived.effectiveTreeForOverlay,
  };
}
