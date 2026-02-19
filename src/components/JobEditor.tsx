import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AerospaceWorkspace, AppSettings, Job, JobType, SecretEntry } from "../types";
import { CronInput } from "./CronInput";

interface Props {
  job: Job | null;
  onSave: (job: Job) => void;
  onCancel: () => void;
}

const emptyJob: Job = {
  name: "",
  job_type: "binary",
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
};

export function JobEditor({ job, onSave, onCancel }: Props) {
  const [form, setForm] = useState<Job>(job ?? emptyJob);
  const [argsText, setArgsText] = useState(form.args.join(" "));
  const [envText, setEnvText] = useState(
    Object.entries(form.env)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n"),
  );

  const [availableSecrets, setAvailableSecrets] = useState<SecretEntry[]>([]);
  const [aerospaceAvailable, setAerospaceAvailable] = useState(false);
  const [aerospaceWorkspaces, setAerospaceWorkspaces] = useState<AerospaceWorkspace[]>([]);
  const [cwdtPreview, setCwdtPreview] = useState<string | null>(null);
  const [preferredEditor, setPreferredEditor] = useState("nvim");

  useEffect(() => {
    invoke<SecretEntry[]>("list_secrets").then(setAvailableSecrets);
    invoke<AppSettings>("get_settings").then((s) => {
      setPreferredEditor(s.preferred_editor);
    });
    invoke<boolean>("aerospace_available").then((avail) => {
      setAerospaceAvailable(avail);
      if (avail) {
        invoke<AerospaceWorkspace[]>("list_aerospace_workspaces").then(setAerospaceWorkspaces);
      }
    });
  }, []);

  // Load cwdt.md preview when folder path changes
  useEffect(() => {
    if (form.job_type === "folder" && form.folder_path) {
      invoke<string>("read_cwdt_entry", { folderPath: form.folder_path })
        .then(setCwdtPreview)
        .catch(() => setCwdtPreview(null));
    } else {
      setCwdtPreview(null);
    }
  }, [form.folder_path, form.job_type]);

  const isNew = job === null;

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

    onSave({
      ...form,
      args,
      env,
    });
  };

  return (
    <div className="settings-section">
      <div className="section-header">
        <h2>{isNew ? "New Job" : `Edit: ${form.name}`}</h2>
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
      </div>

      <div className="form-group">
        <label>Type</label>
        <select
          value={form.job_type}
          onChange={(e) =>
            setForm({ ...form, job_type: e.target.value as JobType })
          }
        >
          <option value="binary">Binary</option>
          <option value="claude">Claude</option>
          <option value="folder">Folder (.cwdt)</option>
        </select>
      </div>

      {form.job_type === "folder" ? (
        <>
          <div className="form-group">
            <label>Folder Path</label>
            <input
              type="text"
              value={form.folder_path ?? ""}
              onChange={(e) => setForm({ ...form, folder_path: e.target.value || null })}
              placeholder="/path/to/project/.cwdt"
              style={{ maxWidth: "100%" }}
            />
            <span className="hint">Path to a folder containing cwdt.md with job directions</span>
          </div>
          {form.folder_path && (
            <div className="form-group">
              <div className="btn-group" style={{ marginBottom: 8 }}>
                <button
                  className="btn btn-sm"
                  onClick={() => {
                    invoke("init_cwdt_folder", { folderPath: form.folder_path }).then(() => {
                      invoke<string>("read_cwdt_entry", { folderPath: form.folder_path }).then(setCwdtPreview);
                    });
                  }}
                >
                  Init cwdt.md
                </button>
                <button
                  className="btn btn-sm"
                  onClick={() => {
                    invoke("open_job_editor", { folderPath: form.folder_path, editor: preferredEditor });
                  }}
                >
                  Open in {preferredEditor}
                </button>
                <select
                  value={preferredEditor}
                  onChange={(e) => setPreferredEditor(e.target.value)}
                  style={{ padding: "2px 6px", fontSize: 12 }}
                >
                  <option value="nvim">nvim</option>
                  <option value="vscode">vscode</option>
                </select>
              </div>
              {cwdtPreview !== null && (
                <div style={{ border: "1px solid var(--border)", borderRadius: 4, padding: 8, maxHeight: 200, overflowY: "auto" }}>
                  <pre style={{ margin: 0, fontSize: 12, whiteSpace: "pre-wrap" }}>{cwdtPreview || "(empty)"}</pre>
                </div>
              )}
            </div>
          )}
        </>
      ) : (
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
      )}

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

      <CronInput
        value={form.cron}
        onChange={(cron) => setForm({ ...form, cron })}
      />

      <div className="form-group">
        <label>Secrets (injected as env vars)</label>
        {availableSecrets.length === 0 ? (
          <p className="text-secondary">No secrets configured. Add them in the Secrets tab.</p>
        ) : (
          <div style={{ maxHeight: 150, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 4, padding: 8 }}>
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
              placeholder="Leave empty to use default"
            />
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
      )}

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
