import { useMemo } from "react";

interface Props {
  value: string;
  onChange: (value: string) => void;
}

export const CRON_PRESETS: { label: string; value: string }[] = [
  { label: "Every minute", value: "* * * * *" },
  { label: "Every 5 minutes", value: "*/5 * * * *" },
  { label: "Every 15 minutes", value: "*/15 * * * *" },
  { label: "Every hour", value: "0 * * * *" },
  { label: "Every 6 hours", value: "0 */6 * * *" },
  { label: "Daily at midnight", value: "0 0 * * *" },
  { label: "Daily at 9am", value: "0 9 * * *" },
  { label: "Weekly (Mon 9am)", value: "0 9 * * 1" },
];

export function describeCron(expr: string): string {
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
    const day = days[parseInt(dow)] ?? dow;
    if (hour !== "*" && min !== "*") return `${day} at ${hour.padStart(2, "0")}:${min.padStart(2, "0")}`;
  }

  return expr;
}

export function CronInput({ value, onChange }: Props) {
  const description = useMemo(() => describeCron(value), [value]);
  const isPreset = CRON_PRESETS.some((p) => p.value === value);

  return (
    <div className="form-group">
      <label>Schedule (cron)</label>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="0 * * * *"
          style={{ maxWidth: 200, fontFamily: "monospace" }}
        />
        <select
          value={isPreset ? value : ""}
          onChange={(e) => {
            if (e.target.value) onChange(e.target.value);
          }}
          style={{ maxWidth: 200 }}
        >
          <option value="">Presets...</option>
          {CRON_PRESETS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
      </div>
      <span className="hint">{description}</span>
    </div>
  );
}
