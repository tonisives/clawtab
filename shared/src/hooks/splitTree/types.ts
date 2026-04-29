import type { PaneContent, SplitNode } from "../../types/splitTree";

export type LeafRect = { id: string; content: PaneContent; x: number; y: number; w: number; h: number };

export interface SplitDragData {
  kind: "job" | "process" | "terminal" | "agent";
  slug?: string;
  paneId?: string;
  tmuxSession?: string;
  source?: "sidebar" | "detail-pane";
  sourceWorkspaceId?: string;
}

export interface UseSplitTreeControlled {
  id: string;
  tree: SplitNode | null;
  focusedLeafId: string | null;
  onChange: (patch: { tree?: SplitNode | null; focusedLeafId?: string | null }) => void;
}

export interface UseSplitTreeOptions {
  storageKey?: string;
  controlled?: UseSplitTreeControlled;
  minPaneSize?: number;
  onCollapse: (content: PaneContent) => void;
  onReplaceSingle: (data: SplitDragData) => void;
  currentContent: PaneContent | null;
}

export interface ZoomSnapshot {
  tree: SplitNode;
  focusedLeafId: string | null;
  content: PaneContent;
}
