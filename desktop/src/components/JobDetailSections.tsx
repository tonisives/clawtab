import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AgentModelOption, JobUpdate, RemoteJob, JobStatus, ProcessProvider } from "@clawtab/shared";
import { AgentSelector, agentSelectionLabel, JobDetailView, useJobDetail, useLogBuffer } from "@clawtab/shared";
import type { AppSettings, Job } from "../types";
import { EDITOR_LABELS } from "../constants";
import { MarkdownHighlight, HighlightedTextarea } from "./MarkdownHighlight";
import { ConfirmDialog } from "./ConfirmDialog";
import { XtermPane } from "./XtermPane";
import type { Transport } from "@clawtab/shared";

const cardSectionStyle = {
  backgroundColor: "var(--bg-primary)",
  borderWidth: 1,
  borderColor: "var(--border-light)",
  borderRadius: 8,
  padding: 16,
} as const;

const desktopContainerStyle = {
  backgroundColor: "var(--bg-primary)",
  borderRadius: 0,
} as const;

// Shared collapsible header button used by detail sections
function CollapsibleHeader({
  collapsed,
  onToggle,
  label,
}: {
  collapsed: boolean;
  onToggle: () => void;
  label: string;
}) {
  return (
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
        width: "100%",
      }}
      className="field-group-title"
    >
      <span style={{ fontFamily: "monospace", fontSize: 9 }}>
        {collapsed ? "\u25B6" : "\u25BC"}
      </span>
      {label}
    </button>
  );
}

export function DetailRow({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div style={{ display: "flex", gap: 12, padding: "4px 0", fontSize: 13 }}>
      <span style={{ color: "var(--text-secondary)", minWidth: 120, flexShrink: 0 }}>{label}</span>
      {mono ? <code style={{ flex: 1 }}>{value}</code> : <span style={{ flex: 1 }}>{value}</span>}
    </div>
  );
}

const inlineFieldStyle = {
  width: "100%",
  minWidth: 0,
  height: 28,
  padding: "3px 8px",
  color: "var(--text-primary)",
  background: "var(--bg-secondary)",
  border: "1px solid var(--border-color)",
  borderRadius: 6,
  fontSize: 12,
  boxSizing: "border-box",
} as const;

function InlineTextField({
  value,
  placeholder,
  mono,
  onSave,
}: {
  value: string | null | undefined;
  placeholder?: string;
  mono?: boolean;
  onSave: (value: string) => void | Promise<void>;
}) {
  const [draft, setDraft] = useState(value ?? "");
  const [saving, setSaving] = useState(false);

  useEffect(() => setDraft(value ?? ""), [value]);

  const save = useCallback(async () => {
    const nextValue = draft.trim();
    if (nextValue === (value ?? "")) return;
    setSaving(true);
    try {
      await onSave(nextValue);
    } finally {
      setSaving(false);
    }
  }, [draft, onSave, value]);

  return (
    <input
      value={draft}
      placeholder={placeholder}
      disabled={saving}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => void save()}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          setDraft(value ?? "");
          event.currentTarget.blur();
        }
      }}
      style={{ ...inlineFieldStyle, fontFamily: mono ? "monospace" : undefined }}
    />
  );
}

function InlineSelectField({
  value,
  options,
  onSave,
}: {
  value: string;
  options: { value: string; label: string }[];
  onSave: (value: string) => void | Promise<void>;
}) {
  const [saving, setSaving] = useState(false);

  return (
    <select
      value={value}
      disabled={saving}
      onChange={async (event) => {
        setSaving(true);
        try {
          await onSave(event.target.value);
        } finally {
          setSaving(false);
        }
      }}
      style={inlineFieldStyle}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>{option.label}</option>
      ))}
    </select>
  );
}

