import type { DetectedProcess } from "../types/process";

export function agentAlertProcesses(processes: DetectedProcess[]) {
  return processes.filter((process): process is DetectedProcess & { _agent_alert: string } => (
    Boolean(process._agent_alert?.trim())
  ));
}

export function sessionSizeAlertLabel(alert?: string | null): string | null {
  const size = alert?.match(/(?:^|\n)Codex session file is (\d+) MB\b/);
  return size ? `↑${size[1]} MB` : null;
}

export function agentAlertTitle(alert?: string | null): string {
  const size = sessionSizeAlertLabel(alert);
  return size ? `Alert ${size}` : "Alert";
}
