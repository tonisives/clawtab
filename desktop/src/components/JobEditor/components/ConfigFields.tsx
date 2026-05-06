import type { Job } from "../../../types";

interface ConfigFieldsProps {
  form: Job;
  setForm: React.Dispatch<React.SetStateAction<Job>>;
  isShellJob: boolean;
  envText: string;
  setEnvText: (v: string) => void;
  setPendingAutoYes: (v: boolean) => void;
  existingGroups?: string[];
}

export function ConfigFields({ form, setForm, isShellJob, envText, setEnvText, setPendingAutoYes, existingGroups = [] }: ConfigFieldsProps) {
  return (
    <>
      {form.job_type === "job" && !isShellJob && (
        <>
          <div className="form-group">
            <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={form.kill_on_end}
                onChange={(e) => setForm((prev) => ({ ...prev, kill_on_end: e.target.checked }))}
                style={{ margin: 0 }}
              />
              Kill on end
            </label>
            <span className="hint">
              When enabled, the generated context.md instructs Claude to run `kill $PPID` when the task is complete.
            </span>
          </div>

          <div className="form-group">
            <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={form.auto_yes}
                onChange={(e) => {
                  if (e.target.checked) {
                    setPendingAutoYes(true);
                  } else {
                    setForm((prev) => ({ ...prev, auto_yes: false }));
                  }
                }}
                style={{ margin: 0 }}
              />
              Auto-yes on start
            </label>
            <span className="hint">
              Automatically enable auto-yes when this job starts running. All questions will be accepted.
            </span>
          </div>
        </>
      )}

      <div className="form-group">
        <label>Group</label>
        <input
          type="text"
          list="job-editor-existing-groups"
          value={form.group}
          onChange={(e) => setForm((prev) => ({ ...prev, group: e.target.value || "default" }))}
          placeholder=""
        />
        <datalist id="job-editor-existing-groups">
          {existingGroups.map((g) => <option key={g} value={g} />)}
        </datalist>
        <span className="hint">Jobs are grouped by this label in the list. Pick existing or type a new one.</span>
      </div>

      <div className="form-group">
        <label>Max History</label>
        <input
          type="text"
          inputMode="numeric"
          value={form.max_history}
          onChange={(e) => {
            const n = parseInt(e.target.value, 10);
            setForm((prev) => ({ ...prev, max_history: Number.isFinite(n) && n > 0 ? n : 1 }));
          }}
        />
        <span className="hint">How many recent runs to keep in history. Older runs are pruned after each new run.</span>
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

      {form.job_type !== "job" && (
        <div className="form-group">
          <label>Working Directory</label>
          <input
            type="text"
            value={form.work_dir ?? ""}
            onChange={(e) =>
              setForm((prev) => ({ ...prev, work_dir: e.target.value || null }))
            }
            placeholder=""
            style={{ maxWidth: "100%" }}
          />
        </div>
      )}
    </>
  );
}
