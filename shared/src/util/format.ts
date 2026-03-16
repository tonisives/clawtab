export function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

export function formatDuration(startIso: string, endIso?: string | null): string {
  if (!endIso) return "...";
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}m ${rem}s`;
}

export function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function shortenPath(path: string | null | undefined): string {
  if (!path) return "";
  return path.replace(/^\/Users\/[^/]+/, "~");
}

/**
 * Compact multi-schedule cron expressions that share the same day fields.
 * e.g. "0 18 * * 5,1,6,0,4,2,3 | 0 12 * * 5,1,6,0,4,2,3" -> "12:00, 18:00 * * 5,1,6,0,4,2,3"
 * Single cron or non-matching schedules are returned as-is.
 */
export function compactCron(cron: string): string {
  const parts = cron.split("|").map((s) => s.trim());
  if (parts.length <= 1) return cron;

  // Parse each part into [min, hour, dom, month, dow]
  const parsed = parts.map((p) => p.split(/\s+/));
  if (parsed.some((p) => p.length < 5)) return cron;

  // Group by day fields (dom + month + dow)
  const groups = new Map<string, { min: string; hour: string }[]>();
  for (const p of parsed) {
    const dayKey = p.slice(2).join(" ");
    const entry = { min: p[0], hour: p[1] };
    const existing = groups.get(dayKey);
    if (existing) existing.push(entry);
    else groups.set(dayKey, [entry]);
  }

  // If everything is one group, compact it
  if (groups.size === 1) {
    const [dayFields, times] = [...groups.entries()][0];
    const sorted = times
      .map((t) => ({ h: parseInt(t.hour, 10), m: parseInt(t.min, 10), raw: t }))
      .sort((a, b) => a.h - b.h || a.m - b.m);
    const timeStr = sorted
      .map((t) => `${String(t.h).padStart(2, "0")}:${String(t.m).padStart(2, "0")}`)
      .join(", ");
    return `${timeStr}  ${dayFields}`;
  }

  // Multiple different day groups - just return original
  return cron;
}

/** Abbreviate intermediate segments to first char: ~/w/t/clawtab */
export function compactPath(path: string | null | undefined): string {
  if (!path) return "";
  const short = path.replace(/^\/Users\/[^/]+/, "~");
  const parts = short.split("/");
  if (parts.length <= 2) return short;
  const last = parts[parts.length - 1];
  const compacted = parts.slice(0, -1).map((p) => (p === "~" ? "~" : p[0] || p));
  return [...compacted, last].join("/");
}
