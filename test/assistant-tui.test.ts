import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { afterEach, describe, expect, test, vi } from "vitest";
import { saveAgentProfile } from "../src/agent/agent-profile.js";
import { defaultConfig } from "../src/config/defaults.js";
import { runAssistantTui } from "../src/assistant/assistant-tui.js";
import { _clearOllamaModelCacheForTests } from "../src/providers/chat-provider.js";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  _clearOllamaModelCacheForTests();
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

    let tagRequests = 0;
    const requestedModels: string[] = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | RequestInfo, init?: RequestInit) => {
        const url = String(input);

        if (url.endsWith("/api/tags")) {
          tagRequests += 1;
          return new Response(
            JSON.stringify({
              models: [
                {
                  name: "micro-claw-planner:latest",
                  size: 10
                },
                {
                  name: "micro-claw-coder:latest",
                  size: 100
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
            model?: string;
            messages?: Array<{ role?: string; content?: string }>;
          };
          requestedModels.push(body.model ?? "");
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
	    expect(secondCapture.read()).toContain("thinking");
	    expect(tagRequests).toBe(3);
	    expect(requestedModels).toEqual(["micro-claw-planner:latest", "micro-claw-planner:latest"]);
	    expect(
	      await readFile(path.join(root, ".micro-claw", "assistant", "chats", "local-tui", "CLAUDE.md"), "utf8")
	    ).toContain("Friday gym");
	    expect(
	      await readFile(path.join(root, ".micro-claw", "assistant", "chats", "local-tui", "memories.md"), "utf8")
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

	  test("renders briefings and forgets curated memories from shared commands", async () => {
	    const root = await mkdtemp(path.join(os.tmpdir(), "micro-claw-assistant-tui-brief-"));
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

	    const config = structuredClone(defaultConfig);
	    config.assistant.enableMemoryCuration = false;

	    const remember = await runAssistantTui({
	      root,
	      config,
	      initialPrompt: "/remember Friday gym",
	      interactive: false,
	      output: createCaptureWritable().sink,
	      env: {
	        https_proxy: "http://127.0.0.1:8083",
	        SSL_CERT_FILE: "/tmp/secretgate-ca.pem"
	      }
	    });
	    expect(remember.lastAssistantMessage).toBe("Saved to chat memory.");

	    const memoryState = JSON.parse(
	      await readFile(path.join(root, ".micro-claw", "assistant", "state.json"), "utf8")
	    ) as { users: Record<string, { memories: Array<{ id: string; text: string }> }> };
	    const memoryId = memoryState.users["local-tui"].memories[0].id.slice(-8);

	    const brief = await runAssistantTui({
	      root,
	      config,
	      initialPrompt: "/brief",
	      interactive: false,
	      output: createCaptureWritable().sink,
	      env: {
	        https_proxy: "http://127.0.0.1:8083",
	        SSL_CERT_FILE: "/tmp/secretgate-ca.pem"
	      }
	    });
	    expect(brief.lastAssistantMessage).toContain("# Brief");
	    expect(brief.lastAssistantMessage).toContain("Friday gym");

	    const forget = await runAssistantTui({
	      root,
	      config,
	      initialPrompt: `/forget ${memoryId}`,
	      interactive: false,
	      output: createCaptureWritable().sink,
	      env: {
	        https_proxy: "http://127.0.0.1:8083",
	        SSL_CERT_FILE: "/tmp/secretgate-ca.pem"
	      }
	    });
	    expect(forget.lastAssistantMessage).toContain("Forgot memory");
	  });
	});
