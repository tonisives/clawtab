import type { PaneContext } from "./paneTypes";

export function PendingProcessPane({ ctx }: { ctx: PaneContext }) {
  const { lifecycle, viewing, split, mode } = ctx;
  const onBack = () => {
    lifecycle.setPendingAgentWorkDir(null);
    lifecycle.setPendingProcess(null);
    if (mode.kind === "leaf") split.handleClosePane(mode.leafId);
    else viewing.setViewingProcess(null);
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: 20 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <button className="btn btn-sm" onClick={onBack}>Back</button>
        <span style={{ color: "var(--text-secondary)", fontSize: 14 }}>Waiting for agent to start...</span>
      </div>
    </div>
  );
}
