import type {
  AssistantScheduleParseResult,
  AssistantSchedulePattern,
  AssistantScheduledTask
} from "../core/types.js";

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const WEEKDAY_MAP = new Map<string, number>([
  ["sun", 0],
  ["sunday", 0],
  ["mon", 1],
  ["monday", 1],
  ["tue", 2],
  ["tues", 2],
  ["tuesday", 2],
  ["wed", 3],
  ["wednesday", 3],
  ["thu", 4],
  ["thur", 4],
  ["thurs", 4],
  ["thursday", 4],
  ["fri", 5],
  ["friday", 5],
  ["sat", 6],
  ["saturday", 6]
]);

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function toLocalIso(date: Date): string {
  return [
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  ].join("T");
}

function parseClock(value: string): { hour: number; minute: number } | undefined {
  const match = value.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) {
    return undefined;
  }

  const hour = Number.parseInt(match[1], 10);
  const minute = Number.parseInt(match[2], 10);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return undefined;
  }

  return { hour, minute };
}

function formatClock(hour: number, minute: number): string {
  return `${pad(hour)}:${pad(minute)}`;
}

function intervalToMs(schedule: Extract<AssistantSchedulePattern, { kind: "interval" }>): number {
  if (schedule.unit === "minutes") {
    return schedule.every * 60_000;
  }

  if (schedule.unit === "hours") {
    return schedule.every * 60 * 60_000;
  }

  return schedule.every * 24 * 60 * 60_000;
}

function assertPositiveInterval(every: number): void {
  if (!Number.isFinite(every) || every <= 0) {
    throw new Error("Interval schedules must use a positive number, for example `every 2h | stretch`.");
  }
}

function nextIntervalRun(
  schedule: Extract<AssistantSchedulePattern, { kind: "interval" }>,
  anchor: Date,
  now: Date
): Date {
  const intervalMs = intervalToMs(schedule);
  let next = anchor.getTime() + intervalMs;

  while (next <= now.getTime()) {
    next += intervalMs;
  }

  return new Date(next);
}

function nextDailyRun(
  schedule: Extract<AssistantSchedulePattern, { kind: "daily" }>,
  anchor: Date,
  now: Date
): Date {
  const candidate = new Date(anchor);
  candidate.setDate(candidate.getDate() + 1);
  candidate.setHours(schedule.hour, schedule.minute, 0, 0);

  while (
    candidate.getTime() <= now.getTime() ||
    (schedule.weekdaysOnly && (candidate.getDay() === 0 || candidate.getDay() === 6))
  ) {
    candidate.setDate(candidate.getDate() + 1);
    candidate.setHours(schedule.hour, schedule.minute, 0, 0);
  }

  return candidate;
}

function nextWeeklyRun(
  schedule: Extract<AssistantSchedulePattern, { kind: "weekly" }>,
  anchor: Date,
  now: Date
): Date {
  const candidate = new Date(anchor);
  candidate.setDate(candidate.getDate() + 1);
  candidate.setHours(schedule.hour, schedule.minute, 0, 0);

  while (candidate.getTime() <= now.getTime() || candidate.getDay() !== schedule.weekday) {
    candidate.setDate(candidate.getDate() + 1);
    candidate.setHours(schedule.hour, schedule.minute, 0, 0);
  }

  return candidate;
}

function firstDailyRun(
  hour: number,
  minute: number,
  now: Date,
  weekdaysOnly: boolean
): Date {
  const candidate = new Date(now);
  candidate.setHours(hour, minute, 0, 0);

  while (
    candidate.getTime() <= now.getTime() ||
    (weekdaysOnly && (candidate.getDay() === 0 || candidate.getDay() === 6))
  ) {
    candidate.setDate(candidate.getDate() + 1);
    candidate.setHours(hour, minute, 0, 0);
  }

  return candidate;
}

function firstWeeklyRun(weekday: number, hour: number, minute: number, now: Date): Date {
  const candidate = new Date(now);
  candidate.setHours(hour, minute, 0, 0);

  while (candidate.getTime() <= now.getTime() || candidate.getDay() !== weekday) {
    candidate.setDate(candidate.getDate() + 1);
    candidate.setHours(hour, minute, 0, 0);
  }

  return candidate;
}

export function formatAssistantSchedule(schedule: AssistantSchedulePattern): string {
  switch (schedule.kind) {
    case "interval":
      return `every ${schedule.every}${schedule.unit === "minutes" ? "m" : schedule.unit === "hours" ? "h" : "d"}`;
    case "daily":
      return schedule.weekdaysOnly
        ? `weekdays ${formatClock(schedule.hour, schedule.minute)}`
        : `daily ${formatClock(schedule.hour, schedule.minute)}`;
    case "weekly":
      return `weekly ${WEEKDAY_LABELS[schedule.weekday].toLowerCase()} ${formatClock(
        schedule.hour,
        schedule.minute
      )}`;
    default:
      return "scheduled";
  }
}