function AgentConfigSection({
  job,
  defaultAgentProvider = "claude",
  defaultAgentModel = null,
  agentModelOptions = [],
  onUpdateJob,
}: {
  job: Job;
  defaultAgentProvider?: ProcessProvider;
  defaultAgentModel?: string | null;
  agentModelOptions?: AgentModelOption[];
  onUpdateJob?: (patch: JobUpdate) => void | Promise<void>;
}) {
  if (job.job_type !== "claude" && job.job_type !== "job") return null;

  const agentProvider = job.agent_provider ?? defaultAgentProvider;
  const agentModel = job.agent_provider ? job.agent_model : defaultAgentModel;
  const agentLabel = agentSelectionLabel(agentProvider, agentModel, job.agent_effort);
  const displayedAgentLabel = `${agentLabel}${job.agent_provider ? "" : " (default)"}`;

  return (
    <div className="field-group">
      <span className="field-group-title">Agent</span>
      <DetailRow
        label="Agent"
        value={onUpdateJob && agentModelOptions.length > 0 ? (
          <AgentSelector
            modelOptions={agentModelOptions}
            provider={job.agent_provider}
            model={job.agent_model}
            effort={job.agent_effort}
            includeDefault
            defaultLabel={`${agentLabel} (default)`}
            label={agentLabel}
            fullWidth
            onSelectDefault={() => onUpdateJob({
              agent_provider: null,
              agent_model: null,
              agent_effort: null,
            })}
            onChange={(selection) => onUpdateJob({
              agent_provider: selection.provider,
              agent_model: selection.modelId,
              agent_effort: selection.effort,
            })}
          />
        ) : displayedAgentLabel}
      />
    </div>
  );
}

