import type { CSSProperties } from "react";
import { JobEditor } from "../../JobEditor";
import type { Job } from "../../../types";

interface JobEditorPaneProps {
  createForGroup: { group: string; folderPath: string | null } | null;
  editingJob: Job | null;
  headerMode: "back" | "close";
  onCancel: () => void;
  onPickTemplate: (templateId: string) => void;
  onSave: (job: Job) => void | Promise<void>;
  panelContentStyle: CSSProperties;
  saveError: string | null;
}

export function JobEditorPane({
  createForGroup,
  editingJob,
  headerMode,
  onCancel,
  onPickTemplate,
  onSave,
  panelContentStyle,
  saveError,
}: JobEditorPaneProps) {
  return (
    <div style={panelContentStyle}>
      {saveError && (
        <div style={{ padding: "8px 12px", marginBottom: 12, background: "var(--danger-bg, #2d1b1b)", border: "1px solid var(--danger, #e55)", borderRadius: 4, fontSize: 13 }}>
          Save failed: {saveError}
        </div>
      )}
      <JobEditor
        job={editingJob}
        onSave={onSave}
        onCancel={onCancel}
        headerMode={headerMode}
        onPickTemplate={onPickTemplate}
        defaultGroup={createForGroup?.group}
        defaultFolderPath={createForGroup?.folderPath ?? undefined}
      />
    </div>
  );
}
