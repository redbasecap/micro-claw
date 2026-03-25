import { describe, expect, test } from "vitest";
import {
  buildTelegramConnectUrl,
  createTelegramConnectInfo,
  formatTelegramConnectInfo
} from "../src/telegram/telegram-connect.js";

describe("telegram connect helpers", () => {
  test("builds a bot deep link", () => {
    expect(buildTelegramConnectUrl("micro_claw_bot")).toBe("https://t.me/micro_claw_bot");
  });

  test("creates printable QR connection info", async () => {
    const info = await createTelegramConnectInfo({
      id: 123,
      username: "micro_claw_bot",
      first_name: "Micro Claw"
    });

    expect(info.connectUrl).toBe("https://t.me/micro_claw_bot");
    expect(info.qrTerminal.length).toBeGreaterThan(10);

    const formatted = formatTelegramConnectInfo(info);
    expect(formatted).toContain("@micro_claw_bot");
    expect(formatted).toContain("https://t.me/micro_claw_bot");
    expect(formatted).toContain("Scan this QR code");
  });
});
