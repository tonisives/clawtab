import type { CalendarSchedule } from "../types/job";
import { formatNextRun } from "./cron";

export let isJobScheduled = (job: {
  cron: string;
  schedule?: CalendarSchedule | null;
}): boolean => Boolean(job.cron || job.schedule);

let parseLocalStart = (value: string): Date | null => {
  let match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/,
  );
  if (!match) return null;

  let [, year, month, day, hour, minute, second = "0"] = match;
  let date = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    0,
  );
  let matchesInput =
    date.getFullYear() === Number(year) &&
    date.getMonth() === Number(month) - 1 &&
    date.getDate() === Number(day) &&
    date.getHours() === Number(hour) &&
    date.getMinutes() === Number(minute);

  return matchesInput ? date : null;
};

export let nextCalendarDate = (
  schedule: CalendarSchedule,
  after: Date = new Date(),
): Date | null => {
  let start = parseLocalStart(schedule.start);
  let every = schedule.repeat.every;
  if (!start || schedule.repeat.unit !== "week" || every < 1) return null;
  if (after < start) return start;

  let intervalDays = every * 7;
  let approximateIndex = Math.max(
    1,
    Math.floor((after.getTime() - start.getTime()) / (intervalDays * 86400000)),
  );
  let candidate = new Date(start);
  candidate.setDate(start.getDate() + approximateIndex * intervalDays);

  while (candidate <= after) {
    candidate.setDate(candidate.getDate() + intervalDays);
  }
  while (approximateIndex > 1) {
    let previous = new Date(candidate);
    previous.setDate(previous.getDate() - intervalDays);
    if (previous <= after) break;
    candidate = previous;
    approximateIndex -= 1;
  }

  return candidate;
};

export let describeCalendarSchedule = (schedule: CalendarSchedule): string => {
  let start = parseLocalStart(schedule.start);
  let every = schedule.repeat.every;
  if (!start || schedule.repeat.unit !== "week" || every < 1) {
    return "Invalid calendar schedule";
  }

  let cadence = every === 1 ? "Weekly" : `Every ${every} weeks`;
  let anchor = start.toLocaleString(undefined, {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  return `${cadence} from ${anchor}`;
};

export let calendarScheduleTooltip = (schedule: CalendarSchedule): string => {
  let description = describeCalendarSchedule(schedule);
  let next = nextCalendarDate(schedule);
  return `${description}\nNext: ${next ? formatNextRun(next) : "unknown"}`;
};
