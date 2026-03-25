import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AssistantReminder, AssistantTodo, AssistantUserState, MicroClawConfig } from "../core/types.js";
import { assertWithinRoot, pathExists } from "../core/utils.js";
import { formatReminderDate } from "./reminder-parser.js";

const MEMORY_FILE_NAME = "CLAUDE.md";
const OVERVIEW_FILE_NAME = "README.md";
const NOTES_FILE_NAME = "notes.md";
const TODOS_FILE_NAME = "todos.md";
const REMINDERS_FILE_NAME = "reminders.md";

function toWorkspaceSlug(chatId: string): string {
  const normalized = chatId.trim().replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return normalized || "chat";
}

function formatTodo(todo: AssistantTodo): string {
  return `${todo.id.slice(0, 8)} ${todo.completedAt ? "[done]" : "[open]"} ${todo.text}`;
}

function formatReminder(reminder: AssistantReminder): string {
  return `${reminder.id.slice(0, 8)} [${reminder.deliveredAt ? "sent" : "pending"}] ${formatReminderDate(reminder.dueAt)} ${reminder.text}`;
}

function buildListMarkdown(title: string, lines: string[], emptyLine: string): string {
  return [
    `# ${title}`,
    "",
    ...(lines.length > 0 ? lines.map((line) => `- ${line}`) : [emptyLine]),
    ""
  ].join("\n");
}

function buildMemoryTemplate(user: AssistantUserState): string {
  return [
    `# Chat Workspace ${user.chatId}`,
    "",
    "This file is the persistent memory for one Telegram chat.",
    "Keep stable preferences, facts, and long-running context here.",
    "",
    "## Identity",
    `- Chat ID: ${user.chatId}`,
    `- Display Name: ${user.displayName ?? "unknown"}`,
    `- Username: ${user.username ?? "unknown"}`,
    "",
    "## Persistent Memory",
    "- Add durable facts here.",
    ""
  ].join("\n");
}

function buildOverview(user: AssistantUserState, relativeDir: string): string {
  const openTodos = user.todos.filter((todo) => !todo.completedAt).length;
  const pendingReminders = user.reminders.filter((reminder) => !reminder.deliveredAt).length;

  return [
    `# Chat Workspace ${user.chatId}`,
    "",
    `Workspace: ${relativeDir}`,
    `Display Name: ${user.displayName ?? "unknown"}`,
    `Username: ${user.username ?? "unknown"}`,
    `Last Seen: ${user.lastSeenAt}`,
    "",
    "## Snapshot",
    `- Notes: ${user.notes.length}`,
    `- Open Todos: ${openTodos}`,
    `- Pending Reminders: ${pendingReminders}`,
    `- Conversation Entries: ${user.conversation.length}`,
    "",
    "## Files",
    `- ${MEMORY_FILE_NAME}`,
    `- ${NOTES_FILE_NAME}`,
    `- ${TODOS_FILE_NAME}`,
    `- ${REMINDERS_FILE_NAME}`,
    ""
  ].join("\n");
}

export interface AssistantWorkspacePaths {
  dir: string;
  relativeDir: string;
  memoryFile: string;
  overviewFile: string;
  notesFile: string;
  todosFile: string;
  remindersFile: string;
}

export function getAssistantWorkspacePaths(
  root: string,
  config: MicroClawConfig,
  chatId: string
): AssistantWorkspacePaths {
  const relativeDir = path.join(config.assistant.workspacesDir, toWorkspaceSlug(chatId));
  const dir = assertWithinRoot(root, relativeDir);

  return {
    dir,
    relativeDir,
    memoryFile: path.join(dir, MEMORY_FILE_NAME),
    overviewFile: path.join(dir, OVERVIEW_FILE_NAME),
    notesFile: path.join(dir, NOTES_FILE_NAME),
    todosFile: path.join(dir, TODOS_FILE_NAME),
    remindersFile: path.join(dir, REMINDERS_FILE_NAME)
  };
}

export async function ensureAssistantWorkspace(
  root: string,
  config: MicroClawConfig,
  user: AssistantUserState
): Promise<AssistantWorkspacePaths> {
  const paths = getAssistantWorkspacePaths(root, config, user.chatId);
  await mkdir(paths.dir, { recursive: true });

  if (!(await pathExists(paths.memoryFile))) {
    await writeFile(paths.memoryFile, buildMemoryTemplate(user), "utf8");
  }

  return paths;
}

export async function syncAssistantWorkspace(
  root: string,
  config: MicroClawConfig,
  user: AssistantUserState
): Promise<AssistantWorkspacePaths> {
  const paths = await ensureAssistantWorkspace(root, config, user);

  await writeFile(paths.overviewFile, buildOverview(user, paths.relativeDir), "utf8");
  await writeFile(
    paths.notesFile,
    buildListMarkdown(
      "Notes",
      user.notes.map((note) => `${note.id.slice(0, 8)} ${note.text}`),
      "No notes saved yet."
    ),
    "utf8"
  );
  await writeFile(
    paths.todosFile,
    buildListMarkdown("Todos", user.todos.map((todo) => formatTodo(todo)), "No todos saved yet."),
    "utf8"
  );
  await writeFile(
    paths.remindersFile,
    buildListMarkdown(
      "Reminders",
      user.reminders.map((reminder) => formatReminder(reminder)),
      "No reminders saved yet."
    ),
    "utf8"
  );

  return paths;
}

export async function readAssistantWorkspaceMemory(
  root: string,
  config: MicroClawConfig,
  chatId: string
): Promise<string> {
  const paths = getAssistantWorkspacePaths(root, config, chatId);
  if (!(await pathExists(paths.memoryFile))) {
    return "No chat workspace memory is stored yet.";
  }

  return readFile(paths.memoryFile, "utf8");
}

export async function appendAssistantWorkspaceMemory(
  root: string,
  config: MicroClawConfig,
  user: AssistantUserState,
  text: string
): Promise<AssistantWorkspacePaths> {
  const paths = await ensureAssistantWorkspace(root, config, user);
  const trimmed = text.trim();
  const source = await readAssistantWorkspaceMemory(root, config, user.chatId);
  const entry = `- ${new Date().toISOString()}: ${trimmed}`;
  const next = source.startsWith("No chat workspace memory is stored yet.")
    ? `${buildMemoryTemplate(user).trimEnd()}\n${entry}\n`
    : `${source.trimEnd()}\n${entry}\n`;

  await writeFile(paths.memoryFile, next, "utf8");
  await syncAssistantWorkspace(root, config, user);
  return paths;
}
