import type { Job } from "../../../types";

interface AdvancedFieldsProps {
  form: Job;
  setForm: React.Dispatch<React.SetStateAction<Job>>;
  isNew: boolean;
  isShellJob: boolean;
  persistTmuxSession: (val: string) => void;
  setPendingAutoYes: (v: boolean) => void;
}

export function AdvancedFields({ form, setForm, isNew, isShellJob, persistTmuxSession, setPendingAutoYes }: AdvancedFieldsProps) {
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
        <label>Tmux Session</label>
        <input
          type="text"
          value={form.tmux_session ?? ""}
          onChange={(e) => setForm((prev) => ({ ...prev, tmux_session: e.target.value || null }))}
          onBlur={(e) => { if (isNew) persistTmuxSession(e.target.value); }}
          placeholder=""
        />
      </div>

      <div className="form-group">
        <label>Group</label>
        <input
          type="text"
          value={form.group}
          onChange={(e) => setForm((prev) => ({ ...prev, group: e.target.value || "default" }))}
          placeholder=""
        />
        <span className="hint">Jobs are grouped by this label in the list</span>
      </div>
    </>
  );
}
