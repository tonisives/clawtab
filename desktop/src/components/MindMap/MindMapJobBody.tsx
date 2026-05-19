import { useCallback, useMemo } from "react";
import type { Transport, useJobsCore, useJobActions } from "@clawtab/shared";
import { DesktopJobDetail } from "../JobDetailSections";
import type { Job } from "../../types";
import type { MindItem } from "./useRecencyLayout";

type DragHandleProps = {
  ref?: (node: HTMLElement | null) => void;
  attributes?: Record<string, unknown>;
  listeners?: Record<string, unknown>;
  isDragging?: boolean;
};

interface Props {
  item: MindItem;
  transport: Transport;
  core: ReturnType<typeof useJobsCore>;
  actions: ReturnType<typeof useJobActions>;
  autoYesActive?: boolean;
  onToggleAutoYes?: () => void;
  autoYesShortcut?: string;
  dragHandleProps?: DragHandleProps;
  onClose: () => void;
  onRequestJobsTab: () => void;
}

export function MindMapJobBody({
  item,
  transport,
  core,
  actions,
  autoYesActive,
  onToggleAutoYes,
  autoYesShortcut,
  dragHandleProps,
  onClose,
  onRequestJobsTab,
}: Props) {
  const slug = item.job?.slug ?? "";
  const job = useMemo(
    () => (core.jobs as Job[]).find((j) => j.slug === slug) ?? null,
    [core.jobs, slug],
  );

  const status = core.statuses[slug] ?? { state: "idle" as const };

  const matchedProcess = useMemo(() => {
    if (item.process) return item.process;
    return core.processes.find((p) => p.matched_job === slug);
  }, [item.process, core.processes, slug]);

  const groups = useMemo(
    () => [...new Set(core.jobs.map((j) => j.group || "default"))],
    [core.jobs],
  );

  const goToJobsTab = useCallback(() => {
    onRequestJobsTab();
    onClose();
  }, [onRequestJobsTab, onClose]);

  const handleOpen = useCallback(() => {
    void actions.runJob(slug);
  }, [actions, slug]);

  const handleToggle = useCallback(() => {
    void actions.toggleJob(slug);
    core.reload();
  }, [actions, core, slug]);

  const handleDelete = useCallback(() => {
    void actions.deleteJob(slug);
    core.reload();
    onClose();
  }, [actions, core, slug, onClose]);

  const handleStopping = useCallback(() => {
    core.requestFastPoll(`job:${slug}`);
  }, [core, slug]);

  if (!job) {
    return (
      <div className="mindmap-modal-meta">
        <div className="row"><span className="k">Group</span><span className="v">{item.group}</span></div>
        <div className="row"><span className="k">State</span><span className="v">{item.state}</span></div>
        <p className="hint">Job not loaded yet.</p>
        <div className="mindmap-popup-actions">
          <button className="btn btn-sm" onClick={goToJobsTab}>Open in Jobs</button>
          <button className="btn btn-sm" onClick={onClose}>Close</button>
        </div>
      </div>
    );
  }

  return (
    <DesktopJobDetail
      transport={transport}
      job={job}
      status={status}
      firstQuery={matchedProcess?.first_query ?? undefined}
      lastQuery={matchedProcess?.last_query ?? undefined}
      tokenCount={matchedProcess?.token_count}
      onBack={onClose}
      onEdit={goToJobsTab}
      onOpen={handleOpen}
      onToggle={handleToggle}
      onDuplicate={goToJobsTab}
      onDuplicateToFolder={goToJobsTab}
      onDelete={handleDelete}
      onStopping={handleStopping}
      groups={groups}
      showBackButton
      autoYesActive={autoYesActive}
      onToggleAutoYes={onToggleAutoYes}
      autoYesShortcut={autoYesShortcut}
      dragHandleProps={dragHandleProps}
      defaultAgentProvider={job.agent_provider ?? undefined}
      defaultAgentModel={job.agent_model ?? undefined}
    />
  );
}
