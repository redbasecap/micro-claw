import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import type { AgentQueueCounts, AgentTaskRecord, AgentTaskStatus } from "../core/types.js";
import { assertWithinRoot, slugify, timestampId } from "../core/utils.js";

const AGENT_ROOT = ".micro-claw/agent";
const TASK_ROOT = `${AGENT_ROOT}/tasks`;

interface AgentPaths {
  rootDir: string;
  statusFile: string;
  statusJsonFile: string;
  taskDirs: Record<AgentTaskStatus, string>;
}

export interface CreateAgentTaskOptions {
  root: string;
  prompt: string;
  source?: string;
  title?: string;
}

export interface FinalizeAgentTaskOptions {
  root: string;
  task: AgentTaskRecord;
  status: Extract<AgentTaskStatus, "done" | "failed">;
  sessionId?: string;
  sessionDir?: string;
  summary?: string;
  error?: string;
}

export interface AgentTaskOverview {
  counts: AgentQueueCounts;
  queued: AgentTaskRecord[];
  working: AgentTaskRecord[];
  done: AgentTaskRecord[];
  failed: AgentTaskRecord[];
}

function normalizePrompt(prompt: string): string {
  return prompt.trim().replace(/\r\n/g, "\n");
}

function buildTaskTitle(prompt: string): string {
  const firstLine = normalizePrompt(prompt).split("\n")[0]?.trim() ?? "agent task";
  return firstLine.length <= 80 ? firstLine : `${firstLine.slice(0, 77)}...`;
}

function getAgentPaths(root: string): AgentPaths {
  const rootDir = assertWithinRoot(root, AGENT_ROOT);
  return {
    rootDir,
    statusFile: assertWithinRoot(root, `${AGENT_ROOT}/status.md`),
    statusJsonFile: assertWithinRoot(root, `${AGENT_ROOT}/status.json`),
    taskDirs: {
      queued: assertWithinRoot(root, `${TASK_ROOT}/queued`),
      working: assertWithinRoot(root, `${TASK_ROOT}/working`),
      done: assertWithinRoot(root, `${TASK_ROOT}/done`),
      failed: assertWithinRoot(root, `${TASK_ROOT}/failed`)
    }
  };
}

function toRelative(root: string, absolutePath: string): string {
  return path.relative(root, absolutePath).replaceAll(path.sep, "/");
}

function buildTaskMetadata(task: AgentTaskRecord): Record<string, unknown> {
  return {
    id: task.id,
    slug: task.slug,
    title: task.title,
    status: task.status,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    source: task.source,
    attempts: task.attempts,
    sessionId: task.sessionId,
    sessionDir: task.sessionDir,
    summary: task.summary,
    error: task.error
  };
}

function formatTaskResult(task: AgentTaskRecord): string {
  const parts = [task.summary?.trim(), task.error ? `Error: ${task.error}` : undefined].filter(
    (value): value is string => typeof value === "string" && value.length > 0
  );
  return parts.join("\n\n");
}

function formatTaskMarkdown(task: AgentTaskRecord): string {
  const metadata = YAML.stringify(buildTaskMetadata(task)).trimEnd();
  const resultBody = formatTaskResult(task);

  return [
    "---",
    metadata,
    "---",
    "# Prompt",
    "",
    normalizePrompt(task.prompt) || "(empty)",
    "",
    "# Result",
    "",
    resultBody || "Pending.",
    ""
  ].join("\n");
}

function parseTaskBody(body: string): { prompt: string; summary?: string; error?: string } {
  const trimmed = body.replace(/^\s+/, "");
  const promptMarker = "# Prompt\n\n";
  const resultMarker = "\n# Result\n\n";

  if (!trimmed.startsWith(promptMarker)) {
    throw new Error("Invalid task markdown: missing prompt section.");
  }

  const resultIndex = trimmed.indexOf(resultMarker);
  if (resultIndex < 0) {
    return {
      prompt: trimmed.slice(promptMarker.length).trim()
    };
  }

  const prompt = trimmed.slice(promptMarker.length, resultIndex).trim();
  const result = trimmed.slice(resultIndex + resultMarker.length).trim();
  const errorPrefix = "Error: ";

  if (!result) {
    return { prompt };
  }

  if (result.startsWith(errorPrefix) && !result.includes("\n\n")) {
    return {
      prompt,
      error: result.slice(errorPrefix.length).trim()
    };
  }

  if (result.includes("\n\nError: ")) {
    const [summary, error] = result.split("\n\nError: ", 2);
    return {
      prompt,
      summary: summary.trim(),
      error: error.trim()
    };
  }

  return {
    prompt,
    summary: result
  };
}

async function writeTaskFile(root: string, absolutePath: string, task: AgentTaskRecord): Promise<AgentTaskRecord> {
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, formatTaskMarkdown(task), "utf8");
  return {
    ...task,
    file: toRelative(root, absolutePath)
  };
}

