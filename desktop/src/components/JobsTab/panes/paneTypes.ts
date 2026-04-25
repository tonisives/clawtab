import type { RefObject } from "react";
import type {
  ClaudeQuestion,
  DetectedProcess,
  ProcessProvider,
  RemoteJob,
  Transport,
  useJobActions,
  useJobsCore,
  useSplitTree,
} from "@clawtab/shared";
import type { Job } from "../../../types";
import type { useViewingState } from "../hooks/useViewingState";
import type { useProcessLifecycle } from "../../../hooks/useProcessLifecycle";
import type { useAutoYes } from "../../../hooks/useAutoYes";
import type { useQuestionPolling } from "../../../hooks/useQuestionPolling";
import type { useWorkspaceManager } from "../../../workspace/WorkspaceManager";
import type { useLeafJobEditing } from "./useLeafJobEditing";

export type PaneMode =
  | { kind: "leaf"; leafId: string }
  | { kind: "single" };

export interface PaneCallbacks {
  handleOpen: (slug: string) => void;
  handleDuplicate: (job: Job, group: string) => void;
  handleDuplicateToFolder: (job: Job) => void;
  handleFork: (paneId: string, direction: "right" | "down") => void;
  handleSplitPane: (paneId: string, direction: "right" | "down") => void;
  handleRunAgent: (prompt: string, workDir?: string, provider?: ProcessProvider) => void | Promise<void>;
  handleGetAgentProviders: () => Promise<ProcessProvider[]>;
  selectAdjacentItem: (currentId: string) => void;
  openRenameProcessDialog: (process: DetectedProcess) => void;
  buildJobPaneActions: (job: Job, jobQuestion: ClaudeQuestion | undefined) => Record<string, unknown>;
  buildJobTitlePath: (job: Job, jobQuestion: ClaudeQuestion | undefined) => string | undefined;
  buildProcessTitlePath: (process: DetectedProcess) => string;
  setEditingJob: (job: Job | null) => void;
  setSkillSearchPaneId: (paneId: string | null) => void;
  setInjectSecretsPaneId: (paneId: string | null) => void;
  processRenameDrafts: Record<string, string | null>;
  folderRunGroups: { group: string; folderPath: string }[];
}

export interface PaneContext {
  mode: PaneMode;
  headerLeftInset: number;
  core: ReturnType<typeof useJobsCore>;
  split: ReturnType<typeof useSplitTree>;
  viewing: ReturnType<typeof useViewingState>;
  lifecycle: ReturnType<typeof useProcessLifecycle>;
  actions: ReturnType<typeof useJobActions>;
  questions: ClaudeQuestion[];
  questionPolling: ReturnType<typeof useQuestionPolling>;
  autoYes: ReturnType<typeof useAutoYes>;
  transport: Transport;
  agentJob: RemoteJob;
  agentProcess: DetectedProcess | null;
  isWide: boolean;
  defaultProvider: ProcessProvider;
  defaultModel?: string | null;
  enabledModels?: Record<string, string[]>;
  autoYesShortcut?: string;
  callbacks: PaneCallbacks;
  sidebarFocusRef: RefObject<{ focus: () => void } | null>;
  mgr: ReturnType<typeof useWorkspaceManager>;
  leafJobEditing: ReturnType<typeof useLeafJobEditing>;
}
