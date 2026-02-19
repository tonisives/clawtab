import { useEffect, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { AerospaceWorkspace, AppSettings, Job, JobType, SecretEntry, ToolInfo } from "../types";
import { CronInput, describeCron } from "./CronInput";

const DEFAULT_TEMPLATE = "# Job Directions\n\nDescribe what the bot should do here.\n";

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

const STEP_TIPS: Record<string, string> = {
  folder: "Choose the project folder where your bot will work. A .cwdt/cwdt.md file will be created with directions for the AI.",
  schedule: "How often should this job run? Pick a preset, choose specific days, or write a cron expression.",
  secrets: "Select API keys and tokens this job needs. They'll be injected as environment variables when the job runs.",
  config: "Optional settings. Most jobs work fine with defaults.",
};

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
const DAY_CRON_MAP: Record<string, string> = {
  Mon: "1", Tue: "2", Wed: "3", Thu: "4", Fri: "5", Sat: "6", Sun: "0",
};

interface Props {
  job: Job | null;
  onSave: (job: Job) => void;
  onCancel: () => void;
}

const emptyJob: Job = {
  name: "",
  job_type: "folder",
  enabled: true,
  path: "",
  args: [],
  cron: "0 0 * * *",
  secret_keys: [],
  env: {},
  work_dir: null,
  tmux_session: null,
  aerospace_workspace: null,
  folder_path: null,
  telegram_chat_id: null,
  group: "default",
  slug: "",
};

type WizardStep = "folder" | "schedule" | "secrets" | "config";

const STEPS: { id: WizardStep; label: string }[] = [
  { id: "folder", label: "Folder" },
  { id: "schedule", label: "Schedule" },
  { id: "secrets", label: "Secrets" },
  { id: "config", label: "Config" },
];

function deriveNameFromPath(folderPath: string): string {
  const parts = folderPath.replace(/\/+$/, "").split("/");
  const last = parts[parts.length - 1];
  if (last === ".cwdt") return parts[parts.length - 2] ?? "";
  return last ?? "";
}

export function JobEditor({ job, onSave, onCancel }: Props) {
  const [form, setForm] = useState<Job>(job ?? emptyJob);
  const [argsText, setArgsText] = useState(form.args.join(" "));
  const [envText, setEnvText] = useState(
    Object.entries(form.env)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n"),
  );

  const isNew = job === null;
  const isWizard = isNew && form.job_type === "folder";

  // Wizard state
  const [currentStep, setCurrentStep] = useState<WizardStep>("folder");
  const currentIdx = STEPS.findIndex((s) => s.id === currentStep);

  // Lazy-loaded data
  const [availableSecrets, setAvailableSecrets] = useState<SecretEntry[] | null>(null);
  const [aerospaceAvailable, setAerospaceAvailable] = useState(false);
  const [aerospaceWorkspaces, setAerospaceWorkspaces] = useState<AerospaceWorkspace[]>([]);
  const [cwdtPreview, setCwdtPreview] = useState<string | null>(null);
  const [preferredEditor, setPreferredEditor] = useState("nvim");
  const [availableEditors, setAvailableEditors] = useState<string[]>(["nvim"]);
  const [browserSessionExists, setBrowserSessionExists] = useState(false);
  const [browserAuthUrl, setBrowserAuthUrl] = useState("https://");
  const [defaultTmuxSession, setDefaultTmuxSession] = useState("tgs");
  const [telegramChats, setTelegramChats] = useState<{ id: number; name: string }[]>([]);
  const [aerospaceExpanded, setAerospaceExpanded] = useState(false);

  // Schedule mode state
  const [manualOnly, setManualOnly] = useState(false);
  const [useWeekly, setUseWeekly] = useState(true);
  const [weeklyDays, setWeeklyDays] = useState<string[]>(["Mon"]);
  const [weeklyTime, setWeeklyTime] = useState("09:00");

  // cwdt.md edited tracking
  const [cwdtEdited, setCwdtEdited] = useState(!isNew);

  // Load settings and detected editors on mount
  useEffect(() => {
    invoke<AppSettings>("get_settings").then((s) => {
      setPreferredEditor(s.preferred_editor);
      setDefaultTmuxSession(s.default_tmux_session || "tgs");
      if (s.telegram?.chat_ids?.length) {
        const chats = s.telegram.chat_ids.map((id) => ({
          id,
          name: s.telegram?.chat_names?.[String(id)] ?? "",
        }));
        setTelegramChats(chats);
        if (isNew && form.telegram_chat_id === null) {
          setForm((prev) => ({ ...prev, telegram_chat_id: chats[0].id }));
        }
      }
    });
    invoke<ToolInfo[]>("detect_tools").then((tools) => {
      const editors = tools
        .filter((t) => t.group === "editor" && t.available)
        .map((t) => t.name);
      if (editors.length > 0) setAvailableEditors(editors);
    });
  }, []);

  // Load secrets when entering secrets step (or on mount for edit mode)
  useEffect(() => {
    if (!isWizard || currentStep === "secrets") {
      if (availableSecrets === null) {
        invoke<SecretEntry[]>("list_secrets").then(setAvailableSecrets);
      }
    }
  }, [currentStep, isWizard, availableSecrets]);

  // Load aerospace + browser session when entering config step (or on mount for edit mode)
  useEffect(() => {
    if (!isWizard || currentStep === "config") {
      invoke<boolean>("aerospace_available")
        .then((avail) => {
          setAerospaceAvailable(avail);
          if (avail) {
            invoke<AerospaceWorkspace[]>("list_aerospace_workspaces")
              .then(setAerospaceWorkspaces)
              .catch(() => {});
          }
        })
        .catch(() => setAerospaceAvailable(false));
      if (form.job_type === "folder" && form.name) {
        invoke<boolean>("check_browser_session", { jobName: form.name })
          .then(setBrowserSessionExists)
          .catch(() => setBrowserSessionExists(false));
      }
    }
  }, [currentStep, isWizard, form.name, form.job_type]);

  // Auto-init cwdt.md and load preview when folder path changes
  const refreshCwdtPreview = useCallback((folderPath: string) => {
    invoke<string>("read_cwdt_entry", { folderPath })
      .then((content) => {
        setCwdtPreview(content);
        setCwdtEdited(!!content && content.trim() !== DEFAULT_TEMPLATE.trim());
      })
      .catch(() => setCwdtPreview(null));
  }, []);

  useEffect(() => {
    if (form.job_type === "folder" && form.folder_path) {
      // Auto-init then load preview
      invoke("init_cwdt_folder", { folderPath: form.folder_path }).then(() => {
        refreshCwdtPreview(form.folder_path!);
      });
    } else {
      setCwdtPreview(null);
    }
  }, [form.folder_path, form.job_type, refreshCwdtPreview]);

  // Poll cwdt.md for changes while on folder step (user may be editing in external editor)
  useEffect(() => {
    if (!isWizard || currentStep !== "folder" || !form.folder_path) return;
    const interval = setInterval(() => {
      refreshCwdtPreview(form.folder_path!);
    }, 2000);
    return () => clearInterval(interval);
  }, [isWizard, currentStep, form.folder_path, refreshCwdtPreview]);

  const toggleSecret = (key: string) => {
    const keys = form.secret_keys.includes(key)
      ? form.secret_keys.filter((k) => k !== key)
      : [...form.secret_keys, key];
    setForm({ ...form, secret_keys: keys });
  };

  const handleSubmit = () => {
    const args = argsText
      .split(/\s+/)
      .filter((s) => s.length > 0);
    const env: Record<string, string> = {};
    for (const line of envText.split("\n")) {
      const eqIdx = line.indexOf("=");
      if (eqIdx > 0) {
        env[line.slice(0, eqIdx).trim()] = line.slice(eqIdx + 1).trim();
      }
    }
    onSave({ ...form, args, env });
  };

  const goNext = () => {
    if (currentIdx < STEPS.length - 1) {
      setCurrentStep(STEPS[currentIdx + 1].id);
    }
  };

  const goBack = () => {
    if (currentIdx > 0) {
      setCurrentStep(STEPS[currentIdx - 1].id);
    }
  };

  const pickFolder = async () => {
    const selected = await open({ directory: true, multiple: false, title: "Choose project folder" });
    if (selected) {
      const projectDir = typeof selected === "string" ? selected : selected;
      const cwdtPath = projectDir.replace(/\/+$/, "") + "/.cwdt";
      const updates: Partial<Job> = { folder_path: cwdtPath };
      if (isNew && !form.name) {
        const derived = deriveNameFromPath(cwdtPath);
        if (derived) updates.name = derived;
      }
      setForm({ ...form, ...updates });
    }
  };

  const canAdvanceFromFolder = (): boolean => {
    if (form.job_type === "folder") {
      if (!form.folder_path || !form.name) return false;
      if (isWizard && !cwdtEdited) return false;
      return true;
    }
    return !!form.name;
  };

  // Build cron from weekly mode
  const buildWeeklyCron = (days: string[], time: string): string => {
    if (days.length === 0) return "0 0 * * *";
    const [h, m] = time.split(":").map(Number);
    const dowList = days.map((d) => DAY_CRON_MAP[d]).join(",");
    return `${m ?? 0} ${h ?? 0} * * ${dowList}`;
  };

  const toggleWeeklyDay = (day: string) => {
    const next = weeklyDays.includes(day)
      ? weeklyDays.filter((d) => d !== day)
      : [...weeklyDays, day];
    setWeeklyDays(next);
    setForm({ ...form, cron: buildWeeklyCron(next, weeklyTime) });
  };

  const setWeeklyTimeValue = (time: string) => {
    setWeeklyTime(time);
    setForm({ ...form, cron: buildWeeklyCron(weeklyDays, time) });
  };

  // ---- Shared field renderers ----

  const renderFolderFields = () => (
    <>
      <div className="form-group">
        <label>Folder Path</label>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            type="text"
            value={form.folder_path ?? ""}
            onChange={(e) => {
              const val = e.target.value || null;
              const updates: Partial<Job> = { folder_path: val };
              if (isNew && val && !form.name) {
                const derived = deriveNameFromPath(val);
                if (derived) updates.name = derived;
              }
              setForm({ ...form, ...updates });
            }}
            placeholder="/path/to/project/.cwdt"
            style={{ flex: 1 }}
          />
          <button className="btn btn-sm" onClick={pickFolder}>
            Browse...
          </button>
        </div>
        <span className="hint">Pick a project folder. A .cwdt/cwdt.md will be created inside it.</span>
      </div>

      <div className="form-group">
        <label>Name</label>
        <input
          type="text"
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          disabled={!isNew}
          placeholder="my-job"
        />
        {isNew && (
          <span className="hint">Auto-derived from folder path</span>
        )}
      </div>

      {form.folder_path && (
        <div className="form-group">
          <div className="btn-group" style={{ marginBottom: 8 }}>
            <button
              className="btn btn-sm"
              onClick={() => {
                invoke("open_job_editor", { folderPath: form.folder_path, editor: preferredEditor }).then(() => {
                  // Will be picked up by polling
                });
              }}
            >
              Edit in {EDITOR_LABELS[preferredEditor] ?? preferredEditor}
            </button>
            <select
              value={preferredEditor}
              onChange={(e) => setPreferredEditor(e.target.value)}
              style={{ padding: "2px 6px", fontSize: 12 }}
            >
              {availableEditors.map((e) => (
                <option key={e} value={e}>
                  {EDITOR_LABELS[e] ?? e}
                </option>
              ))}
            </select>
            <button
              className="btn btn-sm"
              onClick={() => refreshCwdtPreview(form.folder_path!)}
            >
              Refresh
            </button>
          </div>
          {cwdtPreview !== null && (
            <div style={{ border: "1px solid var(--border)", borderRadius: 4, padding: 8, maxHeight: 200, overflowY: "auto" }}>
              <pre style={{ margin: 0, fontSize: 12, whiteSpace: "pre-wrap" }}>{cwdtPreview || "(empty)"}</pre>
            </div>
          )}
          {isWizard && !cwdtEdited && (
            <span className="hint" style={{ color: "var(--warning, #e6a700)" }}>
              Edit cwdt.md before proceeding -- the default template must be changed.
            </span>
          )}
        </div>
      )}
    </>
  );

  const renderScheduleFields = () => {
    if (isWizard) {
      return (
        <div className="form-group">
          <div style={{ marginBottom: 12 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", marginBottom: 8 }}>
              <input
                type="checkbox"
                checked={manualOnly}
                onChange={(e) => {
                  setManualOnly(e.target.checked);
                  if (e.target.checked) {
                    setForm({ ...form, cron: "" });
                  } else {
                    if (useWeekly) {
                      setForm({ ...form, cron: buildWeeklyCron(weeklyDays, weeklyTime) });
                    } else {
                      setForm({ ...form, cron: "0 0 * * *" });
                    }
                  }
                }}
              />
              Manual only (no automatic schedule)
            </label>
          </div>

          {!manualOnly && (
            <>
              <div style={{ marginBottom: 16 }}>
                <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                  <input
                    type="radio"
                    name="schedule-mode"
                    checked={useWeekly}
                    onChange={() => {
                      setUseWeekly(true);
                      setForm({ ...form, cron: buildWeeklyCron(weeklyDays, weeklyTime) });
                    }}
                  />
                  Daily schedule
                </label>
                <div style={{ opacity: useWeekly ? 1 : 0.4, pointerEvents: useWeekly ? "auto" : "none", paddingLeft: 24 }}>
                  <div style={{ display: "flex", gap: 4, marginBottom: 8, flexWrap: "wrap" }}>
                    {DAYS.map((day) => (
                      <button
                        key={day}
                        className={`btn btn-sm ${weeklyDays.includes(day) ? "btn-primary" : ""}`}
                        onClick={() => toggleWeeklyDay(day)}
                        style={{ minWidth: 44 }}
                      >
                        {day}
                      </button>
                    ))}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <label style={{ margin: 0, fontSize: 13 }}>Time:</label>
                    <input
                      type="time"
                      value={weeklyTime}
                      onChange={(e) => setWeeklyTimeValue(e.target.value)}
                      style={{ maxWidth: 120 }}
                    />
                  </div>
                  {useWeekly && (
                    <span className="hint" style={{ marginTop: 4, display: "block" }}>
                      {describeCron(form.cron)}
                    </span>
                  )}
                </div>
              </div>

              <div>
                <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                  <input
                    type="radio"
                    name="schedule-mode"
                    checked={!useWeekly}
                    onChange={() => {
                      setUseWeekly(false);
                      setForm({ ...form, cron: "0 0 * * *" });
                    }}
                  />
                  Cron expression
                </label>
                <div style={{ opacity: !useWeekly ? 1 : 0.4, pointerEvents: !useWeekly ? "auto" : "none", paddingLeft: 24 }}>
                  <CronInput value={form.cron} onChange={(cron) => setForm({ ...form, cron })} />
                </div>
              </div>
            </>
          )}
        </div>
      );
    }

    return (
      <CronInput value={form.cron} onChange={(cron) => setForm({ ...form, cron })} />
    );
  };

  const renderSecretsFields = () => (
    <div className="form-group">
      <label>Secrets (injected as env vars)</label>
      {availableSecrets === null ? (
        <p className="text-secondary">Loading secrets...</p>
      ) : availableSecrets.length === 0 ? (
        <p className="text-secondary">No secrets configured. Add them in the Secrets tab.</p>
      ) : (
        <div style={{ maxHeight: 200, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 4, padding: 8 }}>
          {availableSecrets.map((s) => (
            <label key={s.key} style={{ display: "flex", alignItems: "center", gap: 6, padding: "2px 0", cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={form.secret_keys.includes(s.key)}
                onChange={() => toggleSecret(s.key)}
              />
              <span>{s.key}</span>
              <span className="text-secondary" style={{ fontSize: 11 }}>({s.source})</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );

  const renderConfigFields = () => (
    <>
      <div className="form-group">
        <label>Group</label>
        <input
          type="text"
          value={form.group}
          onChange={(e) => setForm({ ...form, group: e.target.value || "default" })}
          placeholder="default"
        />
        <span className="hint">Jobs are grouped by this label in the list</span>
      </div>

      {(form.job_type === "claude" || form.job_type === "folder") && (
        <>
          <div className="form-group">
            <label>Tmux Session</label>
            <input
              type="text"
              value={form.tmux_session ?? ""}
              onChange={(e) =>
                setForm({ ...form, tmux_session: e.target.value || null })
              }
              placeholder={`Default: ${defaultTmuxSession}`}
            />
          </div>

          {aerospaceAvailable && (
            <div className="form-group">
              <label
                style={{ cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }}
                onClick={() => setAerospaceExpanded(!aerospaceExpanded)}
              >
                <span style={{ fontSize: 10, transform: aerospaceExpanded ? "rotate(0deg)" : "rotate(-90deg)", transition: "transform 0.15s" }}>
                  &#9660;
                </span>
                Aerospace Workspace
              </label>
              {aerospaceExpanded && (
                <>
                  <select
                    value={form.aerospace_workspace ?? ""}
                    onChange={(e) =>
                      setForm({ ...form, aerospace_workspace: e.target.value || null })
                    }
                  >
                    <option value="">None</option>
                    {aerospaceWorkspaces.map((ws) => (
                      <option key={ws.name} value={ws.name}>
                        {ws.name}
                      </option>
                    ))}
                  </select>
                  <span className="hint">Move tmux window to this workspace after creation</span>
                </>
              )}
            </div>
          )}
        </>
      )}

      <div className="form-group">
        <label>Telegram Chat</label>
        {telegramChats.length > 0 ? (
          <select
            value={form.telegram_chat_id ?? ""}
            onChange={(e) => {
              const val = e.target.value;
              setForm({ ...form, telegram_chat_id: val ? parseInt(val, 10) : null });
            }}
          >
            <option value="">None</option>
            {telegramChats.map((chat) => (
              <option key={chat.id} value={chat.id}>
                {chat.name ? `${chat.name} (${chat.id})` : String(chat.id)}
              </option>
            ))}
          </select>
        ) : (
          <input
            type="text"
            value={form.telegram_chat_id ?? ""}
            onChange={(e) => {
              const val = e.target.value.trim();
              setForm({ ...form, telegram_chat_id: val ? parseInt(val, 10) || null : null });
            }}
            placeholder="No chats configured"
          />
        )}
        <span className="hint">
          {telegramChats.length > 0
            ? "Select which chat receives notifications for this job"
            : "Configure telegram in Settings to add chats"}
        </span>
      </div>

      {form.job_type === "folder" && form.name && (
        <div className="form-group">
          <label>
            Browser Session{" "}
            <span style={{ color: browserSessionExists ? "var(--success)" : "var(--text-secondary)", fontSize: 11 }}>
              ({browserSessionExists ? "active" : "none"})
            </span>
          </label>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              type="text"
              value={browserAuthUrl}
              onChange={(e) => setBrowserAuthUrl(e.target.value)}
              placeholder="https://x.com"
              style={{ flex: 1 }}
            />
            <button
              className="btn btn-sm"
              onClick={() => {
                invoke("launch_browser_auth", { jobName: form.name, url: browserAuthUrl })
                  .catch((e) => alert(`Failed to launch auth browser: ${e}`));
              }}
            >
              Launch Auth
            </button>
            {browserSessionExists && (
              <button
                className="btn btn-sm"
                onClick={() => {
                  invoke("clear_browser_session", { jobName: form.name }).then(() =>
                    setBrowserSessionExists(false),
                  );
                }}
              >
                Clear
              </button>
            )}
          </div>
          <span className="hint">Log in to sites the bot needs. Session persists across runs.</span>
        </div>
      )}
    </>
  );

  // ---- Wizard mode (new folder jobs) ----

  if (isWizard) {
    return (
      <div className="settings-section">
        <div className="section-header">
          <h2>New Job</h2>
        </div>

        <div style={{ maxWidth: 520, margin: "0 auto" }}>
          <div style={{ display: "flex", gap: 4, marginBottom: 24 }}>
            {STEPS.map((step, idx) => (
              <div
                key={step.id}
                style={{
                  flex: 1,
                  height: 4,
                  borderRadius: 2,
                  background: idx <= currentIdx ? "var(--accent)" : "var(--border)",
                }}
              />
            ))}
          </div>

          <p className="text-secondary" style={{ marginBottom: 4 }}>
            Step {currentIdx + 1} of {STEPS.length}: {STEPS[currentIdx].label}
          </p>
          <p style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 16 }}>
            {STEP_TIPS[currentStep]}
          </p>

          {currentStep === "folder" && (
            <div>
              <div className="form-group" style={{ marginBottom: 16 }}>
                <label>Type</label>
                <select
                  value={form.job_type}
                  onChange={(e) =>
                    setForm({ ...form, job_type: e.target.value as JobType })
                  }
                >
                  <option value="folder">Folder (.cwdt)</option>
                  <option value="claude">Claude</option>
                  <option value="binary">Binary</option>
                </select>
              </div>
              {renderFolderFields()}
            </div>
          )}

          {currentStep === "schedule" && renderScheduleFields()}
          {currentStep === "secrets" && renderSecretsFields()}
          {currentStep === "config" && renderConfigFields()}

          <div className="btn-group" style={{ marginTop: 24 }}>
            <button className="btn" onClick={onCancel}>
              Cancel
            </button>
            {currentIdx > 0 && (
              <button className="btn" onClick={goBack}>
                Back
              </button>
            )}
            {currentStep === "config" ? (
              <button
                className="btn btn-primary"
                onClick={handleSubmit}
                disabled={!canAdvanceFromFolder()}
              >
                Create
              </button>
            ) : (
              <button
                className="btn btn-primary"
                onClick={goNext}
                disabled={currentStep === "folder" && !canAdvanceFromFolder()}
              >
                Next
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ---- Single-page mode (editing or non-folder new jobs) ----

  return (
    <div className="settings-section">
      <div className="section-header">
        <h2>{isNew ? "New Job" : `Edit: ${form.name}`}</h2>
      </div>

      {isNew && (
        <div className="form-group">
          <label>Type</label>
          <select
            value={form.job_type}
            onChange={(e) =>
              setForm({ ...form, job_type: e.target.value as JobType })
            }
          >
            <option value="folder">Folder (.cwdt)</option>
            <option value="claude">Claude</option>
            <option value="binary">Binary</option>
          </select>
        </div>
      )}

      {form.job_type === "folder" ? (
        renderFolderFields()
      ) : (
        <>
          <div className="form-group">
            <label>Name</label>
            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              disabled={!isNew}
              placeholder="my-job"
            />
          </div>

          <div className="form-group">
            <label>{form.job_type === "binary" ? "Binary Path" : "Prompt File Path"}</label>
            <input
              type="text"
              value={form.path}
              onChange={(e) => setForm({ ...form, path: e.target.value })}
              placeholder={
                form.job_type === "binary"
                  ? "/path/to/binary"
                  : "x-marketing/prompt-product.md"
              }
              style={{ maxWidth: "100%" }}
            />
          </div>

          {form.job_type === "binary" && (
            <div className="form-group">
              <label>Arguments</label>
              <input
                type="text"
                value={argsText}
                onChange={(e) => setArgsText(e.target.value)}
                placeholder="arg1 arg2"
                style={{ maxWidth: "100%" }}
              />
              <span className="hint">Space-separated arguments</span>
            </div>
          )}
        </>
      )}

      {renderScheduleFields()}
      {renderSecretsFields()}

      {form.job_type === "binary" && (
        <div className="form-group">
          <label>Environment Variables</label>
          <textarea
            value={envText}
            onChange={(e) => setEnvText(e.target.value)}
            placeholder={"KEY=value\nANOTHER=value"}
            rows={3}
            style={{ maxWidth: "100%" }}
          />
          <span className="hint">One per line: KEY=value</span>
        </div>
      )}

      {form.job_type !== "folder" && (
        <div className="form-group">
          <label>Working Directory</label>
          <input
            type="text"
            value={form.work_dir ?? ""}
            onChange={(e) =>
              setForm({ ...form, work_dir: e.target.value || null })
            }
            placeholder="Leave empty to use default"
            style={{ maxWidth: "100%" }}
          />
        </div>
      )}

      {renderConfigFields()}

      <div className="btn-group" style={{ marginTop: 20 }}>
        <button className="btn btn-primary" onClick={handleSubmit}>
          {isNew ? "Create" : "Save"}
        </button>
        <button className="btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
