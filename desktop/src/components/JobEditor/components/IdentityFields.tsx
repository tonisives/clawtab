import type { Job, JobType } from "../../../types";
import { slugifyName } from "../utils";
import { JOB_NAME_MAX_LENGTH } from "../types";

interface IdentityFieldsProps {
  form: Job;
  setForm: React.Dispatch<React.SetStateAction<Job>>;
  isNew: boolean;
  argsText: string;
  setArgsText: (v: string) => void;
  pickFolder: () => void;
}

export function IdentityFields({ form, setForm, isNew, argsText, setArgsText, pickFolder }: IdentityFieldsProps) {
  return (
    <>
      {isNew && (
        <div className="form-group">
          <label>Type</label>
          <select
            value={form.job_type}
            onChange={(e) =>
              setForm((prev) => ({ ...prev, job_type: e.target.value as JobType }))
            }
          >
            <option value="job">Job</option>
            <option value="claude">Claude</option>
            <option value="binary">Binary</option>
          </select>
        </div>
      )}

      {form.job_type === "job" ? (
        <>
          <div className="form-group">
            <label>Working Directory</label>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input
                type="text"
                value={form.folder_path ?? ""}
                onChange={(e) => {
                  const val = e.target.value || null;
                  setForm((prev) => ({ ...prev, folder_path: val }));
                }}
                placeholder=""
                style={{ flex: 1 }}
                disabled={!isNew}
              />
              {isNew && (
                <button className="btn btn-sm" onClick={pickFolder}>
                  Browse...
                </button>
              )}
            </div>
            <span className="hint">
              {isNew
                ? "Pick a project directory. Job config is stored centrally in ~/.config/clawtab/jobs/."
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
                const jobId = slugifyName(name) || null;
                setForm((prev) => ({ ...prev, name, job_id: jobId }));
              }}
              placeholder=""
            />
            {form.name && (
              <span className="hint">
                Job: {slugifyName(form.name) || "default"}
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
              onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
              placeholder=""
            />
          </div>

          <div className="form-group">
            <label>{form.job_type === "binary" ? "Binary Path" : "Prompt File Path"}</label>
            <input
              type="text"
              value={form.path}
              onChange={(e) => setForm((prev) => ({ ...prev, path: e.target.value }))}
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
}
