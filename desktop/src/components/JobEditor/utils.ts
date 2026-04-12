import type { ProcessProvider } from "@clawtab/shared";
import { DAYS, CRON_DAY_MAP, DAY_CRON_MAP, JOB_NAME_MAX_LENGTH } from "./types";

export const IMAGE_RE = /\.(png|jpe?g|gif|webp|svg|bmp|tiff?)$/i;

export function slugifyName(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, JOB_NAME_MAX_LENGTH);
}

export function labelForProvider(provider: ProcessProvider): string {
  switch (provider) {
    case "claude":
      return "Claude Code";
    case "codex":
      return "Codex";
    case "opencode":
      return "OpenCode";
    case "shell":
      return "Shell";
  }
}

function parseSingleCronToWeekly(cron: string): { days: string[]; time: string } | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [min, hour, dom, mon, dow] = parts;
  if (dom !== "*" || mon !== "*") return null;
  if (hour === "*" || min === "*") return null;
  const h = parseInt(hour, 10);
  const m = parseInt(min, 10);
  if (isNaN(h) || isNaN(m)) return null;
  const time = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  if (dow === "*") {
    return { days: [...DAYS], time };
  }
  const dayNums = dow.split(",");
  const dayNames = dayNums.map((d) => CRON_DAY_MAP[d.trim()]).filter(Boolean);
  if (dayNames.length === 0) return null;
  return { days: dayNames, time };
}

export function parseCronToWeekly(cron: string): { days: string[]; times: string[] } | null {
  const cronParts = cron.split("|").map((s) => s.trim()).filter(Boolean);
  if (cronParts.length === 0) return null;
  const parsed = cronParts.map(parseSingleCronToWeekly);
  if (parsed.some((p) => p === null)) return null;
  const valid = parsed as { days: string[]; time: string }[];
  const firstDays = valid[0].days.sort().join(",");
  if (!valid.every((p) => p.days.sort().join(",") === firstDays)) return null;
  return {
    days: valid[0].days,
    times: valid.map((p) => p.time),
  };
}

export function buildWeeklyCron(days: string[], times: string[]): string {
  if (days.length === 0 || times.length === 0) return "0 0 * * *";
  const dowList = days.map((d) => DAY_CRON_MAP[d]).join(",");
  const crons = times.map((time) => {
    const [h, m] = time.split(":").map(Number);
    return `${m ?? 0} ${h ?? 0} * * ${dowList}`;
  });
  return crons.join(" | ");
}
