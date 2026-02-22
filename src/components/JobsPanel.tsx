import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { AppSettings, Job, JobStatus, RunRecord } from "../types";
import { JobEditor } from "./JobEditor";
import { SamplePicker } from "./SamplePicker";
import { ConfirmDialog, DeleteButton } from "./ConfirmDialog";
import { GearIcon } from "./icons";
import { LogViewer } from "./LogViewer";

const EDITOR_LABELS: Record<string, string> = {
  nvim: "Neovim",
  vim: "Vim",
  code: "VS Code",
  codium: "VSCodium",
  zed: "Zed",
  hx: "Helix",
  subl: "Sublime Text",
  emacs: "Emacs",
};

function StatusBadge({ status }: { status: JobStatus | undefined }) {
  if (!status || status.state === "idle") {
    return <span className="status-badge status-idle">idle</span>;
  }
  if (status.state === "running") {
    return <span className="status-badge status-running">running</span>;
  }
  if (status.state === "success") {
    return <span className="status-badge status-success">success</span>;
  }
  if (status.state === "failed") {
    return (
      <span className="status-badge status-failed">
        failed ({status.exit_code})
      </span>
    );
  }
  if (status.state === "paused") {
    return <span className="status-badge status-paused">paused</span>;
  }
  return null;
}

