import type { PaneContent, SplitNode } from "../../types/splitTree";
import type { LeafRect, SplitDragData } from "./types";

export function loadTree(storageKey: string, restoreIdCounter: (n: SplitNode) => void, dedupeIds: (n: SplitNode) => SplitNode): SplitNode | null {
  if (typeof localStorage === "undefined") return null;
  const saved = localStorage.getItem(storageKey);
  if (saved) {
    try {
      const parsed = JSON.parse(saved) as SplitNode;
      restoreIdCounter(parsed);
      return dedupeIds(parsed);
    } catch { /* ignore corrupt data */ }
  }
  return null;
}

export function saveTree(storageKey: string, tree: SplitNode | null) {
  if (typeof localStorage === "undefined") return;
  if (tree) localStorage.setItem(storageKey, JSON.stringify(tree));
  else localStorage.removeItem(storageKey);
}

export function loadFocusedLeaf(storageKey: string): string | null {
  if (typeof localStorage === "undefined") return null;
  return localStorage.getItem(storageKey + "_focused_leaf");
}

export function saveFocusedLeaf(storageKey: string, id: string | null) {
  if (typeof localStorage === "undefined") return;
  const key = storageKey + "_focused_leaf";
  if (id) localStorage.setItem(key, id);
  else localStorage.removeItem(key);
}

export function dragDataToContent(data: SplitDragData): PaneContent {
  if (data.kind === "job") return { kind: "job", slug: data.slug ?? "" };
  if (data.kind === "agent") return { kind: "agent" };
  if (data.kind === "terminal") {
    return { kind: "terminal", paneId: data.paneId ?? "", tmuxSession: data.tmuxSession ?? "" };
  }
  return { kind: "process", paneId: data.paneId ?? "" };
}

export function contentKey(content: PaneContent): string {
  if (content.kind === "job") return content.slug;
  if (content.kind === "agent") return "_agent";
  if (content.kind === "terminal") return `_term_${content.paneId}`;
  return content.paneId;
}

export function contentEquals(a: PaneContent, b: PaneContent): boolean {
  if (a.kind !== b.kind) return false;
  return contentKey(a) === contentKey(b);
}

export function createVirtualRoot(content: PaneContent | null): SplitNode {
  return {
    type: "leaf",
    id: "_root",
    content: content ?? { kind: "agent" },
  };
}

export function collectLeafRects(
  node: SplitNode,
  x: number,
  y: number,
  w: number,
  h: number,
): LeafRect[] {
  if (node.type === "leaf") {
    return [{ id: node.id, content: node.content, x, y, w, h }];
  }

  if (node.direction === "horizontal") {
    const firstW = w * node.ratio;
    const secondW = w - firstW;
    return [
      ...collectLeafRects(node.first, x, y, firstW, h),
      ...collectLeafRects(node.second, x + firstW, y, secondW, h),
    ];
  }

  const firstH = h * node.ratio;
  const secondH = h - firstH;
  return [
    ...collectLeafRects(node.first, x, y, w, firstH),
    ...collectLeafRects(node.second, x, y + firstH, w, secondH),
  ];
}

export function chooseSplitDirection(
  rect: Pick<LeafRect, "w" | "h">,
  minPaneSize: number,
): "horizontal" | "vertical" | null {
  const canSplitHorizontal = rect.w >= minPaneSize * 2;
  const canSplitVertical = rect.h >= minPaneSize * 2;
  if (canSplitHorizontal && canSplitVertical) {
    return rect.w >= rect.h ? "horizontal" : "vertical";
  }
  if (canSplitHorizontal) return "horizontal";
  if (canSplitVertical) return "vertical";
  return null;
}
