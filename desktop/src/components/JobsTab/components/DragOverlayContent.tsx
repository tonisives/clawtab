import type { JobStatus } from "@clawtab/shared";
import {
  JobCard,
  RunningJobCard,
  ProcessCard,
  NotificationCard,
} from "@clawtab/shared";
import { DraggableShellCard } from "../../DraggableCards";
import type { DragData } from "../../DraggableCards";

interface DragOverlayContentProps {
  dragOverlayData: DragData | null;
  statuses: Record<string, JobStatus>;
  autoYesPaneIds: Set<string>;
}

export function DragOverlayContent({ dragOverlayData, statuses, autoYesPaneIds }: DragOverlayContentProps) {
  const data = dragOverlayData;
  if (!data) return null;
  const notificationData = data.kind === "process" ? data : null;
  const processData = data.kind === "process" && data.process ? data : null;
  const shellData = data.kind === "terminal" ? data : null;
  return (
    <div style={{ opacity: 0.8, pointerEvents: "none", width: 300 }}>
      {data.kind === "job" ? (
        data.job ? (() => {
          const status = statuses[data.slug] ?? { state: "idle" as const };
          return status.state === "running"
            ? <RunningJobCard job={data.job} status={status} />
            : <JobCard job={data.job} status={status} />;
        })() : (
          <div style={{ padding: 16, borderRadius: 10, background: "var(--bg-primary)", border: "1px solid var(--border-light)" }}>
            {data.slug}
          </div>
        )
      ) : notificationData?.question ? (
        <NotificationCard
          question={notificationData.question}
          resolvedJob={notificationData.resolvedJob ?? null}
          onNavigate={() => {}}
          onSendOption={() => {}}
          autoYesActive={autoYesPaneIds.has(notificationData.paneId)}
        />
      ) : processData?.process ? (
        <ProcessCard process={processData.process} />
      ) : shellData?.shell ? (
        <div style={{ pointerEvents: "none" }}>
          <DraggableShellCard shell={shellData.shell} />
        </div>
      ) : shellData ? (
        <div style={{ padding: 16, borderRadius: 10, background: "var(--bg-primary)", border: "1px solid var(--border-light)" }}>
          Shell {shellData.paneId}
        </div>
      ) : data.kind === "agent" ? (
        <div style={{ padding: 16, borderRadius: 10, background: "var(--bg-primary)", border: "1px solid var(--border-light)" }}>
          Agent
        </div>
      ) : null}
    </div>
  );
}
