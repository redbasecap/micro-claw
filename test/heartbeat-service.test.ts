import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { defaultConfig } from "../src/config/defaults.js";
import { writeHeartbeat } from "../src/heartbeat/heartbeat-service.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("writeHeartbeat", () => {
  test("writes heartbeat markdown and json artifacts", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "micro-claw-heartbeat-"));
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

    const record = await writeHeartbeat({
      root,
      config: defaultConfig,
      intervalSeconds: 60,
      iteration: 1,
      verify: false,
      env: {
        https_proxy: "http://127.0.0.1:8083",
        SSL_CERT_FILE: "/tmp/secretgate-ca.pem"
      }
    });

    expect(["healthy", "degraded"]).toContain(record.status);
    expect(record.boundary.ok).toBe(true);
    expect(record.verification.status).toBe("skipped");

    const markdown = await readFile(path.join(root, "heartbeat.md"), "utf8");
    const json = JSON.parse(await readFile(path.join(root, ".micro-claw", "heartbeat.json"), "utf8")) as {
      status: string;
    };

    expect(markdown).toContain("Micro Claw Heartbeat");
    expect(["healthy", "degraded"]).toContain(json.status);
  });
});
