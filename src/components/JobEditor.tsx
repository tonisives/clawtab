import { useEffect, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { AerospaceWorkspace, AppSettings, Job, JobType, SecretEntry } from "../types";
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
  folder: "Choose the project folder and name the job. A .cwt/{job-name}/job.md file will be created with directions for the AI.",
  schedule: "How often should this job run? Pick a preset, choose specific days, or write a cron expression.",
  secrets: "Select API keys and tokens this job needs. They'll be injected as environment variables when the job runs.",
  config: "Optional settings. Most jobs work fine with defaults.",
};

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
const DAY_CRON_MAP: Record<string, string> = {
  Mon: "1", Tue: "2", Wed: "3", Thu: "4", Fri: "5", Sat: "6", Sun: "0",
};
const CRON_DAY_MAP: Record<string, string> = {
  "0": "Sun", "1": "Mon", "2": "Tue", "3": "Wed", "4": "Thu", "5": "Fri", "6": "Sat",
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
  job_name: null,
  telegram_chat_id: null,
  telegram_log_mode: "on_prompt",
  telegram_notify: { start: true, working: true, logs: true, finish: true },
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

const JOB_NAME_MAX_LENGTH = 40;

function slugifyName(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, JOB_NAME_MAX_LENGTH);
}

function FieldGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="field-group">
      <span className="field-group-title">{title}</span>
      {children}
    </div>
  );
}

