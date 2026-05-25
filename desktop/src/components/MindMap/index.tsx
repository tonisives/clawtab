import { useEffect, useMemo, useState } from "react";
import { processDisplayTitle, useJobsCore, useJobActions, shortenPath, type ClaudeQuestion, type DetectedProcess, type JobStatus, type RemoteJob } from "@clawtab/shared";
import { createTauriTransport } from "../../transport/tauriTransport";
import { useQuestionPolling } from "../../hooks/useQuestionPolling";
import { useAutoYes } from "../../hooks/useAutoYes";
import { useFolderRunGroups } from "../JobsTab/hooks/useFolderRunGroups";
import { MindMapCanvas } from "./MindMapCanvas";
import type { MindItem } from "./useRecencyLayout";
import type { Job } from "../../types";
import "./MindMap.css";

const WORKING_WINDOW_MS = 12000;

interface MindMapPanelProps {
  onRequestJobsTab: () => void;
}

type MindMapKind = "agents" | "jobs";

function parseTs(value: string | null | undefined): number {
  if (!value) return 0;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : 0;
}

function buildAgentItems(processes: DetectedProcess[], questions: ClaudeQuestion[], now: number): MindItem[] {
  const askingByPane = new Set(questions.map((q) => q.pane_id));
  return processes
    .filter((p) => p.provider !== "shell" || !!p.matched_group)
    .map((p) => {
      const sessionTs = parseTs(p.session_started_at);
      const lastLog = p._last_log_change ?? 0;
      const score = Math.max(lastLog, sessionTs);
      const group = p.matched_group || "ungrouped";
      const label = processDisplayTitle(p);
      const sublabel = p.cwd ? shortenPath(p.cwd) : undefined;
      const running = p._transient_state !== "stopping";
      const asking = askingByPane.has(p.pane_id);
      const working = !asking && running && lastLog > 0 && now - lastLog < WORKING_WINDOW_MS;
      return {
        id: `proc:${p.pane_id}`,
        label,
        sublabel,
        group,
        score,
        running,
        state: running ? "running" : "idle",
        asking,
        working,
        provider: p.provider,
        process: p,
        paneId: p.pane_id,
      } satisfies MindItem;
    });
}

function buildJobItems(
  jobs: RemoteJob[],
  statuses: Record<string, JobStatus>,
  processes: DetectedProcess[],
  questions: ClaudeQuestion[],
  now: number,
): MindItem[] {
  const askingByPane = new Set(questions.map((q) => q.pane_id));
  const processByPaneId = new Map<string, DetectedProcess>();
  for (const p of processes) processByPaneId.set(p.pane_id, p);

  return jobs
    .filter((j) => j.job_type !== "claude")
    .map((job) => {
      const status: JobStatus = statuses[job.slug] ?? { state: "idle" };
      const addedAt = parseTs(job.added_at);
      let score = addedAt;
      let process: DetectedProcess | undefined;
      let paneId: string | undefined;
      let running = false;

      if (status.state === "running") {
        running = true;
        paneId = status.pane_id;
        process = paneId ? processByPaneId.get(paneId) : undefined;
        score = Math.max(process?._last_log_change ?? 0, parseTs(status.started_at), addedAt);
      } else if (status.state === "success" || status.state === "failed") {
        score = Math.max(parseTs(status.last_run), addedAt);
      }

      const lastLog = process?._last_log_change ?? 0;
      const asking = paneId ? askingByPane.has(paneId) : false;
      const working = !asking && running && lastLog > 0 && now - lastLog < WORKING_WINDOW_MS;
      return {
        id: `job:${job.slug}`,
        label: job.name,
        sublabel: job.work_dir ? shortenPath(job.work_dir) : undefined,
        group: job.group || "default",
        score,
        running,
        state: status.state,
        asking,
        working,
        provider: process?.provider ?? job.agent_provider ?? null,
        job,
        status,
        process,
        paneId,
      } satisfies MindItem;
    });
}

export function MindMapPanel({ onRequestJobsTab }: MindMapPanelProps) {
  const transport = useMemo(() => createTauriTransport(), []);
  const core = useJobsCore(transport, 10000);
  const actions = useJobActions(transport, core.reloadStatuses);
  const { questions, startFastQuestionPoll, dismissQuestion } = useQuestionPolling();
  const autoYes = useAutoYes(questions, core.processes, core.jobs as Job[], startFastQuestionPoll);
  const folderRunGroups = useFolderRunGroups(core);
  const [kind, setKind] = useState<MindMapKind>("agents");
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const items = useMemo<MindItem[]>(() => {
    if (kind === "agents") return buildAgentItems(core.processes, questions, now);
    return buildJobItems(core.jobs, core.statuses, core.processes, questions, now);
  }, [kind, core.jobs, core.statuses, core.processes, questions, now]);

  const floatingToggle = (
    <div className="mindmap-floating-toggle mindmap-pill-toggle" role="tablist" aria-label="Mind Map mode">
      <button
        role="tab"
        aria-selected={kind === "agents"}
        className={kind === "agents" ? "active" : ""}
        onClick={() => setKind("agents")}
      >
        Agents
      </button>
      <button
        role="tab"
        aria-selected={kind === "jobs"}
        className={kind === "jobs" ? "active" : ""}
        onClick={() => setKind("jobs")}
      >
        Jobs
      </button>
    </div>
  );

  if (!core.loaded && core.jobs.length === 0 && core.processes.length === 0) {
    return (
      <div className="mindmap-root">
        {floatingToggle}
        <div className="mindmap-empty">Loading...</div>
      </div>
    );
  }

  if (items.length === 0) {
    const label = kind === "agents" ? "agents" : "jobs";
    return (
      <div className="mindmap-root">
        {floatingToggle}
        <div className="mindmap-empty">No {label} yet.</div>
      </div>
    );
  }

  return (
    <div className="mindmap-root">
      {floatingToggle}
      <MindMapCanvas
        kind={kind}
        items={items}
        questions={questions}
        autoYes={autoYes}
        transport={transport}
        core={core}
        actions={actions}
        folderGroups={folderRunGroups}
        onDismissQuestion={dismissQuestion}
        onRequestJobsTab={onRequestJobsTab}
      />
    </div>
  );
}
