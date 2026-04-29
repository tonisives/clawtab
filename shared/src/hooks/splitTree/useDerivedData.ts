import { useMemo } from "react";
import type { PaneContent, SplitNode } from "../../types/splitTree";
import { collectLeaves } from "../../util/splitTree";
import { assignPaneColors } from "../../theme/paneColors";
import { colors } from "../../theme/colors";
import { contentKey, createVirtualRoot } from "./helpers";

export function useDerivedData(opts: {
  splitTree: SplitNode | null;
  focusedLeafId: string | null;
  currentContent: PaneContent | null;
}) {
  const { splitTree, focusedLeafId, currentContent } = opts;

  const selectedItems = useMemo((): Map<string, string> | null => {
    if (splitTree) {
      const colorMap = assignPaneColors(splitTree);
      const items = new Map<string, string>();
      for (const leaf of collectLeaves(splitTree)) {
        items.set(contentKey(leaf.content), colorMap.get(leaf.id) ?? colors.accent);
      }
      return items.size > 0 ? items : null;
    }
    if (currentContent) {
      return new Map([[contentKey(currentContent), colors.accent]]);
    }
    return null;
  }, [splitTree, currentContent]);

  const focusedItemKey = useMemo((): string | null => {
    if (!splitTree || !focusedLeafId) return null;
    const leaves = collectLeaves(splitTree);
    const leaf = leaves.find(l => l.id === focusedLeafId);
    return leaf ? contentKey(leaf.content) : null;
  }, [splitTree, focusedLeafId]);

  const paneColors = useMemo(() => {
    if (!splitTree) return undefined;
    return assignPaneColors(splitTree);
  }, [splitTree]);

  const effectiveTreeForOverlay = useMemo(() => {
    if (splitTree) return splitTree;
    return createVirtualRoot(currentContent);
  }, [splitTree, currentContent]);

  return { selectedItems, focusedItemKey, paneColors, effectiveTreeForOverlay };
}
