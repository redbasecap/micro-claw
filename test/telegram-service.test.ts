import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { parseAssistantScheduleRequest } from "../src/assistant/schedule-parser.js";
import { addAssistantScheduledTask } from "../src/assistant/schedule-store.js";
import { touchAssistantUser } from "../src/assistant/store.js";
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
  test("processes telegram commands, syncs workspace memory, and produces a follow-up assistant reply", async () => {
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
                    message_id: 10,
                    date: 1,
                    text: "/remember Working from home on Fridays",
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
                    message_id: 11,
                    date: 2,
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
                  update_id: 3,
                  message: {
                    message_id: 12,
                    date: 3,
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
          expect(latestUser).toContain("Working from home on Fridays");

          return new Response(
            JSON.stringify({
              message: {
                content: "Remember the oat milk and your Friday routine."
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

    expect(result.processedUpdates).toBe(3);
    expect(sentMessages).toHaveLength(3);
    expect(sentMessages[0].text).toContain("Saved to chat memory");
    expect(sentMessages[1].text).toContain("Note saved");
    expect(sentMessages[2].text).toContain("Remember the oat milk and your Friday routine");

    const assistantState = JSON.parse(
      await readFile(path.join(root, ".micro-claw", "assistant", "state.json"), "utf8")
    ) as {
      users: Record<string, { notes: Array<{ text: string }>; conversation: Array<{ content: string }> }>;
    };
    expect(assistantState.users["123"].notes[0].text).toBe("Buy oat milk");
    expect(
      assistantState.users["123"].conversation.some((entry) =>
        entry.content.includes("Remember the oat milk and your Friday routine")
      )
    ).toBe(true);
    expect(
      await readFile(
        path.join(root, ".micro-claw", "assistant", "chats", "123", "CLAUDE.md"),
        "utf8"
      )
    ).toContain("Working from home on Fridays");

    const telegramState = JSON.parse(
      await readFile(path.join(root, ".micro-claw", "telegram", "state.json"), "utf8")
    ) as { lastUpdateId: number };
    expect(telegramState.lastUpdateId).toBe(4);
  });

  test("runs due scheduled tasks and advances their next run", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "micro-claw-scheduled-"));
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
              result: []
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
          return new Response(
            JSON.stringify({
              message: {
                content: "Time to stretch."
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
    await touchAssistantUser(root, config, "123", {
      username: "nick",
      displayName: "Nick"
    });
    await addAssistantScheduledTask(
      root,
      config,
      "123",
      parseAssistantScheduleRequest("every 2h | stretch", new Date(2026, 2, 25, 8, 0, 0))
    );

    const schedulesPath = path.join(root, ".micro-claw", "assistant", "schedules.json");
    const schedulesState = JSON.parse(await readFile(schedulesPath, "utf8")) as {
      tasks: Array<{ nextRunAt: string }>;
    };
    schedulesState.tasks[0].nextRunAt = "2000-01-01T00:00:00";
    await writeFile(schedulesPath, `${JSON.stringify(schedulesState, null, 2)}\n`, "utf8");

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

    expect(result.deliveredScheduledTasks).toBe(1);
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].text).toContain("Scheduled task");
    expect(sentMessages[0].text).toContain("Time to stretch.");

    const savedSchedules = JSON.parse(await readFile(schedulesPath, "utf8")) as {
      tasks: Array<{ nextRunAt: string; lastRunAt?: string; lastResultSummary?: string }>;
    };
    expect(savedSchedules.tasks[0].lastRunAt).toBeTruthy();
    expect(savedSchedules.tasks[0].lastResultSummary).toContain("Time to stretch.");
    expect(savedSchedules.tasks[0].nextRunAt).not.toBe("2000-01-01T00:00:00");
  });
});
