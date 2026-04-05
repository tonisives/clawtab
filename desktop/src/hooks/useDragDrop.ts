import { useCallback, useRef, useState } from "react";
import { useSensor, useSensors, PointerSensor, type DragEndEvent, type DragStartEvent, type DragMoveEvent } from "@dnd-kit/core";
import type { RemoteJob, ClaudeProcess, SplitDirection, LegacyDropZoneId as DropZoneId } from "@clawtab/shared";
import { legacyComputeDropZone as computeDropZone } from "@clawtab/shared";
import type { DragData } from "../components/DraggableCards";

type SplitItem = { kind: "job"; slug: string } | { kind: "process"; paneId: string } | { kind: "agent" };

export function useDragDrop(
  splitItem: SplitItem | null,
  splitDirection: SplitDirection,
  splitRatio: number,
  setSplitDirection: (dir: SplitDirection) => void,
  setSplitRatio: (ratio: number) => void,
  setSplitItem: (item: SplitItem | null) => void,
  viewingAgent: boolean,
  viewingProcess: ClaudeProcess | null,
  viewingJob: { slug: string } | null,
  handleSelectJob: (job: RemoteJob) => void,
  handleSelectProcess: (process: ClaudeProcess) => void,
) {
  const [isDragging, setIsDragging] = useState(false);
  const [dragActiveZone, setDragActiveZone] = useState<DropZoneId | null>(null);
  const [dragOverlayData, setDragOverlayData] = useState<DragData | null>(null);
  const detailPaneRef = useRef<HTMLDivElement>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setIsDragging(true);
    setDragOverlayData(event.active.data.current as DragData);
  }, []);

  const handleDragMove = useCallback((event: DragMoveEvent) => {
    const el = detailPaneRef.current;
    if (!el) { setDragActiveZone(null); return; }
    const rect = el.getBoundingClientRect();
    const act = event.activatorEvent as PointerEvent;
    const dx = event.delta.x;
    const dy = event.delta.y;
    const px = act.clientX + dx;
    const py = act.clientY + dy;

    if (px < rect.left || px > rect.right || py < rect.top || py > rect.bottom) {
      setDragActiveZone(null);
      return;
    }

    const zone = computeDropZone(
      px - rect.left, py - rect.top, rect.width, rect.height,
      splitItem !== null, splitDirection, splitRatio,
    );
    setDragActiveZone(zone);
  }, [splitItem, splitDirection, splitRatio]);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    setIsDragging(false);
    setDragOverlayData(null);
    const zone = dragActiveZone;
    setDragActiveZone(null);

    if (!zone) return;
    const data = event.active.data.current as DragData;
    if (!data) return;

    const item: SplitItem = data.kind === "job"
      ? { kind: "job", slug: data.slug }
      : { kind: "process", paneId: data.paneId };

    if (zone === "replace-current") {
      if (data.kind === "job") handleSelectJob(data.job);
      else handleSelectProcess(data.process);
      return;
    }

    if (zone === "replace-primary") {
      if (data.kind === "job") handleSelectJob(data.job);
      else handleSelectProcess(data.process);
      return;
    }

    if (zone === "replace-secondary") {
      setSplitItem(item);
      return;
    }

    const dir: SplitDirection =
      zone === "split-horizontal-left" || zone === "split-horizontal-right"
        ? "horizontal"
        : "vertical";

    setSplitDirection(dir);
    localStorage.setItem("split_direction", dir);
    setSplitRatio(0.5);
    localStorage.setItem("split_ratio", "0.5");

    if (zone === "split-horizontal-left" || zone === "split-vertical-top") {
      const currentPrimary: SplitItem | null = viewingAgent
        ? { kind: "agent" }
        : viewingProcess
          ? { kind: "process", paneId: viewingProcess.pane_id }
          : viewingJob
            ? { kind: "job", slug: viewingJob.slug }
            : null;
      setSplitItem(currentPrimary);
      if (data.kind === "job") handleSelectJob(data.job);
      else handleSelectProcess(data.process);
    } else {
      setSplitItem(item);
    }
  }, [dragActiveZone, viewingAgent, viewingProcess, viewingJob, handleSelectJob, handleSelectProcess, setSplitItem, setSplitDirection, setSplitRatio]);

  const handleDragCancel = useCallback(() => {
    setIsDragging(false);
    setDragOverlayData(null);
    setDragActiveZone(null);
  }, []);

  return {
    isDragging,
    dragActiveZone,
    dragOverlayData,
    detailPaneRef,
    sensors,
    handleDragStart,
    handleDragMove,
    handleDragEnd,
    handleDragCancel,
  };
}
