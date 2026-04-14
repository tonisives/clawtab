import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { SplitNode } from "../types/splitTree";

export type DropZoneId =
  | { action: "replace"; leafId: string }
  | { action: "split"; leafId: string; direction: "horizontal" | "vertical"; position: "before" | "after" };

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const MIN_PANE_SIZE = 200;

/** Compute which zone the pointer is in, given coordinates relative to the overlay container */
export function computeDropZone(
  px: number,
  py: number,
  containerW: number,
  containerH: number,
  tree: SplitNode | null,
  minPaneSize: number = MIN_PANE_SIZE,
): DropZoneId | null {
  if (!tree) return null;
  const rect: Rect = { x: 0, y: 0, w: containerW, h: containerH };
  return computeZoneInNode(px, py, tree, rect, minPaneSize);
}

function computeZoneInNode(
  px: number,
  py: number,
  node: SplitNode,
  rect: Rect,
  minPaneSize: number,
): DropZoneId | null {
  if (rect.w <= 0 || rect.h <= 0) return null;

  if (node.type === "leaf") {
    // Check if pointer is inside this leaf's rect
    if (px < rect.x || px > rect.x + rect.w || py < rect.y || py > rect.y + rect.h) {
      return null;
    }

    const relX = (px - rect.x) / rect.w;
    const relY = (py - rect.y) / rect.h;

    const canSplitH = rect.w / 2 >= minPaneSize;
    const canSplitV = rect.h / 2 >= minPaneSize;

    // Edge zones: outer 30% on each side triggers split, center 40% triggers replace
    if (canSplitH && relX < 0.3) return { action: "split", leafId: node.id, direction: "horizontal", position: "before" };
    if (canSplitH && relX > 0.7) return { action: "split", leafId: node.id, direction: "horizontal", position: "after" };
    if (canSplitV && relY < 0.3) return { action: "split", leafId: node.id, direction: "vertical", position: "before" };
    if (canSplitV && relY > 0.7) return { action: "split", leafId: node.id, direction: "vertical", position: "after" };

    return { action: "replace", leafId: node.id };
  }

  // Split node: determine which child the pointer is in
  const isH = node.direction === "horizontal";
  const divider = isH
    ? rect.x + rect.w * node.ratio
    : rect.y + rect.h * node.ratio;

  if (isH) {
    if (px < divider) {
      return computeZoneInNode(px, py, node.first, { x: rect.x, y: rect.y, w: rect.w * node.ratio, h: rect.h }, minPaneSize);
    }
    return computeZoneInNode(px, py, node.second, { x: divider, y: rect.y, w: rect.w * (1 - node.ratio), h: rect.h }, minPaneSize);
  }
  if (py < divider) {
    return computeZoneInNode(px, py, node.first, { x: rect.x, y: rect.y, w: rect.w, h: rect.h * node.ratio }, minPaneSize);
  }
  return computeZoneInNode(px, py, node.second, { x: rect.x, y: divider, w: rect.w, h: rect.h * (1 - node.ratio) }, minPaneSize);
}

/** Compute the pixel rect of a leaf within the tree */
function computeLeafRect(
  node: SplitNode,
  leafId: string,
  rect: Rect,
): Rect | null {
  if (node.type === "leaf") {
    return node.id === leafId ? rect : null;
  }
  const isH = node.direction === "horizontal";
  const firstRect: Rect = isH
    ? { x: rect.x, y: rect.y, w: rect.w * node.ratio, h: rect.h }
    : { x: rect.x, y: rect.y, w: rect.w, h: rect.h * node.ratio };
  const secondRect: Rect = isH
    ? { x: rect.x + rect.w * node.ratio, y: rect.y, w: rect.w * (1 - node.ratio), h: rect.h }
    : { x: rect.x, y: rect.y + rect.h * node.ratio, w: rect.w, h: rect.h * (1 - node.ratio) };

  return computeLeafRect(node.first, leafId, firstRect) ?? computeLeafRect(node.second, leafId, secondRect);
}

