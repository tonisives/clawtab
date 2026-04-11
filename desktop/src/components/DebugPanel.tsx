import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

interface SpawnEventRow {
  id: number;
  ts_start_ms: number;
  duration_ms: number;
  program: string;
  args: string;
  callsite: string;
  exit_code: number | null;
  stderr_head: string;
  pid: number | null;
}

interface ProgramCount {
  program: string;
  count: number;
}

interface CallsiteStat {
  callsite: string;
  count: number;
  total_ms: number;
}

interface SpawnSummary {
  total: number;
  window_secs: number;
  calls_per_sec_1s: number;
  calls_per_sec_10s: number;
  top_programs: ProgramCount[];
  top_callsites_by_count: CallsiteStat[];
  top_callsites_by_duration: CallsiteStat[];
}

const MAX_EVENTS = 2000;
const TIMELINE_SECS = 60;
const POLL_MS = 1000;

const PROGRAM_COLORS: Record<string, string> = {
  tmux: "#4f46e5",
  ps: "#16a34a",
  osascript: "#ea580c",
  default: "#64748b",
};

function programColor(program: string): string {
  return PROGRAM_COLORS[program] ?? PROGRAM_COLORS.default;
}

function formatTs(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const sub = String(d.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${sub}`;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + "...";
}

export function DebugPanel() {
  const [summary, setSummary] = useState<SpawnSummary | null>(null);
  const [events, setEvents] = useState<SpawnEventRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const poll = useCallback(async () => {
    try {
      const [sum, rows] = await Promise.all([
        invoke<SpawnSummary>("debug_spawn_summary"),
        invoke<SpawnEventRow[]>("debug_spawn_list", {
          sinceMs: null,
          limit: MAX_EVENTS,
        }),
      ]);
      setSummary(sum);
      const sorted = [...rows].sort((a, b) => b.ts_start_ms - a.ts_start_ms).slice(0, MAX_EVENTS);
      setEvents(sorted);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      if (!alive) return;
      if (!paused && !document.hidden) {
        await poll();
      }
      if (!alive) return;
      timer = setTimeout(tick, POLL_MS);
    };
    void tick();
    return () => {
      alive = false;
      if (timer !== null) clearTimeout(timer);
    };
  }, [poll, paused]);

  useEffect(() => {
    const onVisibility = () => {
      if (!document.hidden) void poll();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [poll]);

  const handleClear = useCallback(async () => {
    try {
      await invoke("debug_spawn_clear");
      setEvents([]);
      await poll();
    } catch (e) {
      setError(String(e));
    }
  }, [poll]);

  const timelineBuckets = useMemo(() => {
    const now = Date.now();
    const start = now - TIMELINE_SECS * 1000;
    const buckets: Map<number, Map<string, number>> = new Map();
    for (let i = 0; i < TIMELINE_SECS; i++) {
      buckets.set(i, new Map());
    }
    for (const ev of events) {
      if (ev.ts_start_ms < start) continue;
      const idx = Math.min(
        TIMELINE_SECS - 1,
        Math.floor((ev.ts_start_ms - start) / 1000),
      );
      const bucket = buckets.get(idx);
      if (!bucket) continue;
      bucket.set(ev.program, (bucket.get(ev.program) ?? 0) + 1);
    }
    const maxCount = Array.from(buckets.values()).reduce((acc, b) => {
      const sum = Array.from(b.values()).reduce((a, v) => a + v, 0);
      return sum > acc ? sum : acc;
    }, 0);
    return { buckets, maxCount, start };
  }, [events]);

  const toggleExpanded = (id: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div
      style={{
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        fontSize: 12,
        color: "#0f172a",
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        background: "#f8fafc",
      }}
    >
      <header
        style={{
          padding: "10px 16px",
          borderBottom: "1px solid #e2e8f0",
          background: "#fff",
          display: "flex",
          alignItems: "center",
          gap: 12,
        }}
      >
        <h1 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>Spawn Debug</h1>
        <div style={{ flex: 1 }} />
        {error && (
          <span style={{ color: "#dc2626", fontSize: 11 }}>{error}</span>
        )}
        <button
          onClick={() => setPaused((p) => !p)}
          style={btnStyle}
        >
          {paused ? "Resume" : "Pause"}
        </button>
        <button onClick={handleClear} style={btnStyle}>
          Clear
        </button>
      </header>

      <div style={{ flex: 1, overflow: "auto", padding: 12, display: "flex", flexDirection: "column", gap: 12 }}>
        <SummaryCard summary={summary} />
        <TimelineCard buckets={timelineBuckets.buckets} maxCount={timelineBuckets.maxCount} />
        <EventTable events={events} expanded={expanded} onToggle={toggleExpanded} />
      </div>
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  fontSize: 11,
  padding: "4px 10px",
  borderRadius: 4,
  border: "1px solid #cbd5e1",
  background: "#fff",
  cursor: "pointer",
};

const cardStyle: React.CSSProperties = {
  background: "#fff",
  border: "1px solid #e2e8f0",
  borderRadius: 6,
  padding: 12,
};

function SummaryCard({ summary }: { summary: SpawnSummary | null }) {
  if (!summary) {
    return (
      <div style={cardStyle}>
        <div style={{ color: "#64748b" }}>Loading...</div>
      </div>
    );
  }
  return (
    <div style={cardStyle}>
      <div style={{ display: "flex", gap: 24, marginBottom: 12 }}>
        <Metric label={`Calls (${summary.window_secs}s)`} value={String(summary.total)} />
        <Metric label="Calls/s (1s)" value={summary.calls_per_sec_1s.toFixed(2)} />
        <Metric label="Calls/s (10s)" value={summary.calls_per_sec_10s.toFixed(2)} />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
        <div>
          <SectionTitle>Top programs</SectionTitle>
          {summary.top_programs.length === 0 ? (
            <Empty />
          ) : (
            summary.top_programs.map((p) => (
              <Row key={p.program}>
                <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: programColor(p.program), marginRight: 6 }} />
                <span style={{ flex: 1 }}>{p.program}</span>
                <span style={monoStyle}>{p.count}</span>
              </Row>
            ))
          )}
        </div>
        <div>
          <SectionTitle>Top callsites (count)</SectionTitle>
          {summary.top_callsites_by_count.length === 0 ? (
            <Empty />
          ) : (
            summary.top_callsites_by_count.map((c) => (
              <Row key={c.callsite}>
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={c.callsite}>
                  {c.callsite}
                </span>
                <span style={monoStyle}>{c.count}</span>
              </Row>
            ))
          )}
        </div>
        <div>
          <SectionTitle>Top callsites (total ms)</SectionTitle>
          {summary.top_callsites_by_duration.length === 0 ? (
            <Empty />
          ) : (
            summary.top_callsites_by_duration.map((c) => (
              <Row key={c.callsite}>
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={c.callsite}>
                  {c.callsite}
                </span>
                <span style={monoStyle}>{c.total_ms}ms</span>
              </Row>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ color: "#64748b", fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 600 }}>{value}</div>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 10, color: "#64748b", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>
      {children}
    </div>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", padding: "2px 0", fontSize: 11 }}>
      {children}
    </div>
  );
}

function Empty() {
  return <div style={{ color: "#94a3b8", fontSize: 11 }}>no data</div>;
}

const monoStyle: React.CSSProperties = {
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  color: "#475569",
};

function TimelineCard({
  buckets,
  maxCount,
}: {
  buckets: Map<number, Map<string, number>>;
  maxCount: number;
}) {
  const width = 800;
  const height = 100;
  const barWidth = width / TIMELINE_SECS;
  const padding = 2;

  const effectiveMax = Math.max(maxCount, 1);

  return (
    <div style={cardStyle}>
      <SectionTitle>Timeline (last {TIMELINE_SECS}s, stacked by program)</SectionTitle>
      <svg viewBox={`0 0 ${width} ${height}`} style={{ width: "100%", height: 100, display: "block" }}>
        {Array.from(buckets.entries()).map(([idx, progs]) => {
          let yCursor = height;
          const programs = Array.from(progs.entries()).sort((a, b) => a[0].localeCompare(b[0]));
          return (
            <g key={idx}>
              {programs.map(([prog, count]) => {
                const h = (count / effectiveMax) * (height - 4);
                yCursor -= h;
                return (
                  <rect
                    key={prog}
                    x={idx * barWidth + padding}
                    y={yCursor}
                    width={barWidth - padding * 2}
                    height={h}
                    fill={programColor(prog)}
                  >
                    <title>
                      {`t-${TIMELINE_SECS - idx}s ${prog}: ${count}`}
                    </title>
                  </rect>
                );
              })}
            </g>
          );
        })}
        <line x1={0} y1={height - 0.5} x2={width} y2={height - 0.5} stroke="#cbd5e1" strokeWidth={0.5} />
      </svg>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#94a3b8", marginTop: 2 }}>
        <span>-{TIMELINE_SECS}s</span>
        <span>peak/s: {maxCount}</span>
        <span>now</span>
      </div>
    </div>
  );
}

function EventTable({
  events,
  expanded,
  onToggle,
}: {
  events: SpawnEventRow[];
  expanded: Set<number>;
  onToggle: (id: number) => void;
}) {
  return (
    <div style={{ ...cardStyle, padding: 0, flex: 1, minHeight: 200 }}>
      <div style={{ padding: "10px 12px", borderBottom: "1px solid #e2e8f0" }}>
        <SectionTitle>Events ({events.length})</SectionTitle>
      </div>
      <div style={{ maxHeight: 500, overflow: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
          <thead style={{ background: "#f1f5f9", position: "sticky", top: 0 }}>
            <tr>
              <Th width={100}>time</Th>
              <Th width={60}>program</Th>
              <Th>args</Th>
              <Th width={70}>dur</Th>
              <Th width={220}>callsite</Th>
              <Th width={40}>exit</Th>
            </tr>
          </thead>
          <tbody>
            {events.length === 0 && (
              <tr>
                <td colSpan={6} style={{ padding: 12, color: "#94a3b8", textAlign: "center" }}>
                  no events yet
                </td>
              </tr>
            )}
            {events.map((ev) => {
              const isOpen = expanded.has(ev.id);
              const isError = ev.exit_code !== null && ev.exit_code !== 0;
              return (
                <Fragment key={ev.id}>
                  <tr
                    onClick={() => onToggle(ev.id)}
                    style={{
                      cursor: "pointer",
                      background: isError ? "#fef2f2" : undefined,
                      borderBottom: "1px solid #f1f5f9",
                    }}
                  >
                    <Td mono>{formatTs(ev.ts_start_ms)}</Td>
                    <Td>
                      <span
                        style={{
                          display: "inline-block",
                          width: 6,
                          height: 6,
                          borderRadius: 3,
                          background: programColor(ev.program),
                          marginRight: 5,
                        }}
                      />
                      {ev.program}
                    </Td>
                    <Td mono truncate>
                      {truncate(ev.args, 80)}
                    </Td>
                    <Td mono align="right">{ev.duration_ms}ms</Td>
                    <Td truncate title={ev.callsite}>{ev.callsite}</Td>
                    <Td mono align="right" color={isError ? "#dc2626" : undefined}>
                      {ev.exit_code ?? "-"}
                    </Td>
                  </tr>
                  {isOpen && (
                    <tr style={{ background: "#f8fafc" }}>
                      <td colSpan={6} style={{ padding: "8px 12px" }}>
                        <DetailRow label="args">{ev.args}</DetailRow>
                        <DetailRow label="callsite">{ev.callsite}</DetailRow>
                        <DetailRow label="pid">{ev.pid ?? "-"}</DetailRow>
                        {ev.stderr_head && <DetailRow label="stderr">{ev.stderr_head}</DetailRow>}
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Th({ children, width }: { children: React.ReactNode; width?: number }) {
  return (
    <th
      style={{
        textAlign: "left",
        padding: "6px 10px",
        fontSize: 10,
        color: "#64748b",
        fontWeight: 600,
        textTransform: "uppercase",
        letterSpacing: 0.5,
        width,
        borderBottom: "1px solid #e2e8f0",
      }}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  mono,
  truncate: shouldTruncate,
  align,
  color,
  title,
}: {
  children: React.ReactNode;
  mono?: boolean;
  truncate?: boolean;
  align?: "left" | "right";
  color?: string;
  title?: string;
}) {
  return (
    <td
      title={title}
      style={{
        padding: "4px 10px",
        fontFamily: mono ? "ui-monospace, SFMono-Regular, Menlo, monospace" : undefined,
        textAlign: align,
        color,
        maxWidth: shouldTruncate ? 300 : undefined,
        overflow: shouldTruncate ? "hidden" : undefined,
        textOverflow: shouldTruncate ? "ellipsis" : undefined,
        whiteSpace: shouldTruncate ? "nowrap" : undefined,
      }}
    >
      {children}
    </td>
  );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", gap: 8, padding: "2px 0", fontSize: 11 }}>
      <span style={{ color: "#64748b", minWidth: 70 }}>{label}</span>
      <span
        style={{
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          wordBreak: "break-all",
          flex: 1,
        }}
      >
        {children}
      </span>
    </div>
  );
}
