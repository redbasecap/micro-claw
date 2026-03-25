import { describe, expect, test } from "vitest";
import {
  computeNextAssistantScheduleRun,
  formatAssistantSchedule,
  parseAssistantScheduleRequest
} from "../src/assistant/schedule-parser.js";

describe("parseAssistantScheduleRequest", () => {
  test("parses interval schedules with a separator", () => {
    const now = new Date(2026, 2, 25, 8, 0, 0);
    const result = parseAssistantScheduleRequest("every 2h | stretch", now);

    expect(result.prompt).toBe("stretch");
    expect(result.schedule).toEqual({
      kind: "interval",
      every: 2,
      unit: "hours"
    });
    expect(result.nextRunAt).toBe("2026-03-25T10:00:00");
    expect(formatAssistantSchedule(result.schedule)).toBe("every 2h");
  });

  test("parses weekday schedules and skips weekends", () => {
    const now = new Date(2026, 2, 27, 18, 0, 0);
    const result = parseAssistantScheduleRequest("weekdays 09:30 | plan the day", now);

    expect(result.schedule).toEqual({
      kind: "daily",
      hour: 9,
      minute: 30,
      weekdaysOnly: true
    });
    expect(result.nextRunAt).toBe("2026-03-30T09:30:00");
  });

  test("advances interval schedules without drift", () => {
    const nextRunAt = computeNextAssistantScheduleRun(
      {
        nextRunAt: "2026-03-25T10:00:00",
        schedule: {
          kind: "interval",
          every: 2,
          unit: "hours"
        }
      },
      new Date(2026, 2, 25, 10, 5, 0)
    );

    expect(nextRunAt).toBe("2026-03-25T12:00:00");
  });
});
