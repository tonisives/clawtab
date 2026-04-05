import type React from "react";

export type LegacyDropZoneId =
  | "split-horizontal-right"
  | "split-horizontal-left"
  | "split-vertical-bottom"
  | "split-vertical-top"
  | "replace-current"
  | "replace-primary"
  | "replace-secondary";

type SplitDirection = "horizontal" | "vertical";

interface LegacyDropZoneOverlayProps {
  isSplit: boolean;
  splitDirection?: SplitDirection;
  splitRatio?: number;
  activeZone: LegacyDropZoneId | null;
}

const ZONE_STYLES: Record<string, { bg: string; border: string; label: string }> = {
  "split-horizontal-right": { bg: "rgba(100, 149, 237, 0.15)", border: "rgba(100, 149, 237, 0.5)", label: "Split Right" },
  "split-horizontal-left": { bg: "rgba(100, 149, 237, 0.15)", border: "rgba(100, 149, 237, 0.5)", label: "Split Left" },
  "split-vertical-bottom": { bg: "rgba(100, 200, 120, 0.15)", border: "rgba(100, 200, 120, 0.5)", label: "Split Below" },
  "split-vertical-top": { bg: "rgba(100, 200, 120, 0.15)", border: "rgba(100, 200, 120, 0.5)", label: "Split Above" },
  "replace-current": { bg: "rgba(200, 160, 60, 0.15)", border: "rgba(200, 160, 60, 0.5)", label: "Replace" },
  "replace-primary": { bg: "rgba(200, 160, 60, 0.15)", border: "rgba(200, 160, 60, 0.5)", label: "Replace" },
  "replace-secondary": { bg: "rgba(200, 160, 60, 0.15)", border: "rgba(200, 160, 60, 0.5)", label: "Replace" },
};

function ZoneIndicator({ zoneId, active, style }: { zoneId: LegacyDropZoneId; active: boolean; style: React.CSSProperties }) {
  const zone = ZONE_STYLES[zoneId];
  return (
    <div
      style={{
        ...style,
        position: "absolute",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: active ? zone.bg : "transparent",
        border: active ? `2px dashed ${zone.border}` : "2px dashed transparent",
        borderRadius: 8,
        transition: "background 150ms, border-color 150ms",
        pointerEvents: "none",
      }}
    >
      {active && (
        <span
          style={{
            color: zone.border,
            fontSize: 13,
            fontWeight: 600,
            opacity: 0.9,
            textShadow: "0 1px 2px rgba(0,0,0,0.5)",
            userSelect: "none",
          }}
        >
          {zone.label}
        </span>
      )}
    </div>
  );
}

/** Legacy computeDropZone for flat 2-pane split */
export function legacyComputeDropZone(
  x: number,
  y: number,
  w: number,
  h: number,
  isSplit: boolean,
  splitDirection?: SplitDirection,
  splitRatio?: number,
): LegacyDropZoneId | null {
  if (w === 0 || h === 0) return null;

  if (isSplit) {
    if (splitDirection === "horizontal") {
      const divider = w * (splitRatio ?? 0.5);
      return x < divider ? "replace-primary" : "replace-secondary";
    } else {
      const divider = h * (splitRatio ?? 0.5);
      return y < divider ? "replace-primary" : "replace-secondary";
    }
  }

  const relX = x / w;
  const relY = y / h;

  if (relX < 0.25) return "split-horizontal-left";
  if (relX > 0.75) return "split-horizontal-right";
  if (relY < 0.25) return "split-vertical-top";
  if (relY > 0.75) return "split-vertical-bottom";
  return "replace-current";
}

const EDGE_SIZE = 80;

export function LegacyDropZoneOverlay({
  isSplit,
  splitDirection,
  splitRatio = 0.5,
  activeZone,
}: LegacyDropZoneOverlayProps) {
  if (isSplit) {
    const isH = splitDirection === "horizontal";
    return (
      <div
        style={{
          position: "absolute",
          inset: 0,
          zIndex: 100,
          pointerEvents: "none",
        }}
      >
        <ZoneIndicator
          zoneId="replace-primary"
          active={activeZone === "replace-primary"}
          style={
            isH
              ? { left: 8, top: 8, bottom: 8, width: `calc(${splitRatio * 100}% - 16px)` }
              : { left: 8, top: 8, right: 8, height: `calc(${splitRatio * 100}% - 16px)` }
          }
        />
        <ZoneIndicator
          zoneId="replace-secondary"
          active={activeZone === "replace-secondary"}
          style={
            isH
              ? { right: 8, top: 8, bottom: 8, width: `calc(${(1 - splitRatio) * 100}% - 16px)` }
              : { left: 8, bottom: 8, right: 8, height: `calc(${(1 - splitRatio) * 100}% - 16px)` }
          }
        />
      </div>
    );
  }

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 100,
        pointerEvents: "none",
      }}
    >
      <ZoneIndicator
        zoneId="split-horizontal-left"
        active={activeZone === "split-horizontal-left"}
        style={{ left: 8, top: 8, bottom: 8, width: EDGE_SIZE }}
      />
      <ZoneIndicator
        zoneId="split-horizontal-right"
        active={activeZone === "split-horizontal-right"}
        style={{ right: 8, top: 8, bottom: 8, width: EDGE_SIZE }}
      />
      <ZoneIndicator
        zoneId="split-vertical-top"
        active={activeZone === "split-vertical-top"}
        style={{ left: EDGE_SIZE + 16, right: EDGE_SIZE + 16, top: 8, height: EDGE_SIZE }}
      />
      <ZoneIndicator
        zoneId="split-vertical-bottom"
        active={activeZone === "split-vertical-bottom"}
        style={{ left: EDGE_SIZE + 16, right: EDGE_SIZE + 16, bottom: 8, height: EDGE_SIZE }}
      />
      <ZoneIndicator
        zoneId="replace-current"
        active={activeZone === "replace-current"}
        style={{
          left: EDGE_SIZE + 16,
          right: EDGE_SIZE + 16,
          top: EDGE_SIZE + 16,
          bottom: EDGE_SIZE + 16,
        }}
      />
    </div>
  );
}
