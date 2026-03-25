import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { afterEach, describe, expect, test, vi } from "vitest";
import { saveAgentProfile } from "../src/agent/agent-profile.js";
import { defaultConfig } from "../src/config/defaults.js";
import { queueAgentTask, refreshAgentStatus, runResidentAgent } from "../src/agent/resident-agent.js";

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

describe("resident agent", () => {
  test("queues tasks and writes a readable status file", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "micro-claw-agent-status-"));
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

    const task = await queueAgentTask({
      root,
      prompt: "create a skill for curl smoke tests"
    });
    const status = await refreshAgentStatus(root, {
      note: "Status refreshed from test."
    });

    expect(task.status).toBe("queued");
    expect(status.counts.queued).toBe(1);
    expect(status.agentProfile.name).toBe("Clawy");
    expect(status.nextTasks[0]?.title).toContain("create a skill");

    const statusMarkdown = await readFile(path.join(root, ".micro-claw", "agent", "status.md"), "utf8");
    expect(statusMarkdown).toContain("Clawy Agent");
    expect(statusMarkdown).toContain("Behavior: brief and practical");
    expect(statusMarkdown).toContain("Queued: 1");
  });

  test("drains queued tasks through the chat tool loop", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "micro-claw-agent-run-"));
    tempDirs.push(root);

    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify(
        {
          name: "fixture",
          private: true,
          scripts: {
            build: 'node --eval "console.log(\\"build ok\\")"'
          }
        },
        null,
        2
      ),
      "utf8"
    );
    await writeFile(path.join(root, "src", "index.ts"), "export const ok = true;\n", "utf8");
    await saveAgentProfile(root, {
      name: "Clawy",
      behavior: "brief and practical"
    });

    await queueAgentTask({
      root,
      prompt: "create a skill for curl smoke tests"
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | RequestInfo) => {
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

        throw new Error(`Unexpected fetch URL: ${url}`);
      })
    );

    const capture = createCaptureWritable();
    const record = await runResidentAgent({
      root,
      config: defaultConfig,
      once: true,
      verify: false,
      env: {
        https_proxy: "http://127.0.0.1:8083",
        SSL_CERT_FILE: "/tmp/secretgate-ca.pem"
      },
      output: capture.sink
    });

    expect(record.processedTasks).toBe(1);
    expect(record.counts.queued).toBe(0);
    expect(record.counts.done).toBe(1);
    expect(record.lastTask?.status).toBe("done");

    const createdSkill = await readFile(path.join(root, "skills", "curl-smoke-tests", "SKILL.md"), "utf8");
    expect(createdSkill).toContain("curl-smoke-tests");

    const doneDirEntries = await readFile(path.join(root, ".micro-claw", "agent", "status.md"), "utf8");
    expect(doneDirEntries).toContain("Processed Tasks: 1");

    const output = capture.read();
    expect(output).toContain("agent> picked up");
    expect(output).toContain("progress> creating skill scaffold");
    expect(output).toContain("agent> completed");

    const heartbeatJson = JSON.parse(await readFile(path.join(root, ".micro-claw", "heartbeat.json"), "utf8")) as {
      status: string;
    };
    expect(["healthy", "degraded"]).toContain(heartbeatJson.status);
  });
});
