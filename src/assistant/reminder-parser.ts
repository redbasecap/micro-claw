import type { ReminderParseResult } from "../core/types.js";

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function toLocalIso(date: Date): string {
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  const seconds = pad(date.getSeconds());
  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}`;
}

function parseClock(hoursPart: string, minutesPart: string, now: Date, dayOffset = 0): Date {
  const date = new Date(now);
  date.setDate(date.getDate() + dayOffset);
  date.setHours(Number.parseInt(hoursPart, 10), Number.parseInt(minutesPart, 10), 0, 0);
  return date;
}

function splitReminderRequest(input: string): { when: string; text: string } | undefined {
  const trimmed = input.trim();
  if (!trimmed) {
    return undefined;
  }

  if (trimmed.includes("|")) {
    const [when, ...rest] = trimmed.split("|");
    const text = rest.join("|").trim();
    if (!when.trim() || !text) {
      return undefined;
    }

    return {
      when: when.trim(),
      text
    };
  }

  const relativeMatch = trimmed.match(/^(in\s+\d+\s*[mhd])\s+(.+)$/i);
  if (relativeMatch) {
    return {
      when: relativeMatch[1].trim(),
      text: relativeMatch[2].trim()
    };
  }

  const absoluteMatch = trimmed.match(/^(\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2})\s+(.+)$/);
  if (absoluteMatch) {
    return {
      when: absoluteMatch[1].trim(),
      text: absoluteMatch[2].trim()
    };
  }

  const namedDayMatch = trimmed.match(/^((?:today|tomorrow)\s+\d{1,2}:\d{2})\s+(.+)$/i);
  if (namedDayMatch) {
    return {
      when: namedDayMatch[1].trim(),
      text: namedDayMatch[2].trim()
    };
  }

  return undefined;
}

function parseWhen(when: string, now: Date): Date | undefined {
  const relativeMatch = when.match(/^in\s+(\d+)\s*([mhd])$/i);
  if (relativeMatch) {
    const amount = Number.parseInt(relativeMatch[1], 10);
    const unit = relativeMatch[2].toLowerCase();
    const date = new Date(now);

    if (unit === "m") {
      date.setMinutes(date.getMinutes() + amount);
    } else if (unit === "h") {
      date.setHours(date.getHours() + amount);
    } else {
      date.setDate(date.getDate() + amount);
    }

    return date;
  }

  const absoluteMatch = when.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})$/);
  if (absoluteMatch) {
    const date = new Date(
      Number.parseInt(absoluteMatch[1], 10),
      Number.parseInt(absoluteMatch[2], 10) - 1,
      Number.parseInt(absoluteMatch[3], 10),
      Number.parseInt(absoluteMatch[4], 10),
      Number.parseInt(absoluteMatch[5], 10),
      0,
      0
    );

    return Number.isNaN(date.getTime()) ? undefined : date;
  }

  const todayMatch = when.match(/^today\s+(\d{1,2}):(\d{2})$/i);
  if (todayMatch) {
    return parseClock(todayMatch[1], todayMatch[2], now, 0);
  }

  const tomorrowMatch = when.match(/^tomorrow\s+(\d{1,2}):(\d{2})$/i);
  if (tomorrowMatch) {
    return parseClock(tomorrowMatch[1], tomorrowMatch[2], now, 1);
  }

  return undefined;
}

export function parseReminderRequest(input: string, now = new Date()): ReminderParseResult {
  const parsed = splitReminderRequest(input);
  if (!parsed) {
    throw new Error(
      "Reminder format must be `in 2h buy milk`, `today 18:00 call mom`, `2026-03-25 09:00 standup`, or use `|` as a separator."
    );
  }

  const dueDate = parseWhen(parsed.when, now);
  if (!dueDate) {
    throw new Error("Could not parse the reminder time.");
  }

  if (dueDate.getTime() <= now.getTime()) {
    throw new Error("Reminder time must be in the future.");
  }

  return {
    dueAt: toLocalIso(dueDate),
    text: parsed.text
  };
}

export function formatReminderDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString();
}
