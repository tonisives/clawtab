import type { ReactNode } from "react";
import type { PaneContent } from "@clawtab/shared";
import { DesktopJobDetail } from "../../JobDetailSections";
import { DraggableSplitPane } from "../../DraggableCards";
import { JobEditorPane } from "../components/JobEditorPane";
import { ErrorPlaceholder } from "./ErrorPlaceholder";
import type { PaneContext } from "./paneTypes";
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
    defaultProvider, defaultModel, sidebarFocusRef, leafJobEditing,
  } = ctx;

  const job = (core.jobs as Job[]).find((j) => j.slug === content.slug);
  if (!job) {
    const onClose = mode.kind === "leaf"
      ? () => split.handleClosePane(mode.leafId)
      : () => viewing.setViewingJob(null);
    return <ErrorPlaceholder message="Job not found" onClose={onClose} headerLeftInset={headerLeftInset} />;
  }

  // Inline edit-mode (leaf only)
  if (mode.kind === "leaf") {
    const editingJob = leafJobEditing.getEditingJob(mode.leafId);
    if (editingJob) {
      const leafId = mode.leafId;
      return (
        <DraggableSplitPane leafId={leafId} content={content} sourceWorkspaceId={mgr.activeId}>
          {() => (
            <JobEditorPane
              createForGroup={null}
              editingJob={editingJob}
              headerMode="close"
              onCancel={() => leafJobEditing.stopEditing(leafId)}
              onPickTemplate={() => {}}
              onSave={(nextJob) => leafJobEditing.saveJob(leafId, editingJob, nextJob)}
              panelContentStyle={{
                flex: 1,
                overflow: "auto",
                paddingTop: 28,
                paddingRight: 20,
                paddingBottom: 20,
                paddingLeft: headerLeftInset || 20,
              }}
              saveError={leafJobEditing.getError(leafId)}
            />
          )}
        </DraggableSplitPane>
      );
    }
  }

  const jobQuestion = questions.find((q) => q.matched_job === job.slug);
  const matchedProcess = core.processes.find((p) => p.matched_job === job.slug);

  const close = mode.kind === "leaf"
    ? () => split.handleClosePane(mode.leafId)
    : () => viewing.setViewingJob(null);

  const onEdit = mode.kind === "leaf"
    ? () => leafJobEditing.startEditing(mode.leafId, job)
    : () => { callbacks.setEditingJob(job); viewing.setViewingJob(null); };

  const onDelete = mode.kind === "leaf"
    ? () => { split.handleClosePane(mode.leafId); actions.deleteJob(job.slug); core.reload(); }
    : () => { const slug = job.slug; callbacks.selectAdjacentItem(slug); actions.deleteJob(slug); core.reload(); };

  const onStopping = () => {
    lifecycle.setStoppingJobSlugs((prev) => new Set(prev).add(job.slug));
    core.requestFastPoll(`job:${job.slug}`);
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
      onEdit={onEdit}
      onOpen={() => callbacks.handleOpen(job.slug)}
      onToggle={() => { actions.toggleJob(job.slug); core.reload(); }}
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
      onRevealInSidebar={onRevealInSidebar}
      headerLeftInset={headerLeftInset}
      titlePath={callbacks.buildJobTitlePath(job, jobQuestion)}
      dragHandleProps={dragHandleProps}
      defaultAgentProvider={defaultProvider}
      defaultAgentModel={defaultModel}
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
