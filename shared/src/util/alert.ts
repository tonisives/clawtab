import type { DetectedProcess } from "../types/process";

export function agentSetupAlert(process: Pick<DetectedProcess, "provider" | "log_lines">): string | undefined {
  const screen = process.log_lines.toLowerCase();
  if (process.provider === "codex" && screen.includes("welcome to codex")
    && screen.includes("sign in with chatgpt") && screen.includes("sign in with device code")
    && !/(?:^|\n)\s*[›❯]/.test(screen)) return "Sign in to Codex to start this agent. Open ClawTab machine settings and choose Sign in to Codex.";
}

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
