import { writeFile } from "node:fs/promises";
import process from "node:process";
import { Writable } from "node:stream";
import { createCliUi } from "../cli-ui.js";
import type { AgentStatusRecord, AgentTaskRecord, HeartbeatRecord, MicroClawConfig } from "../core/types.js";
import { toErrorMessage } from "../core/utils.js";
import { runChatSession } from "../chat/chat-session.js";
import { writeHeartbeat } from "../heartbeat/heartbeat-service.js";
import { resolveAgentProfile } from "./agent-profile.js";
import {
  claimNextAgentTask,
  createAgentTask,
  finalizeAgentTask,
  getAgentStatusPaths,
  listAgentTasks
} from "./task-queue.js";

export interface QueueAgentTaskOptions {
  root: string;
  prompt: string;
  source?: string;
  title?: string;
}

export interface RunResidentAgentOptions {
  root: string;
  config: MicroClawConfig;
  intervalSeconds?: number;
  verify?: boolean;
  once?: boolean;
  env?: NodeJS.ProcessEnv;
  output?: Writable;
}

function createSilentWritable(): Writable {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    }
  });
}

function isIncompleteAssistantMessage(message: string | undefined): boolean {
  if (!message) {
    return true;
  }

  return (
    message.startsWith("Tool-mode reply was not valid JSON.") ||
    message.startsWith("Stopped after reaching the tool step limit.")
  );
}

function formatAgentStatus(record: AgentStatusRecord): string {
  const lines = [
    `# ${record.agentProfile.name} Agent`,
    "",
    `Behavior: ${record.agentProfile.behavior}`,
    `Checked At: ${record.checkedAt}`,
    `Processed Tasks: ${record.processedTasks}`,
    `Note: ${record.note}`,
    "",
    "## Queue",
    `- Queued: ${record.counts.queued}`,
    `- Working: ${record.counts.working}`,
    `- Done: ${record.counts.done}`,
    `- Failed: ${record.counts.failed}`,
    "",
    "## Current Task",
    record.currentTask
      ? `- ${record.currentTask.title} (${record.currentTask.file})`
      : "- none",
    "",
    "## Next Tasks",
    ...(record.nextTasks.length > 0
      ? record.nextTasks.map((task) => `- ${task.title} (${task.file})`)
      : ["- none"]),
    "",
    "## Recent Completed",
    ...(record.recentCompleted.length > 0
      ? record.recentCompleted.map((task) => `- ${task.title} (${task.file})`)
      : ["- none"]),
    "",
    "## Recent Failed",
    ...(record.recentFailed.length > 0
      ? record.recentFailed.map((task) => `- ${task.title} (${task.file})`)
      : ["- none"]),
    "",
    "## Last Task",
    record.lastTask
      ? `- ${record.lastTask.title} [${record.lastTask.status}] (${record.lastTask.file})`
      : "- none",
    "",
    "## Heartbeat",
    record.heartbeatStatus
      ? `- Status: ${record.heartbeatStatus}`
      : "- Status: unavailable",
    record.heartbeatFile ? `- Markdown: ${record.heartbeatFile}` : "- Markdown: unavailable",
    record.heartbeatJsonFile ? `- JSON: ${record.heartbeatJsonFile}` : "- JSON: unavailable",
    ""
  ];

  return lines.join("\n");
}

