import type * as React from "react";
import type { ScrollViewProps, StyleProp, ViewStyle } from "react-native";

import type { RemoteJob, JobStatus, JobSortMode } from "../../types/job";
import type { AgentModelOption, DetectedProcess, ProcessProvider, ShellPane } from "../../types/process";

export const IDLE_STATUS: JobStatus = { state: "idle" };

export const SORT_OPTIONS: { value: JobSortMode; label: string }[] = [
  { value: "name", label: "Name" },
  { value: "recent", label: "Recent" },
  { value: "added", label: "Added" },
];

export const GROUP_AGENT_PROVIDER_STORAGE_KEY = "clawtab_group_agent_providers";

export type GroupedRowPosition = "single" | "first" | "middle" | "last";

export interface JobListViewProps {
  jobs: RemoteJob[];
  statuses: Record<string, JobStatus>;
  detectedProcesses: DetectedProcess[];
  shellPanes?: ShellPane[];
  collapsedGroups: Set<string>;
  onToggleGroup: (group: string) => void;
  groupOrder?: string[];
  jobOrder?: Record<string, string[]>;
  processOrder?: Record<string, string[]>;
  onRefresh?: () => void;
  // Sorting
  sortMode?: JobSortMode;
  onSortChange?: (mode: JobSortMode) => void;
  // Navigation
  onSelectJob?: (job: RemoteJob) => void;
  onSelectProcess?: (process: DetectedProcess) => void;
  onSelectShell?: (shell: ShellPane) => void;
  pinnedItems?: string[];
  onTogglePin?: (key: string) => void;
  // Map of slug/pane_id -> color hex for highlighted items (supports multi-selection)
  selectedItems?: Map<string, string> | null;
  // The key of the focused item (brighter border); unfocused selected items are faded
  focusedItemKey?: string | null;
  // Single selection (backward compat with desktop) - uses accent color
  selectedSlug?: string | null;
  // Agent
  onRunAgent?: (prompt: string, workDir?: string, provider?: ProcessProvider, model?: string | null) => void;
  getAgentProviders?: () => Promise<ProcessProvider[]>;
  defaultAgentProvider?: ProcessProvider;
  agentModelOptions?: AgentModelOption[];
  defaultAgentModel?: string | null;
  // Desktop-only slots
  onAddJob?: (group: string, folderPath?: string) => void;
  onEditJob?: (job: RemoteJob) => void;
  onOpenJob?: (job: RemoteJob) => void;
  // Hidden groups
  hiddenGroups?: Set<string>;
  onHideGroup?: (group: string) => void;
  onUnhideGroup?: (group: string) => void;
  // Header content (for banners, notifications, etc.)
  headerContent?: React.ReactNode;
  // Show empty state
  showEmpty?: boolean;
  emptyMessage?: string;
  // Extra style for scroll content container
  contentContainerStyle?: StyleProp<ViewStyle>;
  contentInsetAdjustmentBehavior?: ScrollViewProps["contentInsetAdjustmentBehavior"];
  // Restore scroll position (web only)
  initialScrollOffset?: number;
  // Report scroll position changes (web only)
  onScrollOffsetChange?: (offset: number) => void;
  // Scroll a specific slug into view (seq increments to re-trigger on same slug)
  scrollToSlug?: { slug: string; seq: number } | null;
  // Stop job/process from sidebar
  onStopJob?: (slug: string) => void;
  onStopProcess?: (paneId: string) => void;
  onRenameProcess?: (process: DetectedProcess) => void;
  onSaveProcessName?: (process: DetectedProcess, name: string) => void;
  onStopShell?: (paneId: string) => void;
  onRenameShell?: (shell: ShellPane) => void;
  // Auto-yes pane IDs (for yellow indicator)
  autoYesPaneIds?: Set<string>;
  // Custom card renderers (for drag-and-drop wrappers)
  renderJobCard?: (props: { job: RemoteJob; group: string; indexInGroup: number; status: JobStatus; onPress?: () => void; selected?: boolean | string; softBorder?: boolean; onStop?: () => void; onTogglePin?: () => void; pinned?: boolean; autoYesActive?: boolean; stopping?: boolean; marginTop?: number; dimmed?: boolean; dataJobSlug?: string; defaultAgentProvider?: ProcessProvider; groupedPosition?: GroupedRowPosition }) => React.ReactNode;
  renderProcessCard?: (props: { process: DetectedProcess; sortGroup: string; onPress?: () => void; inGroup?: boolean; selected?: boolean | string; softBorder?: boolean; onStop?: () => void; onRename?: () => void; onSaveName?: (name: string) => void; onTogglePin?: () => void; pinned?: boolean; autoYesActive?: boolean; marginTop?: number; dataProcessId?: string; startRenameSignal?: number; onRenameDraftChange?: (value: string | null) => void; onRenameStateChange?: (editing: boolean) => void; renameShortcutHint?: string; groupedPosition?: GroupedRowPosition }) => React.ReactNode;
  renderShellCard?: (props: { shell: ShellPane; onPress?: () => void; selected?: boolean | string; softBorder?: boolean; onStop?: () => void; onRename?: () => void; renameShortcutHint?: string; groupedPosition?: GroupedRowPosition }) => React.ReactNode;
  wrapJobGroup?: (group: string, jobSlugs: string[], children: React.ReactNode) => React.ReactNode;
  wrapProcessGroup?: (group: string, processPaneIds: string[], children: React.ReactNode) => React.ReactNode;
  // Disable scrolling (e.g. during drag-and-drop)
  scrollEnabled?: boolean;
  // Slugs currently being stopped (for "Stopping..." display in sidebar)
  stoppingSlugs?: Set<string>;
  // Visible selectable items in rendered sidebar order
  onSelectableItemsChange?: (items: SidebarSelectableItem[]) => void;
  // Ref to focus the sidebar container (desktop only)
  sidebarFocusRef?: React.MutableRefObject<{ focus: () => void } | null>;
  focusAgentWorkDir?: string | null;
  focusAgentSignal?: number;
  renameProcessPaneId?: string | null;
  renameProcessSignal?: number;
  onProcessRenameDraftChange?: (paneId: string, value: string | null) => void;
  onProcessRenameStateChange?: (paneId: string, editing: boolean) => void;
  renameShortcutHint?: string;
  // Per-workspace UI (desktop multi-workspace)
  activeWorkspaceId?: string;
  onActivateWorkspace?: (group: string) => void;
  /** When true (a pane is being dragged), hovering a non-active workspace
   *  group header for ~250ms switches to that workspace so the drag can end
   *  inside its detail tree. */
  dragActive?: boolean;
  /** Content keys ("job:slug", "term:paneId", "proc:paneId", "agent") of items
   *  currently open in a workspace other than the active one. Used to visually
   *  mark those items so the user knows they're live elsewhere. */
  openElsewhereContentKeys?: Set<string>;
  /** Persisted per-group choice between the "tabs" view (shells/processes/agent)
   *  and the "jobs" view (configured RemoteJobs). Only shown when a group has
   *  more than one RemoteJob. */
  groupTabView?: Record<string, "tabs" | "jobs">;
  onGroupTabViewChange?: (group: string, view: "tabs" | "jobs") => void;
  /** Set the view ("tabs" | "jobs") for every group at once. Used by the
   *  global top-of-sidebar toggle. The caller receives the list of group
   *  keys currently visible in the sidebar. */
  onSetAllGroupTabView?: (groups: string[], view: "tabs" | "jobs") => void;
  searchQuery?: string;
  onSearchQueryChange?: (query: string) => void;
  hideSearchBar?: boolean;
  scrollEventThrottle?: number;
  renderAsScrollRoot?: boolean;
}

export type ListItem =
  | { kind: "header"; group: string; displayGroup: string; folderPath?: string; tabsToggle?: { group: string; view: "tabs" | "jobs"; hasTabs: boolean; hasJobs: boolean; tabCount: number; jobCount: number } }
  | { kind: "group-footer"; group: string; folderPath: string }
  | { kind: "job"; job: RemoteJob; idx: number }
  | { kind: "process"; process: DetectedProcess; inGroup?: boolean }
  | { kind: "shell"; shell: ShellPane }
  | { kind: "group-agent"; workDir: string; footerPath?: string }
  | { kind: "hidden-section" }
  | { kind: "hidden-header"; group: string; displayGroup: string };

export type SidebarSelectableItem =
  | { kind: "job"; key: string; job: RemoteJob }
  | { kind: "process"; key: string; process: DetectedProcess }
  | { kind: "shell"; key: string; shell: ShellPane };
