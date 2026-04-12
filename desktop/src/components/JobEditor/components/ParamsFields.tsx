import type { Job } from "../../../types";

interface ParamsFieldsProps {
  form: Job;
  setForm: React.Dispatch<React.SetStateAction<Job>>;
  paramInput: string;
  setParamInput: (v: string) => void;
  editorRef: React.RefObject<HTMLTextAreaElement | null>;
  previewFile: "job.md" | "context.md";
  inlineContent: string;
  handleInlineChange: (content: string) => void;
}

export function ParamsFields({
  form, setForm, paramInput, setParamInput,
  editorRef, previewFile, inlineContent, handleInlineChange,
}: ParamsFieldsProps) {
  if (form.job_type !== "job") return null;

  const addParam = (name: string) => {
    const key = name.trim().replace(/[^a-zA-Z0-9_-]/g, "");
    if (!key || form.params.includes(key)) return;
    setForm((prev) => ({ ...prev, params: [...prev.params, key] }));
    setParamInput("");
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
    setForm((prev) => ({ ...prev, params: prev.params.filter((p) => p !== key) }));
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
}
