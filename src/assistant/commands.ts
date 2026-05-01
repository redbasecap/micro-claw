import type { AssistantUserState, MicroClawConfig } from "../core/types.js";
import { toErrorMessage, truncate } from "../core/utils.js";
import { buildAssistantBriefing } from "./briefing.js";
import { formatReminderDate, parseReminderRequest } from "./reminder-parser.js";
import { computeNextAssistantScheduleRun, formatAssistantSchedule, parseAssistantScheduleRequest } from "./schedule-parser.js";
import {
  addAssistantScheduledTask,
  formatAssistantScheduledTaskList,
  listAssistantScheduledTasks,
  removeAssistantScheduledTask
} from "./schedule-store.js";
import {
  addAssistantMemory,
  addAssistantNote,
  addAssistantReminder,
  addAssistantTodo,
  completeAssistantTodo,
  forgetAssistantMemory,
  getAssistantUserState
} from "./store.js";
import { appendAssistantWorkspaceMemory, getAssistantWorkspacePaths, readAssistantWorkspaceMemory } from "./workspace.js";

export const ASSISTANT_HELP_LINES = [
  "/help",
  "/status",
  "/whoami",
  "/workspace",
  "/memory",
  "/brief",
  "/today",
  "/review",
  "/inbox",
  "/remember <text>",
  "/forget <id-prefix>",
  "/note <text>",
  "/notes",
  "/todo <text>",
  "/todos",
  "/done <id-prefix>",
  "/remind in 2h buy milk",
  "/reminders",
  "/schedule every 2h | stretch",
  "/schedules",
  "/unschedule <id-prefix>",
  "/exit"
] as const;

export interface AssistantCommand {
  command: string;
  args: string;
}

export interface AssistantCommandResult {
  handled: boolean;
  reply?: string;
  exit?: boolean;
  user?: AssistantUserState;
}

export function parseAssistantCommand(text: string): AssistantCommand | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) {
    return undefined;
  }

  const firstSpace = trimmed.indexOf(" ");
  if (firstSpace < 0) {
    return {
      command: trimmed.slice(1).split("@")[0].toLowerCase(),
      args: ""
    };
  }

  return {
    command: trimmed.slice(1, firstSpace).split("@")[0].toLowerCase(),
    args: trimmed.slice(firstSpace + 1).trim()
  };
}

export function formatAssistantHelp(includeExit = true): string {
  const lines = includeExit ? ASSISTANT_HELP_LINES : ASSISTANT_HELP_LINES.filter((line) => line !== "/exit");
  return ["Commands:", ...lines].join("\n");
}

function formatNotes(user: AssistantUserState | undefined): string {
  if (!user || user.notes.length === 0) {
    return "No notes saved yet.";
  }

  return user.notes.slice(-10).map((note) => `- ${note.id.slice(0, 8)} ${note.text}`).join("\n");
}

function formatTodos(user: AssistantUserState | undefined): string {
  const openTodos = user?.todos.filter((todo) => !todo.completedAt) ?? [];
  if (openTodos.length === 0) {
    return "No open todos.";
  }

  return openTodos.slice(-10).map((todo) => `- ${todo.id.slice(0, 8)} ${todo.text}`).join("\n");
}

function formatReminders(user: AssistantUserState | undefined): string {
  const reminders = user?.reminders.filter((reminder) => !reminder.deliveredAt) ?? [];
  if (reminders.length === 0) {
    return "No pending reminders.";
  }

  return reminders
    .slice(-10)
    .map((reminder) => `- ${reminder.id.slice(0, 8)} ${formatReminderDate(reminder.dueAt)} ${reminder.text}`)
    .join("\n");
}

function formatMemories(user: AssistantUserState | undefined): string {
  if (!user || user.memories.length === 0) {
    return "No curated memories saved yet.";
  }

  return user.memories
    .slice(-15)
    .map((memory) => `- ${memory.id.slice(-8)} [${memory.kind}] ${memory.text}`)
    .join("\n");
}