async function readTaskFile(root: string, absolutePath: string): Promise<AgentTaskRecord> {
  const content = await readFile(absolutePath, "utf8");
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);

  if (!frontmatterMatch) {
    throw new Error(`Invalid task file: ${absolutePath}`);
  }

  const metadata = YAML.parse(frontmatterMatch[1]) as Record<string, unknown>;
  const parsedBody = parseTaskBody(frontmatterMatch[2]);

  return {
    id: String(metadata.id ?? ""),
    slug: String(metadata.slug ?? ""),
    title: String(metadata.title ?? ""),
    status: String(metadata.status ?? "queued") as AgentTaskStatus,
    createdAt: String(metadata.createdAt ?? ""),
    updatedAt: String(metadata.updatedAt ?? ""),
    source: String(metadata.source ?? "unknown"),
    attempts: Number(metadata.attempts ?? 0),
    prompt: parsedBody.prompt,
    file: toRelative(root, absolutePath),
    sessionId: typeof metadata.sessionId === "string" ? metadata.sessionId : undefined,
    sessionDir: typeof metadata.sessionDir === "string" ? metadata.sessionDir : undefined,
    summary:
      parsedBody.summary ??
      (typeof metadata.summary === "string" && metadata.summary.length > 0 ? metadata.summary : undefined),
    error:
      parsedBody.error ??
      (typeof metadata.error === "string" && metadata.error.length > 0 ? metadata.error : undefined)
  };
}

async function readTasksFromDirectory(root: string, directory: string): Promise<AgentTaskRecord[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => path.join(directory, entry.name))
    .sort((left, right) => path.basename(left).localeCompare(path.basename(right)));

  const tasks: AgentTaskRecord[] = [];
  for (const file of files) {
    tasks.push(await readTaskFile(root, file));
  }
  return tasks;
}

export async function ensureAgentWorkspace(root: string): Promise<AgentPaths> {
  const paths = getAgentPaths(root);
  await mkdir(paths.rootDir, { recursive: true });
  await Promise.all(Object.values(paths.taskDirs).map((directory) => mkdir(directory, { recursive: true })));
  return paths;
}

export async function createAgentTask(options: CreateAgentTaskOptions): Promise<AgentTaskRecord> {
  const prompt = normalizePrompt(options.prompt);
  if (!prompt) {
    throw new Error("Agent task prompt cannot be empty.");
  }

  const paths = await ensureAgentWorkspace(options.root);
  const createdAt = new Date().toISOString();
  const baseTitle = options.title?.trim() || buildTaskTitle(prompt);
  const slug = slugify(baseTitle || "task") || "task";
  const id = timestampId(new Date());
  const targetPath = path.join(paths.taskDirs.queued, `${id}-${slug}.md`);
  const task: AgentTaskRecord = {
    id,
    slug,
    title: baseTitle,
    prompt,
    status: "queued",
    createdAt,
    updatedAt: createdAt,
    source: options.source?.trim() || "cli",
    attempts: 0,
    file: toRelative(options.root, targetPath)
  };

  return writeTaskFile(options.root, targetPath, task);
}

export async function listAgentTasks(root: string): Promise<AgentTaskOverview> {
  const paths = await ensureAgentWorkspace(root);
  const [queued, working, doneAscending, failedAscending] = await Promise.all([
    readTasksFromDirectory(root, paths.taskDirs.queued),
    readTasksFromDirectory(root, paths.taskDirs.working),
    readTasksFromDirectory(root, paths.taskDirs.done),
    readTasksFromDirectory(root, paths.taskDirs.failed)
  ]);

  const done = doneAscending.reverse();
  const failed = failedAscending.reverse();

  return {
    counts: {
      queued: queued.length,
      working: working.length,
      done: done.length,
      failed: failed.length
    },
    queued,
    working,
    done,
    failed
  };
}

export async function claimNextAgentTask(root: string): Promise<AgentTaskRecord | undefined> {
  const paths = await ensureAgentWorkspace(root);
  const queuedTasks = await readTasksFromDirectory(root, paths.taskDirs.queued);
  const nextTask = queuedTasks[0];

  if (!nextTask) {
    return undefined;
  }

  const sourcePath = assertWithinRoot(root, nextTask.file);
  const targetPath = path.join(paths.taskDirs.working, path.basename(sourcePath));
  await rename(sourcePath, targetPath);

  const workingTask: AgentTaskRecord = {
    ...nextTask,
    status: "working",
    attempts: nextTask.attempts + 1,
    updatedAt: new Date().toISOString(),
    file: toRelative(root, targetPath)
  };

  return writeTaskFile(root, targetPath, workingTask);
}

export async function finalizeAgentTask(options: FinalizeAgentTaskOptions): Promise<AgentTaskRecord> {
  const paths = await ensureAgentWorkspace(options.root);
  const sourcePath = assertWithinRoot(options.root, options.task.file);
  const targetPath = path.join(paths.taskDirs[options.status], path.basename(sourcePath));
  await rename(sourcePath, targetPath);

  const finalizedTask: AgentTaskRecord = {
    ...options.task,
    status: options.status,
    updatedAt: new Date().toISOString(),
    file: toRelative(options.root, targetPath),
    sessionId: options.sessionId ?? options.task.sessionId,
    sessionDir: options.sessionDir ?? options.task.sessionDir,
    summary: options.summary ?? options.task.summary,
    error: options.error
  };

  return writeTaskFile(options.root, targetPath, finalizedTask);
}

export function getAgentStatusPaths(root: string): Pick<AgentPaths, "statusFile" | "statusJsonFile"> {
  const paths = getAgentPaths(root);
  return {
    statusFile: paths.statusFile,
    statusJsonFile: paths.statusJsonFile
  };
}
