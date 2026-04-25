import type { ReactNode } from "react";
import type { PaneContent } from "@clawtab/shared";
import { shortenPath } from "@clawtab/shared";
import { TmuxPaneDetail } from "../../TmuxPaneDetail";
import { DraggableSplitPane } from "../../DraggableCards";
import { ErrorPlaceholder } from "./ErrorPlaceholder";
import { ProcessTmuxView } from "./ProcessTmuxView";
import type { PaneContext } from "./paneTypes";

type DragHandleProps = {
  ref?: (node: HTMLElement | null) => void;
  attributes?: any;
  listeners?: any;
  isDragging?: boolean;
};

interface Props {
  content: Extract<PaneContent, { kind: "terminal" }>;
  ctx: PaneContext;
}

export function TerminalPane({ content, ctx }: Props) {
  const {
    core, lifecycle, split, viewing, mode, headerLeftInset, isWide, mgr, callbacks,
  } = ctx;
  const { stoppingProcesses, shellPanes, demotedShellPaneIdsRef, setShellPanes } = lifecycle;

  const proc = core.processes.find((p) => p.pane_id === content.paneId)
    ?? (mode.kind === "leaf"
      ? stoppingProcesses.find((sp) => sp.process.pane_id === content.paneId)?.process
      : undefined);
  const shell = shellPanes.find((p) => p.pane_id === content.paneId);

  if (!shell && !proc) {
    const onClose = mode.kind === "leaf"
      ? () => split.handleClosePane(mode.leafId)
      : () => { viewing.setViewingProcess(null); viewing.setViewingShell(null); };
    return <ErrorPlaceholder message="Tmux pane not found" onClose={onClose} headerLeftInset={headerLeftInset} />;
  }

  if (proc) {
    return <ProcessTmuxView content={content} process={proc} ctx={ctx} />;
  }

  if (!shell) return null;

  const close = mode.kind === "leaf"
    ? () => split.handleClosePane(mode.leafId)
    : () => viewing.setViewingShell(null);

  const zoom = mode.kind === "leaf"
    ? () => split.toggleZoomLeaf(mode.leafId)
    : () => split.toggleZoomLeaf("");

  const onStopped = () => {
    demotedShellPaneIdsRef.current.delete(shell.pane_id);
    setShellPanes((prev) => prev.filter((p) => p.pane_id !== shell.pane_id));
    if (mode.kind === "leaf") split.handleClosePane(mode.leafId);
    else callbacks.selectAdjacentItem(shell.pane_id);
  };

  const detail = (dragHandleProps?: DragHandleProps): ReactNode => (
    <TmuxPaneDetail
      target={{ kind: "shell", shell }}
      onBack={close}
      showBackButton={!isWide}
      hidePath
      onStopped={onStopped}
      onSplitPane={(direction) => callbacks.handleSplitPane(shell.pane_id, direction)}
      onZoomPane={zoom}
      headerLeftInset={headerLeftInset}
      titlePath={shortenPath(shell.cwd)}
      dragHandleProps={dragHandleProps}
    />
  );

  if (mode.kind === "leaf") {
    return (
      <DraggableSplitPane leafId={mode.leafId} content={content} sourceWorkspaceId={mgr.activeId}>
        {(dragHandleProps) => detail(dragHandleProps)}
      </DraggableSplitPane>
    );
  }
  return <>{detail()}</>;
}