const ZONE_STYLES: Record<string, { bg: string; border: string; label: string }> = {
  "split-h-before": { bg: "rgba(100, 149, 237, 0.15)", border: "rgba(100, 149, 237, 0.5)", label: "Split Left" },
  "split-h-after": { bg: "rgba(100, 149, 237, 0.15)", border: "rgba(100, 149, 237, 0.5)", label: "Split Right" },
  "split-v-before": { bg: "rgba(100, 200, 120, 0.15)", border: "rgba(100, 200, 120, 0.5)", label: "Split Above" },
  "split-v-after": { bg: "rgba(100, 200, 120, 0.15)", border: "rgba(100, 200, 120, 0.5)", label: "Split Below" },
  replace: { bg: "rgba(200, 160, 60, 0.15)", border: "rgba(200, 160, 60, 0.5)", label: "Replace" },
};

function zoneKey(zone: DropZoneId): string {
  if (zone.action === "replace") return "replace";
  return `split-${zone.direction === "horizontal" ? "h" : "v"}-${zone.position}`;
}

interface DropZoneOverlayProps {
  tree: SplitNode | null;
  containerW: number;
  containerH: number;
  activeZone: DropZoneId | null;
}

export function DropZoneOverlay({
  tree,
  containerW,
  containerH,
  activeZone,
}: DropZoneOverlayProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const [measuredSize, setMeasuredSize] = useState({ w: 0, h: 0 });

  useLayoutEffect(() => {
    const el = overlayRef.current;
    if (!el) return;

    const updateSize = () => {
      const rect = el.getBoundingClientRect();
      setMeasuredSize((prev) => {
        if (prev.w === rect.width && prev.h === rect.height) return prev;
        return { w: rect.width, h: rect.height };
      });
    };

    updateSize();
    const ro = new ResizeObserver(updateSize);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const outer = (children?: ReactNode) => (
    <div
      ref={overlayRef}
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 100,
        pointerEvents: "none",
      }}
    >
      {children}
    </div>
  );

  if (!activeZone || !tree) return null;

  const effectiveW = measuredSize.w > 0 ? measuredSize.w : containerW;
  const effectiveH = measuredSize.h > 0 ? measuredSize.h : containerH;
  if (effectiveW <= 0 || effectiveH <= 0) return outer();

  const leafRect = computeLeafRect(tree, activeZone.leafId, { x: 0, y: 0, w: effectiveW, h: effectiveH });
  if (!leafRect) return outer();

  const key = zoneKey(activeZone);
  const style = ZONE_STYLES[key];
  if (!style) return outer();

  // Compute the highlighted sub-rect within the leaf
  let highlightRect: Rect;
  const pad = 8;
  if (activeZone.action === "replace") {
    highlightRect = {
      x: leafRect.x + pad,
      y: leafRect.y + pad,
      w: leafRect.w - pad * 2,
      h: leafRect.h - pad * 2,
    };
  } else {
    const { direction, position } = activeZone;
    if (direction === "horizontal") {
      const halfW = leafRect.w / 2;
      highlightRect = position === "before"
        ? { x: leafRect.x + pad, y: leafRect.y + pad, w: halfW - pad, h: leafRect.h - pad * 2 }
        : { x: leafRect.x + halfW, y: leafRect.y + pad, w: halfW - pad, h: leafRect.h - pad * 2 };
    } else {
      const halfH = leafRect.h / 2;
      highlightRect = position === "before"
        ? { x: leafRect.x + pad, y: leafRect.y + pad, w: leafRect.w - pad * 2, h: halfH - pad }
        : { x: leafRect.x + pad, y: leafRect.y + halfH, w: leafRect.w - pad * 2, h: halfH - pad };
    }
  }

  if (highlightRect.w <= 0 || highlightRect.h <= 0) return outer();

  return outer(
    <div
      style={{
        position: "absolute",
        left: highlightRect.x,
        top: highlightRect.y,
        width: highlightRect.w,
        height: highlightRect.h,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: style.bg,
        border: `2px dashed ${style.border}`,
        borderRadius: 8,
        transition: "all 150ms",
      }}
    >
      <span
        style={{
          color: style.border,
          fontSize: 13,
          fontWeight: 600,
          opacity: 0.9,
          textShadow: "0 1px 2px rgba(0,0,0,0.5)",
          userSelect: "none",
        }}
      >
        {style.label}
      </span>
    </div>
  );
}
