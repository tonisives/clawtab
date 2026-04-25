import type { DetectedProcess, ShellPane } from "@clawtab/shared";
import type { Job } from "../../types";

export interface JobsTabProps {
  pendingTemplateId?: string | null;
  onTemplateHandled?: () => void;
  createJobKey?: number;
  importCwtKey?: number;
  pendingPaneId?: string | null;
  onPaneHandled?: () => void;
  navBar?: React.ReactNode | ((notificationsButton: React.ReactNode) => React.ReactNode);
  rightPanelOverlay?: React.ReactNode;
  onJobSelected?: () => void;
  onOpenSettings?: () => void;
}

export type { ExistingPaneInfo } from "../../types";

export type ListItemRef =
  | { kind: "job"; slug: string; job: Job }
  | { kind: "process"; paneId: string; process: DetectedProcess }
  | { kind: "terminal"; paneId: string; shell: ShellPane };
