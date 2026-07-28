import { useEffect, useState } from "react";
import type { Job } from "../../../types";
import {
  parseCronToWeekly,
  buildWeeklyCron,
  buildCalendarSchedule,
  defaultCalendarStart,
} from "../utils";

interface UseScheduleStateParams {
  form: Job;
  setForm: React.Dispatch<React.SetStateAction<Job>>;
  isNew: boolean;
}

export function useScheduleState({ form, setForm, isNew }: UseScheduleStateParams) {
  const initWeekly = !isNew ? parseCronToWeekly(form.cron) : null;
  const [manualOnly, setManualOnly] = useState(
    !isNew ? form.cron === "" && !form.schedule : false,
  );
  const [scheduleMode, setScheduleMode] = useState<"weekly" | "calendar" | "cron">(
    form.schedule ? "calendar" : !isNew && initWeekly === null && form.cron ? "cron" : "weekly",
  );
  const [weeklyDays, setWeeklyDays] = useState<string[]>(initWeekly?.days ?? ["Mon"]);
  const [weeklyTimes, setWeeklyTimes] = useState<string[]>(initWeekly?.times ?? ["09:00"]);
  const [calendarStart, setCalendarStart] = useState(
    form.schedule?.start ?? defaultCalendarStart(),
  );
  const [calendarEvery, setCalendarEvery] = useState(
    form.schedule?.repeat.every ?? 2,
  );

  const hasParams = form.params.length > 0;

  useEffect(() => {
    if (hasParams && !manualOnly) {
      setManualOnly(true);
      setForm((prev) => ({ ...prev, cron: "", schedule: null }));
    }
  }, [hasParams]);

  const selectManual = (manual: boolean) => {
    setManualOnly(manual);
    if (manual) {
      setForm((prev) => ({ ...prev, cron: "", schedule: null }));
      return;
    }
    if (scheduleMode === "calendar") {
      setForm((prev) => ({
        ...prev,
        cron: "",
        schedule: buildCalendarSchedule(calendarStart, calendarEvery),
      }));
    } else if (scheduleMode === "weekly") {
      setForm((prev) => ({
        ...prev,
        cron: buildWeeklyCron(weeklyDays, weeklyTimes),
        schedule: null,
      }));
    } else {
      setForm((prev) => ({ ...prev, cron: "0 0 * * *", schedule: null }));
    }
  };

  const selectScheduleMode = (mode: "weekly" | "calendar" | "cron") => {
    setScheduleMode(mode);
    if (mode === "calendar") {
      setForm((prev) => ({
        ...prev,
        cron: "",
        schedule: buildCalendarSchedule(calendarStart, calendarEvery),
      }));
    } else if (mode === "weekly") {
      setForm((prev) => ({
        ...prev,
        cron: buildWeeklyCron(weeklyDays, weeklyTimes),
        schedule: null,
      }));
    } else {
      setForm((prev) => ({ ...prev, cron: "0 0 * * *", schedule: null }));
    }
  };

  const toggleWeeklyDay = (day: string) => {
    const next = weeklyDays.includes(day)
      ? weeklyDays.filter((d) => d !== day)
      : [...weeklyDays, day];
    setWeeklyDays(next);
    setForm((prev) => ({
      ...prev,
      cron: buildWeeklyCron(next, weeklyTimes),
      schedule: null,
    }));
  };

  const setWeeklyTimeAtIndex = (index: number, time: string) => {
    const next = [...weeklyTimes];
    next[index] = time;
    setWeeklyTimes(next);
    setForm((prev) => ({
      ...prev,
      cron: buildWeeklyCron(weeklyDays, next),
      schedule: null,
    }));
  };

  const addWeeklyTime = () => {
    const next = [...weeklyTimes, "09:00"];
    setWeeklyTimes(next);
    setForm((prev) => ({
      ...prev,
      cron: buildWeeklyCron(weeklyDays, next),
      schedule: null,
    }));
  };

  const removeWeeklyTime = (index: number) => {
    if (weeklyTimes.length <= 1) return;
    const next = weeklyTimes.filter((_, i) => i !== index);
    setWeeklyTimes(next);
    setForm((prev) => ({
      ...prev,
      cron: buildWeeklyCron(weeklyDays, next),
      schedule: null,
    }));
  };

  const updateCalendarStart = (start: string) => {
    setCalendarStart(start);
    setForm((prev) => ({
      ...prev,
      cron: "",
      schedule: buildCalendarSchedule(start, calendarEvery),
    }));
  };

  const updateCalendarEvery = (every: number) => {
    setCalendarEvery(every);
    setForm((prev) => ({
      ...prev,
      cron: "",
      schedule: buildCalendarSchedule(calendarStart, every),
    }));
  };

  return {
    manualOnly,
    setManualOnly,
    scheduleMode,
    weeklyDays,
    weeklyTimes,
    calendarStart,
    calendarEvery,
    hasParams,
    selectManual,
    selectScheduleMode,
    toggleWeeklyDay,
    setWeeklyTimeAtIndex,
    addWeeklyTime,
    removeWeeklyTime,
    updateCalendarStart,
    updateCalendarEvery,
  };
}
