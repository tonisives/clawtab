import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { emit } from "@tauri-apps/api/event";
import { TmuxPaneDetail } from "../TmuxPaneDetail";
import { useWorkspaceManager } from "../../workspace/WorkspaceManager";
import type { useAutoYes } from "../../hooks/useAutoYes";
import type { ClaudeQuestion, ShellPane, Transport, useJobActions, useJobsCore } from "@clawtab/shared";
import type { MindItem } from "./useRecencyLayout";
import { MindMapJobBody } from "./MindMapJobBody";

export interface ModalRect {
  x: number;
  y: number;
  width: number;
  height: number;
  z: number;
}

interface AgentModalProps {
  item: MindItem;
  shell?: ShellPane;
  rect: ModalRect;
  containerRef: React.RefObject<HTMLDivElement | null>;
  questions: ClaudeQuestion[];
  autoYes: ReturnType<typeof useAutoYes>;
  transport: Transport;
  core: ReturnType<typeof useJobsCore>;
  actions: ReturnType<typeof useJobActions>;
  onDismissQuestion: (questionId: string) => void;
  onClose: (id: string) => void;
  onChange: (id: string, rect: ModalRect) => void;
  onFocus: (id: string) => void;
  onRequestJobsTab: () => void;
  onStopped?: (id: string) => void;
}

type ResizeDirection = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
type DragMode = null | "move" | `resize:${ResizeDirection}`;

