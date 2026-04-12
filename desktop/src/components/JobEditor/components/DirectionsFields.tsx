import { invoke } from "@tauri-apps/api/core";
import type { Job } from "../../../types";
import { HighlightedTextarea } from "../../MarkdownHighlight";
import { EDITOR_LABELS } from "../../../constants";

interface DirectionsFieldsProps {
  form: Job;
  isNew: boolean;
  isShellJob: boolean;
  isWizard: boolean;
  preferredEditor: string;
  previewFile: "job.md" | "context.md";
  setPreviewFile: (v: "job.md" | "context.md") => void;
  inlineContent: string;
  jobCwtContent: string | null;
  dragOver: boolean;
  editorRef: React.RefObject<HTMLTextAreaElement | null>;
  cwtEdited: boolean;
  handleInlineChange: (content: string) => void;
  importableJobs: Job[];
  showImportPicker: boolean;
  setShowImportPicker: (v: boolean) => void;
  handleImportJob: (source: Job) => Promise<void>;
}

export function DirectionsFields({
  form, isNew, isShellJob, isWizard, preferredEditor,
  previewFile, setPreviewFile, inlineContent, jobCwtContent,
  dragOver, editorRef, cwtEdited, handleInlineChange,
  importableJobs, showImportPicker, setShowImportPicker, handleImportJob,
}: DirectionsFieldsProps) {
  if (form.job_type !== "job" || !form.folder_path) return null;

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
          {!isShellJob && (
            <button
              className={`directions-tab ${previewFile === "context.md" ? "active" : ""}`}
              onClick={() => setPreviewFile("context.md")}
            >
              context.md
            </button>
          )}
          {isNew && importableJobs.length > 0 && (
            <div style={{ position: "relative", marginLeft: "auto" }}>
              <button
                className="directions-tab"
                onClick={() => setShowImportPicker(!showImportPicker)}
              >
                Import
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
                        {j.folder_path?.split("/").pop()}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
        {previewFile === "job.md" ? (
          <>
            {isShellJob && (
              <span className="hint" style={{ display: "block", marginBottom: 8 }}>
                Shell jobs run job.md as a shell command from the working directory, for example `sh run.sh`.
              </span>
            )}
            <HighlightedTextarea
              textareaRef={editorRef}
              wrapClassName={dragOver ? "drag-over" : ""}
              value={inlineContent}
              onChange={(e) => handleInlineChange(e.target.value)}
              spellCheck={false}
              placeholder=""
            />
          </>
        ) : (
          <HighlightedTextarea
            value={jobCwtContent || "(no context.md)"}
            readOnly
          />
        )}
      </div>

      {!isNew && previewFile === "job.md" && (
        <button
          className="btn btn-sm"
          style={{ marginTop: 8 }}
          onClick={() => {
            invoke("open_job_editor", {
              folderPath: form.folder_path,
              editor: preferredEditor,
              jobId: form.job_id ?? "default",
              fileName: "job.md",
              slug: form.slug || null,
            });
          }}
        >
          Edit in {EDITOR_LABELS[preferredEditor] ?? preferredEditor}
        </button>
      )}

      {isWizard && !cwtEdited && (
        <span className="hint" style={{ color: "var(--warning-color)" }}>
          Edit job.md before proceeding - the default template must be changed.
        </span>
      )}
    </div>
  );
}
