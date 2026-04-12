import type { Job } from "../../../types";
import { CronInput, describeCron } from "../../CronInput";
import { DAYS } from "../types";
import { buildWeeklyCron } from "../utils";

interface ScheduleFieldsProps {
  form: Job;
  setForm: React.Dispatch<React.SetStateAction<Job>>;
  manualOnly: boolean;
  setManualOnly: (v: boolean) => void;
  useWeekly: boolean;
  setUseWeekly: (v: boolean) => void;
  weeklyDays: string[];
  weeklyTimes: string[];
  hasParams: boolean;
  toggleWeeklyDay: (day: string) => void;
  setWeeklyTimeAtIndex: (index: number, time: string) => void;
  addWeeklyTime: () => void;
  removeWeeklyTime: (index: number) => void;
}

export function ScheduleFields({
  form, setForm, manualOnly, setManualOnly, useWeekly, setUseWeekly,
  weeklyDays, weeklyTimes, hasParams, toggleWeeklyDay,
  setWeeklyTimeAtIndex, addWeeklyTime, removeWeeklyTime,
}: ScheduleFieldsProps) {
  return (
    <div className="form-group">
      {hasParams && (
        <span className="hint" style={{ marginBottom: 8, display: "block" }}>
          Schedule is disabled because this job has parameters (manual-only).
        </span>
      )}
      <div style={{ marginBottom: 12, opacity: hasParams ? 0.5 : 1, pointerEvents: hasParams ? "none" : "auto" }}>
        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", marginBottom: 8 }}>
          <input
            type="checkbox"
            checked={manualOnly}
            disabled={hasParams}
            onChange={(e) => {
              setManualOnly(e.target.checked);
              if (e.target.checked) {
                setForm((prev) => ({ ...prev, cron: "" }));
              } else {
                if (useWeekly) {
                  setForm((prev) => ({ ...prev, cron: buildWeeklyCron(weeklyDays, weeklyTimes) }));
                } else {
                  setForm((prev) => ({ ...prev, cron: "0 0 * * *" }));
                }
              }
            }}
          />
          Manual only (no automatic schedule)
        </label>
      </div>

      {!manualOnly && (
        <>
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <input
                type="radio"
                name="schedule-mode"
                checked={useWeekly}
                onChange={() => {
                  setUseWeekly(true);
                  setForm((prev) => ({ ...prev, cron: buildWeeklyCron(weeklyDays, weeklyTimes) }));
                }}
              />
              Daily schedule
            </label>
            <div style={{ opacity: useWeekly ? 1 : 0.4, pointerEvents: useWeekly ? "auto" : "none", paddingLeft: 24 }}>
              <div style={{ display: "flex", gap: 4, marginBottom: 8, flexWrap: "wrap" }}>
                {DAYS.map((day) => (
                  <button
                    key={day}
                    className={`btn btn-sm ${weeklyDays.includes(day) ? "btn-primary" : ""}`}
                    onClick={() => toggleWeeklyDay(day)}
                    style={{ minWidth: 44 }}
                  >
                    {day}
                  </button>
                ))}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {weeklyTimes.map((time, idx) => (
                  <div key={idx} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <label style={{ margin: 0, fontSize: 13 }}>{idx === 0 ? "Time:" : ""}</label>
                    <input
                      type="time"
                      value={time}
                      onChange={(e) => setWeeklyTimeAtIndex(idx, e.target.value)}
                      style={{ maxWidth: 120 }}
                    />
                    {weeklyTimes.length > 1 && (
                      <button
                        className="btn btn-sm"
                        onClick={() => removeWeeklyTime(idx)}
                        title="Remove time"
                        style={{ padding: "2px 8px", fontSize: 14, lineHeight: 1 }}
                      >
                        -
                      </button>
                    )}
                    {idx === weeklyTimes.length - 1 && (
                      <button
                        className="btn btn-sm"
                        onClick={addWeeklyTime}
                        title="Add another time"
                        style={{ padding: "2px 8px", fontSize: 14, lineHeight: 1 }}
                      >
                        +
                      </button>
                    )}
                  </div>
                ))}
              </div>
              {useWeekly && (
                <span className="hint" style={{ marginTop: 4, display: "block" }}>
                  {describeCron(form.cron)}
                </span>
              )}
            </div>
          </div>

          <div>
            <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <input
                type="radio"
                name="schedule-mode"
                checked={!useWeekly}
                onChange={() => {
                  setUseWeekly(false);
                  setForm((prev) => ({ ...prev, cron: "0 0 * * *" }));
                }}
              />
              Cron expression
            </label>
            <div style={{ opacity: !useWeekly ? 1 : 0.4, pointerEvents: !useWeekly ? "auto" : "none", paddingLeft: 24 }}>
              <CronInput value={form.cron} onChange={(cron) => setForm((prev) => ({ ...prev, cron }))} />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
