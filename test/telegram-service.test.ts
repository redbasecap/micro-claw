import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { defaultConfig } from "../src/config/defaults.js";
import { runTelegramService } from "../src/telegram/telegram-service.js";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.TELEGRAM_BOT_TOKEN;
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("runTelegramService", () => {
  test("processes telegram commands and a follow-up assistant reply", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "micro-claw-telegram-"));
    tempDirs.push(root);

    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify(
        {
          name: "fixture",
          private: true
        },
        null,
        2
      ),
      "utf8"
    );

    process.env.TELEGRAM_BOT_TOKEN = "token";
    const sentMessages: Array<{ chat_id: string; text: string }> = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | RequestInfo, init?: RequestInit) => {
        const url = String(input);

        if (url.endsWith("/api/tags")) {
          return new Response(
            JSON.stringify({
              models: [
                {
                  name: "llama3.2:latest",
                  size: 10
                }
              ]
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" }
            }
          );
        }

        if (url.includes("/bottoken/getUpdates")) {
          return new Response(
            JSON.stringify({
              ok: true,
              result: [
                {
                  update_id: 1,
                  message: {
                    message_id: 11,
                    date: 1,
                    text: "/note Buy oat milk",
                    chat: {
                      id: 123,
                      type: "private",
                      first_name: "Nick"
                    },
                    from: {
                      id: 123,
                      first_name: "Nick",
                      username: "nick"
                    }
                  }
                },
                {
                  update_id: 2,
                  message: {
                    message_id: 12,
                    date: 2,
                    text: "What should I remember?",
                    chat: {
                      id: 123,
                      type: "private",
                      first_name: "Nick"
                    },
                    from: {
                      id: 123,
                      first_name: "Nick",
                      username: "nick"
                    }
                  }
                }
              ]
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" }
            }
          );
        }

        if (url.includes("/bottoken/sendMessage")) {
          const body = JSON.parse(String(init?.body ?? "{}")) as { chat_id: string; text: string };
          sentMessages.push(body);
          return new Response(
            JSON.stringify({
              ok: true,
              result: {
                message_id: sentMessages.length
              }
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" }
            }
          );
        }

        if (url.endsWith("/api/chat")) {
          const body = JSON.parse(String(init?.body ?? "{}")) as {
            messages?: Array<{ role?: string; content?: string }>;
          };
          const latestUser = body.messages?.findLast((message) => message.role === "user")?.content ?? "";
          expect(latestUser).toContain("Buy oat milk");

          return new Response(
            JSON.stringify({
              message: {
                content: "Remember the oat milk."
              }
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" }
            }
          );
        }

        throw new Error(`Unexpected fetch URL: ${url}`);
      })
    );

    const config = structuredClone(defaultConfig);
    const result = await runTelegramService({
      root,
      config,
      once: true,
      verify: false,
      env: {
        https_proxy: "http://127.0.0.1:8083",
        SSL_CERT_FILE: "/tmp/secretgate-ca.pem"
      }
    });

    expect(result.processedUpdates).toBe(2);
    expect(sentMessages).toHaveLength(2);
    expect(sentMessages[0].text).toContain("Note saved");
    expect(sentMessages[1].text).toContain("Remember the oat milk");

    const assistantState = JSON.parse(
      await readFile(path.join(root, ".micro-claw", "assistant", "state.json"), "utf8")
    ) as {
      users: Record<string, { notes: Array<{ text: string }>; conversation: Array<{ content: string }> }>;
    };
    expect(assistantState.users["123"].notes[0].text).toBe("Buy oat milk");
    expect(
      assistantState.users["123"].conversation.some((entry) => entry.content.includes("Remember the oat milk"))
    ).toBe(true);

    const telegramState = JSON.parse(
      await readFile(path.join(root, ".micro-claw", "telegram", "state.json"), "utf8")
    ) as { lastUpdateId: number };
    expect(telegramState.lastUpdateId).toBe(3);
  });
});
