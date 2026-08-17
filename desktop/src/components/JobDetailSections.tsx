import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import type {
  AgentModelOption,
  JobUpdate,
  RemoteJob,
  JobStatus,
  ProcessProvider,
  TelegramNotify,
} from "@clawtab/shared";
import {
  AgentSelector,
  agentSelectionLabel,
  describeCalendarSchedule,
  JobDetailView,
  useJobDetail,
  useLogBuffer,
} from "@clawtab/shared";
import type { AppSettings, Job, SecretEntry } from "../types";
import { EDITOR_LABELS } from "../constants";
import { MarkdownHighlight, HighlightedTextarea } from "./MarkdownHighlight";
import { ConfirmDialog } from "./ConfirmDialog";
import { XtermPane } from "./XtermPane";
import type { Transport } from "@clawtab/shared";
import { ScheduleFields } from "./JobEditor/components/ScheduleFields";
import { useScheduleState } from "./JobEditor/hooks/useScheduleState";

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

function ScheduleDialog({
  job,
  onSave,
  onCancel,
}: {
  job: Job;
  onSave: (patch: JobUpdate) => void | Promise<void>;
  onCancel: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState<Job>(job);
  const [saving, setSaving] = useState(false);
  const schedule = useScheduleState({ form: draft, setForm: setDraft, isNew: false });

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      if (dialog?.open) dialog.close();
    };
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      await onSave({
        cron: draft.cron,
        schedule: draft.schedule ?? null,
      });
      onCancel();
    } finally {
      setSaving(false);
    }
  };

  return createPortal(
    <dialog
      ref={dialogRef}
      className="confirm-overlay"
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
      onClick={(event) => {
        if (event.target === dialogRef.current) onCancel();
      }}
    >
      <div
        className="confirm-dialog"
        onClick={(event) => event.stopPropagation()}
        style={{ width: 560, maxWidth: "calc(100vw - 32px)", maxHeight: "calc(100vh - 48px)", overflowY: "auto" }}
      >
        <h3 style={{ margin: "0 0 16px", fontSize: 15 }}>Schedule</h3>
        <ScheduleFields form={draft} setForm={setDraft} {...schedule} />
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 20 }}>
          <button className="btn btn-sm" disabled={saving} onClick={onCancel}>
            Cancel
          </button>
          <button className="btn btn-primary btn-sm" disabled={saving} onClick={() => void save()}>
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      </div>
    </dialog>,
    document.body,
  );
}

function InlineScheduleField({
  job,
  onSave,
}: {
  job: Job;
  onSave: (patch: JobUpdate) => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const label = job.schedule
    ? describeCalendarSchedule(job.schedule)
    : job.cron || "Manual";

  return (
    <>
      <button
        type="button"
        className="btn btn-sm"
        onClick={() => setOpen(true)}
        style={{ width: "100%", minHeight: 28, justifyContent: "flex-start", textAlign: "left" }}
        title="Edit schedule"
      >
        {label}
      </button>
      {open && (
        <ScheduleDialog
          job={job}
          onSave={onSave}
          onCancel={() => setOpen(false)}
        />
      )}
    </>
  );
}

const InlineToggleField = ({
  value,
  ariaLabel,
  onSave,
}: {
  value: boolean;
  ariaLabel: string;
  onSave: (value: boolean) => void | Promise<void>;
}) => {
  const [saving, setSaving] = useState(false);

  const handleChange = async (nextValue: boolean) => {
    setSaving(true);
    try {
      await onSave(nextValue);
    } finally {
      setSaving(false);
    }
  };

  return (
    <input
      type="checkbox"
      className="toggle-switch"
      checked={value}
      disabled={saving}
      aria-label={ariaLabel}
      onChange={(event) => { void handleChange(event.target.checked); }}
    />
  );
};

type InlineNotificationKey = keyof TelegramNotify;

const INLINE_NOTIFICATION_OPTIONS: { key: InlineNotificationKey; label: string; hint: string }[] = [
  { key: "start", label: "Job started", hint: "Notify when the job begins" },
  { key: "working", label: "Working timer", hint: "Live elapsed time counter" },
  { key: "logs", label: "Log output", hint: "Stream pane output while running" },
  { key: "finish", label: "Job finished", hint: "Send a completion message" },
];

const InlineNotificationCheckboxes = ({
  job,
  label,
  onUpdateJob,
}: {
  job: Job;
  label: string;
  onUpdateJob: (patch: JobUpdate) => void | Promise<void>;
}) => {
  const [savingKey, setSavingKey] = useState<InlineNotificationKey | null>(null);

  const handleChange = async (key: InlineNotificationKey, enabled: boolean) => {
    setSavingKey(key);
    try {
      await onUpdateJob({ telegram_notify: { ...job.telegram_notify, [key]: enabled } });
    } finally {
      setSavingKey(null);
    }
  };

  return (
    <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px solid var(--border-light)" }}>
      <span className="field-group-title">{label}</span>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "4px 0" }}>
        {INLINE_NOTIFICATION_OPTIONS.map(({ key, label: optionLabel, hint }) => (
          <label key={key} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, cursor: savingKey ? "wait" : "pointer" }}>
            <input
              type="checkbox"
              checked={job.telegram_notify[key]}
              disabled={savingKey !== null}
              onChange={(event) => { void handleChange(key, event.target.checked); }}
              style={{ margin: 0 }}
            />
            <span>{optionLabel}</span>
            <span style={{ color: "var(--text-secondary)", fontSize: 11 }}>{hint}</span>
          </label>
        ))}
      </div>
    </div>
  );
};

