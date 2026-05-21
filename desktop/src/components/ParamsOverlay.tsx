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
        {job.params.map((p, i) => (
          <div key={p.name} style={{ marginBottom: 10 }}>
            <label style={{ fontSize: 12, fontWeight: 500, marginBottom: 4, display: "block" }}>
              {p.name}
            </label>
            <input
              className="input"
              type="text"
              value={values[p.name] ?? p.value ?? ""}
              onChange={(e) => onChange({ ...values, [p.name]: e.target.value })}
              onKeyDown={(e) => { if (e.key === "Enter") onRun(); }}
              placeholder={p.value ?? `{${p.name}}`}
              autoFocus={i === 0}
            />
          </div>
        ))}
        <div className="btn-group" style={{ marginTop: 16, justifyContent: "flex-end" }}>
          <button className="btn btn-sm" onClick={onCancel}>Cancel</button>
          <button
            className="btn btn-primary btn-sm"
            onClick={onRun}
            disabled={job.params.some((p) => !(values[p.name] ?? p.value ?? "").trim())}
          >
            Run
          </button>
        </div>
      </div>
    </div>
  );
}