function groupJobs(jobs: Job[]): Map<string, Job[]> {
  const groups = new Map<string, Job[]>();
  for (const job of jobs) {
    const group = job.group || "default";
    const list = groups.get(group) ?? [];
    list.push(job);
    groups.set(group, list);
  }
  return groups;
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function useJobRuns(jobName: string) {
  const [runs, setRuns] = useState<RunRecord[] | null>(null);

  const load = async () => {
    try {
      const loaded = await invoke<RunRecord[]>("get_job_runs", { jobName });
      setRuns(loaded);
    } catch (e) {
      console.error("Failed to load runs:", e);
    }
  };

  useEffect(() => { load(); }, [jobName]);

  return { runs, reload: load };
}

function DragGrip() {
  return (
    <span
      className="drag-grip"
      title="Drag to reorder"
      style={{
        cursor: "grab",
        display: "inline-flex",
        flexDirection: "column",
        gap: 2,
        padding: "2px 4px",
        opacity: 0.4,
        userSelect: "none",
      }}
    >
      <svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor">
        <circle cx="2" cy="2" r="1.2" />
        <circle cx="8" cy="2" r="1.2" />
        <circle cx="2" cy="7" r="1.2" />
        <circle cx="8" cy="7" r="1.2" />
        <circle cx="2" cy="12" r="1.2" />
        <circle cx="8" cy="12" r="1.2" />
      </svg>
    </span>
  );
}


interface JobsPanelProps {
  pendingTemplateId?: string | null;
  onTemplateHandled?: () => void;
  createJobKey?: number;
}

export function JobsPanel({ pendingTemplateId, onTemplateHandled, createJobKey }: JobsPanelProps) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [statuses, setStatuses] = useState<Record<string, JobStatus>>({});
  const [editingJob, setEditingJob] = useState<Job | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [expandedJobs, setExpandedJobs] = useState<Set<string>>(new Set());
  const [groupOrder, setGroupOrder] = useState<string[]>([]);
  const [showAgentPrompt, setShowAgentPrompt] = useState(false);

  const loadJobs = async () => {
    try {
      const loaded = await invoke<Job[]>("get_jobs");
      setJobs(loaded);
    } catch (e) {
      console.error("Failed to load jobs:", e);
    }
  };

  const loadStatuses = async () => {
    try {
      const loaded = await invoke<Record<string, JobStatus>>(
        "get_job_statuses"
      );
      setStatuses(loaded);
    } catch (e) {
      console.error("Failed to load statuses:", e);
    }
  };

  const loadSettings = async () => {
    try {
      const s = await invoke<AppSettings>("get_settings");
      if (s.group_order && s.group_order.length > 0) {
        setGroupOrder(s.group_order);
      }
    } catch (e) {
      console.error("Failed to load settings:", e);
    }
  };

  const saveGroupOrder = async (order: string[]) => {
    setGroupOrder(order);
    try {
      const s = await invoke<AppSettings>("get_settings");
      await invoke("set_settings", { newSettings: { ...s, group_order: order } });
    } catch (e) {
      console.error("Failed to save group order:", e);
    }
  };

  useEffect(() => {
    loadJobs();
    loadStatuses();
    loadSettings();
    const interval = setInterval(loadStatuses, 5000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (pendingTemplateId) {
      setShowPicker(true);
    }
  }, [pendingTemplateId]);

  useEffect(() => {
    if (createJobKey && createJobKey > 0) {
      setShowPicker(true);
    }
  }, [createJobKey]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor),
  );

  const handleToggle = async (name: string) => {
    try {
      await invoke("toggle_job", { name });
      await loadJobs();
    } catch (e) {
      console.error("Failed to toggle job:", e);
    }
  };

  const handleRunNow = async (name: string) => {
    try {
      await invoke("run_job_now", { name });
      setTimeout(loadStatuses, 500);
    } catch (e) {
      console.error("Failed to run job:", e);
    }
  };

  const handlePause = async (name: string) => {
    try {
      await invoke("pause_job", { name });
      setTimeout(loadStatuses, 500);
    } catch (e) {
      console.error("Failed to pause job:", e);
    }
  };

  const handleResume = async (name: string) => {
    try {
      await invoke("resume_job", { name });
      setTimeout(loadStatuses, 500);
    } catch (e) {
      console.error("Failed to resume job:", e);
    }
  };

  const handleRestart = async (name: string) => {
    try {
      await invoke("restart_job", { name });
      setTimeout(loadStatuses, 500);
    } catch (e) {
      console.error("Failed to restart job:", e);
    }
  };

  const handleOpen = async (name: string) => {
    try {
      await invoke("focus_job_window", { name });
    } catch (e) {
      console.error("Failed to open job window:", e);
    }
  };

  const handleDelete = async (name: string) => {
    try {
      await invoke("delete_job", { name });
      await loadJobs();
    } catch (e) {
      console.error("Failed to delete job:", e);
    }
  };

  const handleSave = async (job: Job) => {
    setSaveError(null);
    try {
      const renamed = editingJob && job.name !== editingJob.name;
      if (renamed) {
        await invoke("delete_job", { name: editingJob.name });
        job = { ...job, slug: "" };
      }
      await invoke("save_job", { job });
      await loadJobs();
      setEditingJob(null);
      setIsCreating(false);
    } catch (e) {
      const msg = typeof e === "string" ? e : String(e);
      setSaveError(msg);
      console.error("Failed to save job:", e);
    }
  };

  const handleDuplicate = async (job: Job) => {
    const existingNames = new Set(jobs.map((j) => j.name));
    let copyName = `${job.name}-copy`;
    let i = 2;
    while (existingNames.has(copyName)) {
      copyName = `${job.name}-copy-${i}`;
      i++;
    }
    const dup: Job = { ...job, name: copyName, slug: "", enabled: false };
    try {
      await invoke("save_job", { job: dup });
      await loadJobs();
    } catch (e) {
      console.error("Failed to duplicate job:", e);
    }
  };

  const toggleGroup = (group: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(group)) {
        next.delete(group);
      } else {
        next.add(group);
      }
      return next;
    });
  };

  const toggleJobExpand = (name: string) => {
    setExpandedJobs((prev) => {
      const next = new Set(prev);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  };

  // Scroll tab-content to top when switching to editor/picker views
  useEffect(() => {
    if (editingJob || isCreating || showPicker) {
      const tabContent = document.querySelector(".tab-content");
      if (tabContent) tabContent.scrollTop = 0;
    }
  }, [editingJob, isCreating, showPicker]);

  if (showPicker) {
    return (
      <SamplePicker
        autoCreateTemplateId={pendingTemplateId ?? undefined}
        onCreated={() => {
          setShowPicker(false);
          onTemplateHandled?.();
          loadJobs();
        }}
        onBlank={() => {
          setShowPicker(false);
          onTemplateHandled?.();
          setIsCreating(true);
        }}
        onCancel={() => {
          setShowPicker(false);
          onTemplateHandled?.();
        }}
      />
    );
  }

  if (editingJob || isCreating) {
    return (
      <>
        {saveError && (
          <div style={{ padding: "8px 12px", marginBottom: 12, background: "var(--danger-bg, #2d1b1b)", border: "1px solid var(--danger, #e55)", borderRadius: 4, fontSize: 13 }}>
            Save failed: {saveError}
          </div>
        )}
        <JobEditor
          job={editingJob}
          onSave={handleSave}
          onCancel={() => {
            setEditingJob(null);
            setIsCreating(false);
            setSaveError(null);
          }}
        />
      </>
    );
  }

  const grouped = groupJobs(jobs);
  const allGroupNames = new Set(grouped.keys());
  allGroupNames.add("agent");

  const sortedGroups = sortGroupNames(Array.from(allGroupNames), groupOrder);

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIdx = sortedGroups.indexOf(String(active.id));
    const newIdx = sortedGroups.indexOf(String(over.id));
    if (oldIdx === -1 || newIdx === -1) return;
    const newOrder = [...sortedGroups];
    newOrder.splice(oldIdx, 1);
    newOrder.splice(newIdx, 0, String(active.id));
    saveGroupOrder(newOrder);
  };

  const renderJobRows = (job: Job) => {
    const status = statuses[job.name];
    const state = status?.state ?? "idle";
    const isExpanded = expandedJobs.has(job.name);

    return [
      <JobRow
        key={job.name}
        job={job}
        state={state}
        status={status}
        isExpanded={isExpanded}
        onToggleEnabled={() => handleToggle(job.name)}
        onRun={() => handleRunNow(job.name)}
        onPause={() => handlePause(job.name)}
        onResume={() => handleResume(job.name)}
        onRestart={() => handleRestart(job.name)}
        onOpen={() => handleOpen(job.name)}
        onEdit={() => setEditingJob(job)}
        onDuplicate={() => handleDuplicate(job)}
        onDelete={() => handleDelete(job.name)}
        onToggleExpand={() => toggleJobExpand(job.name)}
      />,
      state === "running" && status?.state === "running" && status.pane_id && (
        <RunningLogs key={`${job.name}-live`} jobName={job.name} />
      ),
      isExpanded && (
        <RunsPanel key={`${job.name}-runs`} jobName={job.name} jobState={state} />
      ),
    ];
  };

  const tableHead = (
    <thead>
      <tr>
        <th className="col-expand"></th>
        <th className="col-toggle" title="Enabled"></th>
        <th className="col-name">Name</th>
        <th className="col-type">Type</th>
        <th className="col-cron">Cron</th>
        <th className="col-status">Status</th>
        <th className="col-actions"></th>
        <th className="col-gear"></th>
      </tr>
    </thead>
  );

  return (
    <div className="settings-section">
      <div className="section-header">
        <h2>Jobs</h2>
        <div className="btn-group">
          <button
            className="btn btn-primary btn-sm"
            onClick={() => setShowPicker(true)}
          >
            Add Job
          </button>
        </div>
      </div>

      {jobs.length === 0 && !sortedGroups.includes("agent") && (
        <div className="empty-state">
          <p>No jobs configured yet.</p>
          <button
            className="btn btn-primary"
            onClick={() => setShowPicker(true)}
          >
            Create your first job
          </button>
        </div>
      )}

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={sortedGroups}
          strategy={verticalListSortingStrategy}
        >
          {sortedGroups.map((group) => (
            <SortableGroup
              key={group}
              id={group}
              group={group}
              grouped={grouped}
              statuses={statuses}
              collapsedGroups={collapsedGroups}
              expandedJobs={expandedJobs}
              tableHead={tableHead}
              renderJobRows={renderJobRows}
              onToggleGroup={() => toggleGroup(group)}
              onToggleJobExpand={toggleJobExpand}
              onShowAgentPrompt={() => setShowAgentPrompt(true)}
              onOpenAgent={() => handleOpen("agent")}
            />
          ))}
        </SortableContext>
      </DndContext>

      {showAgentPrompt && (
        <AgentPromptModal
          onRun={async (prompt) => {
            try {
              await invoke("run_agent", { prompt });
              setShowAgentPrompt(false);
              setTimeout(loadStatuses, 500);
            } catch (e) {
              console.error("Failed to run agent:", e);
            }
          }}
          onCancel={() => setShowAgentPrompt(false)}
        />
      )}
    </div>
  );
}

