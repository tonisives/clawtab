import type { SplitNode } from "../types/splitTree";
import { collectLeaves } from "../util/splitTree";

export const PANE_COLORS = [
  "#7986cb", // indigo (matches accent)
  "#4db6ac", // teal
  "#ff8a65", // coral
  "#ba68c8", // purple
  "#4fc3f7", // sky blue
  "#aed581", // light green
] as const;

/** Assign a color to each leaf in the tree (DFS order) */
export function assignPaneColors(node: SplitNode): Map<string, string> {
  const leaves = collectLeaves(node);
  const map = new Map<string, string>();
  for (let i = 0; i < leaves.length; i++) {
    map.set(leaves[i].id, PANE_COLORS[i % PANE_COLORS.length]);
  }
  return map;
}
