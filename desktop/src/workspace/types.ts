import type { PaneContent, SplitNode } from "@clawtab/shared";

export type WorkspaceId = string;

export interface WorkspaceState {
  id: WorkspaceId;
  tree: SplitNode | null;
  focusedLeafId: string | null;
  singlePaneContent: PaneContent | null;
}

export interface FocusHistoryEntry {
  workspaceId: WorkspaceId;
  leafId: string | null;
  contentKey: string;
  ts: number;
}

export interface WorkspaceIndex {
  version: 2;
  ids: WorkspaceId[];
  activeId: WorkspaceId;
}

export const DEFAULT_WORKSPACE_ID: WorkspaceId = "default";

export function emptyWorkspaceState(id: WorkspaceId): WorkspaceState {
  return { id, tree: null, focusedLeafId: null, singlePaneContent: null };
}

export function wsKey(id: WorkspaceId, suffix: "tree" | "focused" | "single"): string {
  return `clawtab_ws:${id}:${suffix}`;
}

export const WS_INDEX_KEY = "clawtab_ws_index";
export const FOCUS_HISTORY_KEY = "clawtab_focus_history";