function formatWorkspaceSummary(root: string, config: MicroClawConfig, chatId: string): string {
  const paths = getAssistantWorkspacePaths(root, config, chatId);
  return [
    `Workspace: ${paths.relativeDir}`,
    `Memory File: ${paths.relativeDir}/CLAUDE.md`,
    `Curated Memory File: ${paths.relativeDir}/memories.md`,
    `Notes File: ${paths.relativeDir}/notes.md`,
    `Todos File: ${paths.relativeDir}/todos.md`,
    `Reminders File: ${paths.relativeDir}/reminders.md`
  ].join("\n");
}

async function refreshUser(root: string, config: MicroClawConfig, chatId: string): Promise<AssistantUserState | undefined> {
  return getAssistantUserState(root, config, chatId);
}

export async function handleAssistantCommand(options: {
  root: string;
  config: MicroClawConfig;
  chatId: string;
  line: string;
  user?: AssistantUserState;
  allowExit?: boolean;
}): Promise<AssistantCommandResult> {
  const parsed = parseAssistantCommand(options.line);
  if (!parsed) {
    return { handled: false };
  }

  let reply: string | undefined;
  let user = options.user;

  switch (parsed.command) {
    case "start":
    case "help":
      reply = formatAssistantHelp(options.allowExit === true);
      break;
    case "whoami":
      reply = `Chat ID: ${options.chatId}\nDisplay Name: ${user?.displayName ?? "unknown"}\nUsername: ${user?.username ?? "unknown"}`;
      break;
    case "status": {
      const schedules = await listAssistantScheduledTasks(options.root, options.config, options.chatId);
      user = await refreshUser(options.root, options.config, options.chatId);
      reply = [
        `Notes: ${user?.notes.length ?? 0}`,
        `Open todos: ${user?.todos.filter((todo) => !todo.completedAt).length ?? 0}`,
        `Pending reminders: ${user?.reminders.filter((reminder) => !reminder.deliveredAt).length ?? 0}`,
        `Curated memories: ${user?.memories.length ?? 0}`,
        `Scheduled tasks: ${schedules.length}`
      ].join("\n");
      break;
    }
    case "workspace":
      reply = formatWorkspaceSummary(options.root, options.config, options.chatId);
      break;
    case "memory": {
      user = await refreshUser(options.root, options.config, options.chatId);
      const workspaceMemory = await readAssistantWorkspaceMemory(options.root, options.config, options.chatId);
      reply = [`Curated memories:\n${formatMemories(user)}`, "", "Workspace memory:", truncate(workspaceMemory, 2_800)].join("\n");
      break;
    }
    case "brief":
      user = await refreshUser(options.root, options.config, options.chatId);
      reply = await buildAssistantBriefing({
        root: options.root,
        config: options.config,
        chatId: options.chatId,
        user,
        mode: "brief"
      });
      break;
    case "today":
      user = await refreshUser(options.root, options.config, options.chatId);
      reply = await buildAssistantBriefing({
        root: options.root,
        config: options.config,
        chatId: options.chatId,
        user,
        mode: "today"
      });
      break;
    case "review":
      user = await refreshUser(options.root, options.config, options.chatId);
      reply = await buildAssistantBriefing({
        root: options.root,
        config: options.config,
        chatId: options.chatId,
        user,
        mode: "review"
      });
      break;
    case "inbox":
      user = await refreshUser(options.root, options.config, options.chatId);
      reply = await buildAssistantBriefing({
        root: options.root,
        config: options.config,
        chatId: options.chatId,
        user,
        mode: "inbox"
      });
      break;
    case "remember":
      if (!parsed.args) {
        reply = "Usage: /remember <text>";
        break;
      }
      if (!user) {
        reply = "Chat workspace is not ready yet.";
        break;
      }
      await appendAssistantWorkspaceMemory(options.root, options.config, user, parsed.args);
      await addAssistantMemory(options.root, options.config, options.chatId, {
        text: parsed.args,
        kind: "fact",
        source: "manual",
        confidence: 1
      });
      user = await refreshUser(options.root, options.config, options.chatId);
      reply = "Saved to chat memory.";
      break;
    case "forget": {
      if (!parsed.args) {
        reply = "Usage: /forget <id-prefix>";
        break;
      }
      const removed = await forgetAssistantMemory(options.root, options.config, options.chatId, parsed.args);
      user = await refreshUser(options.root, options.config, options.chatId);
      reply = removed ? `Forgot memory ${removed.id.slice(-8)}.` : "No matching curated memory found.";
      break;
    }
    case "note":
      if (!parsed.args) {
        reply = "Usage: /note <text>";
        break;
      }
      await addAssistantNote(options.root, options.config, options.chatId, parsed.args);
      user = await refreshUser(options.root, options.config, options.chatId);
      reply = "Note saved.";
      break;
    case "notes":
      user = await refreshUser(options.root, options.config, options.chatId);
      reply = formatNotes(user);
      break;
    case "todo":
      if (!parsed.args) {
        reply = "Usage: /todo <text>";
        break;
      }
      await addAssistantTodo(options.root, options.config, options.chatId, parsed.args);
      user = await refreshUser(options.root, options.config, options.chatId);
      reply = "Todo added.";
      break;
    case "todos":
      user = await refreshUser(options.root, options.config, options.chatId);
      reply = formatTodos(user);
      break;
    case "done": {
      if (!parsed.args) {
        reply = "Usage: /done <id-prefix>";
        break;
      }
      const completed = await completeAssistantTodo(options.root, options.config, options.chatId, parsed.args);
      user = await refreshUser(options.root, options.config, options.chatId);
      reply = completed ? `Completed todo ${completed.id.slice(0, 8)}.` : "No matching open todo found.";
      break;
    }
    case "remind":
      if (!parsed.args) {
        reply = "Usage: /remind in 2h buy milk";
        break;
      }
      try {
        const reminder = parseReminderRequest(parsed.args);
        await addAssistantReminder(options.root, options.config, options.chatId, reminder);
        user = await refreshUser(options.root, options.config, options.chatId);
        reply = `Reminder saved for ${formatReminderDate(reminder.dueAt)}.`;
      } catch (error) {
        reply = toErrorMessage(error);
      }
      break;
    case "reminders":
      user = await refreshUser(options.root, options.config, options.chatId);
      reply = formatReminders(user);
      break;
    case "schedule":
      if (!parsed.args) {
        reply = "Usage: /schedule every 2h | stretch";
        break;
      }
      try {
        const scheduled = parseAssistantScheduleRequest(parsed.args);
        const task = await addAssistantScheduledTask(options.root, options.config, options.chatId, scheduled);
        reply = [
          `Scheduled task ${task.id.slice(0, 8)}.`,
          `Pattern: ${formatAssistantSchedule(task.schedule)}`,
          `Next run: ${formatReminderDate(task.nextRunAt)}`
        ].join("\n");
      } catch (error) {
        reply = toErrorMessage(error);
      }
      break;
    case "schedules":
      reply = formatAssistantScheduledTaskList(
        await listAssistantScheduledTasks(options.root, options.config, options.chatId)
      );
      break;
    case "unschedule":
      if (!parsed.args) {
        reply = "Usage: /unschedule <id-prefix>";
        break;
      }
      try {
        const removed = await removeAssistantScheduledTask(options.root, options.config, options.chatId, parsed.args);
        reply = removed ? `Removed schedule ${removed.id.slice(0, 8)}.` : "No matching schedule found.";
      } catch (error) {
        reply = toErrorMessage(error);
      }
      break;
    case "exit":
      if (options.allowExit === true) {
        return { handled: true, exit: true, user };
      }
      return { handled: false };
    default:
      return { handled: false, user };
  }

  return {
    handled: true,
    reply,
    user
  };
}