// Agent directions - shows context.md with option to open in editor
export function AgentDetailSections() {
  const [collapsed, setCollapsed] = useState(false);
  const [cwtContext, setCwtContext] = useState<string | null>(null);
  const [preferredEditor, setPreferredEditor] = useState("nvim");

  useEffect(() => {
    invoke<AppSettings>("get_settings").then((s) => {
      setPreferredEditor(s.preferred_editor);
    }).catch(() => {});
  }, []);

  const reloadContext = useCallback(() => {
    invoke<string>("read_agent_context")
      .then(setCwtContext)
      .catch(() => setCwtContext(null));
  }, []);

  useEffect(() => { reloadContext(); }, [reloadContext]);
  useEffect(() => {
    const interval = setInterval(reloadContext, 2000);
    return () => clearInterval(interval);
  }, [reloadContext]);
  useEffect(() => {
    const onFocus = () => reloadContext();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [reloadContext]);

  return (
    <div className="field-group">
      <CollapsibleHeader collapsed={collapsed} onToggle={() => setCollapsed((v) => !v)} label="Directions" />
      {!collapsed && (
        <div style={{ marginTop: 8 }}>
          <MarkdownHighlight
            content={cwtContext || "(no context.md)"}
            style={{
              padding: "10px 12px",
              height: 350,
              minHeight: 225,
              overflowY: "auto",
              fontFamily: "monospace",
              fontSize: 12,
              lineHeight: 1.5,
              color: "var(--text-primary)",
              background: "var(--bg-secondary)",
              whiteSpace: "pre-wrap",
              margin: 0,
              border: "1px solid var(--border-color)",
              borderRadius: 7,
              boxSizing: "border-box",
            }}
          />
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
            <button
              className="btn btn-sm"
              onClick={() => { invoke("open_agent_editor", { fileName: "context.md" }); }}
            >
              Edit in {EDITOR_LABELS[preferredEditor] ?? preferredEditor}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// Desktop-only detail sections: Directions, Configuration, Runtime, Secrets
export function DesktopDetailSections({
  job,
  defaultAgentProvider = "claude",
  defaultAgentModel = null,
  agentModelOptions = [],
  groups = [],
  onUpdateJob,
}: {
  job: Job;
  defaultAgentProvider?: ProcessProvider;
  defaultAgentModel?: string | null;
  agentModelOptions?: AgentModelOption[];
  groups?: string[];
  onUpdateJob?: (patch: JobUpdate) => void | Promise<void>;
}) {
  const [directionsCollapsed, setDirectionsCollapsed] = useState(false);
  const [configCollapsed, setConfigCollapsed] = useState(false);
  const [previewFile, setPreviewFile] = useState<"job.md" | "context.md">("job.md");
  const [inlineContent, setInlineContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [cwtContextPreview, setCwtContextPreview] = useState<string | null>(null);
  const [preferredEditor, setPreferredEditor] = useState("nvim");
  const savedContentRef = useRef(savedContent);
  savedContentRef.current = savedContent;

  const dirty = inlineContent !== savedContent;

  useEffect(() => {
    invoke<AppSettings>("get_settings").then((s) => {
      setPreferredEditor(s.preferred_editor);
    }).catch(() => {});
  }, []);

  const reloadDirections = useCallback(() => {
    if (job.job_type !== "job" || !job.folder_path) return;
    const jn = job.job_id ?? "default";
    invoke<string>("read_cwt_entry_at", { folderPath: job.folder_path, jobId: jn, slug: job.slug })
      .then((content) => {
        setInlineContent((prev) => prev === savedContentRef.current ? content : prev);
        setSavedContent(content);
      })
      .catch(() => {});
  }, [job]);

  useEffect(() => {
    if (job.job_type === "job" && job.folder_path) {
      const jn = job.job_id ?? "default";
      invoke<string>("read_cwt_entry_at", { folderPath: job.folder_path, jobId: jn, slug: job.slug })
        .then((content) => {
          setInlineContent(content);
          setSavedContent(content);
        })
        .catch(() => {});
      invoke<string>("read_cwt_context_at", { folderPath: job.folder_path, jobId: jn, slug: job.slug })
        .then(setCwtContextPreview)
        .catch(() => setCwtContextPreview(null));
    }
  }, [job]);

  useEffect(() => {
    if (job.job_type !== "job" || !job.folder_path) return;
    const interval = setInterval(reloadDirections, 2000);
    return () => clearInterval(interval);
  }, [job, reloadDirections]);

  useEffect(() => {
    const onFocus = () => reloadDirections();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [reloadDirections]);

  const handleSaveDirections = () => {
    if (job.folder_path) {
      invoke("write_cwt_entry_at", {
        folderPath: job.folder_path,
        jobId: job.job_id ?? "default",
        content: inlineContent,
        slug: job.slug,
      }).then(() => {
        setSavedContent(inlineContent);
      }).catch(() => {});
    }
  };

  const displayJobType = job.job_type;

  return (
    <>
      <AgentConfigSection
        job={job}
        defaultAgentProvider={defaultAgentProvider}
        defaultAgentModel={defaultAgentModel}
        agentModelOptions={agentModelOptions}
        onUpdateJob={onUpdateJob}
      />

      {/* Directions (folder jobs only) */}
      {job.job_type === "job" && job.folder_path && (
        <div className="field-group">
          <CollapsibleHeader
            collapsed={directionsCollapsed}
            onToggle={() => setDirectionsCollapsed((v) => !v)}
            label="Directions"
          />
          {!directionsCollapsed && (
            <div style={{ marginTop: 8 }}>
              <div className="directions-box">
                <div className="directions-tabs">
                  <button
                    className={`directions-tab ${previewFile === "job.md" ? "active" : ""}`}
                    onClick={() => setPreviewFile("job.md")}
                  >
                    job.md
                  </button>
                  <button
                    className={`directions-tab ${previewFile === "context.md" ? "active" : ""}`}
                    onClick={() => setPreviewFile("context.md")}
                  >
                    context.md
                  </button>
                </div>
                {previewFile === "job.md" ? (
                  <HighlightedTextarea
                    value={inlineContent}
                    onChange={(e) => setInlineContent(e.target.value)}
                    spellCheck={false}
                    placeholder=""
                  />
                ) : (
                  <HighlightedTextarea
                    value={cwtContextPreview || "(no context.md)"}
                    readOnly
                  />
                )}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
                {dirty && (
                  <button className="btn btn-primary btn-sm" onClick={handleSaveDirections}>
                    Save
                  </button>
                )}
                <button
                  className="btn btn-sm"
                  onClick={() => {
                    invoke("open_job_editor", {
                      folderPath: job.folder_path,
                      editor: preferredEditor,
                      jobId: job.job_id ?? "default",
                      fileName: previewFile,
                      slug: job.slug,
                    });
                  }}
                >
                  Edit in {EDITOR_LABELS[preferredEditor] ?? preferredEditor}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Configuration */}
      <div className="field-group">
        <CollapsibleHeader
          collapsed={configCollapsed}
          onToggle={() => setConfigCollapsed((v) => !v)}
          label="Configuration"
        />
        {!configCollapsed && (
          <>
            <DetailRow label="Type" value={displayJobType} />
            <DetailRow
              label="Enabled"
              value={onUpdateJob ? (
                <InlineSelectField
                  value={job.enabled ? "true" : "false"}
                  options={[
                    { value: "true", label: "Enabled" },
                    { value: "false", label: "Disabled" },
                  ]}
                  onSave={(value) => onUpdateJob({ enabled: value === "true" })}
                />
              ) : job.enabled ? "Enabled" : "Disabled"}
            />
            <DetailRow
              label="Schedule"
              value={onUpdateJob ? (
                <InlineTextField
                  value={job.cron}
                  placeholder="Manual"
                  mono
                  onSave={(cron) => onUpdateJob({ cron })}
                />
              ) : job.cron || "Manual"}
            />
            <DetailRow
              label="Group"
              value={onUpdateJob ? (
                <InlineSelectField
                  value={job.group || "default"}
                  options={[...new Set([job.group || "default", "default", ...groups])].map((group) => ({
                    value: group,
                    label: group,
                  }))}
                  onSave={(group) => onUpdateJob({ group })}
                />
              ) : job.group || "default"}
            />
            {job.job_type === "job" && job.folder_path && (
              <DetailRow label="Job folder" value={job.folder_path} mono />
            )}
            <DetailRow
              label="Working directory"
              value={onUpdateJob ? (
                <InlineTextField
                  value={job.work_dir}
                  placeholder="Default"
                  mono
                  onSave={(workDir) => onUpdateJob({ work_dir: workDir || null })}
                />
              ) : job.work_dir || "Default"}
            />
            {job.job_type === "binary" && (
              <DetailRow label="Path" value={job.path} mono />
            )}
            {job.args.length > 0 && (
              <DetailRow label="Args" value={job.args.join(" ")} mono />
            )}
            <DetailRow
              label="Kill on end"
              value={onUpdateJob ? (
                <InlineSelectField
                  value={(job.kill_on_end ?? true) ? "true" : "false"}
                  options={[
                    { value: "true", label: "Yes" },
                    { value: "false", label: "No" },
                  ]}
                  onSave={(value) => onUpdateJob({ kill_on_end: value === "true" })}
                />
              ) : (job.kill_on_end ?? true) ? "Yes" : "No"}
            />
            <DetailRow
              label="Auto-yes on start"
              value={onUpdateJob ? (
                <InlineSelectField
                  value={job.auto_yes ? "true" : "false"}
                  options={[
                    { value: "true", label: "Yes" },
                    { value: "false", label: "No" },
                  ]}
                  onSave={(value) => onUpdateJob({ auto_yes: value === "true" })}
                />
              ) : job.auto_yes ? "Yes" : "No"}
            />
            <DetailRow
              label="Max history"
              value={onUpdateJob ? (
                <InlineSelectField
                  value={String(job.max_history ?? 3)}
                  options={[...new Set([job.max_history ?? 3, 1, 3, 5, 10, 25, 50])].map((count) => ({
                    value: String(count),
                    label: String(count),
                  }))}
                  onSave={(value) => onUpdateJob({ max_history: Number(value) })}
                />
              ) : String(job.max_history ?? 3)}
            />
          </>
        )}
      </div>

      {/* Runtime */}
      {(onUpdateJob || job.telegram_chat_id || job.notify_target === "telegram" || job.tmux_session || job.aerospace_workspace || job.notify_target !== "none") && (
        <div className="field-group">
          <span className="field-group-title">Runtime</span>
          <DetailRow
            label="Tmux session"
            value={onUpdateJob ? (
              <InlineTextField
                value={job.tmux_session}
                placeholder="Default"
                mono
                onSave={(tmuxSession) => onUpdateJob({ tmux_session: tmuxSession || null })}
              />
            ) : job.tmux_session || "Default"}
          />
          <DetailRow
            label="Aerospace workspace"
            value={onUpdateJob ? (
              <InlineTextField
                value={job.aerospace_workspace}
                placeholder="None"
                onSave={(workspace) => onUpdateJob({ aerospace_workspace: workspace || null })}
              />
            ) : job.aerospace_workspace || "None"}
          />
          <DetailRow
            label="Notify target"
            value={onUpdateJob ? (
              <InlineSelectField
                value={job.notify_target || "none"}
                options={[
                  { value: "none", label: "None" },
                  { value: "app", label: "App" },
                  { value: "telegram", label: "Telegram" },
                ]}
                onSave={(notifyTarget) => onUpdateJob({ notify_target: notifyTarget })}
              />
            ) : job.notify_target === "telegram" ? "Telegram" : job.notify_target === "app" ? "App" : "None"}
          />
          {job.notify_target === "telegram" && job.telegram_chat_id && (
            <>
              <DetailRow label="Telegram chat" value={String(job.telegram_chat_id)} mono />
              <DetailRow
                label="Notifications"
                value={
                  [
                    job.telegram_notify.start && "start",
                    job.telegram_notify.working && "working",
                    job.telegram_notify.logs && "logs",
                    job.telegram_notify.finish && "finish",
                  ].filter(Boolean).join(", ") || "none"
                }
              />
            </>
          )}
        </div>
      )}

      {/* Secrets */}
      {job.secret_keys.length > 0 && (
        <div className="field-group">
          <span className="field-group-title">Secrets</span>
          {job.secret_keys.map((key) => (
            <DetailRow key={key} label={key} value="(set)" mono />
          ))}
        </div>
      )}
    </>
  );
}

// Desktop job detail - wraps the shared JobDetailView with desktop-specific sections
export function DesktopJobDetail({
  transport,
  job,
  status,
  onBack,
  onEdit,
  onOpen,
  onToggle,
  onDuplicate,
  onDuplicateToFolder,
  onDelete,
  groups,
  options,
  questionContext,
  autoYesActive,
  onToggleAutoYes,
  autoYesShortcut,
  firstQuery,
  lastQuery,
  tokenCount,
  showBackButton = false,
  hidePath = false,
  onFork,
  onSplitPane,
  onSplitRunPane,
  onZoomPane,
  onInjectSecrets,
  onSearchSkills,
  onStopping,
  onStopFailed,
  onRevealInSidebar,
  contentStyle,
  headerLeftInset,
  titlePath,
  dragHandleProps,
  defaultAgentProvider,
  defaultAgentModel,
  agentModelOptions,
  onUpdateJob,
}: {
  transport: Transport;
  job: Job;
  status: JobStatus;
  onBack: () => void;
  onEdit: () => void;
  onOpen: () => void;
  onToggle: () => void;
  onDuplicate: (group: string) => void;
  onDuplicateToFolder: () => void;
  onDelete: () => void;
  groups: string[];
  showBackButton?: boolean;
  hidePath?: boolean;
  options?: { number: string; label: string }[];
  questionContext?: string;
  autoYesActive?: boolean;
  onToggleAutoYes?: () => void;
  autoYesShortcut?: string;
  firstQuery?: string;
  lastQuery?: string;
  tokenCount?: number | null;
  onFork?: (direction: "right" | "down") => void;
  onSplitPane?: (direction: "right" | "down") => void;
  onSplitRunPane?: (paneId: string, direction: "right" | "down") => void;
  onZoomPane?: () => void;
  onInjectSecrets?: () => void;
  onSearchSkills?: () => void;
  onStopping?: () => void;
  onStopFailed?: () => void;
  onRevealInSidebar?: () => void;
  contentStyle?: unknown;
  headerLeftInset?: number;
  titlePath?: string;
  defaultAgentProvider?: ProcessProvider;
  defaultAgentModel?: string | null;
  agentModelOptions?: AgentModelOption[];
  onUpdateJob?: (patch: JobUpdate) => void | Promise<void>;
  dragHandleProps?: {
    ref?: (node: HTMLElement | null) => void;
    attributes?: Record<string, unknown>;
    listeners?: Record<string, unknown>;
    isDragging?: boolean;
  };
}) {
  const { runs, reloadRuns } = useJobDetail(transport, job.slug);
  const { logs } = useLogBuffer(transport, job.slug);
  const [showConfirm, setShowConfirm] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const id = requestAnimationFrame(() => setReady(true));
    return () => { cancelAnimationFrame(id); setReady(false); };
  }, [job.slug]);

  const extraContent = useMemo(
    () => ready ? (
      <DesktopDetailSections
        job={job}
        defaultAgentProvider={defaultAgentProvider}
        defaultAgentModel={defaultAgentModel}
        agentModelOptions={agentModelOptions}
        groups={groups}
        onUpdateJob={onUpdateJob}
      />
    ) : null,
    [job, ready, defaultAgentProvider, defaultAgentModel, agentModelOptions, groups, onUpdateJob],
  );

  // Extract pane info for interactive terminal when job is running
  const paneId = status.state === "running" ? status.pane_id : undefined;
  const tmuxSession = status.state === "running" ? status.tmux_session : undefined;

  const renderTerminal = useCallback(
    () => paneId && tmuxSession ? (
      <XtermPane paneId={paneId} tmuxSession={tmuxSession} group={job.group} />
    ) : null,
    [paneId, tmuxSession, job.group],
  );

  const renderRunTerminal = useCallback(
    (runPaneId: string, runTmuxSession: string) => (
      <XtermPane paneId={runPaneId} tmuxSession={runTmuxSession} group={job.group} />
    ),
    [job.group],
  );

  const handleRelease = useCallback(async () => {
    if (!paneId) return;
    try {
      await invoke("pty_release", { paneId });
    } catch (err) {
      console.error("pty_release failed:", err);
    }
  }, [paneId]);

  return (
    <>
      <JobDetailView
        transport={transport}
        job={job as unknown as RemoteJob}
        status={status}
        logs={logs}
        runs={runs}
        runsLoading={!runs}
        onBack={onBack}
        showBackButton={showBackButton}
        hidePath={hidePath}
        onReloadRuns={reloadRuns}
        onEdit={onEdit}
        onOpen={onOpen}
        onToggleEnabled={onToggle}
        onDuplicate={onDuplicate}
        onDuplicateToFolder={onDuplicateToFolder}
        groups={groups}
        currentGroup={job.group || "default"}
        onDelete={() => setShowConfirm(true)}
        extraContent={extraContent}
        options={options}
        questionContext={questionContext}
        autoYesActive={autoYesActive}
        onToggleAutoYes={onToggleAutoYes}
        autoYesShortcut={autoYesShortcut}
        sectionStyle={cardSectionStyle}
        containerStyle={desktopContainerStyle}
        contentStyle={contentStyle as any}
        headerLeftInset={headerLeftInset}
        titlePath={titlePath}
        firstQuery={firstQuery}
        lastQuery={lastQuery}
        tokenCount={tokenCount}
        renderTerminal={paneId && tmuxSession ? renderTerminal : undefined}
        hideMessageInput={!!(paneId && tmuxSession)}
        onFork={onFork}
        onSplitPane={onSplitPane}
        onSplitRunPane={onSplitRunPane}
        onZoomPane={onZoomPane}
        onInjectSecrets={onInjectSecrets}
        onSearchSkills={onSearchSkills}
        onRelease={paneId ? handleRelease : undefined}
        onRevealInSidebar={onRevealInSidebar}
        onStopping={onStopping}
        onStopFailed={onStopFailed}
        dragHandleProps={dragHandleProps}
        renderRunTerminal={renderRunTerminal}
        defaultAgentProvider={defaultAgentProvider}
        defaultAgentModel={defaultAgentModel}
        agentModelOptions={agentModelOptions}
        onUpdateJob={onUpdateJob}
        editHeaderFields={false}
        showHeaderAgent={false}
      />
      {showConfirm && (
        <ConfirmDialog
          message={`Delete job "${job.name}"? This cannot be undone.`}
          onConfirm={() => { onDelete(); setShowConfirm(false); }}
          onCancel={() => setShowConfirm(false)}
        />
      )}
    </>
  );
}

// Agent detail view - wraps shared JobDetailView for the agent
export function AgentDetail({
  transport,
  job,
  status,
  onBack,
  onOpen,
  onEditTitle,
  showBackButton = false,
  hidePath = false,
  contentStyle,
  headerLeftInset,
  titlePath,
  onZoomPane,
  dragHandleProps,
}: {
  transport: Transport;
  job: RemoteJob;
  status: JobStatus;
  onBack: () => void;
  onOpen: () => void;
  onEditTitle?: () => void;
  showBackButton?: boolean;
  hidePath?: boolean;
  contentStyle?: unknown;
  headerLeftInset?: number;
  titlePath?: string;
  onZoomPane?: () => void;
  dragHandleProps?: {
    ref?: (node: HTMLElement | null) => void;
    attributes?: Record<string, unknown>;
    listeners?: Record<string, unknown>;
    isDragging?: boolean;
  };
}) {
  const { runs, reloadRuns } = useJobDetail(transport, "agent");
  const { logs } = useLogBuffer(transport, "agent");

  const extraContent = useMemo(
    () => <AgentDetailSections />,
    [],
  );

  return (
    <JobDetailView
      transport={transport}
      job={job}
      status={status}
      logs={logs}
      runs={runs}
      onBack={onBack}
      showBackButton={showBackButton}
      hidePath={hidePath}
      onReloadRuns={reloadRuns}
      onOpen={onOpen}
      onEditTitle={onEditTitle}
      onZoomPane={onZoomPane}
      extraContent={extraContent}
      sectionStyle={cardSectionStyle}
      containerStyle={desktopContainerStyle}
      contentStyle={contentStyle as any}
      headerLeftInset={headerLeftInset}
      titlePath={titlePath}
      expandOutput
      dragHandleProps={dragHandleProps}
    />
  );
}
