import type { PaneContent } from "@clawtab/shared";
import { ErrorPlaceholder } from "./ErrorPlaceholder";
import { PendingProcessPane } from "./PendingProcessPane";
import { ProcessTmuxView } from "./ProcessTmuxView";
import type { PaneContext } from "./paneTypes";

interface Props {
  content: Extract<PaneContent, { kind: "process" }>;
  ctx: PaneContext;
}

export function ProcessPane({ content, ctx }: Props) {
  const { core, lifecycle, split, viewing, mode, headerLeftInset } = ctx;
  const { pendingProcess, stoppingProcesses } = lifecycle;

  const proc = core.processes.find((p) => p.pane_id === content.paneId)
    ?? stoppingProcesses.find((sp) => sp.process.pane_id === content.paneId)?.process
    ?? (pendingProcess?.pane_id === content.paneId ? pendingProcess : null);

  if (!proc) {
    const onClose = mode.kind === "leaf"
      ? () => split.handleClosePane(mode.leafId)
      : () => viewing.setViewingProcess(null);
    return <ErrorPlaceholder message="Process not found" onClose={onClose} headerLeftInset={headerLeftInset} />;
  }

  if (proc.pane_id.startsWith("_pending_")) {
    return <PendingProcessPane ctx={ctx} />;
  }

  return <ProcessTmuxView content={content} process={proc} ctx={ctx} />;
}
