import { useMemo } from "react";
import { describeCron } from "@clawtab/shared";

export { describeCron };

interface Props {
  value: string;
  onChange: (value: string) => void;
}

const CRON_PRESETS: { label: string; value: string }[] = [
  { label: "Every minute", value: "* * * * *" },
  { label: "Every 5 minutes", value: "*/5 * * * *" },
  { label: "Every 15 minutes", value: "*/15 * * * *" },
  { label: "Every hour", value: "0 * * * *" },
  { label: "Every 6 hours", value: "0 */6 * * *" },
  { label: "Daily at midnight", value: "0 0 * * *" },
  { label: "Daily at 9am", value: "0 9 * * *" },
  { label: "Weekly (Mon 9am)", value: "0 9 * * 1" },
];

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