export function parseAssistantScheduleRequest(
  input: string,
  now = new Date()
): AssistantScheduleParseResult {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error(
      "Schedule format must be `every 2h | stretch`, `daily 09:00 | morning plan`, `weekdays 18:00 | review todos`, or `weekly mon 10:00 | status`."
    );
  }

  const [head, ...tail] = trimmed.includes("|")
    ? trimmed.split("|").map((part) => part.trim())
    : [trimmed];

  if (trimmed.includes("|") && tail.length > 0) {
    const prompt = tail.join(" | ").trim();
    if (!prompt) {
      throw new Error("Scheduled tasks need a prompt after `|`.");
    }
    const intervalMatch = head.match(/^every\s+(\d+)\s*([mhd])$/i);
    if (intervalMatch) {
      const every = Number.parseInt(intervalMatch[1], 10);
      assertPositiveInterval(every);
      const unit =
        intervalMatch[2].toLowerCase() === "m"
          ? "minutes"
          : intervalMatch[2].toLowerCase() === "h"
            ? "hours"
            : "days";
      const schedule: AssistantSchedulePattern = { kind: "interval", every, unit };
      return {
        prompt,
        nextRunAt: toLocalIso(nextIntervalRun(schedule, now, new Date(now.getTime() - 1))),
        schedule
      };
    }

    const dailyMatch = head.match(/^(daily|weekdays)\s+(\d{1,2}:\d{2})$/i);
    if (dailyMatch) {
      const clock = parseClock(dailyMatch[2]);
      if (!clock) {
        throw new Error("Schedule time must use HH:MM.");
      }

      const weekdaysOnly = dailyMatch[1].toLowerCase() === "weekdays";
      const schedule: AssistantSchedulePattern = {
        kind: "daily",
        hour: clock.hour,
        minute: clock.minute,
        weekdaysOnly
      };
      return {
        prompt,
        nextRunAt: toLocalIso(firstDailyRun(clock.hour, clock.minute, now, weekdaysOnly)),
        schedule
      };
    }

    const weeklyMatch = head.match(/^weekly\s+([a-z]+)\s+(\d{1,2}:\d{2})$/i);
    if (weeklyMatch) {
      const weekday = WEEKDAY_MAP.get(weeklyMatch[1].toLowerCase());
      const clock = parseClock(weeklyMatch[2]);
      if (weekday === undefined || !clock) {
        throw new Error("Weekly schedules must use a weekday and HH:MM, for example `weekly mon 10:00 | status`.");
      }

      const schedule: AssistantSchedulePattern = {
        kind: "weekly",
        weekday,
        hour: clock.hour,
        minute: clock.minute
      };
      return {
        prompt,
        nextRunAt: toLocalIso(firstWeeklyRun(weekday, clock.hour, clock.minute, now)),
        schedule
      };
    }
  }

  const intervalInlineMatch = trimmed.match(/^every\s+(\d+)\s*([mhd])\s+(.+)$/i);
  if (intervalInlineMatch) {
    const every = Number.parseInt(intervalInlineMatch[1], 10);
    assertPositiveInterval(every);
    const unit =
      intervalInlineMatch[2].toLowerCase() === "m"
        ? "minutes"
        : intervalInlineMatch[2].toLowerCase() === "h"
          ? "hours"
          : "days";
    const schedule: AssistantSchedulePattern = { kind: "interval", every, unit };
    return {
      prompt: intervalInlineMatch[3].trim(),
      nextRunAt: toLocalIso(nextIntervalRun(schedule, now, new Date(now.getTime() - 1))),
      schedule
    };
  }

  const dailyInlineMatch = trimmed.match(/^(daily|weekdays)\s+(\d{1,2}:\d{2})\s+(.+)$/i);
  if (dailyInlineMatch) {
    const clock = parseClock(dailyInlineMatch[2]);
    if (!clock) {
      throw new Error("Schedule time must use HH:MM.");
    }

    const weekdaysOnly = dailyInlineMatch[1].toLowerCase() === "weekdays";
    const schedule: AssistantSchedulePattern = {
      kind: "daily",
      hour: clock.hour,
      minute: clock.minute,
      weekdaysOnly
    };
    return {
      prompt: dailyInlineMatch[3].trim(),
      nextRunAt: toLocalIso(firstDailyRun(clock.hour, clock.minute, now, weekdaysOnly)),
      schedule
    };
  }

  const weeklyInlineMatch = trimmed.match(/^weekly\s+([a-z]+)\s+(\d{1,2}:\d{2})\s+(.+)$/i);
  if (weeklyInlineMatch) {
    const weekday = WEEKDAY_MAP.get(weeklyInlineMatch[1].toLowerCase());
    const clock = parseClock(weeklyInlineMatch[2]);
    if (weekday === undefined || !clock) {
      throw new Error("Weekly schedules must use a weekday and HH:MM, for example `weekly mon 10:00 status`.");
    }

    const schedule: AssistantSchedulePattern = {
      kind: "weekly",
      weekday,
      hour: clock.hour,
      minute: clock.minute
    };
    return {
      prompt: weeklyInlineMatch[3].trim(),
      nextRunAt: toLocalIso(firstWeeklyRun(weekday, clock.hour, clock.minute, now)),
      schedule
    };
  }

  throw new Error(
    "Schedule format must be `every 2h | stretch`, `daily 09:00 | morning plan`, `weekdays 18:00 | review todos`, or `weekly mon 10:00 | status`."
  );
}

export function computeNextAssistantScheduleRun(
  task: Pick<AssistantScheduledTask, "nextRunAt" | "schedule">,
  now = new Date()
): string {
  const anchor = new Date(task.nextRunAt);
  const safeAnchor = Number.isNaN(anchor.getTime()) ? now : anchor;

  if (task.schedule.kind === "interval") {
    return toLocalIso(nextIntervalRun(task.schedule, safeAnchor, now));
  }

  if (task.schedule.kind === "daily") {
    return toLocalIso(nextDailyRun(task.schedule, safeAnchor, now));
  }

  return toLocalIso(nextWeeklyRun(task.schedule, safeAnchor, now));
}
