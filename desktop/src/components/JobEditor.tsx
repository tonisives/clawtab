import { useEffect, useState, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import type { AerospaceWorkspace, AppSettings, Job, JobType, NotifyTarget, SecretEntry } from "../types";
import { CronInput, describeCron } from "./CronInput";
import { SAMPLE_TEMPLATES, TEMPLATE_CATEGORIES } from "../data/sampleTemplates";

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
  identity: "Choose the project folder, name the job, and write its directions.",
  settings: "Configure schedule, secrets, and notifications. Expand sections as needed.",
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
  onPickTemplate?: (templateId: string) => void;
  defaultGroup?: string;
  defaultFolderPath?: string;
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
  notify_target: "none",
  group: "default",
  slug: "",
  skill_paths: [],
  params: [],
  kill_on_end: true,
};

type WizardStep = "identity" | "settings";

const STEPS: { id: WizardStep; label: string }[] = [
  { id: "identity", label: "Identity & Directions" },
  { id: "settings", label: "Settings" },
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

function CollapsibleFieldGroup({ title, expanded, onToggle, children }: { title: string; expanded: boolean; onToggle: () => void; children: React.ReactNode }) {
  return (
    <div className="field-group">
      <span
        className="field-group-title"
        style={{ cursor: "pointer", userSelect: "none", display: "flex", alignItems: "center", gap: 6 }}
        onClick={onToggle}
      >
        <span style={{ fontSize: 10, transform: expanded ? "rotate(0deg)" : "rotate(-90deg)", transition: "transform 0.15s", display: "inline-block" }}>
          &#9660;
        </span>
        {title}
      </span>
      {expanded && children}
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

export function JobEditor({ job, onSave, onCancel, onPickTemplate, defaultGroup, defaultFolderPath }: Props) {
  const [form, setForm] = useState<Job>(job ?? {
    ...emptyJob,
    ...(defaultGroup ? { group: defaultGroup } : {}),
    ...(defaultFolderPath ? { folder_path: defaultFolderPath } : {}),
  });
  const [argsText, setArgsText] = useState(form.args.join(" "));
  const [envText, setEnvText] = useState(
    Object.entries(form.env)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n"),
  );

  const isNew = job === null;
  const isWizard = isNew && form.job_type === "folder";

  // Wizard state
  const [currentStep, setCurrentStep] = useState<WizardStep>("identity");
  const currentIdx = STEPS.findIndex((s) => s.id === currentStep);

  // Existing jobs for import
  const [existingJobs, setExistingJobs] = useState<Job[]>([]);
  const [showImportPicker, setShowImportPicker] = useState(false);

  useEffect(() => {
    if (isNew) {
      invoke<Job[]>("get_jobs").then(setExistingJobs).catch(() => {});
    }
  }, []);

  const importableJobs = existingJobs.filter((j) => j.job_type === "folder");

  const handleImportJob = async (source: Job) => {
    // Load the source job's content
    const jn = source.job_name ?? "default";
    const [jobMd, cwtMd] = await Promise.all([
      invoke<string>("read_cwt_entry", { folderPath: source.folder_path, jobName: jn }).catch(() => ""),
      invoke<string>("read_cwt_shared", { folderPath: source.folder_path! }).catch(() => ""),
    ]);
    // Prefill form from source (but clear name/slug so user must set new ones)
    setForm({
      ...source,
      name: "",
      job_name: null,
      slug: "",
      enabled: true,
    });
    setInlineContent(jobMd);
    setInlineLoaded(true);
    setCwtEdited(!!jobMd && jobMd.trim() !== DEFAULT_TEMPLATE.trim());
    setSharedContent(cwtMd);
    setSharedLoaded(true);
    setShowImportPicker(false);
  };

  // Lazy-loaded data
  const [availableSkills, setAvailableSkills] = useState<{ name: string }[] | null>(null);
  const [availableSecrets, setAvailableSecrets] = useState<SecretEntry[] | null>(null);
  const [aerospaceAvailable, setAerospaceAvailable] = useState(false);
  const [aerospaceWorkspaces, setAerospaceWorkspaces] = useState<AerospaceWorkspace[]>([]);
  const [previewFile, setPreviewFile] = useState<"job.md" | "cwt.md">("job.md");
  const [sharedContent, setSharedContent] = useState("");
  const [sharedLoaded, setSharedLoaded] = useState(false);
  const [preferredEditor, setPreferredEditor] = useState("nvim");
  const [telegramChats, setTelegramChats] = useState<{ id: number; name: string }[]>([]);
  const [aerospaceExpanded, setAerospaceExpanded] = useState(false);
  const [paramInput, setParamInput] = useState("");

  // Template categories for wizard
  const [expandedCategory, setExpandedCategory] = useState<string | null>(null);

  // Wizard step 2 collapsible sections
  const [scheduleExpanded, setScheduleExpanded] = useState(true);
  const [secretsExpanded, setSecretsExpanded] = useState(false);
  const [skillsExpanded, setSkillsExpanded] = useState(false);
  const [telegramExpanded, setTelegramExpanded] = useState(false);
  const [advancedExpanded, setAdvancedExpanded] = useState(false);

  // Inline editor state
  const [inlineContent, setInlineContent] = useState("");
  const [inlineLoaded, setInlineLoaded] = useState(false);

  // Schedule mode state -- initialize from existing cron
  const initWeekly = !isNew ? parseCronToWeekly(form.cron) : null;
  const [manualOnly, setManualOnly] = useState(!isNew ? form.cron === "" : false);
  const [useWeekly, setUseWeekly] = useState(!isNew ? (form.cron === "" || initWeekly !== null) : true);
  const [weeklyDays, setWeeklyDays] = useState<string[]>(initWeekly?.days ?? ["Mon"]);
  const [weeklyTime, setWeeklyTime] = useState(initWeekly?.time ?? "09:00");

  // Force manual-only when params are present
  const hasParams = form.params.length > 0;
  useEffect(() => {
    if (hasParams && !manualOnly) {
      setManualOnly(true);
      setForm((prev) => ({ ...prev, cron: "" }));
    }
  }, [hasParams]);

  // job.md edited tracking
  const [cwtEdited, setCwtEdited] = useState(!isNew);

  // Template grid data
  const templatesByCategory = TEMPLATE_CATEGORIES.map((cat) => ({
    ...cat,
    templates: SAMPLE_TEMPLATES.filter((t) => t.category === cat.id),
  }));
  const templateRows: (typeof templatesByCategory)[] = [];
  for (let i = 0; i < templatesByCategory.length; i += 2) {
    templateRows.push(templatesByCategory.slice(i, i + 2));
  }

  // Load settings and detected editors on mount
  useEffect(() => {
    invoke<AppSettings>("get_settings").then((s) => {
      setPreferredEditor(s.preferred_editor);
      // Auto-set folder_path for new wizard jobs to default_work_dir/.cwt
      if (isWizard && !form.folder_path) {
        const workDir = (s.default_work_dir || "~").replace(/\/+$/, "");
        setForm((prev) => ({ ...prev, folder_path: workDir + "/.cwt" }));
      }
      if (isNew && s.default_tmux_session) {
        setForm((prev) => ({ ...prev, tmux_session: s.default_tmux_session }));
      }
      if (s.telegram?.chat_ids?.length) {
        const chats = s.telegram.chat_ids.map((id) => ({
          id,
          name: s.telegram?.chat_names?.[String(id)] ?? "",
        }));
        setTelegramChats(chats);
        if (isNew && form.telegram_chat_id === null) {
          setForm((prev) => ({
            ...prev,
            telegram_chat_id: chats[0].id,
            notify_target: "telegram",
          }));
        }
      }
    });
  }, []);

  // Load secrets and skills when entering settings step (or on mount for edit mode)
  useEffect(() => {
    if (!isWizard || currentStep === "settings") {
      if (availableSecrets === null) {
        invoke<SecretEntry[]>("list_secrets").then(setAvailableSecrets);
      }
      if (availableSkills === null) {
        invoke<{ name: string }[]>("list_skills").then(setAvailableSkills).catch(() => setAvailableSkills([]));
      }
    }
  }, [currentStep, isWizard, availableSecrets, availableSkills]);

  // Load aerospace when entering settings step (or on mount for edit mode)
  useEffect(() => {
    if (!isWizard || currentStep === "settings") {
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

  // Load existing content for edit mode (not new wizard)
  useEffect(() => {
    if (!isNew && form.job_type === "folder" && form.folder_path) {
      const jn = form.job_name ?? "default";
      invoke<string>("read_cwt_entry", { folderPath: form.folder_path, jobName: jn })
        .then((content) => {
          setCwtEdited(!!content && content.trim() !== DEFAULT_TEMPLATE.trim());
          if (!inlineLoaded) {
            setInlineContent(content);
            setInlineLoaded(true);
          }
        })
        .catch(() => {});
      if (!sharedLoaded) {
        invoke<string>("read_cwt_shared", { folderPath: form.folder_path })
          .then((content) => {
            setSharedContent(content);
            setSharedLoaded(true);
          })
          .catch(() => {});
      }
    }
  }, [form.folder_path, form.job_type]);

  // For new wizard jobs, set default inline content
  useEffect(() => {
    if (isNew && !inlineLoaded) {
      setInlineContent(DEFAULT_TEMPLATE);
    }
  }, []);

  // Update inline content - only write to disk in edit mode
  const handleInlineChange = (content: string) => {
    setInlineContent(content);
    setCwtEdited(!!content && content.trim() !== DEFAULT_TEMPLATE.trim());
    if (!isNew && form.folder_path) {
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

  const toggleSkill = (name: string) => {
    const path = `~/.claude/skills/${name}/SKILL.md`;
    const paths = form.skill_paths.includes(path)
      ? form.skill_paths.filter((p) => p !== path)
      : [...form.skill_paths, path];
    setForm({ ...form, skill_paths: paths });
  };

  const handleSubmit = async () => {
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
    // For new folder jobs, create the .cwt directory and write files now
    if (isNew && form.job_type === "folder" && form.folder_path) {
      const jn = form.job_name ?? "default";
      await invoke("init_cwt_folder", { folderPath: form.folder_path, jobName: jn });
      await invoke("write_cwt_entry", {
        folderPath: form.folder_path,
        jobName: jn,
        content: inlineContent,
      });
      if (sharedContent) {
        await invoke("write_cwt_shared", {
          folderPath: form.folder_path,
          content: sharedContent,
        });
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
      const folderName = projectDir.replace(/\/+$/, "").split("/").pop() || "default";
      setForm({ ...form, folder_path: cwtPath, group: folderName });
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
                disabled={!isNew}
              />
              {isNew && (
                <>
                  <button className="btn btn-sm" onClick={pickFolder}>
                    Browse...
                  </button>
                  {importableJobs.length > 0 && (
                    <div style={{ position: "relative" }}>
                      <button className="btn btn-sm" onClick={() => setShowImportPicker(!showImportPicker)}>
                        Import...
                      </button>
                      {showImportPicker && (
                        <div style={{
                          position: "absolute",
                          top: "100%",
                          right: 0,
                          marginTop: 4,
                          background: "var(--bg-secondary, #1a1a1a)",
                          border: "1px solid var(--border)",
                          borderRadius: 6,
                          padding: 4,
                          zIndex: 100,
                          minWidth: 200,
                          maxHeight: 240,
                          overflowY: "auto",
                          boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
                        }}>
                          {importableJobs.map((j) => (
                            <button
                              key={j.slug}
                              className="btn btn-sm"
                              style={{
                                display: "block",
                                width: "100%",
                                textAlign: "left",
                                fontSize: 12,
                                padding: "6px 8px",
                                border: "none",
                                borderRadius: 4,
                              }}
                              onClick={() => handleImportJob(j)}
                            >
                              <div>{j.name}</div>
                              <div style={{ fontSize: 10, color: "var(--text-secondary)", fontFamily: "monospace" }}>
                                {j.folder_path?.replace(/\/\.cwt$/, "").split("/").pop()}
                              </div>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
            <span className="hint">
              {isNew
                ? "Pick a project folder. A .cwt/ directory will be created inside it."
                : "Directory cannot be changed after creation."}
            </span>
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

  const [dragOver, setDragOver] = useState(false);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const inlineContentRef = useRef(inlineContent);
  inlineContentRef.current = inlineContent;

  const IMAGE_RE = /\.(png|jpe?g|gif|webp|svg|bmp|tiff?)$/i;

  useEffect(() => {
    const unlisten = getCurrentWebview().onDragDropEvent((event) => {
      const el = editorRef.current;
      if (!el || previewFile !== "job.md") return;
      const p = event.payload;

      if (p.type === "over" || p.type === "drop") {
        const rect = el.getBoundingClientRect();
        const { x, y } = p.position;
        const inside = x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;

        if (p.type === "over") {
          setDragOver(inside);
        } else if (inside) {
          setDragOver(false);
          const images = p.paths.filter((path: string) => IMAGE_RE.test(path));
          if (images.length === 0) return;
          const cursor = el.selectionStart ?? inlineContentRef.current.length;
          const insert = images.join("\n") + "\n";
          const updated = inlineContentRef.current.slice(0, cursor) + insert + inlineContentRef.current.slice(cursor);
          handleInlineChange(updated);
        }
      } else {
        setDragOver(false);
      }
    });
    return () => { unlisten.then((fn) => fn()); };
  }, [previewFile]);

  const handleSharedChange = (content: string) => {
    setSharedContent(content);
    if (!isNew && form.folder_path) {
      invoke("write_cwt_shared", {
        folderPath: form.folder_path,
        content,
      }).catch(() => {});
    }
  };

  const renderDirectionsFields = () => {
    if (form.job_type !== "folder" || !form.folder_path) return null;

    return (
      <div className="form-group">
        <div className="directions-box">
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
          {previewFile === "job.md" ? (
            <textarea
              ref={editorRef}
              className={`directions-editor${dragOver ? " drag-over" : ""}`}
              value={inlineContent}
              onChange={(e) => handleInlineChange(e.target.value)}
              spellCheck={false}
              placeholder=""
            />
          ) : (
            <textarea
              className="directions-editor"
              value={sharedContent}
              onChange={(e) => handleSharedChange(e.target.value)}
              spellCheck={false}
              placeholder="Shared project context for all jobs in this folder..."
            />
          )}
        </div>

        {!isNew && (
          <button
            className="btn btn-sm"
            style={{ marginTop: 8 }}
            onClick={() => {
              invoke("open_job_editor", {
                folderPath: form.folder_path,
                editor: preferredEditor,
                jobName: previewFile === "cwt.md" ? "." : (form.job_name ?? "default"),
                fileName: previewFile === "cwt.md" ? "cwt.md" : "job.md",
              });
            }}
          >
            Edit in {EDITOR_LABELS[preferredEditor] ?? preferredEditor}
          </button>
        )}

        {isWizard && !cwtEdited && (
          <span className="hint" style={{ color: "var(--warning-color)" }}>
            Edit job.md before proceeding -- the default template must be changed.
          </span>
        )}
      </div>
    );
  };

  const renderParamsFields = () => {
    if (form.job_type !== "folder") return null;

    const addParam = (name: string) => {
      const key = name.trim().replace(/[^a-zA-Z0-9_-]/g, "");
      if (!key || form.params.includes(key)) return;
      setForm({ ...form, params: [...form.params, key] });
      setParamInput("");
      // Insert placeholder at cursor in editor if visible
      if (editorRef.current && previewFile === "job.md") {
        const ta = editorRef.current;
        const pos = ta.selectionStart;
        const before = inlineContent.slice(0, pos);
        const after = inlineContent.slice(pos);
        const inserted = `{${key}}`;
        handleInlineChange(before + inserted + after);
        requestAnimationFrame(() => {
          ta.selectionStart = ta.selectionEnd = pos + inserted.length;
          ta.focus();
        });
      }
    };

    const removeParam = (key: string) => {
      setForm({ ...form, params: form.params.filter((p) => p !== key) });
    };

    return (
      <div className="form-group">
        <label>Parameters</label>
        <span className="hint">
          Named placeholders replaced at runtime. Jobs with parameters are manual-only.
        </span>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 6 }}>
          {form.params.map((p) => (
            <span
              key={p}
              className="tag"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: 4,
                padding: "2px 8px",
                fontSize: 12,
              }}
            >
              <code>{`{${p}}`}</code>
              <span
                style={{ cursor: "pointer", opacity: 0.6, fontSize: 14, lineHeight: 1 }}
                onClick={() => removeParam(p)}
                title="Remove"
              >
                x
              </span>
            </span>
          ))}
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <input
            className="input"
            type="text"
            value={paramInput}
            onChange={(e) => setParamInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addParam(paramInput);
              }
            }}
            placeholder="param name"
            style={{ flex: 1, maxWidth: 200 }}
          />
          <button
            className="btn btn-sm"
            onClick={() => addParam(paramInput)}
            disabled={!paramInput.trim()}
          >
            Add
          </button>
        </div>
      </div>
    );
  };

  const renderScheduleFields = () => (
    <div className="form-group">
      {hasParams && (
        <span className="hint" style={{ marginBottom: 8, display: "block" }}>
          Schedule is disabled because this job has parameters (manual-only).
        </span>
      )}
      <div style={{ marginBottom: 12, opacity: hasParams ? 0.5 : 1, pointerEvents: hasParams ? "none" : "auto" }}>
        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", marginBottom: 8 }}>
          <input
            type="checkbox"
            checked={manualOnly}
            disabled={hasParams}
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

  const renderSkillsFields = () => (
    <div className="form-group">
      <label>Skills (included as @references in Claude prompt)</label>
      {availableSkills === null ? (
        <p className="text-secondary">Loading skills...</p>
      ) : availableSkills.length === 0 ? (
        <p className="text-secondary">No skills found. Create them in the Skills tab.</p>
      ) : (
        <div style={{ maxHeight: 200, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 4, padding: 8 }}>
          {availableSkills.map((s) => {
            const path = `~/.claude/skills/${s.name}/SKILL.md`;
            return (
              <label key={s.name} style={{ display: "flex", alignItems: "center", gap: 6, padding: "2px 0", cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={form.skill_paths.includes(path)}
                  onChange={() => toggleSkill(s.name)}
                />
                <span>{s.name}</span>
                <span style={{ fontSize: 11, color: "var(--text-secondary)", fontFamily: "monospace" }}>
                  @~/.claude/skills/{s.name}/SKILL.md
                </span>
              </label>
            );
          })}
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

      {renderNotificationFields()}
    </>
  );

  const renderConfigFields = () => (
    <>
      {form.job_type === "folder" && (
        <div className="form-group">
          <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={form.kill_on_end}
              onChange={(e) => setForm({ ...form, kill_on_end: e.target.checked })}
              style={{ margin: 0 }}
            />
            Kill on end
          </label>
          <span className="hint">
            When enabled, the generated cwt.md instructs Claude to run `kill $PPID` when the task is complete.
          </span>
        </div>
      )}

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

  // ---- Wizard-only field renderers (split from runtime/config for collapsible sections) ----

  const renderNotificationFields = () => (
    <>
      <div className="form-group">
        <label>Notification Target</label>
        <div style={{ display: "flex", gap: 8, padding: "4px 0" }}>
          {([
            { value: "none" as NotifyTarget, label: "None" },
            { value: "app" as NotifyTarget, label: "App" },
            { value: "telegram" as NotifyTarget, label: "Telegram" },
          ]).map(({ value, label }) => (
            <label key={value} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 13, cursor: "pointer" }}>
              <input
                type="radio"
                name="notify_target"
                checked={form.notify_target === value}
                onChange={() => setForm({ ...form, notify_target: value })}
                style={{ margin: 0 }}
              />
              {label}
            </label>
          ))}
        </div>
        <span className="hint">
          {form.notify_target === "none" && "No push notifications for this job"}
          {form.notify_target === "app" && "Push notifications via ClawTab mobile app"}
          {form.notify_target === "telegram" && "Notifications sent to Telegram bot"}
        </span>
      </div>

      {form.notify_target === "telegram" && (
        <>
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

          {form.telegram_chat_id != null && (
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
      )}

      {form.notify_target === "app" && (
        <div className="form-group">
          <span className="hint">
            Push notifications sent to ClawTab mobile app. Download at remote.clawtab.cc
          </span>
        </div>
      )}
    </>
  );

  const renderAdvancedFields = () => (
    <>
      {form.job_type === "folder" && (
        <div className="form-group">
          <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={form.kill_on_end}
              onChange={(e) => setForm({ ...form, kill_on_end: e.target.checked })}
              style={{ margin: 0 }}
            />
            Kill on end
          </label>
          <span className="hint">
            When enabled, the generated cwt.md instructs Claude to run `kill $PPID` when the task is complete.
          </span>
        </div>
      )}

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

      {aerospaceAvailable && (
        <div className="form-group">
          <label>Aerospace Workspace</label>
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
        </div>
      )}
    </>
  );

  // ---- Wizard mode (new folder jobs) ----

  if (isWizard) {
    return (
      <div className="settings-section">
        <div className="section-header" onClick={onCancel} style={{ cursor: "pointer" }} title="Back to jobs">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--text-secondary)", flexShrink: 0 }}>
            <path d="M15 18l-6-6 6-6" />
          </svg>
          <h2>Add Job</h2>
        </div>

        <div>
          <div className="wizard-center">
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

          {currentStep === "identity" && (
              <div className="wizard-identity-row">
                <div className="wizard-identity-col">
                  <FieldGroup title="Identity">
                    {renderIdentityFields()}
                  </FieldGroup>
                </div>
                {form.folder_path && (
                  <div className="wizard-directions-col">
                    <FieldGroup title="Directions">
                      {renderDirectionsFields()}
                      {renderParamsFields()}
                    </FieldGroup>
                  </div>
                )}
              </div>
          )}

          {currentStep === "settings" && (
            <div className="wizard-center">
              <CollapsibleFieldGroup title="Schedule" expanded={scheduleExpanded} onToggle={() => setScheduleExpanded(!scheduleExpanded)}>
                {renderScheduleFields()}
              </CollapsibleFieldGroup>

              <CollapsibleFieldGroup title="Secrets" expanded={secretsExpanded} onToggle={() => setSecretsExpanded(!secretsExpanded)}>
                {renderSecretsFields()}
              </CollapsibleFieldGroup>

              <CollapsibleFieldGroup title="Skills" expanded={skillsExpanded} onToggle={() => setSkillsExpanded(!skillsExpanded)}>
                {renderSkillsFields()}
              </CollapsibleFieldGroup>

              <CollapsibleFieldGroup title="Notifications" expanded={telegramExpanded} onToggle={() => setTelegramExpanded(!telegramExpanded)}>
                {renderNotificationFields()}
              </CollapsibleFieldGroup>

              <CollapsibleFieldGroup title="Advanced" expanded={advancedExpanded} onToggle={() => setAdvancedExpanded(!advancedExpanded)}>
                {renderAdvancedFields()}
              </CollapsibleFieldGroup>
            </div>
          )}

          <div className="btn-group" style={{ marginTop: 24, justifyContent: "center" }}>
            <button className="btn" onClick={onCancel}>
              Cancel
            </button>
            {currentIdx > 0 && (
              <button className="btn" onClick={goBack}>
                Back
              </button>
            )}
            {currentStep === "settings" ? (
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
                disabled={currentStep === "identity" && !canAdvanceFromFolder()}
              >
                Next
              </button>
            )}
          </div>

          {currentStep === "identity" && onPickTemplate && (
            <div>
              <p className="text-secondary" style={{ marginTop: 32, marginBottom: 16, fontSize: 13, textAlign: "center" }}>
                Or start from a template:
              </p>
              <div className="sample-grid-cards">
                {templateRows.map((row, i) => (
                  <div key={i} className="sample-grid-row">
                    {row.map((cat) => (
                      <div
                        key={cat.id}
                        className={`sample-card-v2${expandedCategory === cat.id ? " expanded" : ""}`}
                      >
                        <div className="sample-card-v2-top" onClick={() => setExpandedCategory(expandedCategory === cat.id ? null : cat.id)}>
                          <img className="sample-card-v2-hero" src={cat.image} alt={cat.name} />
                          <div className="sample-card-v2-header">
                            <div><h3>{cat.name}</h3></div>
                            <span className="sample-card-v2-badge">{cat.templates.length} templates</span>
                          </div>
                        </div>
                        <div className="sample-card-v2-body">
                          <div className="sample-card-v2-templates">
                            {cat.templates.map((template) => (
                              <div key={template.id} className="sample-template-row">
                                <div className="sample-template-row-header">
                                  <div className="sample-template-row-info">
                                    <strong>{template.name}</strong>
                                    <span>{template.description}</span>
                                  </div>
                                  <div className="sample-template-row-actions">
                                    <code className="sample-template-row-cron">{template.cron || "manual"}</code>
                                    <button
                                      className="btn btn-primary btn-sm"
                                      onClick={(e) => { e.stopPropagation(); onPickTemplate(template.id); }}
                                    >
                                      Create
                                    </button>
                                  </div>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  // ---- Single-page mode (editing or non-folder new jobs) ----

  return (
    <div className="settings-section">
      <div className="section-header" style={{ justifyContent: "space-between" }}>
        <div
          onClick={onCancel}
          style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}
          title={isNew ? "Back to jobs" : "Back to job"}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--text-secondary)", flexShrink: 0 }}>
            <path d="M15 18l-6-6 6-6" />
          </svg>
          <h2>{isNew ? "Add Job" : `Edit: ${form.name}`}</h2>
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
          {renderParamsFields()}
        </FieldGroup>
      )}

      <FieldGroup title="Schedule">
        {renderScheduleFields()}
      </FieldGroup>

      <FieldGroup title="Secrets">
        {renderSecretsFields()}
      </FieldGroup>

      <FieldGroup title="Skills">
        {renderSkillsFields()}
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
