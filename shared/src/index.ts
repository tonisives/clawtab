// Types
export type {
  RemoteJob,
  DesktopJob,
  JobType,
  JobStatus,
  JobSortMode,
  RunRecord,
  RunDetail,
  TelegramLogMode,
  TelegramNotify,
} from "./types/job";
export type { DetectedProcess, ProcessProvider, ShellPane, QuestionOption, ClaudeQuestion } from "./types/process";
export type { PaneContent, SplitNode, SplitTreeState, SplitDirection } from "./types/splitTree";
export type { Transport } from "./transport";

// Theme
export { colors } from "./theme/colors";
export { spacing, radius } from "./theme/spacing";
export { PANE_COLORS, assignPaneColors } from "./theme/paneColors";

// Utils
export { formatTime, formatDuration, timeAgo, shortenPath, compactPath, compactCron } from "./util/format";
export { nextCronDate, formatNextRun, describeCron, cronTooltip } from "./util/cron";
export { groupJobs, sortGroupNames, findYesOption, isFreetextOption, typeIcon } from "./util/jobs";
export { collapseSeparators, stripSeparators, truncateLogLines } from "./util/logs";
export {
  genPaneId,
  restoreIdCounter,
  collectLeaves,
  findNode,
  replaceNode,
  removeLeaf,
  updateRatio,
  splitLeaf,
  removeStaleLeaves,
} from "./util/splitTree";
export {
  statusLabel,
  statusColor,
  statusBg,
  runStatusColor,
  runStatusLabel,
  availableActions,
} from "./util/status";
export type { AvailableAction } from "./util/status";

// Components
export { StatusBadge } from "./components/StatusBadge";
export { JobCard } from "./components/JobCard";
export { RunningJobCard } from "./components/RunningJobCard";
export { ProcessCard } from "./components/ProcessCard";
export { ShellCard } from "./components/ShellCard";
export { JobKindIcon, kindForJob, kindForProcess, kindForShell } from "./components/JobKindIcon";
export { LogViewer } from "./components/LogViewer";
export { MessageInput } from "./components/MessageInput";
export { ParamsDialog } from "./components/ParamsDialog";
export { AgentSection } from "./components/AgentSection";
export { NotificationCard } from "./components/NotificationCard";
export { NotificationSection } from "./components/NotificationSection";
export { AutoYesBanner } from "./components/AutoYesBanner";
export type { AutoYesEntry } from "./components/AutoYesBanner";
export { JobListView } from "./components/JobListView";
export type { SidebarSelectableItem } from "./components/JobListView";
export { JobDetailView } from "./components/JobDetailView";
export { XtermLog } from "./components/XtermLog";
export type { XtermLogHandle } from "./components/XtermLog";
export { ReadOnlyXterm } from "./components/ReadOnlyXterm";
export { ShareSection } from "./components/ShareSection";
export type { ShareInfo, SharedWithMeInfo, ShareSectionProps } from "./components/ShareSection";
export { SplitDetailArea } from "./components/SplitDetailArea";
export type { SplitDetailAreaProps } from "./components/SplitDetailArea";
export { DropZoneOverlay, computeDropZone } from "./components/DropZoneOverlay";
export type { DropZoneId } from "./components/DropZoneOverlay";

// Hooks
export { useJobsCore } from "./hooks/useJobsCore";
export { useJobActions } from "./hooks/useJobActions";
export { useJobDetail } from "./hooks/useJobDetail";
export { useLogBuffer } from "./hooks/useLogBuffer";
export { useSplitTree } from "./hooks/useSplitTree";
export type { SplitDragData, UseSplitTreeOptions } from "./hooks/useSplitTree";
