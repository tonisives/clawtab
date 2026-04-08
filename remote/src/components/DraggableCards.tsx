import { useDraggable } from "@dnd-kit/core"
import type { RemoteJob, JobStatus } from "@clawtab/shared"
import type { ClaudeProcess } from "@clawtab/shared"
import { JobCard, RunningJobCard, ProcessCard } from "@clawtab/shared"

export type DragData =
  | { kind: "job"; slug: string; job: RemoteJob }
  | { kind: "process"; paneId: string; process: ClaudeProcess }

// Use plain div since @dnd-kit spreads DOM-specific attributes that
// conflict with React Native View types. Web wide-mode only.

export function DraggableJobCard({
  job,
  status,
  onPress,
  selected,
}: {
  job: RemoteJob
  status: JobStatus
  onPress?: () => void
  selected?: boolean | string
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `drag-job-${job.slug}`,
    data: { kind: "job", slug: job.slug, job } satisfies DragData,
  })

  return (
    <div
      ref={setNodeRef}
      style={{ opacity: isDragging ? 0.4 : 1, cursor: "grab", touchAction: "none" }}
      {...listeners}
      {...attributes}
    >
      {status.state === "running" ? (
        <RunningJobCard job={job} status={status} onPress={onPress} selected={selected} />
      ) : (
        <JobCard job={job} status={status} onPress={onPress} selected={selected} />
      )}
    </div>
  )
}

export function DraggableProcessCard({
  process,
  onPress,
  inGroup,
  selected,
}: {
  process: ClaudeProcess
  onPress?: () => void
  inGroup?: boolean
  selected?: boolean | string
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `drag-process-${process.pane_id}`,
    data: { kind: "process", paneId: process.pane_id, process } satisfies DragData,
  })

  return (
    <div
      ref={setNodeRef}
      style={{ opacity: isDragging ? 0.4 : 1, cursor: "grab", touchAction: "none" }}
      {...listeners}
      {...attributes}
    >
      <ProcessCard process={process} onPress={onPress} inGroup={inGroup} selected={selected} />
    </div>
  )
}
