import type { useSplitTree } from "@clawtab/shared";

export function makeZoomAwareClose(
  split: ReturnType<typeof useSplitTree>,
  fallback: () => void,
): () => void {
  return () => {
    const zoomedId = split.getZoomedLeafId();
    if (zoomedId) {
      split.handleClosePane(zoomedId);
      return;
    }
    fallback();
  };
}
