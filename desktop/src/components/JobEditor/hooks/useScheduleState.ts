import { useEffect, useState } from "react";
import type { Job } from "../../../types";
import { parseCronToWeekly, buildWeeklyCron } from "../utils";

interface UseScheduleStateParams {
  form: Job;
  setForm: React.Dispatch<React.SetStateAction<Job>>;
  isNew: boolean;
}

export function useScheduleState({ form, setForm, isNew }: UseScheduleStateParams) {
  const initWeekly = !isNew ? parseCronToWeekly(form.cron) : null;
  const [manualOnly, setManualOnly] = useState(!isNew ? form.cron === "" : false);
  const [useWeekly, setUseWeekly] = useState(!isNew ? (form.cron === "" || initWeekly !== null) : true);
  const [weeklyDays, setWeeklyDays] = useState<string[]>(initWeekly?.days ?? ["Mon"]);
  const [weeklyTimes, setWeeklyTimes] = useState<string[]>(initWeekly?.times ?? ["09:00"]);

  const hasParams = form.params.length > 0;

  useEffect(() => {
    if (hasParams && !manualOnly) {
      setManualOnly(true);
      setForm((prev) => ({ ...prev, cron: "" }));
    }
  }, [hasParams]);

  const toggleWeeklyDay = (day: string) => {
    const next = weeklyDays.includes(day)
      ? weeklyDays.filter((d) => d !== day)
      : [...weeklyDays, day];
    setWeeklyDays(next);
    setForm((prev) => ({ ...prev, cron: buildWeeklyCron(next, weeklyTimes) }));
  };

  const setWeeklyTimeAtIndex = (index: number, time: string) => {
    const next = [...weeklyTimes];
    next[index] = time;
    setWeeklyTimes(next);
    setForm((prev) => ({ ...prev, cron: buildWeeklyCron(weeklyDays, next) }));
  };

  const addWeeklyTime = () => {
    const next = [...weeklyTimes, "09:00"];
    setWeeklyTimes(next);
    setForm((prev) => ({ ...prev, cron: buildWeeklyCron(weeklyDays, next) }));
  };

  const removeWeeklyTime = (index: number) => {
    if (weeklyTimes.length <= 1) return;
    const next = weeklyTimes.filter((_, i) => i !== index);
    setWeeklyTimes(next);
    setForm((prev) => ({ ...prev, cron: buildWeeklyCron(weeklyDays, next) }));
  };

  return {
    manualOnly,
    setManualOnly,
    useWeekly,
    setUseWeekly,
    weeklyDays,
    weeklyTimes,
    hasParams,
    buildWeeklyCron,
    toggleWeeklyDay,
    setWeeklyTimeAtIndex,
    addWeeklyTime,
    removeWeeklyTime,
  };
}