function sortGroupNames(groups: string[], savedOrder: string[]): string[] {
  const orderMap = new Map(savedOrder.map((g, i) => [g, i]));
  return groups.sort((a, b) => {
    const aIdx = orderMap.get(a);
    const bIdx = orderMap.get(b);
    if (aIdx !== undefined && bIdx !== undefined) return aIdx - bIdx;
    if (aIdx !== undefined) return -1;
    if (bIdx !== undefined) return 1;
    if (a === "agent") return -1;
    if (b === "agent") return 1;
    if (a === "default") return -1;
    if (b === "default") return 1;
    return a.localeCompare(b);
  });
}

function SortableGroup({
  id,
  group,
  grouped,
  statuses,
  collapsedGroups,
  expandedJobs,
  tableHead,
  renderJobRows,
  onToggleGroup,
  onToggleJobExpand,
  onShowAgentPrompt,
  onOpenAgent,
}: {
  id: string;
  group: string;
  grouped: Map<string, Job[]>;
  statuses: Record<string, JobStatus>;
  collapsedGroups: Set<string>;
  expandedJobs: Set<string>;
  tableHead: React.ReactNode;
  renderJobRows: (job: Job) => React.ReactNode[];
  onToggleGroup: () => void;
  onToggleJobExpand: (name: string) => void;
  onShowAgentPrompt: () => void;
  onOpenAgent: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });

  const style = {
    transform: CSS.Transform.toString(
      transform ? { ...transform, scaleX: 1, scaleY: 1 } : null
    ),
    transition: isDragging ? "none" : transition || "transform 200ms ease",
    opacity: isDragging ? 0.5 : 1,
  };

  const isCollapsed = collapsedGroups.has(group);

  if (group === "agent") {
    const agentStatus = statuses["agent"];
    const agentState = agentStatus?.state ?? "idle";
    const isAgentExpanded = expandedJobs.has("agent");

    return (
      <div ref={setNodeRef} style={style} className="field-group">
        <GroupHeader
          displayName="Agent"
          count={null}
          isCollapsed={isCollapsed}
          onToggle={onToggleGroup}
          dragAttributes={attributes}
          dragListeners={listeners}
        />
        {!isCollapsed && (
          <table className="data-table">
            {tableHead}
            <tbody>
              <AgentRow
                status={agentStatus}
                state={agentState}
                isExpanded={isAgentExpanded}
                onRun={onShowAgentPrompt}
                onOpen={onOpenAgent}
                onToggleExpand={() => onToggleJobExpand("agent")}
              />
              {agentState === "running" && agentStatus?.state === "running" && agentStatus.pane_id && (
                <RunningLogs jobName="agent" />
              )}
              {isAgentExpanded && (
                <RunsPanel jobName="agent" jobState={agentState} />
              )}
            </tbody>
          </table>
        )}
      </div>
    );
  }

  const groupJobList = grouped.get(group) ?? [];
  if (groupJobList.length === 0) return null;

  const displayName = group === "default" ? "General" : group;

  return (
    <div ref={setNodeRef} style={style} className="field-group">
      <GroupHeader
        displayName={displayName}
        count={groupJobList.length}
        isCollapsed={isCollapsed}
        onToggle={onToggleGroup}
        dragAttributes={attributes}
        dragListeners={listeners}
      />
      {!isCollapsed && (
        <table className="data-table">
          {tableHead}
          <tbody>
            {groupJobList.flatMap(renderJobRows)}
          </tbody>
        </table>
      )}
    </div>
  );
}

