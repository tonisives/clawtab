import type { DetectedProcess, ShellPane } from "@clawtab/shared";
import type { Job } from "../../types";

export interface JobsTabProps {
  pendingTemplateId?: string | null;
  onTemplateHandled?: () => void;
  createJobKey?: number;
  importCwtKey?: number;
  pendingPaneId?: string | null;
  onPaneHandled?: () => void;
  navBar?: React.ReactNode;
  rightPanelOverlay?: React.ReactNode;
  onJobSelected?: () => void;
}

export interface ExistingPaneInfo {
  pane_id: string;
  cwd: string;
  tmux_session: string;
  window_name: string;
}

export type ListItemRef =
  | { kind: "job"; slug: string; job: Job }
  | { kind: "process"; paneId: string; process: DetectedProcess }
  | { kind: "terminal"; paneId: string; shell: ShellPane };
