import { useState } from "react";
import type { Job, JobType } from "../types";
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
};

export function JobEditor({ job, onSave, onCancel }: Props) {
  const [form, setForm] = useState<Job>(job ?? emptyJob);
  const [argsText, setArgsText] = useState(form.args.join(" "));
  const [secretKeysText, setSecretKeysText] = useState(form.secret_keys.join(", "));
  const [envText, setEnvText] = useState(
    Object.entries(form.env)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n"),
  );

  const isNew = job === null;

  const handleSubmit = () => {
    const args = argsText
      .split(/\s+/)
      .filter((s) => s.length > 0);
    const secretKeys = secretKeysText
      .split(",")
      .map((s) => s.trim())
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
      secret_keys: secretKeys,
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
        </select>
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

      <CronInput
        value={form.cron}
        onChange={(cron) => setForm({ ...form, cron })}
      />

      <div className="form-group">
        <label>Secret Keys</label>
        <input
          type="text"
          value={secretKeysText}
          onChange={(e) => setSecretKeysText(e.target.value)}
          placeholder="SECRET_KEY_1, SECRET_KEY_2"
          style={{ maxWidth: "100%" }}
        />
        <span className="hint">Comma-separated Keychain secret names to inject as env vars</span>
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

      {form.job_type === "claude" && (
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