function GroupHeader({
  displayName,
  count,
  isCollapsed,
  onToggle,
  dragAttributes,
  dragListeners,
}: {
  displayName: string;
  count: number | null;
  isCollapsed: boolean;
  onToggle: () => void;
  dragAttributes: ReturnType<typeof useSortable>["attributes"];
  dragListeners: ReturnType<typeof useSortable>["listeners"];
}) {
  return (
    <div
      className="field-group-title"
      style={{ display: "flex", alignItems: "center", gap: 6 }}
    >
      <button
        onClick={onToggle}
        style={{
          background: "none",
          border: "none",
          color: "var(--text-secondary)",
          cursor: "pointer",
          padding: 0,
          fontSize: 11,
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: "0.5px",
          display: "flex",
          alignItems: "center",
          gap: 6,
          flex: 1,
        }}
      >
        <span style={{ fontFamily: "monospace", fontSize: 9 }}>
          {isCollapsed ? "\u25B6" : "\u25BC"}
        </span>
        {displayName}
        {count !== null && (
          <span style={{ fontWeight: 400, fontSize: 10, opacity: 0.7 }}>
            ({count})
          </span>
        )}
      </button>
      <div {...dragAttributes} {...dragListeners}>
        <DragGrip />
      </div>
    </div>
  );
}

