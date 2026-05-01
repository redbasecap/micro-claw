import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaultConfig } from "../config/defaults.js";
import type { MicroClawConfig } from "../core/types.js";
import { timestampId } from "../core/utils.js";
import { handleAssistantCommand } from "../assistant/commands.js";
import { addAssistantMemory, addAssistantReminder, addAssistantTodo, touchAssistantUser } from "../assistant/store.js";
import { parseReminderRequest } from "../assistant/reminder-parser.js";
import { addAssistantScheduledTask } from "../assistant/schedule-store.js";
import { parseAssistantScheduleRequest } from "../assistant/schedule-parser.js";
import { assistantTaskCorpus, type AssistantEvalTask } from "./assistant-task-corpus.js";

export interface AssistantEvalTaskResult {
  taskId: string;
  title: string;
  command: string;
  passed: boolean;
  durationMs: number;
  reply: string;
  missingPatterns: string[];
}

export interface AssistantEvalRun {
  id: string;
  runAt: string;
  modelProfile: string;
  runtimeMode: "local" | "remote";
  resultsDir: string;
  taskResults: AssistantEvalTaskResult[];
  summary: {
    totalTasks: number;
    passedTasks: number;
    failedTasks: number;
    passRate: number;
    avgDurationMs: number;
  };
}

export interface RunAssistantEvalOptions {
  resultsDir: string;
  modelProfile: string;
  runtimeMode: "local" | "remote";
  config?: MicroClawConfig;
}

function createEvalConfig(options: RunAssistantEvalOptions): MicroClawConfig {
  return {
    ...(options.config ?? defaultConfig),
    runtime: {
      ...(options.config ?? defaultConfig).runtime,
      mode: options.runtimeMode
    },
    provider: {
      ...(options.config ?? defaultConfig).provider,
      kind: options.runtimeMode === "remote" ? "openai-compatible" : "ollama",
      model: options.modelProfile
    },
    assistant: {
      ...(options.config ?? defaultConfig).assistant,
      replyModel: options.modelProfile,
      memoryModel: options.modelProfile,
      briefingModel: options.modelProfile,
      enableMemoryCuration: false
    }
  };
}

async function seedAssistantFixture(root: string, config: MicroClawConfig, chatId: string): Promise<void> {
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "assistant-eval-fixture", private: true }, null, 2),
    "utf8"
  );
  await touchAssistantUser(root, config, chatId, {
    username: "eval",
    displayName: "Eval User"
  });
  await addAssistantTodo(root, config, chatId, "Buy oat milk");
  await addAssistantReminder(root, config, chatId, parseReminderRequest("today 18:30 review plan"));
  await addAssistantMemory(root, config, chatId, {
    text: "Works from home on Friday.",
    kind: "routine",
    source: "manual",
    confidence: 1
  });
  await addAssistantScheduledTask(
    root,
    config,
    chatId,
    parseAssistantScheduleRequest("daily 09:00 | morning plan")
  );
}

async function runAssistantEvalTask(
  task: AssistantEvalTask,
  root: string,
  config: MicroClawConfig,
  chatId: string
): Promise<AssistantEvalTaskResult> {
  const started = Date.now();
  const user = await touchAssistantUser(root, config, chatId);
  const result = await handleAssistantCommand({
    root,
    config,
    chatId,
    line: task.command,
    user,
    allowExit: false
  });
  const reply = result.reply ?? "";
  const missingPatterns = task.expectedPatterns.filter((pattern) => !new RegExp(pattern, "i").test(reply));

  return {
    taskId: task.id,
    title: task.title,
    command: task.command,
    passed: result.handled && missingPatterns.length === 0,
    durationMs: Date.now() - started,
    reply,
    missingPatterns
  };
}

export async function runAssistantEval(options: RunAssistantEvalOptions): Promise<AssistantEvalRun> {
  const runId = timestampId();
  const runAt = new Date().toISOString();
  const config = createEvalConfig(options);
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "micro-claw-assistant-eval-"));
  const chatId = "assistant-eval";

  try {
    await seedAssistantFixture(tempRoot, config, chatId);
    const taskResults: AssistantEvalTaskResult[] = [];
    for (const task of assistantTaskCorpus) {
      taskResults.push(await runAssistantEvalTask(task, tempRoot, config, chatId));
    }

    const passedTasks = taskResults.filter((result) => result.passed).length;
    const run: AssistantEvalRun = {
      id: runId,
      runAt,
      modelProfile: options.modelProfile,
      runtimeMode: options.runtimeMode,
      resultsDir: options.resultsDir,
      taskResults,
      summary: {
        totalTasks: taskResults.length,
        passedTasks,
        failedTasks: taskResults.length - passedTasks,
        passRate: taskResults.length > 0 ? passedTasks / taskResults.length : 0,
        avgDurationMs:
          taskResults.length > 0
            ? taskResults.reduce((sum, result) => sum + result.durationMs, 0) / taskResults.length
            : 0
      }
    };

    await writeFile(
      path.join(options.resultsDir, `assistant-run-${runId}.json`),
      `${JSON.stringify(run, null, 2)}\n`,
      "utf8"
    ).catch(async (error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }

      await import("node:fs/promises").then(({ mkdir }) => mkdir(options.resultsDir, { recursive: true }));
      await writeFile(path.join(options.resultsDir, `assistant-run-${runId}.json`), `${JSON.stringify(run, null, 2)}\n`, "utf8");
    });

    return run;
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}
