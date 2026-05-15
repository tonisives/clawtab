import type { DetectedProcess, ShellPane } from "@clawtab/shared";
import type { Job } from "../../types";
import type { PaletteViewId } from "../CommandPalette";

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
  onSelectView?: (viewId: PaletteViewId) => void;
}

export type { ExistingPaneInfo } from "../../types";

export type ListItemRef =
  | { kind: "job"; slug: string; job: Job }
  | { kind: "process"; paneId: string; process: DetectedProcess }
  | { kind: "terminal"; paneId: string; shell: ShellPane };
