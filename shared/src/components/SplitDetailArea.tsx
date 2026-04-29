import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { SplitNode, PaneContent } from "../types/splitTree";

export type { SplitDirection } from "../types/splitTree";

const MIN_PANE_SIZE = 200;

export interface SplitDetailAreaProps {
  tree: SplitNode | null;
  renderLeaf: (content: PaneContent, leafId: string) => ReactNode;
  onRatioChange: (splitNodeId: string, ratio: number) => void;
  onFocusLeaf?: (leafId: string) => void;
  focusedLeafId?: string | null;
  paneColors?: Map<string, string>;
  minPaneSize?: number;
  emptyContent?: ReactNode;
  overlay?: ReactNode;
}

export function SplitDetailArea({
  tree,
  renderLeaf,
  onRatioChange,
  onFocusLeaf,
  focusedLeafId,
  paneColors,
  minPaneSize = MIN_PANE_SIZE,
  emptyContent,
  overlay,
}: SplitDetailAreaProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerSize, setContainerSize] = useState({ w: 0, h: 0 });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        setContainerSize({ w: entry.contentRect.width, h: entry.contentRect.height });
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!focusedLeafId) return;
    const container = containerRef.current;
    if (!container) return;
    const leafEl = container.querySelector(`[data-leaf-id="${focusedLeafId}"]`);
    if (!leafEl) return;
    // Skip if focus is already inside the target leaf. Otherwise this fights with
    // requestXtermPaneFocus and the focusin listener in useSplitTree: each focus
    // attempt triggers a focusin that bubbles to the container, which writes back
    // to focusedLeafId; if a sibling pane also self-focuses we get a ping-pong.
    if (leafEl.contains(document.activeElement)) return;
    const raf = requestAnimationFrame(() => {
      const ta = leafEl.querySelector(".xterm-helper-textarea");
      if (ta instanceof HTMLElement && !leafEl.contains(document.activeElement)) ta.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [focusedLeafId]);

  return (
    <div
      ref={containerRef}
      style={{
        flex: 1,
        display: "flex",
        overflow: "hidden",
        position: "relative",
      }}
    >
      {tree ? (
        <SplitNodeRenderer
          node={tree}
          renderLeaf={renderLeaf}
          onRatioChange={onRatioChange}
          onFocusLeaf={onFocusLeaf}
          focusedLeafId={focusedLeafId}
          paneColors={paneColors}
          minPaneSize={minPaneSize}
          availableW={containerSize.w}
          availableH={containerSize.h}
        />
      ) : (
        emptyContent ?? null
      )}
      {overlay}
    </div>
  );
}