const notificationSummary = (notify: TelegramNotify) => [
  notify.start && "start",
  notify.working && "working",
  notify.logs && "logs",
  notify.finish && "finish",
].filter(Boolean).join(", ") || "none";

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
  const [telegramChats, setTelegramChats] = useState<{ id: number; name: string }[]>([]);
  const [availableSecrets, setAvailableSecrets] = useState<SecretEntry[]>([]);
  const [selectedSecret, setSelectedSecret] = useState("");
  const [secretsSaving, setSecretsSaving] = useState(false);
  const savedContentRef = useRef(savedContent);
  savedContentRef.current = savedContent;

  const dirty = inlineContent !== savedContent;

  useEffect(() => {
    invoke<AppSettings>("get_settings").then((s) => {
      setPreferredEditor(s.preferred_editor);
      setTelegramChats(s.telegram?.chat_ids.map((id) => ({
        id,
        name: s.telegram?.chat_names[String(id)] ?? "",
      })) ?? []);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!onUpdateJob) return;
    invoke<SecretEntry[]>("list_secrets").then(setAvailableSecrets).catch(() => {});
  }, [onUpdateJob]);

  const unassignedSecrets = availableSecrets.filter(
    (secret) => !job.secret_keys.includes(secret.key),
  );

  const updateSecrets = async (secretKeys: string[]) => {
    if (!onUpdateJob || secretsSaving) return;
    setSecretsSaving(true);
    try {
      await onUpdateJob({ secret_keys: secretKeys });
      setSelectedSecret("");
    } finally {
      setSecretsSaving(false);
    }
  };

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
  const telegramChatOptions = useMemo(() => {
    const selectedChatId = job.telegram_chat_id;
    const hasSavedChat = selectedChatId != null && telegramChats.some((chat) => chat.id === selectedChatId);
    return selectedChatId != null && !hasSavedChat
      ? [{ id: selectedChatId, name: "Saved chat" }, ...telegramChats]
      : telegramChats;
  }, [job.telegram_chat_id, telegramChats]);
  const telegramChatValue = job.telegram_chat_id == null ? "" : String(job.telegram_chat_id);

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
                <InlineToggleField
                  value={job.enabled}
                  ariaLabel="Enable job"
                  onSave={(enabled) => onUpdateJob({ enabled })}
                />
              ) : job.enabled ? "Enabled" : "Disabled"}
            />
            <DetailRow
              label="Schedule"
              value={onUpdateJob ? (
                <InlineScheduleField job={job} onSave={onUpdateJob} />
              ) : job.schedule ? describeCalendarSchedule(job.schedule) : job.cron || "Manual"}
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
                <InlineToggleField
                  value={job.kill_on_end ?? true}
                  ariaLabel="Kill job when it ends"
                  onSave={(killOnEnd) => onUpdateJob({ kill_on_end: killOnEnd })}
                />
              ) : (job.kill_on_end ?? true) ? "Yes" : "No"}
            />
            <DetailRow
              label="Auto-yes on start"
              value={onUpdateJob ? (
                <InlineToggleField
                  value={job.auto_yes}
                  ariaLabel="Enable auto-yes on start"
                  onSave={(autoYes) => onUpdateJob({ auto_yes: autoYes })}
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
      {(onUpdateJob || job.telegram_chat_id || job.notify_target === "telegram" || job.tmux_session || job.notify_target !== "none") && (
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
          {job.notify_target === "telegram" && (
            <>
              <DetailRow
                label="Telegram chat"
                value={onUpdateJob ? (
                  telegramChatOptions.length > 0 ? (
                    <InlineSelectField
                      value={telegramChatValue}
                      options={[
                        { value: "", label: "Default chat" },
                        ...telegramChatOptions.map((chat) => ({
                          value: String(chat.id),
                          label: chat.name ? `${chat.name} (${chat.id})` : String(chat.id),
                        })),
                      ]}
                      onSave={(value) => onUpdateJob({
                        telegram_chat_id: value ? Number.parseInt(value, 10) : null,
                      })}
                    />
                  ) : (
                    <InlineTextField
                      value={telegramChatValue}
                      placeholder="Chat ID or default"
                      mono
                      onSave={(value) => {
                        const trimmed = value.trim();
                        const parsed = trimmed ? Number.parseInt(trimmed, 10) : null;
                        return onUpdateJob({
                          telegram_chat_id: parsed != null && Number.isFinite(parsed) ? parsed : null,
                        });
                      }}
                    />
                  )
                ) : job.telegram_chat_id == null ? "Default chat" : String(job.telegram_chat_id)}
                mono={!onUpdateJob}
              />
              {onUpdateJob ? (
                <InlineNotificationCheckboxes
                  job={job}
                  label="Telegram notifications"
                  onUpdateJob={onUpdateJob}
                />
              ) : (
                <DetailRow label="Notifications" value={notificationSummary(job.telegram_notify)} />
              )}
            </>
          )}
          {job.notify_target === "app" && (
            onUpdateJob ? (
              <InlineNotificationCheckboxes
                job={job}
                label="App notifications"
                onUpdateJob={onUpdateJob}
              />
            ) : (
              <DetailRow label="Notifications" value={notificationSummary(job.telegram_notify)} />
            )
          )}
        </div>
      )}

      {/* Secrets */}
      {(job.secret_keys.length > 0 || onUpdateJob) && (
        <div className="field-group">
          <span className="field-group-title">Secrets</span>
          {job.secret_keys.map((key) => (
            <div
              key={key}
              style={{ display: "flex", alignItems: "center", gap: 8 }}
            >
              <DetailRow label={key} value="(set)" mono />
              {onUpdateJob && (
                <button
                  className="btn btn-sm"
                  onClick={() => updateSecrets(job.secret_keys.filter((item) => item !== key))}
                  disabled={secretsSaving}
                  title={`Remove ${key} from this job`}
                >
                  Remove
                </button>
              )}
            </div>
          ))}
          {onUpdateJob && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
              <select
                value={selectedSecret}
                onChange={(event) => setSelectedSecret(event.target.value)}
                disabled={secretsSaving || unassignedSecrets.length === 0}
                style={{ ...inlineFieldStyle, flex: 1 }}
                aria-label="Secret to add"
              >
                <option value="">
                  {unassignedSecrets.length === 0 ? "No more secrets available" : "Select a secret"}
                </option>
                {unassignedSecrets.map((secret) => (
                  <option key={secret.key} value={secret.key}>{secret.key}</option>
                ))}
              </select>
              <button
                className="btn btn-sm"
                onClick={() => updateSecrets([...job.secret_keys, selectedSecret])}
                disabled={!selectedSecret || secretsSaving}
              >
                Add secret
              </button>
            </div>
          )}
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
  onOpen,
  onDuplicate,
  onDuplicateToFolder,
  onDelete,
  groups,
  options,
  questionContext,
  autoYesActive,
  onToggleAutoYes,
  autoYesShortcut,
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
  onOpen: () => void;
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
        onOpen={onOpen}
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
        defaultOutputCollapsed
        defaultRunsCollapsed
        containerStyle={desktopContainerStyle}
        contentStyle={contentStyle as any}
        headerLeftInset={headerLeftInset}
        titlePath={titlePath}
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
