import type { Job } from "../types";

export function ParamsOverlay({
  job,
  values,
  onChange,
  onRun,
  onCancel,
}: {
  job: Job;
  values: Record<string, string>;
  onChange: (values: Record<string, string>) => void;
  onRun: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="confirm-overlay" onClick={onCancel}>
      <div className="confirm-dialog" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 420 }}>
        <h3 style={{ marginBottom: 12 }}>Run: {job.name}</h3>
        <p className="text-secondary" style={{ fontSize: 12, marginBottom: 12 }}>
          Fill in all parameters before running.
        </p>
        {job.params.map((key) => (
          <div key={key} style={{ marginBottom: 10 }}>
            <label style={{ fontSize: 12, fontWeight: 500, marginBottom: 4, display: "block" }}>
              {key}
            </label>
            <input
              className="input"
              type="text"
              value={values[key] ?? ""}
              onChange={(e) => onChange({ ...values, [key]: e.target.value })}
              onKeyDown={(e) => { if (e.key === "Enter") onRun(); }}
              placeholder={`{${key}}`}
              autoFocus={key === job.params[0]}
            />
          </div>
        ))}
        <div className="btn-group" style={{ marginTop: 16, justifyContent: "flex-end" }}>
          <button className="btn btn-sm" onClick={onCancel}>Cancel</button>
          <button
            className="btn btn-primary btn-sm"
            onClick={onRun}
            disabled={job.params.some((k) => !values[k]?.trim())}
          >
            Run
          </button>
        </div>
      </div>
    </div>
  );
}
