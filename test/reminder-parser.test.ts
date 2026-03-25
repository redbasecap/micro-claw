import { describe, expect, test } from "vitest";
import { formatReminderDate, parseReminderRequest } from "../src/assistant/reminder-parser.js";

describe("parseReminderRequest", () => {
  test("parses relative reminder syntax", () => {
    const now = new Date(2026, 2, 24, 10, 0, 0);
    const result = parseReminderRequest("in 2h buy milk", now);

    expect(result.text).toBe("buy milk");
    expect(result.dueAt).toBe("2026-03-24T12:00:00");
  });

  test("parses named-day reminder syntax", () => {
    const now = new Date(2026, 2, 24, 10, 0, 0);
    const result = parseReminderRequest("tomorrow 08:30 standup", now);

    expect(result.text).toBe("standup");
    expect(result.dueAt).toBe("2026-03-25T08:30:00");
    expect(formatReminderDate(result.dueAt)).toContain("2026");
  });
});
