import type { RemoteJob } from "../types/job";
import type { ClaudeQuestion } from "../types/process";
import { colors } from "../theme/colors";
import { kindForJob, type JobKind } from "../components/JobKindIcon";

export function groupJobs<T extends RemoteJob>(jobs: T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const job of jobs) {
    const group = job.group || "default";
    const list = groups.get(group) ?? [];
    list.push(job);
    groups.set(group, list);
  }
  return groups;
}

export function sortGroupNames(groups: string[], savedOrder: string[]): string[] {
  const orderMap = new Map(savedOrder.map((g, i) => [g, i]));
  return [...groups].sort((a, b) => {
    const aIdx = orderMap.get(a);
    const bIdx = orderMap.get(b);
    if (aIdx !== undefined && bIdx !== undefined) return aIdx - bIdx;
    if (aIdx !== undefined) return -1;
    if (bIdx !== undefined) return 1;
    if (a === "agent") return -1;
    if (b === "agent") return 1;
    if (a === "default") return -1;
    if (b === "default") return 1;
    return a.localeCompare(b);
  });
}

/** Find the best "yes" option: prefer "Yes, during this session" over plain "Yes" */
export function findYesOption(q: ClaudeQuestion): string | null {
  const sessionOpt = q.options.find((o) =>
    /yes.*session/i.test(o.label),
  );
  if (sessionOpt) return sessionOpt.number;
  const yesOpt = q.options.find((o) => /^yes/i.test(o.label));
  if (yesOpt) return yesOpt.number;
  return null;
}

/** Check if an option label is a "Type something" freetext option */
export function isFreetextOption(label: string): boolean {
  return /^type something/i.test(label.trim());
}

export function typeIcon(jobType: string): { kind: JobKind; bg: string } {
  const kind = kindForJob({ job_type: jobType, cron: "", enabled: true, group: "", name: "", slug: "" });
  switch (kind) {
    case "claude":
      return { kind, bg: colors.accentBg };
    case "cron":
      return { kind, bg: "rgba(255, 159, 10, 0.16)" };
    case "manual":
      return { kind, bg: "rgba(10, 132, 255, 0.14)" };
    case "shell":
      return { kind, bg: colors.successBg ?? "rgba(52, 199, 89, 0.14)" };
    default:
      return { kind, bg: "rgba(152, 152, 157, 0.12)" };
  }
}