function AgentRow({
  status,
  state,
  isExpanded,
  onRun,
  onOpen,
  onToggleExpand,
}: {
  status: JobStatus | undefined;
  state: string;
  isExpanded: boolean;
  onRun: () => void;
  onOpen: () => void;
  onToggleExpand: () => void;
}) {
  const { runs } = useJobRuns("agent");
  const hasRuns = runs !== null && runs.length > 0;

  return (
    <tr className={isExpanded ? "row-expanded" : undefined}>
      <td className="col-expand">
        <button
          onClick={hasRuns ? onToggleExpand : undefined}
          title="Runs"
          disabled={!hasRuns}
          className="expand-btn"
          style={{ opacity: hasRuns ? 1 : 0.3 }}
        >
          <span style={{ fontFamily: "monospace", fontSize: 9 }}>
            {isExpanded ? "\u25BC" : "\u25B6"}
          </span>
        </button>
      </td>
      <td className="col-toggle">
        <input
          type="checkbox"
          className="toggle-switch"
          checked={true}
          disabled
          title="Enabled"
        />
      </td>
      <td className="col-name">agent</td>
      <td className="col-type">claude</td>
      <td className="col-cron">
        <code>manual</code>
      </td>
      <td className="col-status">
        <StatusBadge status={status} />
      </td>
      <td className="col-actions actions">
        <div className="btn-group">
          {state === "running" && (
            <button className="btn btn-sm" onClick={onOpen}>
              Open
            </button>
          )}
          {(state === "idle" || !status || state === "success" || state === "failed") && (
            <button className="btn btn-primary btn-sm" onClick={onRun}>
              {state === "success" ? "Run Again" : "Run"}
            </button>
          )}
        </div>
      </td>
      <td className="col-gear">
        <button
          title="Settings (not available for agent)"
          disabled
          style={{
            background: "none",
            border: "none",
            color: "var(--text-secondary)",
            opacity: 0.3,
            cursor: "not-allowed",
            padding: "2px 4px",
            lineHeight: 1,
            display: "inline-flex",
            alignItems: "center",
          }}
        >
          <GearIcon size={16} />
        </button>
      </td>
    </tr>
  );
}

function AgentPromptModal({
  onRun,
  onCancel,
}: {
  onRun: (prompt: string) => void;
  onCancel: () => void;
}) {
  const [prompt, setPrompt] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (prompt.trim()) onRun(prompt.trim());
    }
    if (e.key === "Escape") {
      onCancel();
    }
  };

  return (
    <div className="sample-modal-overlay" onClick={onCancel}>
      <div className="sample-modal" onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginBottom: 12 }}>Run Agent</h3>
        <div className="form-group" style={{ marginBottom: 12 }}>
          <label>Prompt</label>
          <textarea
            ref={inputRef}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Enter a prompt for the agent..."
            rows={4}
            style={{ maxWidth: "100%" }}
          />
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button className="btn btn-sm" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="btn btn-primary btn-sm"
            onClick={() => { if (prompt.trim()) onRun(prompt.trim()); }}
            disabled={!prompt.trim()}
          >
            Run
          </button>
        </div>
      </div>
    </div>
  );
}

