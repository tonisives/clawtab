import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { SplitNode, PaneContent } from "../types/splitTree";

export type { SplitDirection } from "../types/splitTree";

const MIN_PANE_SIZE = 200;

export interface SplitDetailAreaProps {
  tree: SplitNode | null;
  renderLeaf: (content: PaneContent, leafId: string) => ReactNode;
  onRatioChange: (splitNodeId: string, ratio: number) => void;
  onClosePane: (leafId: string) => void;
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
  onClosePane,
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

  const leafCount = tree ? countLeaves(tree) : 0;

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
          onClosePane={leafCount > 1 ? onClosePane : undefined}
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

function countLeaves(node: SplitNode): number {
  if (node.type === "leaf") return 1;
  return countLeaves(node.first) + countLeaves(node.second);
}

function SplitNodeRenderer({
  node,
  renderLeaf,
  onRatioChange,
  onClosePane,
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
  onClosePane?: (leafId: string) => void;
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
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          position: "relative",
          outline: showColorStrip ? `2px solid ${color ?? "transparent"}` : undefined,
          outlineOffset: "-2px",
          opacity: showColorStrip && !isFocused ? 0.85 : 1,
        }}
        onMouseDown={onFocusLeaf ? () => onFocusLeaf(node.id) : undefined}
      >
        {onClosePane && (
          <button
            onClick={() => onClosePane(node.id)}
            style={{
              position: "absolute",
              top: 6,
              right: 6,
              zIndex: 10,
              background: "var(--bg-tertiary, #222)",
              border: "1px solid var(--border-light, #333)",
              borderRadius: 4,
              color: "var(--text-muted, #888)",
              cursor: "pointer",
              padding: "2px 6px",
              fontSize: 11,
              lineHeight: "1",
            }}
            title="Close pane"
          >
            x
          </button>
        )}
        {renderLeaf(node.content, node.id)}
      </div>
    );
  }

  const isH = node.direction === "horizontal";
  const firstW = isH ? availableW * node.ratio : availableW;
  const firstH = isH ? availableH : availableH * node.ratio;
  const secondW = isH ? availableW * (1 - node.ratio) : availableW;
  const secondH = isH ? availableH : availableH * (1 - node.ratio);

  return (
    <SplitContainer
      node={node}
      onRatioChange={onRatioChange}
      minPaneSize={minPaneSize}
    >
      <SplitNodeRenderer
        node={node.first}
        renderLeaf={renderLeaf}
        onRatioChange={onRatioChange}
        onClosePane={onClosePane}
        onFocusLeaf={onFocusLeaf}
        focusedLeafId={focusedLeafId}
        paneColors={paneColors}
        minPaneSize={minPaneSize}
        availableW={firstW}
        availableH={firstH}
      />
      <SplitNodeRenderer
        node={node.second}
        renderLeaf={renderLeaf}
        onRatioChange={onRatioChange}
        onClosePane={onClosePane}
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
            ? { width: 9, marginLeft: -5, marginRight: -4, cursor: "col-resize" }
            : { height: 9, marginTop: -5, marginBottom: -4, cursor: "row-resize" }),
          backgroundColor: "transparent",
          zIndex: 10,
          flexShrink: 0,
          position: "relative",
        }}
      >
        <div
          style={{
            position: "absolute",
            ...(isH
              ? { left: 4, top: 0, bottom: 0, width: 1 }
              : { top: 4, left: 0, right: 0, height: 1 }),
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
