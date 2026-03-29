import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { RemoteJob, JobStatus } from "@clawtab/shared";
import { JobDetailView, useJobDetail, useLogBuffer } from "@clawtab/shared";
import type { AppSettings, Job } from "../types";
import { EDITOR_LABELS } from "../constants";
import { MarkdownHighlight, HighlightedTextarea } from "./MarkdownHighlight";
import { ConfirmDialog } from "./ConfirmDialog";
import { describeCron } from "./CronInput";
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
export function DesktopDetailSections({ job }: { job: Job }) {
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
    if (job.job_type !== "folder" || !job.folder_path) return;
    const jn = job.job_name ?? "default";
    invoke<string>("read_cwt_entry", { folderPath: job.folder_path, jobName: jn })
      .then((content) => {
        setInlineContent((prev) => prev === savedContentRef.current ? content : prev);
        setSavedContent(content);
      })
      .catch(() => {});
  }, [job]);

  useEffect(() => {
    if (job.job_type === "folder" && job.folder_path) {
      const jn = job.job_name ?? "default";
      invoke<string>("read_cwt_entry", { folderPath: job.folder_path, jobName: jn })
        .then((content) => {
          setInlineContent(content);
          setSavedContent(content);
        })
        .catch(() => {});
      invoke<string>("read_cwt_context", { folderPath: job.folder_path, jobName: jn })
        .then(setCwtContextPreview)
        .catch(() => setCwtContextPreview(null));
    }
  }, [job]);

  useEffect(() => {
    if (job.job_type !== "folder" || !job.folder_path) return;
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
      invoke("write_cwt_entry", {
        folderPath: job.folder_path,
        jobName: job.job_name ?? "default",
        content: inlineContent,
      }).then(() => {
        setSavedContent(inlineContent);
      }).catch(() => {});
    }
  };

  return (
    <>
      {/* Directions (folder jobs only) */}
      {job.job_type === "folder" && job.folder_path && (
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
                      jobName: job.job_name ?? "default",
                      fileName: previewFile,
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
            <DetailRow label="Type" value={job.job_type} />
            <DetailRow label="Enabled" value={job.enabled ? "Yes" : "No"} />
            {job.cron ? (
              <>
                <DetailRow label="Schedule" value={describeCron(job.cron)} />
                <DetailRow label="Cron" value={job.cron} mono />
              </>
            ) : (
              <DetailRow label="Schedule" value="Manual" />
            )}
            {job.group && job.group !== "default" && (
              <DetailRow label="Group" value={job.group} />
            )}
            {job.job_type === "folder" && job.folder_path && (
              <DetailRow label="Folder" value={job.folder_path} mono />
            )}
            {job.job_type === "binary" && (
              <DetailRow label="Path" value={job.path} mono />
            )}
            {job.args.length > 0 && (
              <DetailRow label="Args" value={job.args.join(" ")} mono />
            )}
            {job.work_dir && (
              <DetailRow label="Work dir" value={job.work_dir} mono />
            )}
          </>
        )}
      </div>

      {/* Runtime */}
      {(job.tmux_session || job.aerospace_workspace || job.notify_target !== "none") && (
        <div className="field-group">
          <span className="field-group-title">Runtime</span>
          {job.tmux_session && (
            <DetailRow label="Tmux session" value={job.tmux_session} mono />
          )}
          {job.aerospace_workspace && (
            <DetailRow label="Aerospace workspace" value={job.aerospace_workspace} />
          )}
          {job.notify_target !== "none" && (
            <DetailRow label="Notify target" value={job.notify_target === "telegram" ? "Telegram" : "App"} />
          )}
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
  firstQuery,
  lastQuery,
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
  options?: { number: string; label: string }[];
  questionContext?: string;
  autoYesActive?: boolean;
  onToggleAutoYes?: () => void;
  firstQuery?: string;
  lastQuery?: string;
}) {
  const { runs, reloadRuns } = useJobDetail(transport, job.slug);
  const { logs } = useLogBuffer(transport, job.slug);
  const [showConfirm, setShowConfirm] = useState(false);

  const extraContent = useMemo(
    () => <DesktopDetailSections job={job} />,
    [job],
  );

  return (
    <>
      <JobDetailView
        transport={transport}
        job={job as unknown as RemoteJob}
        status={status}
        logs={logs}
        runs={runs}
        onBack={onBack}
        showBackButton={false}
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
        sectionStyle={cardSectionStyle}
        containerStyle={desktopContainerStyle}
        expandOutput
        firstQuery={firstQuery}
        lastQuery={lastQuery}
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
}: {
  transport: Transport;
  job: RemoteJob;
  status: JobStatus;
  onBack: () => void;
  onOpen: () => void;
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
      showBackButton={false}
      onReloadRuns={reloadRuns}
      onOpen={onOpen}
      extraContent={extraContent}
      sectionStyle={cardSectionStyle}
      containerStyle={desktopContainerStyle}
      expandOutput
    />
  );
}