function JobRow({
  job,
  state,
  status,
  isExpanded,
  onToggleEnabled,
  onRun,
  onPause,
  onResume,
  onRestart,
  onOpen,
  onEdit,
  onDuplicate,
  onDelete,
  onToggleExpand,
}: {
  job: Job;
  state: string;
  status: JobStatus | undefined;
  isExpanded: boolean;
  onToggleEnabled: () => void;
  onRun: () => void;
  onPause: () => void;
  onResume: () => void;
  onRestart: () => void;
  onOpen: () => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onToggleExpand: () => void;
}) {
  const { runs } = useJobRuns(job.name);
  const hasRuns = runs !== null && runs.length > 0;
  const [showConfirm, setShowConfirm] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showMenu) return;
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowMenu(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [showMenu]);

  return (
    <tr className={isExpanded ? "row-expanded" : undefined}>
      <td className="col-expand">
        <button
          onClick={hasRuns ? onToggleExpand : undefined}
          title="Runs"
          disabled={!hasRuns}
          className="expand-btn"
          style={{ opacity: hasRuns ? 1 : 0.3 }}
        >
          <span style={{ fontFamily: "monospace", fontSize: 9 }}>
            {isExpanded ? "\u25BC" : "\u25B6"}
          </span>
        </button>
      </td>
      <td className="col-toggle">
        <input
          type="checkbox"
          className="toggle-switch"
          checked={job.enabled}
          onChange={onToggleEnabled}
          title="Enabled"
        />
      </td>
      <td className="col-name">
        {job.name}
      </td>
      <td className="col-type">{job.job_type}</td>
      <td className="col-cron">
        <code>{job.cron || "manual"}</code>
      </td>
      <td className="col-status">
        <StatusBadge status={status} />
      </td>
      <td className="col-actions actions">
        <div className="btn-group">
          {state === "running" && (
            <>
              <button className="btn btn-sm" onClick={onOpen}>
                Open
              </button>
              <button className="btn btn-sm" onClick={onPause}>
                Pause
              </button>
            </>
          )}
          {state === "paused" && (
            <button className="btn btn-primary btn-sm" onClick={onResume}>
              Resume
            </button>
          )}
          {state === "failed" && (
            <button className="btn btn-primary btn-sm" onClick={onRestart}>
              Restart
            </button>
          )}
          {state === "success" && (
            <button className="btn btn-primary btn-sm" onClick={onRun}>
              Run Again
            </button>
          )}
          {(state === "idle" || !status) && (
            <button className="btn btn-primary btn-sm" onClick={onRun}>
              Run
            </button>
          )}
        </div>
      </td>
      <td className="col-gear">
        <div ref={menuRef} style={{ position: "relative" }}>
          <button
            onClick={() => setShowMenu((v) => !v)}
            title="Settings"
            style={{
              background: "none",
              border: "none",
              color: "var(--text-secondary)",
              cursor: "pointer",
              padding: "2px 4px",
              lineHeight: 1,
              display: "inline-flex",
              alignItems: "center",
            }}
          >
            <GearIcon size={16} />
          </button>
          {showMenu && (
            <div className="job-action-menu">
              <button
                className="job-action-menu-item"
                onClick={() => { setShowMenu(false); onEdit(); }}
              >
                Edit
              </button>
              <button
                className="job-action-menu-item"
                onClick={() => { setShowMenu(false); onDuplicate(); }}
              >
                Duplicate
              </button>
              <button
                className="job-action-menu-item job-action-menu-item-danger"
                onClick={() => { setShowMenu(false); setShowConfirm(true); }}
              >
                Delete
              </button>
            </div>
          )}
        </div>
      </td>
      {showConfirm && (
        <ConfirmDialog
          message={`Delete job "${job.name}"? This cannot be undone.`}
          onConfirm={() => { onDelete(); setShowConfirm(false); }}
          onCancel={() => setShowConfirm(false)}
        />
      )}
    </tr>
  );
}