async function writeAgentStatusRecord(record: AgentStatusRecord): Promise<AgentStatusRecord> {
  await writeFile(record.statusFile, formatAgentStatus(record), "utf8");
  await writeFile(record.statusJsonFile, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return record;
}

export async function refreshAgentStatus(
  root: string,
  options?: {
    note?: string;
    processedTasks?: number;
    lastTask?: AgentTaskRecord;
    heartbeat?: HeartbeatRecord;
  }
): Promise<AgentStatusRecord> {
  const overview = await listAgentTasks(root);
  const { statusFile, statusJsonFile } = getAgentStatusPaths(root);
  const agentProfile = await resolveAgentProfile({
    root,
    promptIfMissing: false
  });

  return writeAgentStatusRecord({
    checkedAt: new Date().toISOString(),
    root,
    agentProfile,
    counts: overview.counts,
    currentTask: overview.working[0]
      ? {
          id: overview.working[0].id,
          title: overview.working[0].title,
          file: overview.working[0].file
        }
      : undefined,
    nextTasks: overview.queued.slice(0, 5).map((task) => ({
      id: task.id,
      title: task.title,
      file: task.file
    })),
    recentCompleted: overview.done.slice(0, 5).map((task) => ({
      id: task.id,
      title: task.title,
      file: task.file,
      summary: task.summary
    })),
    recentFailed: overview.failed.slice(0, 5).map((task) => ({
      id: task.id,
      title: task.title,
      file: task.file,
      error: task.error
    })),
    lastTask: options?.lastTask
      ? {
          id: options.lastTask.id,
          title: options.lastTask.title,
          status: options.lastTask.status,
          file: options.lastTask.file,
          sessionDir: options.lastTask.sessionDir,
          summary: options.lastTask.summary,
          error: options.lastTask.error
        }
      : undefined,
    processedTasks: options?.processedTasks ?? 0,
    note: options?.note ?? "Agent status refreshed.",
    heartbeatStatus: options?.heartbeat?.status,
    heartbeatFile: options?.heartbeat?.heartbeatFile,
    heartbeatJsonFile: options?.heartbeat?.heartbeatJsonFile,
    statusFile,
    statusJsonFile
  });
}

export async function queueAgentTask(options: QueueAgentTaskOptions): Promise<AgentTaskRecord> {
  const task = await createAgentTask(options);
  await refreshAgentStatus(options.root, {
    note: `Queued task ${task.title}.`
  });
  return task;
}

async function runNextQueuedTask(
  options: Omit<RunResidentAgentOptions, "intervalSeconds" | "once"> & {
    heartbeat?: HeartbeatRecord;
    processedTasks: number;
  }
): Promise<{
  processed: boolean;
  lastTask?: AgentTaskRecord;
}> {
  const task = await claimNextAgentTask(options.root);
  if (!task) {
    return {
      processed: false
    };
  }

  const ui = createCliUi(options.output, options.env);
  options.output?.write(`${ui.formatAgent(`picked up ${task.title}`, "warning")}\n`);
  await refreshAgentStatus(options.root, {
    note: `Working on ${task.title}.`,
    processedTasks: options.processedTasks,
    lastTask: task,
    heartbeat: options.heartbeat
  });

  try {
    const chatResult = await runChatSession({
      root: options.root,
      config: options.config,
      initialPrompt: task.prompt,
      interactive: false,
      jsonMode: false,
      output: options.output ?? createSilentWritable(),
      env: options.env
    });

    const lastAssistantMessage = chatResult.lastAssistantMessage ?? "Task completed.";
    const incomplete = isIncompleteAssistantMessage(chatResult.lastAssistantMessage);
    const finalizedTask = await finalizeAgentTask({
      root: options.root,
      task,
      status: incomplete ? "failed" : "done",
      sessionId: chatResult.sessionId,
      sessionDir: chatResult.sessionDir,
      summary: lastAssistantMessage,
      error: incomplete ? "Agent loop did not finish with a clean final answer." : undefined
    });

    options.output?.write(
      `${ui.formatAgent(
        `${finalizedTask.status === "done" ? "completed" : "degraded"} ${finalizedTask.title}`,
        finalizedTask.status === "done" ? "success" : "warning"
      )}\n`
    );

    return {
      processed: true,
      lastTask: finalizedTask
    };
  } catch (error) {
    const finalizedTask = await finalizeAgentTask({
      root: options.root,
      task,
      status: "failed",
      summary: "Task execution failed.",
      error: toErrorMessage(error)
    });

    options.output?.write(`${ui.formatAgent(`failed ${finalizedTask.title}: ${finalizedTask.error}`, "danger")}\n`);

    return {
      processed: true,
      lastTask: finalizedTask
    };
  }
}

async function sleepWithStop(ms: number, shouldStop: () => boolean): Promise<void> {
  if (ms <= 0) {
    return;
  }

  const stepMs = 250;
  let remaining = ms;

  while (remaining > 0 && !shouldStop()) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, Math.min(stepMs, remaining));
    });
    remaining -= stepMs;
  }
}

export async function runResidentAgent(options: RunResidentAgentOptions): Promise<AgentStatusRecord> {
  const intervalSeconds = options.intervalSeconds ?? options.config.security.defaultHeartbeatIntervalSeconds;
  await resolveAgentProfile({
    root: options.root,
    output: options.output,
    promptIfMissing: Boolean(options.output && process.stdin.isTTY && process.stdout.isTTY)
  });
  let iteration = 1;
  let totalProcessedTasks = 0;
  let stopRequested = false;
  let lastRecord: AgentStatusRecord | undefined;
  let lastTask: AgentTaskRecord | undefined;

  const onStop = () => {
    stopRequested = true;
  };

  process.on("SIGINT", onStop);
  process.on("SIGTERM", onStop);

  try {
    do {
      const heartbeat = await writeHeartbeat({
        root: options.root,
        config: options.config,
        intervalSeconds,
        iteration,
        verify: options.verify,
        env: options.env
      });

      lastRecord = await refreshAgentStatus(options.root, {
        note: "Heartbeat refreshed. Draining queued tasks.",
        processedTasks: totalProcessedTasks,
        lastTask,
        heartbeat
      });

      let processedThisCycle = 0;
      while (!stopRequested) {
        const next = await runNextQueuedTask({
          root: options.root,
          config: options.config,
          verify: options.verify,
          env: options.env,
          output: options.output,
          heartbeat,
          processedTasks: totalProcessedTasks
        });

        if (!next.processed) {
          break;
        }

        processedThisCycle += 1;
        totalProcessedTasks += 1;
        lastTask = next.lastTask;

        lastRecord = await refreshAgentStatus(options.root, {
          note: `${next.lastTask?.status === "failed" ? "Finished with issues" : "Finished"} ${next.lastTask?.title ?? "task"}.`,
          processedTasks: totalProcessedTasks,
          lastTask,
          heartbeat
        });
      }

      lastRecord = await refreshAgentStatus(options.root, {
        note:
          processedThisCycle > 0
            ? `Processed ${processedThisCycle} task(s) in this cycle.`
            : "Agent is idle and waiting for queued tasks.",
        processedTasks: totalProcessedTasks,
        lastTask,
        heartbeat
      });

      if (options.once) {
        return lastRecord;
      }

      iteration += 1;
      await sleepWithStop(intervalSeconds * 1_000, () => stopRequested);
    } while (!stopRequested);
  } finally {
    process.off("SIGINT", onStop);
    process.off("SIGTERM", onStop);
  }

  if (!lastRecord) {
    return refreshAgentStatus(options.root, {
      note: "Agent stopped before completing a cycle.",
      processedTasks: totalProcessedTasks,
      lastTask
    });
  }

  return lastRecord;
}
