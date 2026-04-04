import { useCallback, useRef, type ReactNode } from "react";

export type SplitDirection = "horizontal" | "vertical";

export interface SplitDetailAreaProps {
  /** Content for the primary (top/left) pane */
  primaryContent: ReactNode;
  /** Content for the secondary (bottom/right) pane - null means no split */
  secondaryContent: ReactNode | null;
  /** Split direction: horizontal = side-by-side, vertical = top-bottom */
  direction: SplitDirection;
  /** Split ratio 0.2-0.8, default 0.5 */
  ratio: number;
  onRatioChange: (ratio: number) => void;
  /** Close button handler for primary pane */
  onClosePrimary?: () => void;
  /** Close button handler for secondary pane */
  onCloseSecondary?: () => void;
  /** Overlay to render on top (drop zone overlay during drag) */
  overlay?: ReactNode;
}

export function SplitDetailArea({
  primaryContent,
  secondaryContent,
  direction,
  ratio,
  onRatioChange,
  onClosePrimary,
  onCloseSecondary,
  overlay,
}: SplitDetailAreaProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const ratioRef = useRef(ratio);
  ratioRef.current = ratio;

  const onResizeHandleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const container = containerRef.current;
      if (!container) return;

      const rect = container.getBoundingClientRect();
      const isHorizontal = direction === "horizontal";

      const onMouseMove = (ev: MouseEvent) => {
        const pos = isHorizontal ? ev.clientX - rect.left : ev.clientY - rect.top;
        const total = isHorizontal ? rect.width : rect.height;
        const newRatio = Math.max(0.2, Math.min(0.8, pos / total));
        onRatioChange(newRatio);
      };
      const onMouseUp = () => {
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
      document.body.style.cursor = isHorizontal ? "col-resize" : "row-resize";
      document.body.style.userSelect = "none";
    },
    [direction, onRatioChange],
  );

  const isSplit = secondaryContent !== null;
  const isHorizontal = direction === "horizontal";

  return (
    <div
      ref={containerRef}
      style={{
        flex: 1,
        display: "flex",
        flexDirection: isHorizontal ? "row" : "column",
        overflow: "hidden",
        position: "relative",
      }}
    >
      {/* Primary pane */}
      <div
        style={{
          ...(isSplit
            ? isHorizontal
              ? { width: `${ratio * 100}%` }
              : { height: `${ratio * 100}%` }
            : { flex: 1 }),
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          position: "relative",
        }}
      >
        {isSplit && onClosePrimary && (
          <button
            onClick={onClosePrimary}
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
        {primaryContent}
      </div>

      {/* Resize handle */}
      {isSplit && (
        <div
          onMouseDown={onResizeHandleMouseDown}
          style={{
            ...(isHorizontal
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
              ...(isHorizontal
                ? { left: 4, top: 0, bottom: 0, width: 1 }
                : { top: 4, left: 0, right: 0, height: 1 }),
              background: "var(--border-light, #333)",
            }}
          />
        </div>
      )}

      {/* Secondary pane */}
      {isSplit && (
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
            position: "relative",
          }}
        >
          {onCloseSecondary && (
            <button
              onClick={onCloseSecondary}
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
          {secondaryContent}
        </div>
      )}

      {/* Drop zone overlay */}
      {overlay}
    </div>
  );
}