function buildLogContent(run: RunRecord): string {
  let content = "";
  if (run.stdout) {
    content += run.stdout;
  }
  if (run.stderr) {
    if (content) content += "\n";
    content += "--- stderr ---\n" + run.stderr;
  }
  return content || "(no output)";
}

function RunningLogs({ jobName }: { jobName: string }) {
  const [logs, setLogs] = useState("");
  const preRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    let active = true;
    const poll = async () => {
      try {
        const result = await invoke<string>("get_running_job_logs", { name: jobName });
        if (active) setLogs(result);
      } catch {
        // Job may have stopped between polls
      }
    };
    poll();
    const interval = setInterval(poll, 3000);
    return () => { active = false; clearInterval(interval); };
  }, [jobName]);

  useEffect(() => {
    if (preRef.current) {
      preRef.current.scrollTop = preRef.current.scrollHeight;
    }
  }, [logs]);

  if (!logs) return null;

  return (
    <tr>
      <td colSpan={8} style={{ padding: "0 12px 4px", border: "none" }}>
        <pre ref={preRef} style={{
          margin: 0,
          padding: "6px 8px",
          fontSize: 11,
          lineHeight: 1.4,
          background: "var(--bg-secondary, #1a1a1a)",
          borderRadius: 4,
          overflowY: "auto",
          whiteSpace: "pre-wrap",
          wordBreak: "break-all",
          height: 100,
          minHeight: 40,
          maxHeight: 400,
          resize: "vertical",
          color: "var(--text-secondary)",
        }}>{logs}</pre>
      </td>
    </tr>
  );
}

