import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  AssistantScheduleParseResult,
  AssistantScheduleState,
  AssistantScheduledTask,
  MicroClawConfig
} from "../core/types.js";
import { assertWithinRoot, pathExists, timestampId, truncate } from "../core/utils.js";
import { computeNextAssistantScheduleRun, formatAssistantSchedule } from "./schedule-parser.js";
import { formatReminderDate } from "./reminder-parser.js";

function getAssistantSchedulePaths(root: string, config: MicroClawConfig): {
  stateFile: string;
  summaryFile: string;
} {
  return {
    stateFile: assertWithinRoot(root, config.assistant.schedulesFile),
    summaryFile: assertWithinRoot(root, config.assistant.schedulesSummaryFile)
  };
}

function createEmptyScheduleState(now = new Date()): AssistantScheduleState {
  return {
    version: 1,
    updatedAt: now.toISOString(),
    tasks: []
  };
}

function sortTasks(tasks: AssistantScheduledTask[]): AssistantScheduledTask[] {
  return [...tasks].sort((left, right) => {
    const nextRunCompare = left.nextRunAt.localeCompare(right.nextRunAt);
    if (nextRunCompare !== 0) {
      return nextRunCompare;
    }

    return left.id.localeCompare(right.id);
  });
}

function formatScheduleSummary(state: AssistantScheduleState): string {
  const tasks = sortTasks(state.tasks);

  return [
    "# Micro Claw Scheduled Tasks",
    "",
    `Updated At: ${state.updatedAt}`,
    `Tasks: ${tasks.length}`,
    "",
    ...(tasks.length > 0
      ? tasks.flatMap((task) => [
          `## ${task.id.slice(0, 8)} ${formatAssistantSchedule(task.schedule)}`,
          "",
          `Chat ID: ${task.chatId}`,
          `Next Run: ${formatReminderDate(task.nextRunAt)}`,
          `Prompt: ${task.prompt}`,
          `Last Run: ${task.lastRunAt ? formatReminderDate(task.lastRunAt) : "never"}`,
          `Last Result: ${task.lastResultSummary ?? "none"}`,
          `Last Error: ${task.lastError ?? "none"}`,
          ""
        ])
      : ["No scheduled tasks saved yet.", ""])
  ].join("\n");
}

async function saveAssistantScheduleState(
  root: string,
  config: MicroClawConfig,
  state: AssistantScheduleState
): Promise<AssistantScheduleState> {
  const paths = getAssistantSchedulePaths(root, config);
  const next = {
    ...state,
    updatedAt: new Date().toISOString(),
    tasks: sortTasks(state.tasks)
  };

  await mkdir(path.dirname(paths.stateFile), { recursive: true });
  await mkdir(path.dirname(paths.summaryFile), { recursive: true });
  await writeFile(paths.stateFile, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  await writeFile(paths.summaryFile, formatScheduleSummary(next), "utf8");
  return next;
}

export async function loadAssistantScheduleState(
  root: string,
  config: MicroClawConfig
): Promise<AssistantScheduleState> {
  const { stateFile } = getAssistantSchedulePaths(root, config);
  if (!(await pathExists(stateFile))) {
    return createEmptyScheduleState();
  }

  const source = await readFile(stateFile, "utf8");
  const parsed = JSON.parse(source) as Partial<AssistantScheduleState>;

  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.tasks)) {
    throw new Error(`Invalid assistant schedules state: ${stateFile}`);
  }

  return {
    version: typeof parsed.version === "number" ? parsed.version : 1,
    updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
    tasks: parsed.tasks as AssistantScheduledTask[]
  };
}

export async function addAssistantScheduledTask(
  root: string,
  config: MicroClawConfig,
  chatId: string,
  schedule: AssistantScheduleParseResult
): Promise<AssistantScheduledTask> {
  const now = new Date().toISOString();
  const created: AssistantScheduledTask = {
    id: timestampId(),
    chatId,
    prompt: schedule.prompt.trim(),
    createdAt: now,
    updatedAt: now,
    nextRunAt: schedule.nextRunAt,
    schedule: schedule.schedule
  };

  const state = await loadAssistantScheduleState(root, config);
  state.tasks.push(created);
  const saved = await saveAssistantScheduleState(root, config, state);
  return saved.tasks.find((task) => task.id === created.id) ?? created;
}

export async function listAssistantScheduledTasks(
  root: string,
  config: MicroClawConfig,
  chatId?: string
): Promise<AssistantScheduledTask[]> {
  const state = await loadAssistantScheduleState(root, config);
  const tasks = chatId ? state.tasks.filter((task) => task.chatId === chatId) : state.tasks;
  return sortTasks(tasks);
}

export async function removeAssistantScheduledTask(
  root: string,
  config: MicroClawConfig,
  chatId: string,
  taskIdPrefix: string
): Promise<AssistantScheduledTask | undefined> {
  const normalized = taskIdPrefix.trim().toLowerCase();
  const state = await loadAssistantScheduleState(root, config);
  const matches = state.tasks.filter(
    (task) => task.chatId === chatId && task.id.toLowerCase().startsWith(normalized)
  );

  if (matches.length > 1) {
    throw new Error(`Multiple scheduled tasks match ${taskIdPrefix}. Use more of the id.`);
  }

  if (matches.length === 0) {
    return undefined;
  }

  const removed = matches[0];
  state.tasks = state.tasks.filter((task) => task.id !== removed.id);
  await saveAssistantScheduleState(root, config, state);
  return removed;
}

export async function listDueAssistantScheduledTasks(
  root: string,
  config: MicroClawConfig,
  now = new Date()
): Promise<AssistantScheduledTask[]> {
  const state = await loadAssistantScheduleState(root, config);
  const nowMs = now.getTime();
  return sortTasks(
    state.tasks.filter((task) => {
      const dueAt = new Date(task.nextRunAt);
      return !Number.isNaN(dueAt.getTime()) && dueAt.getTime() <= nowMs;
    })
  );
}

export async function markAssistantScheduledTaskRun(
  root: string,
  config: MicroClawConfig,
  taskId: string,
  input: {
    lastRunAt: string;
    lastResultSummary?: string;
    lastError?: string;
  }
): Promise<AssistantScheduledTask | undefined> {
  const state = await loadAssistantScheduleState(root, config);
  const task = state.tasks.find((entry) => entry.id === taskId);
  if (!task) {
    return undefined;
  }

  task.lastRunAt = input.lastRunAt;
  task.lastResultSummary = input.lastResultSummary
    ? truncate(input.lastResultSummary.trim(), 240).replace(/\s+/g, " ")
    : undefined;
  task.lastError = input.lastError ? truncate(input.lastError.trim(), 240).replace(/\s+/g, " ") : undefined;
  task.updatedAt = new Date().toISOString();
  task.nextRunAt = computeNextAssistantScheduleRun(task, new Date(input.lastRunAt));

  const saved = await saveAssistantScheduleState(root, config, state);
  return saved.tasks.find((entry) => entry.id === taskId);
}

export function formatAssistantScheduledTaskList(tasks: AssistantScheduledTask[]): string {
  if (tasks.length === 0) {
    return "No scheduled tasks.";
  }

  return tasks
    .slice(0, 10)
    .map(
      (task) =>
        `- ${task.id.slice(0, 8)} ${formatAssistantSchedule(task.schedule)} next ${formatReminderDate(
          task.nextRunAt
        )} :: ${truncate(task.prompt, 120).replace(/\s+/g, " ")}`
    )
    .join("\n");
}