/** Parse a cron expression into weekly picker state, or return null if not parseable as weekly. */
function parseCronToWeekly(cron: string): { days: string[]; time: string } | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [min, hour, dom, mon, dow] = parts;
  if (dom !== "*" || mon !== "*") return null;
  if (dow === "*") {
    // daily -- all days
    if (hour === "*" || min === "*") return null;
    const h = parseInt(hour, 10);
    const m = parseInt(min, 10);
    if (isNaN(h) || isNaN(m)) return null;
    return {
      days: [...DAYS],
      time: `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`,
    };
  }
  // Specific days
  const h = parseInt(hour, 10);
  const m = parseInt(min, 10);
  if (isNaN(h) || isNaN(m)) return null;
  const dayNums = dow.split(",");
  const dayNames = dayNums.map((d) => CRON_DAY_MAP[d.trim()]).filter(Boolean);
  if (dayNames.length === 0) return null;
  return {
    days: dayNames,
    time: `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`,
  };
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
  const [cwtContextPreview, setCwtContextPreview] = useState<string | null>(null);
  const [previewFile, setPreviewFile] = useState<"job.md" | "cwt.md">("job.md");
  const [preferredEditor, setPreferredEditor] = useState("nvim");
  const [telegramChats, setTelegramChats] = useState<{ id: number; name: string }[]>([]);
  const [aerospaceExpanded, setAerospaceExpanded] = useState(false);

  // Inline editor state
  const [inlineContent, setInlineContent] = useState("");
  const [inlineLoaded, setInlineLoaded] = useState(false);

  // Schedule mode state -- initialize from existing cron
  const initWeekly = !isNew ? parseCronToWeekly(form.cron) : null;
  const [manualOnly, setManualOnly] = useState(!isNew ? form.cron === "" : false);
  const [useWeekly, setUseWeekly] = useState(!isNew ? (form.cron === "" || initWeekly !== null) : true);
  const [weeklyDays, setWeeklyDays] = useState<string[]>(initWeekly?.days ?? ["Mon"]);
  const [weeklyTime, setWeeklyTime] = useState(initWeekly?.time ?? "09:00");

  // job.md edited tracking
  const [cwtEdited, setCwtEdited] = useState(!isNew);

  // Load settings and detected editors on mount
  useEffect(() => {
    invoke<AppSettings>("get_settings").then((s) => {
      setPreferredEditor(s.preferred_editor);
      // Auto-set folder_path for new wizard jobs to default_work_dir/.cwt
      if (isWizard && !form.folder_path) {
        const workDir = (s.default_work_dir || "~").replace(/\/+$/, "");
        setForm((prev) => ({ ...prev, folder_path: workDir + "/.cwt" }));
      }
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
  }, []);

  // Load secrets when entering secrets step (or on mount for edit mode)
  useEffect(() => {
    if (!isWizard || currentStep === "secrets") {
      if (availableSecrets === null) {
        invoke<SecretEntry[]>("list_secrets").then(setAvailableSecrets);
      }
    }
  }, [currentStep, isWizard, availableSecrets]);

  // Load aerospace when entering config step (or on mount for edit mode)
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
    }
  }, [currentStep, isWizard]);

  // Auto-init job.md and load preview when folder path changes
  const refreshCwtPreview = useCallback((folderPath: string, jn: string | null) => {
    invoke<string>("read_cwt_entry", { folderPath, jobName: jn ?? "default" })
      .then((content) => {
        setCwtEdited(!!content && content.trim() !== DEFAULT_TEMPLATE.trim());
        if (!inlineLoaded) {
          setInlineContent(content);
          setInlineLoaded(true);
        }
      })
      .catch(() => {});
    invoke<string>("read_cwt_context", { folderPath, jobName: jn ?? "default" })
      .then(setCwtContextPreview)
      .catch(() => setCwtContextPreview(null));
  }, [inlineLoaded]);

  useEffect(() => {
    if (form.job_type === "folder" && form.folder_path) {
      // Auto-init then load preview
      const jn = form.job_name ?? "default";
      invoke("init_cwt_folder", { folderPath: form.folder_path, jobName: jn }).then(() => {
        refreshCwtPreview(form.folder_path!, form.job_name);
      });
    } else {
      setCwtContextPreview(null);
    }
  }, [form.folder_path, form.job_type, form.job_name, refreshCwtPreview]);

  // Save inline content immediately on each change
  const handleInlineChange = (content: string) => {
    setInlineContent(content);
    setCwtEdited(!!content && content.trim() !== DEFAULT_TEMPLATE.trim());
    if (form.folder_path) {
      invoke("write_cwt_entry", {
        folderPath: form.folder_path,
        jobName: form.job_name ?? "default",
        content,
      }).catch(() => {});
    }
  };

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
      const cwtPath = projectDir.replace(/\/+$/, "") + "/.cwt";
      setForm({ ...form, folder_path: cwtPath });
    }
  };

  const canAdvanceFromFolder = (): boolean => {
    if (form.job_type === "folder") {
      if (!form.folder_path || !form.name) return false;
      if (isWizard && !cwtEdited) return false;
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

  const renderIdentityFields = () => (
    <>
      {isNew && (
        <div className="form-group">
          <label>Type</label>
          <select
            value={form.job_type}
            onChange={(e) =>
              setForm({ ...form, job_type: e.target.value as JobType })
            }
          >
            <option value="folder">Folder (.cwt)</option>
            <option value="claude">Claude</option>
            <option value="binary">Binary</option>
          </select>
        </div>
      )}

      {form.job_type === "folder" ? (
        <>
          <div className="form-group">
            <label>Folder Path</label>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input
                type="text"
                value={form.folder_path ?? ""}
                onChange={(e) => {
                  const val = e.target.value || null;
                  setForm({ ...form, folder_path: val });
                }}
                placeholder=""
                style={{ flex: 1 }}
              />
              <button className="btn btn-sm" onClick={pickFolder}>
                Browse...
              </button>
            </div>
            <span className="hint">Pick a project folder. A .cwt/ directory will be created inside it.</span>
          </div>

          <div className="form-group">
            <label>Name</label>
            <input
              type="text"
              value={form.name}
              maxLength={JOB_NAME_MAX_LENGTH}
              onChange={(e) => {
                const name = e.target.value;
                const jobName = slugifyName(name) || null;
                setForm({ ...form, name, job_name: jobName });
              }}
              placeholder=""
            />
            {form.name && (
              <span className="hint">
                Folder: .cwt/{slugifyName(form.name) || "default"}/
              </span>
            )}
          </div>
        </>
      ) : (
        <>
          <div className="form-group">
            <label>Name</label>
            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder=""
            />
          </div>

          <div className="form-group">
            <label>{form.job_type === "binary" ? "Binary Path" : "Prompt File Path"}</label>
            <input
              type="text"
              value={form.path}
              onChange={(e) => setForm({ ...form, path: e.target.value })}
              placeholder=""
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
                placeholder=""
                style={{ maxWidth: "100%" }}
              />
              <span className="hint">Space-separated arguments</span>
            </div>
          )}
        </>
      )}
    </>
  );

  const renderDirectionsFields = () => {
    if (form.job_type !== "folder" || !form.folder_path) return null;

    const showTabs = !isNew;

    return (
      <div className="form-group">
        <div className="directions-box">
          {showTabs ? (
            <div className="directions-tabs">
              <button
                className={`directions-tab ${previewFile === "job.md" ? "active" : ""}`}
                onClick={() => setPreviewFile("job.md")}
              >
                job.md
              </button>
              <button
                className={`directions-tab ${previewFile === "cwt.md" ? "active" : ""}`}
                onClick={() => setPreviewFile("cwt.md")}
              >
                cwt.md
              </button>
            </div>
          ) : (
            <div className="directions-tabs">
              <span className="directions-tab active">job.md</span>
            </div>
          )}
          {previewFile === "job.md" ? (
            <textarea
              className="directions-editor"
              value={inlineContent}
              onChange={(e) => handleInlineChange(e.target.value)}
              spellCheck={false}
              placeholder=""
            />
          ) : (
            <pre className="directions-body">
              {cwtContextPreview || "(empty)"}
            </pre>
          )}
        </div>

        <button
          className="btn btn-sm"
          style={{ marginTop: 8 }}
          onClick={() => {
            invoke("open_job_editor", {
              folderPath: form.folder_path,
              editor: preferredEditor,
              jobName: form.job_name ?? "default",
              fileName: previewFile,
            });
          }}
        >
          Edit in {EDITOR_LABELS[preferredEditor] ?? preferredEditor}
        </button>

        {isWizard && !cwtEdited && (
          <span className="hint" style={{ color: "var(--warning-color)" }}>
            Edit job.md before proceeding -- the default template must be changed.
          </span>
        )}
      </div>
    );
  };

  const renderScheduleFields = () => (
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
            </label>
          ))}
        </div>
      )}
    </div>
  );

  const renderRuntimeFields = () => (
    <>
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
              placeholder=""
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
            placeholder=""
          />
        )}
        <span className="hint">
          {telegramChats.length > 0
            ? "Select which chat receives notifications for this job"
            : "Configure telegram in Settings to add chats"}
        </span>
      </div>

      {form.telegram_chat_id != null && (form.job_type === "claude" || form.job_type === "folder") && (
        <div className="form-group">
          <label>Telegram Notifications</label>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "4px 0" }}>
            {([
              { key: "start" as const, label: "Job started", hint: "Notify when the job begins" },
              { key: "working" as const, label: "Working timer", hint: "Live elapsed time counter" },
              { key: "logs" as const, label: "Log output", hint: "Stream pane output while running" },
              { key: "finish" as const, label: "Job finished", hint: "Final snapshot and completion message" },
            ] as const).map(({ key, label, hint }) => (
              <label key={key} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={form.telegram_notify[key]}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      telegram_notify: { ...form.telegram_notify, [key]: e.target.checked },
                    })
                  }
                  style={{ margin: 0 }}
                />
                <span>{label}</span>
                <span style={{ color: "var(--text-secondary)", fontSize: 11 }}>{hint}</span>
              </label>
            ))}
          </div>
        </div>
      )}
    </>
  );

  const renderConfigFields = () => (
    <>
      <div className="form-group">
        <label>Group</label>
        <input
          type="text"
          value={form.group}
          onChange={(e) => setForm({ ...form, group: e.target.value || "default" })}
          placeholder=""
        />
        <span className="hint">Jobs are grouped by this label in the list</span>
      </div>

      {form.job_type === "binary" && (
        <div className="form-group">
          <label>Environment Variables</label>
          <textarea
            value={envText}
            onChange={(e) => setEnvText(e.target.value)}
            placeholder=""
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
            placeholder=""
            style={{ maxWidth: "100%" }}
          />
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

        <div>
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
          </div>

          {currentStep === "folder" && (
            <>
              <div style={{ maxWidth: 520, margin: "0 auto" }}>
                <FieldGroup title="Identity">
                  {renderIdentityFields()}
                </FieldGroup>
              </div>
              {form.folder_path && (
                <FieldGroup title="Directions">
                  {renderDirectionsFields()}
                </FieldGroup>
              )}
            </>
          )}

          <div style={{ maxWidth: 520, margin: "0 auto" }}>
            {currentStep === "schedule" && (
              <FieldGroup title="Schedule">
                {renderScheduleFields()}
              </FieldGroup>
            )}

            {currentStep === "secrets" && (
              <FieldGroup title="Secrets">
                {renderSecretsFields()}
              </FieldGroup>
            )}

            {currentStep === "config" && (
              <>
                <FieldGroup title="Config">
                  {renderConfigFields()}
                </FieldGroup>
                <FieldGroup title="Runtime">
                  {renderRuntimeFields()}
                </FieldGroup>
              </>
            )}

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
      </div>
    );
  }

  // ---- Single-page mode (editing or non-folder new jobs) ----

  return (
    <div className="settings-section">
      <div className="section-header" style={{ justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button
            onClick={onCancel}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              color: "var(--text-secondary)",
              padding: "2px 4px",
              lineHeight: 1,
              display: "inline-flex",
              alignItems: "center",
            }}
            title="Back to jobs"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 18l-6-6 6-6" />
            </svg>
          </button>
          <h2>{isNew ? "New Job" : `Edit: ${form.name}`}</h2>
        </div>
        <button className="btn btn-primary btn-sm" onClick={handleSubmit}>
          {isNew ? "Create" : "Save"}
        </button>
      </div>

      <FieldGroup title="Identity">
        {renderIdentityFields()}
      </FieldGroup>

      {form.job_type === "folder" && form.folder_path && (
        <FieldGroup title="Directions">
          {renderDirectionsFields()}
        </FieldGroup>
      )}

      <FieldGroup title="Schedule">
        {renderScheduleFields()}
      </FieldGroup>

      <FieldGroup title="Secrets">
        {renderSecretsFields()}
      </FieldGroup>

      <FieldGroup title="Config">
        {renderConfigFields()}
      </FieldGroup>

      <FieldGroup title="Runtime">
        {renderRuntimeFields()}
      </FieldGroup>
    </div>
  );
}