function RunsPanel({ jobName, jobState }: { jobName: string; jobState: string }) {
  const { runs, reload } = useJobRuns(jobName);
  const [confirmRunId, setConfirmRunId] = useState<string | null>(null);
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const [selectedRuns, setSelectedRuns] = useState<Set<string>>(new Set());
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  const [preferredEditor, setPreferredEditor] = useState("nvim");

  useEffect(() => { reload(); }, []);

  useEffect(() => {
    invoke<AppSettings>("get_settings").then((s) => {
      setPreferredEditor(s.preferred_editor);
    });
  }, []);

  const handleDeleteRun = async (runId: string) => {
    try {
      await invoke("delete_run", { runId });
      reload();
    } catch (e) {
      console.error("Failed to delete run:", e);
    }
  };

  const handleDeleteSelected = async () => {
    try {
      await invoke("delete_runs", { runIds: Array.from(selectedRuns) });
      setSelectedRuns(new Set());
      reload();
    } catch (e) {
      console.error("Failed to delete runs:", e);
    }
  };

  const handleOpenLog = async (runId: string) => {
    try {
      await invoke("open_run_log", { runId });
    } catch (e) {
      console.error("Failed to open log:", e);
    }
  };

  const toggleRunSelected = (runId: string) => {
    setSelectedRuns((prev) => {
      const next = new Set(prev);
      if (next.has(runId)) {
        next.delete(runId);
      } else {
        next.add(runId);
      }
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (!runs) return;
    if (selectedRuns.size === runs.length) {
      setSelectedRuns(new Set());
    } else {
      setSelectedRuns(new Set(runs.map((r) => r.id)));
    }
  };

  const exitCodeClass = (run: RunRecord) => {
    if (run.exit_code === null) {
      if (run.finished_at || jobState !== "running") return "error";
      return "running";
    }
    if (run.exit_code === 0) return "idle";
    return "error";
  };

  const exitCodeLabel = (run: RunRecord) => {
    if (run.exit_code === null) {
      if (run.finished_at || jobState !== "running") return "interrupted";
      return "running";
    }
    if (run.exit_code === 0) return "ok";
    return `exit ${run.exit_code}`;
  };

  const hasSelection = selectedRuns.size > 0;

  return (
    <tr>
      <td colSpan={8} style={{ padding: "0 0 8px", border: "none" }}>
        {runs === null ? (
          <span className="text-secondary" style={{ fontSize: 12, padding: "0 12px" }}>Loading...</span>
        ) : runs.length === 0 ? (
          <span className="text-secondary" style={{ fontSize: 12, padding: "0 12px" }}>No run history</span>
        ) : (
          <>
            {hasSelection && (
              <div style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "4px 12px",
                fontSize: 12,
                color: "var(--text-secondary)",
              }}>
                <span>{selectedRuns.size} selected</span>
                <button
                  className="btn btn-sm"
                  style={{ fontSize: 11, color: "var(--danger-color)" }}
                  onClick={() => setConfirmBulkDelete(true)}
                >
                  Delete selected
                </button>
              </div>
            )}
            <table className="data-table runs-table" style={{ fontSize: 12 }}>
              <thead>
                <tr>
                  <th className="col-run-expand"></th>
                  <th style={{ fontSize: 10, padding: "4px 12px" }}>Status</th>
                  <th style={{ fontSize: 10, padding: "4px 12px" }}>Trigger</th>
                  <th style={{ fontSize: 10, padding: "4px 12px" }}>Started</th>
                  <th style={{ fontSize: 10, padding: "4px 12px" }}>Duration</th>
                  <th style={{ fontSize: 10, padding: "4px 8px", width: 28 }}></th>
                  <th style={{ width: 24, padding: "4px" }}>
                    <input
                      type="checkbox"
                      checked={runs.length > 0 && selectedRuns.size === runs.length}
                      onChange={toggleSelectAll}
                      title="Select all"
                      style={{ margin: 0 }}
                    />
                  </th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => {
                  const duration = run.finished_at
                    ? `${((new Date(run.finished_at).getTime() - new Date(run.started_at).getTime()) / 1000).toFixed(1)}s`
                    : "...";
                  const isLogExpanded = expandedRunId === run.id;

                  return [
                    <tr key={run.id} className={isLogExpanded ? "row-expanded" : undefined}>
                      <td className="col-run-expand">
                        <button
                          className="expand-btn"
                          onClick={() => setExpandedRunId(isLogExpanded ? null : run.id)}
                          title="Logs"
                        >
                          <span style={{ fontFamily: "monospace", fontSize: 9 }}>
                            {isLogExpanded ? "\u25BC" : "\u25B6"}
                          </span>
                        </button>
                      </td>
                      <td>
                        <span className={`status-dot ${exitCodeClass(run)}`} />
                        {exitCodeLabel(run)}
                      </td>
                      <td>{run.trigger}</td>
                      <td>{formatTime(run.started_at)}</td>
                      <td>{duration}</td>
                      <td style={{ textAlign: "right", padding: "0 8px" }}>
                        <DeleteButton
                          onClick={() => setConfirmRunId(run.id)}
                          title="Delete this run"
                          size={11}
                        />
                      </td>
                      <td style={{ width: 24, padding: "4px" }}>
                        <input
                          type="checkbox"
                          checked={selectedRuns.has(run.id)}
                          onChange={() => toggleRunSelected(run.id)}
                          style={{ margin: 0 }}
                        />
                      </td>
                    </tr>,
                    isLogExpanded && (
                      <tr key={`${run.id}-logs`}>
                        <td colSpan={7} style={{ padding: "0 12px 8px", border: "none" }}>
                          <LogViewer content={buildLogContent(run)} />
                          <button
                            className="btn btn-sm"
                            style={{ marginTop: 6, fontSize: 11 }}
                            onClick={() => handleOpenLog(run.id)}
                          >
                            Open in {EDITOR_LABELS[preferredEditor] ?? preferredEditor}
                          </button>
                        </td>
                      </tr>
                    ),
                  ];
                })}
              </tbody>
            </table>
          </>
        )}
        {confirmRunId && (
          <ConfirmDialog
            message="Delete this run record? This cannot be undone."
            onConfirm={() => { handleDeleteRun(confirmRunId); setConfirmRunId(null); }}
            onCancel={() => setConfirmRunId(null)}
          />
        )}
        {confirmBulkDelete && (
          <ConfirmDialog
            message={`Delete ${selectedRuns.size} run record${selectedRuns.size === 1 ? "" : "s"}? This cannot be undone.`}
            onConfirm={() => { handleDeleteSelected(); setConfirmBulkDelete(false); }}
            onCancel={() => setConfirmBulkDelete(false)}
          />
        )}
      </td>
    </tr>
  );
}
