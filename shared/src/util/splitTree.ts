import type { PaneContent, SplitNode } from "../types/splitTree";

let _nextId = 1;

export function genPaneId(): string {
  return `pane-${_nextId++}`;
}

/** Restore counter above any existing IDs in a tree (call on load) */
export function restoreIdCounter(node: SplitNode | null): void {
  if (!node) return;
  const match = node.id.match(/^pane-(\d+)$/);
  if (match) {
    const n = parseInt(match[1], 10);
    if (n >= _nextId) _nextId = n + 1;
  }
  if (node.type === "split") {
    restoreIdCounter(node.first);
    restoreIdCounter(node.second);
  }
}

/** Collect all ids in the tree (split nodes and leaves), in DFS order. */
export function collectIds(node: SplitNode): string[] {
  if (node.type === "leaf") return [node.id];
  return [node.id, ...collectIds(node.first), ...collectIds(node.second)];
}

/** Return the set of ids that appear more than once in the tree. */
export function findDuplicateIds(node: SplitNode): string[] {
  const counts = new Map<string, number>();
  for (const id of collectIds(node)) counts.set(id, (counts.get(id) ?? 0) + 1);
  return Array.from(counts.entries()).filter(([, n]) => n > 1).map(([id]) => id);
}

/** Walk the tree and rewrite any duplicated ids so each node has a unique id.
 *  Needed on load to heal trees persisted before the splitLeaf/replaceNode fix. */
export function dedupeIds(root: SplitNode): SplitNode {
  const seen = new Set<string>();
  const walk = (node: SplitNode): SplitNode => {
    const id = seen.has(node.id) ? genPaneId() : node.id;
    seen.add(id);
    if (node.type === "leaf") {
      return id === node.id ? node : { ...node, id };
    }
    const first = walk(node.first);
    const second = walk(node.second);
    if (id === node.id && first === node.first && second === node.second) return node;
    return { ...node, id, first, second };
  };
  return walk(root);
}

/** Collect all leaves in DFS order (left/top first) */
export function collectLeaves(node: SplitNode): { id: string; content: PaneContent }[] {
  if (node.type === "leaf") return [{ id: node.id, content: node.content }];
  return [...collectLeaves(node.first), ...collectLeaves(node.second)];
}

/** Find a node by ID */
export function findNode(root: SplitNode, id: string): SplitNode | null {
  if (root.id === id) return root;
  if (root.type === "split") {
    return findNode(root.first, id) ?? findNode(root.second, id);
  }
  return null;
}

/** Immutably replace a node by ID. Only the first match is replaced so a
 *  replacement that itself contains the same id (e.g. splitLeaf reusing the
 *  target's id for the surviving leaf) doesn't cascade into further replacements. */
export function replaceNode(root: SplitNode, id: string, replacement: SplitNode): SplitNode {
  if (root.id === id) return replacement;
  if (root.type === "split") {
    const newFirst = replaceNode(root.first, id, replacement);
    if (newFirst !== root.first) return { ...root, first: newFirst };
    const newSecond = replaceNode(root.second, id, replacement);
    if (newSecond !== root.second) return { ...root, second: newSecond };
  }
  return root;
}

/** Remove a leaf, collapsing its parent split to the sibling. Returns null if it was the only leaf. */
export function removeLeaf(root: SplitNode, leafId: string): SplitNode | null {
  if (root.type === "leaf") {
    return root.id === leafId ? null : root;
  }
  if (root.first.id === leafId) return root.second;
  if (root.second.id === leafId) return root.first;
  // Recurse into children
  const newFirst = removeLeaf(root.first, leafId);
  if (newFirst !== root.first) {
    return newFirst === null ? root.second : { ...root, first: newFirst };
  }
  const newSecond = removeLeaf(root.second, leafId);
  if (newSecond !== root.second) {
    return newSecond === null ? root.first : { ...root, second: newSecond };
  }
  return root;
}

/** Update a split node's ratio */
export function updateRatio(root: SplitNode, splitId: string, ratio: number): SplitNode {
  if (root.id === splitId && root.type === "split") {
    return { ...root, ratio };
  }
  if (root.type === "split") {
    return {
      ...root,
      first: updateRatio(root.first, splitId, ratio),
      second: updateRatio(root.second, splitId, ratio),
    };
  }
  return root;
}

/** Split a leaf into a split node containing the original leaf and a new leaf.
 *  The surviving child gets a fresh id so the tree never holds two nodes with the
 *  same id, even transiently inside the replacement subtree. */
export function splitLeaf(
  root: SplitNode,
  leafId: string,
  newContent: PaneContent,
  direction: "horizontal" | "vertical",
  position: "before" | "after",
): SplitNode {
  const existingContent = findLeafContent(root, leafId);
  if (existingContent === null) return root;
  const newLeaf: SplitNode = { type: "leaf", id: genPaneId(), content: newContent };
  const survivingLeaf: SplitNode = { type: "leaf", id: genPaneId(), content: existingContent };
  const replacement: SplitNode = {
    type: "split",
    id: genPaneId(),
    direction,
    ratio: 0.5,
    first: position === "before" ? newLeaf : survivingLeaf,
    second: position === "after" ? newLeaf : survivingLeaf,
  };
  return replaceNode(root, leafId, replacement);
}

function findLeafContent(root: SplitNode, leafId: string): PaneContent | null {
  const node = findNode(root, leafId);
  return node?.type === "leaf" ? node.content : null;
}

/** Remove all leaves matching a predicate, collapsing parent splits */
export function removeStaleLeaves(
  root: SplitNode,
  isStale: (content: PaneContent) => boolean,
): SplitNode | null {
  if (root.type === "leaf") {
    return isStale(root.content) ? null : root;
  }
  const newFirst = removeStaleLeaves(root.first, isStale);
  const newSecond = removeStaleLeaves(root.second, isStale);
  if (!newFirst && !newSecond) return null;
  if (!newFirst) return newSecond;
  if (!newSecond) return newFirst;
  if (newFirst === root.first && newSecond === root.second) return root;
  return { ...root, first: newFirst, second: newSecond };
}
