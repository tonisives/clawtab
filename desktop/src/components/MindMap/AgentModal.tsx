import { useCallback, useEffect, useRef, useState } from "react";
import { emit } from "@tauri-apps/api/event";
import { TmuxPaneDetail } from "../TmuxPaneDetail";
import { useWorkspaceManager } from "../../workspace/WorkspaceManager";
import type { useAutoYes } from "../../hooks/useAutoYes";
import type { ClaudeQuestion } from "@clawtab/shared";
import type { MindItem } from "./useRecencyLayout";

function statusLabel(state: string): string {
  switch (state) {
    case "running": return "Running";
    case "idle": return "Idle";
    case "success": return "Completed";
    case "failed": return "Failed";
    case "paused": return "Paused";
    default: return state;
  }
}

export interface ModalRect {
  x: number;
  y: number;
  width: number;
  height: number;
  z: number;
}

interface AgentModalProps {
  item: MindItem;
  rect: ModalRect;
  containerRef: React.RefObject<HTMLDivElement | null>;
  questions: ClaudeQuestion[];
  autoYes: ReturnType<typeof useAutoYes>;
  onDismissQuestion: (questionId: string) => void;
  onClose: (id: string) => void;
  onChange: (id: string, rect: ModalRect) => void;
  onFocus: (id: string) => void;
  onRequestJobsTab: () => void;
}

type DragMode = null | "move" | "resize";

export function AgentModal({
  item,
  rect,
  containerRef,
  questions,
  autoYes,
  onDismissQuestion,
  onClose,
  onChange,
  onFocus,
  onRequestJobsTab,
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
  } | null>(null);
  const [activeDrag, setActiveDrag] = useState<DragMode>(null);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose(item.id);
      }
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
      const bounds = containerRef.current.getBoundingClientRect();
      if (st.mode === "move") {
        const nx = Math.max(0, Math.min(bounds.width - rect.width, st.origX + dx));
        const ny = Math.max(0, Math.min(bounds.height - rect.height, st.origY + dy));
        onChange(item.id, { ...rect, x: nx, y: ny });
      } else if (st.mode === "resize") {
        const nw = Math.max(320, Math.min(bounds.width - st.origX, st.origW + dx));
        const nh = Math.max(220, Math.min(bounds.height - st.origY, st.origH + dy));
        onChange(item.id, { ...rect, width: nw, height: nh });
      }
    };
    const onUp = () => {
      dragState.current = null;
      setActiveDrag(null);
    };
    if (activeDrag) {
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    }
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [activeDrag, containerRef, item.id, onChange, rect]);

  const startDrag = useCallback((mode: DragMode, e: React.MouseEvent) => {
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
    };
    setActiveDrag(mode);
  }, [item.id, onFocus, rect.height, rect.width, rect.x, rect.y]);

  const handleOpenInJobs = () => {
    mgr.ensure(item.group);
    mgr.setActive(item.group);
    if (item.paneId) void emit("open-pane", item.paneId);
    onRequestJobsTab();
    onClose(item.id);
  };

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
  const autoYesActive = item.paneId ? autoYes.autoYesPaneIds.has(item.paneId) : false;

  return (
    <div
      className="mindmap-modal-shell"
      style={{
        left: rect.x,
        top: rect.y,
        width: rect.width,
        height: rect.height,
        zIndex: rect.z,
      }}
      onMouseDown={() => onFocus(item.id)}
      role="dialog"
      aria-modal="false"
    >
      <div
        className="mindmap-modal-slot-header"
        onMouseDown={(e) => startDrag("move", e)}
      >
        <div className="mindmap-modal-slot-title">
          <span className="title">{item.label}</span>
          {item.sublabel && <span className="sub">{item.sublabel}</span>}
        </div>
        <div className="mindmap-modal-slot-actions" onMouseDown={(e) => e.stopPropagation()}>
          <span className={`mindmap-status-badge ${item.state}`}>
            {item.asking ? "Asking" : item.working ? "Working" : statusLabel(item.state)}
          </span>
          <button className="btn btn-sm" onClick={handleOpenInJobs} title="Open in Jobs tab">
            Open in Jobs
          </button>
          <button className="btn btn-sm" onClick={() => onClose(item.id)} title="Close">
            Close
          </button>
        </div>
      </div>
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
            hidePath
          />
        ) : (
          <div className="mindmap-modal-meta">
            <div className="row"><span className="k">Group</span><span className="v">{item.group}</span></div>
            <div className="row"><span className="k">State</span><span className="v">{statusLabel(item.state)}</span></div>
            {item.job?.work_dir && (
              <div className="row"><span className="k">Work dir</span><span className="v">{item.job.work_dir}</span></div>
            )}
            {item.job?.cron && (
              <div className="row"><span className="k">Cron</span><span className="v">{item.job.cron}</span></div>
            )}
            <p className="hint">No live terminal for this item. Use "Open in Jobs" to start or focus it.</p>
          </div>
        )}
      </div>
      <div
        className="mindmap-modal-resize"
        onMouseDown={(e) => startDrag("resize", e)}
        aria-label="Resize"
        title="Drag to resize"
      />
    </div>
  );
}