export function AgentModal({
  item,
  shell,
  rect,
  containerRef,
  questions,
  autoYes,
  transport,
  core,
  actions,
  onDismissQuestion,
  onClose,
  onChange,
  onFocus,
  onRequestJobsTab,
  onStopped,
}: AgentModalProps) {
  const mgr = useWorkspaceManager();

  const dragState = useRef<{
    mode: DragMode;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
    origW: number;
    origH: number;
    armed: boolean;
  } | null>(null);
  const [activeDrag, setActiveDrag] = useState<DragMode>(null);
  const [armedDrag, setArmedDrag] = useState<DragMode>(null);
  const lastWindowedRectRef = useRef<ModalRect | null>(null);
  const DRAG_THRESHOLD_PX = 4;
  const MIN_WIDTH = 360;
  const MIN_HEIGHT = 260;

  const isFullscreen = useMemo(() => {
    const bounds = containerRef.current?.getBoundingClientRect();
    if (!bounds) return false;
    return rect.x <= 1
      && rect.y <= 1
      && Math.abs(rect.width - bounds.width) <= 2
      && Math.abs(rect.height - bounds.height) <= 2;
  }, [containerRef, rect.height, rect.width, rect.x, rect.y]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // A modal dialog (rename, confirm, etc.) is open and will handle Escape
      // itself - don't also close the underlying modal window.
      if (document.querySelector("dialog[open]")) return;
      e.preventDefault();
      onClose(item.id);
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [item.id, onClose]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const st = dragState.current;
      if (!st || !containerRef.current) return;
      const dx = e.clientX - st.startX;
      const dy = e.clientY - st.startY;
      if (st.armed) {
        if (Math.abs(dx) < DRAG_THRESHOLD_PX && Math.abs(dy) < DRAG_THRESHOLD_PX) return;
        st.armed = false;
        setActiveDrag(st.mode);
      }
      const bounds = containerRef.current.getBoundingClientRect();
      if (st.mode === "move") {
        const nx = Math.max(0, Math.min(bounds.width - rect.width, st.origX + dx));
        const ny = Math.max(0, Math.min(bounds.height - rect.height, st.origY + dy));
        onChange(item.id, { ...rect, x: nx, y: ny });
      } else if (st.mode?.startsWith("resize:")) {
        const dir = st.mode.slice("resize:".length) as ResizeDirection;
        let nx = st.origX;
        let ny = st.origY;
        let nw = st.origW;
        let nh = st.origH;

        if (dir.includes("e")) {
          nw = Math.max(MIN_WIDTH, Math.min(bounds.width - st.origX, st.origW + dx));
        }
        if (dir.includes("s")) {
          nh = Math.max(MIN_HEIGHT, Math.min(bounds.height - st.origY, st.origH + dy));
        }
        if (dir.includes("w")) {
          const maxDx = st.origW - MIN_WIDTH;
          const clampedDx = Math.max(-st.origX, Math.min(maxDx, dx));
          nx = st.origX + clampedDx;
          nw = st.origW - clampedDx;
        }
        if (dir.includes("n")) {
          const maxDy = st.origH - MIN_HEIGHT;
          const clampedDy = Math.max(-st.origY, Math.min(maxDy, dy));
          ny = st.origY + clampedDy;
          nh = st.origH - clampedDy;
        }

        onChange(item.id, { ...rect, x: nx, y: ny, width: nw, height: nh });
      }
    };
    const onUp = () => {
      dragState.current = null;
      setActiveDrag(null);
      setArmedDrag(null);
    };
    if (activeDrag !== null || armedDrag !== null) {
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    }
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [activeDrag, armedDrag, containerRef, item.id, onChange, rect]);

  const startDrag = useCallback((mode: DragMode, e: React.MouseEvent | MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onFocus(item.id);
    dragState.current = {
      mode,
      startX: e.clientX,
      startY: e.clientY,
      origX: rect.x,
      origY: rect.y,
      origW: rect.width,
      origH: rect.height,
      armed: false,
    };
    setActiveDrag(mode);
  }, [item.id, onFocus, rect.height, rect.width, rect.x, rect.y]);

  // Arm a deferred drag: only promotes to actual drag once the cursor moves
  // past the threshold. Critically, we DON'T preventDefault/stopPropagation
  // here so a click on a child (button, link, etc.) still fires normally.
  const armDrag = useCallback((mode: DragMode, e: React.MouseEvent | MouseEvent) => {
    onFocus(item.id);
    dragState.current = {
      mode,
      startX: e.clientX,
      startY: e.clientY,
      origX: rect.x,
      origY: rect.y,
      origW: rect.width,
      origH: rect.height,
      armed: true,
    };
    setArmedDrag(mode);
  }, [item.id, onFocus, rect.height, rect.width, rect.x, rect.y]);

  const toggleFullscreen = useCallback((e?: React.MouseEvent) => {
    e?.preventDefault();
    e?.stopPropagation();
    onFocus(item.id);
    const bounds = containerRef.current?.getBoundingClientRect();
    if (!bounds) return;
    if (isFullscreen) {
      const restore = lastWindowedRectRef.current ?? {
        ...rect,
        width: Math.min(720, Math.max(MIN_WIDTH, bounds.width - 32)),
        height: Math.min(520, Math.max(MIN_HEIGHT, bounds.height - 32)),
        x: Math.max(0, (bounds.width - Math.min(720, Math.max(MIN_WIDTH, bounds.width - 32))) / 2),
        y: Math.max(0, (bounds.height - Math.min(520, Math.max(MIN_HEIGHT, bounds.height - 32))) / 2),
      };
      onChange(item.id, {
        ...restore,
        x: Math.max(0, Math.min(bounds.width - restore.width, restore.x)),
        y: Math.max(0, Math.min(bounds.height - restore.height, restore.y)),
        z: rect.z,
      });
      return;
    }
    lastWindowedRectRef.current = rect;
    onChange(item.id, { ...rect, x: 0, y: 0, width: bounds.width, height: bounds.height });
  }, [containerRef, isFullscreen, item.id, onChange, onFocus, rect]);

  const handleBack = useCallback(() => {
    mgr.ensure(item.group);
    mgr.setActive(item.group);
    if (item.paneId) void emit("open-pane", item.paneId);
    onRequestJobsTab();
    onClose(item.id);
  }, [mgr, item.group, item.paneId, item.id, onRequestJobsTab, onClose]);

  const handleToggleAutoYes = () => {
    if (!item.paneId) return;
    const paneQuestion = questions.find((q) => q.pane_id === item.paneId);
    if (paneQuestion) autoYes.handleToggleAutoYes(paneQuestion);
    else {
      const cwd = item.process?.cwd ?? item.job?.work_dir ?? "";
      const title = cwd.replace(/^\/Users\/[^/]+/, "~") || item.label;
      autoYes.handleToggleAutoYesByPaneId(item.paneId, title);
    }
  };

  const hasLiveProcess = Boolean(item.process);
  const hasShell = Boolean(shell);
  const autoYesActive = item.paneId ? autoYes.autoYesPaneIds.has(item.paneId) : false;

  // Wire path bar into modal drag: the grip handle in JobDetailView's header
  // gets our mousedown via the `listeners` shape so dragging it moves the
  // whole modal. No separate modal titlebar is needed.
  const dragHandleProps = useMemo(() => ({
    listeners: {
      onMouseDown: (e: MouseEvent) => startDrag("move", e),
    },
    isDragging: activeDrag === "move",
  }), [startDrag, activeDrag]);

  // Whole top pane (info row + path row, ~80px) drags the modal. We "arm" the
  // drag on mousedown without preventing default so child clicks (3-dot menu,
  // toggles, etc.) still fire normally; the drag only activates once the
  // cursor crosses the threshold.
  const DRAG_REGION_PX = 80;
  const [dragRegionHover, setDragRegionHover] = useState(false);

  const isInteractiveTarget = useCallback((target: HTMLElement | null): boolean => {
    if (!target) return false;
    if (target.closest('.xterm, .xterm-viewport, .xterm-screen')) return true;
    if (target.closest('input, textarea, select, [contenteditable="true"]')) return true;
    // react-native-web TouchableOpacity exposes tabIndex="0" and cursor: pointer
    const el = target.closest('[tabindex="0"], [tabindex="-1"], button, a, [role="button"], [role="menuitem"], [role="switch"]');
    if (el) return true;
    return false;
  }, []);

  const handleShellMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (activeDrag === "move" || armedDrag === "move") {
      if (!dragRegionHover) setDragRegionHover(true);
      return;
    }
    const shellEl = e.currentTarget;
    const shellRect = shellEl.getBoundingClientRect();
    const relY = e.clientY - shellRect.top;
    const inTop = relY <= DRAG_REGION_PX;
    const interactive = isInteractiveTarget(e.target as HTMLElement | null);
    const hovering = inTop && !interactive;
    if (hovering !== dragRegionHover) setDragRegionHover(hovering);
  }, [activeDrag, armedDrag, dragRegionHover, isInteractiveTarget]);

  const handleShellMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    onFocus(item.id);
    if (e.button !== 0) return;
    const shellEl = e.currentTarget;
    const shellRect = shellEl.getBoundingClientRect();
    const relY = e.clientY - shellRect.top;
    if (relY > DRAG_REGION_PX) return;
    if (isInteractiveTarget(e.target as HTMLElement | null)) return;
    armDrag("move", e);
  }, [item.id, onFocus, armDrag, isInteractiveTarget]);

  return (
    <div
      className="mindmap-modal-shell"
      style={{
        left: rect.x,
        top: rect.y,
        width: rect.width,
        height: rect.height,
        zIndex: rect.z + 20,
        cursor: activeDrag === "move" ? "grabbing" : (dragRegionHover ? "grab" : undefined),
      }}
      onMouseDown={handleShellMouseDown}
      onMouseMove={handleShellMouseMove}
      onMouseLeave={() => setDragRegionHover(false)}
      role="dialog"
      aria-modal="false"
    >
      <div className="mindmap-modal-slot-body">
        {hasLiveProcess ? (
          <TmuxPaneDetail
            target={{ kind: "process", process: item.process! }}
            questions={questions}
            onBack={() => onClose(item.id)}
            onDismissQuestion={(qId) => onDismissQuestion(qId)}
            autoYesActive={autoYesActive}
            onToggleAutoYes={handleToggleAutoYes}
            showBackButton={false}
            onStopped={() => onStopped?.(item.id)}
            dragHandleProps={dragHandleProps}
            hidePath
            headerActionsBeforeClose={(
              <button
                type="button"
                className="mindmap-modal-fullscreen"
                onClick={toggleFullscreen}
                aria-label={isFullscreen ? "Restore window" : "Fullscreen"}
                title={isFullscreen ? "Restore window" : "Fullscreen"}
              >
                {isFullscreen ? "\u2750" : "\u26F6"}
              </button>
            )}
          />
        ) : hasShell ? (
          <TmuxPaneDetail
            target={{ kind: "shell", shell: shell! }}
            questions={questions}
            onBack={() => onClose(item.id)}
            onDismissQuestion={(qId) => onDismissQuestion(qId)}
            autoYesActive={autoYesActive}
            onToggleAutoYes={handleToggleAutoYes}
            showBackButton={false}
            onStopped={() => onStopped?.(item.id)}
            dragHandleProps={dragHandleProps}
            hidePath
            headerActionsBeforeClose={(
              <button
                type="button"
                className="mindmap-modal-fullscreen"
                onClick={toggleFullscreen}
                aria-label={isFullscreen ? "Restore window" : "Fullscreen"}
                title={isFullscreen ? "Restore window" : "Fullscreen"}
              >
                {isFullscreen ? "\u2750" : "\u26F6"}
              </button>
            )}
          />
        ) : item.job ? (
          <MindMapJobBody
            item={item}
            transport={transport}
            core={core}
            actions={actions}
            autoYesActive={autoYesActive}
            onToggleAutoYes={item.paneId ? handleToggleAutoYes : undefined}
            dragHandleProps={dragHandleProps}
            onClose={() => onClose(item.id)}
            onRequestJobsTab={onRequestJobsTab}
          />
        ) : (
          <div className="mindmap-modal-meta">
            <div className="row"><span className="k">Group</span><span className="v">{item.group}</span></div>
            <div className="row"><span className="k">State</span><span className="v">{item.state}</span></div>
            <p className="hint">No live terminal for this item. Use the back arrow to open it in Jobs.</p>
            <div className="mindmap-popup-actions">
              <button className="btn btn-sm" onClick={handleBack}>Open in Jobs</button>
              <button className="btn btn-sm" onClick={() => onClose(item.id)}>Close</button>
            </div>
          </div>
        )}
      </div>
      {(["n", "s", "e", "w", "ne", "nw", "se", "sw"] as ResizeDirection[]).map((dir) => (
        <div
          key={dir}
          className={`mindmap-modal-resize mindmap-modal-resize-${dir}`}
          onMouseDown={(e) => startDrag(`resize:${dir}`, e)}
          aria-label={`Resize ${dir}`}
          title="Drag to resize"
        />
      ))}
    </div>
  );
}