function SplitNodeRenderer({
  node,
  renderLeaf,
  onRatioChange,
  onFocusLeaf,
  focusedLeafId,
  paneColors,
  minPaneSize,
  availableW,
  availableH,
}: {
  node: SplitNode;
  renderLeaf: (content: PaneContent, leafId: string) => ReactNode;
  onRatioChange: (splitNodeId: string, ratio: number) => void;
  onFocusLeaf?: (leafId: string) => void;
  focusedLeafId?: string | null;
  paneColors?: Map<string, string>;
  minPaneSize: number;
  availableW: number;
  availableH: number;
}) {
  if (node.type === "leaf") {
    const color = paneColors?.get(node.id);
    const showColorStrip = paneColors && paneColors.size > 1;
    const isFocused = focusedLeafId === node.id;
    return (
      <div
        data-leaf-id={node.id}
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          position: "relative",
          borderRadius: 3,
          opacity: showColorStrip && !isFocused ? 0.85 : 1,
          isolation: "isolate",
        }}
        onMouseDown={onFocusLeaf ? () => onFocusLeaf(node.id) : undefined}
      >
        {renderLeaf(node.content, node.id)}
        {showColorStrip && (() => {
          const c = (color ?? "transparent") + (isFocused ? "" : "66");
          return (
            <div style={{
              position: "absolute",
              inset: 0,
              borderRadius: 3,
              border: `1px solid ${c}`,
              boxShadow: `inset 0 0 1px ${c}`,
              pointerEvents: "none",
              zIndex: 9999,
            }} />
          );
        })()}
      </div>
    );
  }

  const isH = node.direction === "horizontal";
  const firstW = isH ? availableW * node.ratio : availableW;
  const firstH = isH ? availableH : availableH * node.ratio;
  const secondW = isH ? availableW * (1 - node.ratio) : availableW;
  const secondH = isH ? availableH : availableH * (1 - node.ratio);

  // Keys keyed by node.id — without them React reconciles by position, which
  // means restructuring the tree (leaf becomes a split, sibling order changes,
  // etc.) makes React update the existing component instance with a different
  // node's content rather than preserving identity. That manifests as panes
  // displaying another leaf's content during the transient render.
  return (
    <SplitContainer
      node={node}
      onRatioChange={onRatioChange}
      minPaneSize={minPaneSize}
    >
      <SplitNodeRenderer
        key={node.first.id}
        node={node.first}
        renderLeaf={renderLeaf}
        onRatioChange={onRatioChange}
        onFocusLeaf={onFocusLeaf}
        focusedLeafId={focusedLeafId}
        paneColors={paneColors}
        minPaneSize={minPaneSize}
        availableW={firstW}
        availableH={firstH}
      />
      <SplitNodeRenderer
        key={node.second.id}
        node={node.second}
        renderLeaf={renderLeaf}
        onRatioChange={onRatioChange}
        onFocusLeaf={onFocusLeaf}
        focusedLeafId={focusedLeafId}
        paneColors={paneColors}
        minPaneSize={minPaneSize}
        availableW={secondW}
        availableH={secondH}
      />
    </SplitContainer>
  );
}

function SplitContainer({
  node,
  onRatioChange,
  minPaneSize,
  children,
}: {
  node: Extract<SplitNode, { type: "split" }>;
  onRatioChange: (splitNodeId: string, ratio: number) => void;
  minPaneSize: number;
  children: [ReactNode, ReactNode];
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const isH = node.direction === "horizontal";

  const onResizeHandleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const total = isH ? rect.width : rect.height;
      const minRatio = total > 0 ? minPaneSize / total : 0.2;
      const maxRatio = total > 0 ? 1 - minPaneSize / total : 0.8;

      const onMouseMove = (ev: MouseEvent) => {
        const pos = isH ? ev.clientX - rect.left : ev.clientY - rect.top;
        const raw = pos / total;
        const clamped = Math.max(minRatio, Math.min(maxRatio, raw));
        onRatioChange(node.id, clamped);
      };
      const onMouseUp = () => {
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
      document.body.style.cursor = isH ? "col-resize" : "row-resize";
      document.body.style.userSelect = "none";
    },
    [isH, minPaneSize, node.id, onRatioChange],
  );

  return (
    <div
      ref={containerRef}
      style={{
        flex: 1,
        display: "flex",
        flexDirection: isH ? "row" : "column",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          ...(isH
            ? { width: `${node.ratio * 100}%` }
            : { height: `${node.ratio * 100}%` }),
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {children[0]}
      </div>
      <div
        onMouseDown={onResizeHandleMouseDown}
        style={{
          ...(isH
            ? { width: 1, margin: "0 -4px", padding: "0 4px", cursor: "col-resize" }
            : { height: 1, margin: "-4px 0", padding: "4px 0", cursor: "row-resize" }),
          backgroundColor: "transparent",
          zIndex: 10,
          flexShrink: 0,
          position: "relative",
          boxSizing: "content-box",
        }}
      >
        <div
          style={{
            ...(isH
              ? { width: 1, height: "100%" }
              : { height: 1, width: "100%" }),
            background: "var(--border-light, #333)",
          }}
        />
      </div>
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {children[1]}
      </div>
    </div>
  );
}
