import type { JobStatus, RunRecord } from "../types/job";
import { colors } from "../theme/colors";

export function statusLabel(status: JobStatus): string {
  switch (status.state) {
    case "idle":
      return "Idle";
    case "running":
      return "Running";
    case "success":
      return "Success";
    case "failed":
      return `Failed (${status.exit_code})`;
    case "paused":
      return "Paused";
  }
}

export function statusColor(status: JobStatus): string {
  switch (status.state) {
    case "idle":
      return colors.statusIdle;
    case "running":
      return colors.statusRunning;
    case "success":
      return colors.statusSuccess;
    case "failed":
      return colors.statusFailed;
    case "paused":
      return colors.statusPaused;
  }
}

export function statusBg(status: JobStatus): string {
  switch (status.state) {
    case "idle":
      return "transparent";
    case "running":
      return colors.accentBg;
    case "success":
      return colors.successBg;
    case "failed":
      return colors.dangerBg;
    case "paused":
      return colors.warningBg;
  }
}

export function runStatusColor(run: RunRecord, currentState: string): string {
  if (run.exit_code == null) {
    if (run.finished_at || currentState !== "running") return colors.danger;
    return colors.statusRunning;
  }
  if (run.exit_code === 0) return colors.success;
  return colors.danger;
}

export function runStatusLabel(run: RunRecord, currentState: string): string {
  if (run.exit_code == null) {
    if (run.finished_at || currentState !== "running") return "interrupted";
    return "running";
  }
  if (run.exit_code === 0) return "ok";
  return `exit ${run.exit_code}`;
}

export type AvailableAction = "run" | "stop" | "pause" | "resume" | "restart";

export function availableActions(status: JobStatus): AvailableAction[] {
  switch (status.state) {
    case "idle":
      return ["run"];
    case "running":
      return ["pause", "stop"];
    case "success":
      return ["run"];
    case "failed":
      return ["restart"];
    case "paused":
      return ["resume", "stop"];
  }
}
