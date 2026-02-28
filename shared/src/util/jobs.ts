import type { RemoteJob } from "../types/job";
import type { ClaudeQuestion } from "../types/process";
import { colors } from "../theme/colors";

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

export function parseNumberedOptions(text: string): { number: string; label: string }[] {
  const lines = text.split("\n").slice(-20);
  const options: { number: string; label: string }[] = [];
  for (const line of lines) {
    const match = line.match(/^[\s>›»❯▸▶]*(\d+)\.\s+(.+)/);
    if (match) {
      options.push({ number: match[1], label: match[2].trim() });
    }
  }
  return options;
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

export function typeIcon(jobType: string): { letter: string; bg: string } {
  switch (jobType) {
    case "claude":
      return { letter: "C", bg: colors.accentBg };
    case "binary":
      return { letter: "B", bg: "rgba(152, 152, 157, 0.12)" };
    case "folder":
      return { letter: "F", bg: "rgba(152, 152, 157, 0.12)" };
    default:
      return { letter: "?", bg: "rgba(152, 152, 157, 0.12)" };
  }
}
