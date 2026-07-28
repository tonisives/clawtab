import type { ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { PaneContent } from "@clawtab/shared";
import { DesktopJobDetail } from "../../JobDetailSections";
import { buildModelOptions } from "../../JobEditor/utils";
import { DraggableSplitPane } from "../../DraggableCards";
import { ErrorPlaceholder } from "./ErrorPlaceholder";
import type { PaneContext } from "./paneTypes";
import { makeZoomAwareClose } from "./zoomAwareClose";
import type { Job } from "../../../types";

type DragHandleProps = {
  ref?: (node: HTMLElement | null) => void;
  attributes?: any;
  listeners?: any;
  isDragging?: boolean;
};

interface Props {
  content: Extract<PaneContent, { kind: "job" }>;
  ctx: PaneContext;
}

export function JobPane({ content, ctx }: Props) {
  const {
    core, split, viewing, lifecycle, actions,
    questions, transport, autoYesShortcut,
    isWide, headerLeftInset, mode, mgr, callbacks,
    defaultProvider, defaultModel, enabledModels, sidebarFocusRef,
  } = ctx;

  const job = (core.jobs as Job[]).find((j) => j.slug === content.slug);
  if (!job) {
    const onClose = mode.kind === "leaf"
      ? () => split.handleClosePane(mode.leafId)
      : makeZoomAwareClose(split, () => viewing.setViewingJob(null));
    return <ErrorPlaceholder message="Job not found" onClose={onClose} headerLeftInset={headerLeftInset} />;
  }

  const jobQuestion = questions.find((q) => q.matched_job === job.slug);
  const matchedProcess = core.processes.find((p) => p.matched_job === job.slug);

  const close = mode.kind === "leaf"
    ? () => split.handleClosePane(mode.leafId)
    : makeZoomAwareClose(split, () => viewing.setViewingJob(null));

  const onDelete = mode.kind === "leaf"
    ? () => { split.handleClosePane(mode.leafId); actions.deleteJob(job.slug); core.reload(); }
    : () => { const slug = job.slug; callbacks.selectAdjacentItem(slug); actions.deleteJob(slug); core.reload(); };

  const modelOptions = buildModelOptions(
    ["claude", "codex", "opencode", "antigravity", "shell"],
    enabledModels ?? {},
  );

  const onUpdateJob = async (patch: import("@clawtab/shared").JobUpdate) => {
    await invoke("save_job", { job: { ...job, ...patch } });
    await core.reload();
  };

  const onStopping = () => {
    lifecycle.setStoppingJobSlugs((prev) => new Set(prev).add(job.slug));
    core.requestFastPoll(`job:${job.slug}`);
  };

  const onStopFailed = () => {
    lifecycle.setStoppingJobSlugs((prev) => {
      const next = new Set(prev);
      next.delete(job.slug);
      return next;
    });
  };

  const onRevealInSidebar = () => {
    viewing.setScrollToSlug(job.slug);
    sidebarFocusRef.current?.focus();
  };

  const detail = (dragHandleProps?: DragHandleProps): ReactNode => (
    <DesktopJobDetail
      transport={transport}
      job={job}
      status={core.statuses[job.slug] ?? { state: "idle" as const }}
      firstQuery={matchedProcess?.first_query ?? undefined}
      lastQuery={matchedProcess?.last_query ?? undefined}
      tokenCount={matchedProcess?.token_count}
      onBack={close}
      onOpen={() => callbacks.handleOpen(job.slug)}
      onDuplicate={(group: string) => callbacks.handleDuplicate(job, group)}
      onDuplicateToFolder={() => callbacks.handleDuplicateToFolder(job)}
      onDelete={onDelete}
      groups={[...new Set(core.jobs.map((j) => j.group || "default"))]}
      showBackButton={!isWide}
      hidePath
      options={jobQuestion?.options}
      questionContext={jobQuestion?.context_lines}
      {...callbacks.buildJobPaneActions(job, jobQuestion)}
      onSplitRunPane={(paneId: string, direction: "right" | "down") => callbacks.handleSplitPane(paneId, direction)}
      autoYesShortcut={autoYesShortcut}
      onStopping={onStopping}
      onStopFailed={onStopFailed}
      onRevealInSidebar={onRevealInSidebar}
      headerLeftInset={headerLeftInset}
      titlePath={callbacks.buildJobTitlePath(job, jobQuestion)}
      dragHandleProps={dragHandleProps}
      defaultAgentProvider={defaultProvider}
      defaultAgentModel={defaultModel}
      agentModelOptions={modelOptions}
      onUpdateJob={onUpdateJob}
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
