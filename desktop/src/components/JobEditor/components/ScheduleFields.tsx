import { describeCalendarSchedule } from "@clawtab/shared";
import type { Job } from "../../../types";
import { CronInput, describeCron } from "../../CronInput";
import { DAYS } from "../types";

interface ScheduleFieldsProps {
  form: Job;
  setForm: React.Dispatch<React.SetStateAction<Job>>;
  manualOnly: boolean;
  scheduleMode: "weekly" | "calendar" | "cron";
  weeklyDays: string[];
  weeklyTimes: string[];
  calendarStart: string;
  calendarEvery: number;
  hasParams: boolean;
  selectManual: (manual: boolean) => void;
  selectScheduleMode: (mode: "weekly" | "calendar" | "cron") => void;
  toggleWeeklyDay: (day: string) => void;
  setWeeklyTimeAtIndex: (index: number, time: string) => void;
  addWeeklyTime: () => void;
  removeWeeklyTime: (index: number) => void;
  updateCalendarStart: (start: string) => void;
  updateCalendarEvery: (every: number) => void;
}

export function ScheduleFields({
  form, setForm, manualOnly, scheduleMode,
  weeklyDays, weeklyTimes, calendarStart, calendarEvery, hasParams,
  selectManual, selectScheduleMode, toggleWeeklyDay,
  setWeeklyTimeAtIndex, addWeeklyTime, removeWeeklyTime,
  updateCalendarStart, updateCalendarEvery,
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
            onChange={(event) => selectManual(event.target.checked)}
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
                checked={scheduleMode === "weekly"}
                onChange={() => selectScheduleMode("weekly")}
              />
              Weekly cron schedule
            </label>
            <div style={{ opacity: scheduleMode === "weekly" ? 1 : 0.4, pointerEvents: scheduleMode === "weekly" ? "auto" : "none", paddingLeft: 24 }}>
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
              {scheduleMode === "weekly" && (
                <span className="hint" style={{ marginTop: 4, display: "block" }}>
                  {describeCron(form.cron)}
                </span>
              )}
            </div>
          </div>

          <div style={{ marginBottom: 16 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <input
                type="radio"
                name="schedule-mode"
                checked={scheduleMode === "calendar"}
                onChange={() => selectScheduleMode("calendar")}
              />
              Calendar recurrence
            </label>
            <div style={{ opacity: scheduleMode === "calendar" ? 1 : 0.4, pointerEvents: scheduleMode === "calendar" ? "auto" : "none", paddingLeft: 24 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <label style={{ margin: 0, fontSize: 13 }} htmlFor="calendar-schedule-start">
                  Starts
                </label>
                <input
                  id="calendar-schedule-start"
                  type="datetime-local"
                  value={calendarStart}
                  onChange={(event) => updateCalendarStart(event.target.value)}
                />
                <label style={{ margin: 0, fontSize: 13 }} htmlFor="calendar-schedule-repeat">
                  Repeat
                </label>
                <select
                  id="calendar-schedule-repeat"
                  value={calendarEvery}
                  onChange={(event) => updateCalendarEvery(Number(event.target.value))}
                >
                  {Array.from({ length: 12 }, (_, optionIndex) => optionIndex + 1).map((every) => (
                    <option key={every} value={every}>
                      {every === 1 ? "Every week" : every === 2 ? "Every other week" : `Every ${every} weeks`}
                    </option>
                  ))}
                </select>
              </div>
              {scheduleMode === "calendar" && form.schedule ? (
                <span className="hint" style={{ marginTop: 6, display: "block" }}>
                  {describeCalendarSchedule(form.schedule)} in this Mac's local timezone.
                </span>
              ) : null}
            </div>
          </div>

          <div>
            <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <input
                type="radio"
                name="schedule-mode"
                checked={scheduleMode === "cron"}
                onChange={() => selectScheduleMode("cron")}
              />
              Cron expression
            </label>
            <div style={{ opacity: scheduleMode === "cron" ? 1 : 0.4, pointerEvents: scheduleMode === "cron" ? "auto" : "none", paddingLeft: 24 }}>
              <CronInput
                value={form.cron}
                onChange={(cron) => setForm((prev) => ({ ...prev, cron, schedule: null }))}
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
