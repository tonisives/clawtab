/**
 * Compute the next fire time for a 5-field cron expression.
 * Supports: *, N, N/step, N-M, comma-separated lists.
 * Pipe-separated multi-crons return the earliest next fire.
 */

function parseField(field: string, min: number, max: number): number[] {
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const stepMatch = part.match(/^(.+)\/(\d+)$/);
    if (stepMatch) {
      const step = parseInt(stepMatch[2], 10);
      const base = stepMatch[1] === "*" ? min : parseInt(stepMatch[1], 10);
      for (let i = base; i <= max; i += step) values.add(i);
    } else if (part === "*") {
      for (let i = min; i <= max; i++) values.add(i);
    } else if (part.includes("-")) {
      const [a, b] = part.split("-").map(Number);
      for (let i = a; i <= b; i++) values.add(i);
    } else {
      values.add(parseInt(part, 10));
    }
  }
  return [...values].sort((a, b) => a - b);
}

function nextForSingle(expr: string, after: Date): Date | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;

  const minutes = parseField(parts[0], 0, 59);
  const hours = parseField(parts[1], 0, 23);
  const doms = parseField(parts[2], 1, 31);
  const months = parseField(parts[3], 1, 12);
  const dows = parseField(parts[4], 0, 6);

  const hasDom = parts[2] !== "*";
  const hasDow = parts[4] !== "*";

  // Start one minute after `after`
  const d = new Date(after);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);

  // Brute-force search - max ~2 years of minutes (but we jump smartly)
  for (let i = 0; i < 366 * 24 * 60; i++) {
    const mo = d.getMonth() + 1;
    if (!months.includes(mo)) {
      // Skip to first valid month
      d.setMonth(d.getMonth() + 1, 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }

    const dom = d.getDate();
    const dow = d.getDay();
    const domMatch = !hasDom || doms.includes(dom);
    const dowMatch = !hasDow || dows.includes(dow);
    // Standard cron: if both dom and dow are specified, match if EITHER matches
    const dayMatch = hasDom && hasDow ? domMatch || dowMatch : domMatch && dowMatch;

    if (!dayMatch) {
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }

    const h = d.getHours();
    if (!hours.includes(h)) {
      d.setHours(d.getHours() + 1, 0, 0, 0);
      continue;
    }

    const m = d.getMinutes();
    if (!minutes.includes(m)) {
      d.setMinutes(d.getMinutes() + 1, 0, 0);
      continue;
    }

    return new Date(d);
  }
  return null;
}

export function nextCronDate(cron: string, after: Date = new Date()): Date | null {
  const exprs = cron.split("|").map((s) => s.trim()).filter(Boolean);
  let earliest: Date | null = null;
  for (const expr of exprs) {
    const next = nextForSingle(expr, after);
    if (next && (!earliest || next < earliest)) earliest = next;
  }
  return earliest;
}

/**
 * Format the next cron run in a human-friendly way:
 * - "today 1:00pm"
 * - "tomorrow 9:00am"
 * - "Wed 3:30pm"
 * - "Mar 15 9:00am"
 */
export function formatNextRun(date: Date): string {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diffDays = Math.round((target.getTime() - today.getTime()) / 86400000);

  const timeStr = date.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).toLowerCase();

  if (diffDays === 0) return `today ${timeStr}`;
  if (diffDays === 1) return `tomorrow ${timeStr}`;
  if (diffDays < 7) {
    const day = date.toLocaleDateString(undefined, { weekday: "short" });
    return `${day} ${timeStr}`;
  }
  const monthDay = date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `${monthDay} ${timeStr}`;
}

function describeSingleCron(expr: string): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return "Invalid cron expression";

  const [min, hour, dom, mon, dow] = parts;

  if (min === "*" && hour === "*") return "Every minute";
  if (min.startsWith("*/") && hour === "*") return `Every ${min.slice(2)} minutes`;
  if (hour.startsWith("*/") && min === "0") return `Every ${hour.slice(2)} hours`;
  if (min === "0" && hour === "*") return "Every hour";
  if (dom === "*" && mon === "*" && dow === "*") {
    if (hour !== "*" && min !== "*") return `Daily at ${hour.padStart(2, "0")}:${min.padStart(2, "0")}`;
  }
  if (dow !== "*" && dom === "*" && mon === "*") {
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const dayNums = dow.split(",");
    const dayNames = dayNums.map((d) => days[parseInt(d)] ?? d);
    const dayStr = dayNames.length === 7 ? "Daily" : dayNames.join(", ");
    if (hour !== "*" && min !== "*") return `${dayStr} at ${hour.padStart(2, "0")}:${min.padStart(2, "0")}`;
  }

  return expr;
}

export function describeCron(expr: string): string {
  const cronParts = expr.split("|").map((s) => s.trim()).filter(Boolean);
  if (cronParts.length <= 1) return describeSingleCron(expr);

  const parsed = cronParts.map((c) => {
    const p = c.trim().split(/\s+/);
    if (p.length !== 5) return null;
    return { min: p[0], hour: p[1], dow: p[4] };
  });
  if (parsed.every((p) => p !== null) && parsed.every((p) => p!.dow === parsed[0]!.dow)) {
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const dow = parsed[0]!.dow;
    const dayNums = dow === "*" ? [] : dow.split(",");
    const dayStr = dow === "*" ? "Daily" : dayNums.map((d) => days[parseInt(d)] ?? d).join(", ");
    const times = parsed.map((p) => `${p!.hour.padStart(2, "0")}:${p!.min.padStart(2, "0")}`);
    return `${dayStr} at ${times.join(", ")}`;
  }

  return cronParts.map(describeSingleCron).join("; ");
}

/** Full human-readable description for tooltip: description + next run time */
export function cronTooltip(cron: string): string {
  const desc = describeCron(cron);
  const next = nextCronDate(cron);
  const nextStr = next ? formatNextRun(next) : "unknown";
  return `${desc}\nNext: ${nextStr}`;
}
