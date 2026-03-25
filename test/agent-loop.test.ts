import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { defaultConfig } from "../src/config/defaults.js";
import { runAgentLoop } from "../src/orchestrator/agent-loop.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("runAgentLoop", () => {
  test("creates session artifacts and runs discovered verification commands", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "micro-claw-run-"));
    tempDirs.push(root);

    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify(
        {
          name: "fixture",
          private: true,
          scripts: {
            build: 'node --eval "console.log(\\"build ok\\")"',
            test: 'node --eval "console.log(\\"test ok\\")"'
          }
        },
        null,
        2
      ),
      "utf8"
    );
    await writeFile(path.join(root, "src", "index.ts"), "export const ok = true;\n", "utf8");

    const result = await runAgentLoop({
      root,
      task: "build the project",
      config: defaultConfig
    });

    expect(result.outcome).toBe("done");
    expect(result.verification.status).toBe("passed");
    expect(result.repoSummary.buildCommands).toContain("npm run build");
    expect(result.repoSummary.testCommands).toContain("npm run test");

    const resultArtifact = JSON.parse(await readFile(path.join(result.sessionDir, "result.json"), "utf8")) as {
      task: string;
    };

    expect(resultArtifact.task).toBe("build the project");
  });
});
