import { useDraggable } from "@dnd-kit/core";
import type { RemoteJob, JobStatus } from "@clawtab/shared";
import type { ClaudeProcess, ClaudeQuestion } from "@clawtab/shared";
import { JobCard, RunningJobCard, ProcessCard } from "@clawtab/shared";

export type DragData =
  | { kind: "job"; slug: string; job: RemoteJob }
  | { kind: "process"; paneId: string; process?: ClaudeProcess; question?: ClaudeQuestion; resolvedJob?: string | null };

export function DraggableJobCard({
  job,
  status,
  onPress,
  selected,
  onStop,
  autoYesActive,
  stopping,
}: {
  job: RemoteJob;
  status: JobStatus;
  onPress?: () => void;
  selected?: boolean | string;
  onStop?: () => void;
  autoYesActive?: boolean;
  stopping?: boolean;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `drag-job-${job.slug}`,
    data: { kind: "job", slug: job.slug, job } satisfies DragData,
  });

  // Do NOT apply transform here - DragOverlay handles the floating preview.
  // This prevents the source element from moving and causing scroll jumps.
  return (
    <div
      ref={setNodeRef}
      style={{ opacity: isDragging ? 0.4 : 1, cursor: "grab", touchAction: "none" }}
      {...listeners}
      {...attributes}
    >
      {status.state === "running" ? (
        <RunningJobCard
          job={job}
          status={status}
          onPress={onPress}
          selected={selected}
          onStop={onStop}
          autoYesActive={autoYesActive}
          stopping={stopping}
        />
      ) : (
        <JobCard
          job={job}
          status={status}
          onPress={onPress}
          selected={selected}
        />
      )}
    </div>
  );
}

export function DraggableProcessCard({
  process,
  onPress,
  inGroup,
  selected,
  onStop,
  onRename,
  autoYesActive,
}: {
  process: ClaudeProcess;
  onPress?: () => void;
  inGroup?: boolean;
  selected?: boolean | string;
  onStop?: () => void;
  onRename?: () => void;
  autoYesActive?: boolean;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `drag-process-${process.pane_id}`,
    data: { kind: "process", paneId: process.pane_id, process } satisfies DragData,
  });

  return (
    <div
      ref={setNodeRef}
      style={{ opacity: isDragging ? 0.4 : 1, cursor: "grab", touchAction: "none" }}
      {...listeners}
      {...attributes}
    >
      <ProcessCard
        process={process}
        onPress={onPress}
        inGroup={inGroup}
        selected={selected}
        onStop={onStop}
        onRename={onRename}
        autoYesActive={autoYesActive}
      />
    </div>
  );
}

export function DraggableNotificationCard({
  question,
  resolvedJob,
  children,
}: {
  question: ClaudeQuestion;
  resolvedJob: string | null;
  children: React.ReactNode;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `drag-question-${question.question_id}`,
    data: {
      kind: "process",
      paneId: question.pane_id,
      question,
      resolvedJob,
    } satisfies DragData,
  });

  return (
    <div
      ref={setNodeRef}
      style={{ opacity: isDragging ? 0.4 : 1, cursor: "grab", touchAction: "none" }}
      {...listeners}
      {...attributes}
    >
      {children}
    </div>
  );
}
