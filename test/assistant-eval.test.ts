import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { runAssistantEval } from "../src/evals/assistant-eval-runner.js";
import { assistantTaskCorpus } from "../src/evals/assistant-task-corpus.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("assistant eval runner", () => {
  test("has assistant tasks for the Telegram-first command surface", () => {
    expect(assistantTaskCorpus.length).toBeGreaterThanOrEqual(4);
    expect(assistantTaskCorpus.map((task) => task.command)).toContain("/brief");
    expect(assistantTaskCorpus.map((task) => task.command)).toContain("/inbox");
  });

  test("runs deterministic assistant command evals and writes a result artifact", async () => {
    const resultsDir = await mkdtemp(path.join(os.tmpdir(), "micro-claw-assistant-eval-results-"));
    tempDirs.push(resultsDir);

    const run = await runAssistantEval({
      resultsDir,
      modelProfile: "qwen3:4b",
      runtimeMode: "local"
    });

    expect(run.summary.totalTasks).toBe(assistantTaskCorpus.length);
    expect(run.summary.passRate).toBe(1);

    const saved = JSON.parse(
      await readFile(path.join(resultsDir, `assistant-run-${run.id}.json`), "utf8")
    ) as typeof run;
    expect(saved.id).toBe(run.id);
    expect(saved.taskResults.every((task) => task.passed)).toBe(true);
  });
});
