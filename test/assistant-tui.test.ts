import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { afterEach, describe, expect, test, vi } from "vitest";
import { saveAgentProfile } from "../src/agent/agent-profile.js";
import { defaultConfig } from "../src/config/defaults.js";
import { runAssistantTui } from "../src/assistant/assistant-tui.js";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function createCaptureWritable() {
  let output = "";

  const sink = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    }
  });

  return {
    sink,
    read() {
      return output;
    }
  };
}

describe("runAssistantTui", () => {
  test("reuses local workspace memory across terminal sessions", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "micro-claw-assistant-tui-"));
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
    await saveAgentProfile(root, {
      name: "Clawy",
      behavior: "brief and practical"
    });

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

        if (url.endsWith("/api/chat")) {
          const body = JSON.parse(String(init?.body ?? "{}")) as {
            messages?: Array<{ role?: string; content?: string }>;
          };
          const latestUser = body.messages?.findLast((message) => message.role === "user")?.content ?? "";
          expect(latestUser).toContain("Friday gym");

          return new Response(
            JSON.stringify({
              message: {
                content: "Remember Friday gym."
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

    const firstCapture = createCaptureWritable();
    const first = await runAssistantTui({
      root,
      config: defaultConfig,
      initialPrompt: "/remember Friday gym",
      interactive: false,
      output: firstCapture.sink,
      env: {
        https_proxy: "http://127.0.0.1:8083",
        SSL_CERT_FILE: "/tmp/secretgate-ca.pem"
      }
    });

    expect(first.lastAssistantMessage).toBe("Saved to chat memory.");

    const secondCapture = createCaptureWritable();
    const second = await runAssistantTui({
      root,
      config: defaultConfig,
      initialPrompt: "What should I remember?",
      interactive: false,
      output: secondCapture.sink,
      env: {
        https_proxy: "http://127.0.0.1:8083",
        SSL_CERT_FILE: "/tmp/secretgate-ca.pem"
      }
    });

    expect(second.lastAssistantMessage).toBe("Remember Friday gym.");
    expect(
      await readFile(path.join(root, ".micro-claw", "assistant", "chats", "local-tui", "CLAUDE.md"), "utf8")
    ).toContain("Friday gym");
  });

  test("creates local schedules from slash commands", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "micro-claw-assistant-tui-schedule-"));
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
    await saveAgentProfile(root, {
      name: "Clawy",
      behavior: "brief and practical"
    });

    const capture = createCaptureWritable();
    const result = await runAssistantTui({
      root,
      config: defaultConfig,
      initialPrompt: "/schedule every 2h | stretch",
      interactive: false,
      output: capture.sink,
      env: {
        https_proxy: "http://127.0.0.1:8083",
        SSL_CERT_FILE: "/tmp/secretgate-ca.pem"
      }
    });

    expect(result.lastAssistantMessage).toContain("Scheduled task");

    const schedules = JSON.parse(
      await readFile(path.join(root, ".micro-claw", "assistant", "schedules.json"), "utf8")
    ) as {
      tasks: Array<{ chatId: string; prompt: string }>;
    };
    expect(schedules.tasks).toHaveLength(1);
    expect(schedules.tasks[0].chatId).toBe("local-tui");
    expect(schedules.tasks[0].prompt).toBe("stretch");
  });
});
