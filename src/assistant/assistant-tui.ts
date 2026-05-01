import { Writable } from "node:stream";
import { createInterface } from "node:readline/promises";
import process from "node:process";
import { resolveAgentProfile } from "../agent/agent-profile.js";
import { createCliUi, writeHero } from "../cli-ui.js";
import type {
  AssistantReminder,
  AssistantScheduledTask,
  AssistantTuiResult,
  AssistantUserState,
  MicroClawConfig
} from "../core/types.js";
import { toErrorMessage, truncate } from "../core/utils.js";
import { SessionStore } from "../memory/session-store.js";
import { diagnoseProvider } from "../providers/provider-diagnostics.js";
import { inspectSecretgateBoundary } from "../security/secretgate-boundary.js";
import {
  appendAssistantConversation,
  addAssistantNote,
  addAssistantReminder,
  addAssistantTodo,
  completeAssistantTodo,
  getAssistantUserState,
  listDueAssistantReminders,
  markAssistantReminderDelivered,
  touchAssistantUser
} from "./store.js";
import {
  addAssistantScheduledTask,
  formatAssistantScheduledTaskList,
  listAssistantScheduledTasks,
  listDueAssistantScheduledTasks,
  markAssistantScheduledTaskRun,
  removeAssistantScheduledTask
} from "./schedule-store.js";
import { formatReminderDate, parseReminderRequest } from "./reminder-parser.js";
import { computeNextAssistantScheduleRun, formatAssistantSchedule, parseAssistantScheduleRequest } from "./schedule-parser.js";
import { appendAssistantWorkspaceMemory, getAssistantWorkspacePaths, readAssistantWorkspaceMemory } from "./workspace.js";
import { generateDailyAssistantReply } from "./daily-reply.js";
import { handleAssistantCommand } from "./commands.js";

const DEFAULT_CHAT_ID = "local-tui";

const HELP_LINES = [
  "/help",
  "/status",
  "/whoami",
  "/workspace",
  "/memory",
  "/remember <text>",
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

function parseCommand(text: string): { command: string; args: string } | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) {
    return undefined;
  }

  const firstSpace = trimmed.indexOf(" ");
  if (firstSpace < 0) {
    return {
      command: trimmed.slice(1).toLowerCase(),
      args: ""
    };
  }

  return {
    command: trimmed.slice(1, firstSpace).toLowerCase(),
    args: trimmed.slice(firstSpace + 1).trim()
  };
}

function formatHelp(): string {
  return ["Commands:", ...HELP_LINES].join("\n");
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

function formatWorkspaceSummary(root: string, config: MicroClawConfig, chatId: string): string {
  const paths = getAssistantWorkspacePaths(root, config, chatId);
  return [
    `Workspace: ${paths.relativeDir}`,
    `Memory File: ${paths.relativeDir}/CLAUDE.md`,
    `Notes File: ${paths.relativeDir}/notes.md`,
    `Todos File: ${paths.relativeDir}/todos.md`,
    `Reminders File: ${paths.relativeDir}/reminders.md`
  ].join("\n");
}

function formatReminderNotification(reminder: AssistantReminder): string {
  return `Reminder: ${reminder.text}\nDue: ${formatReminderDate(reminder.dueAt)}`;
}

function isTtyWritable(output: Writable): boolean {
  return Boolean((output as Writable & { isTTY?: boolean }).isTTY);
}

async function withProgressHeartbeat<T>(
  task: () => Promise<T>,
  notify: () => void,
  intervalMs = 10_000
): Promise<T> {
  const timer = setInterval(() => {
    notify();
  }, intervalMs);

  timer.unref?.();

  try {
    return await task();
  } finally {
    clearInterval(timer);
  }
}

interface AssistantTuiState {
  session: SessionStore;
  chatId: string;
  user: AssistantUserState;
  turnCount: number;
  deliveredReminders: number;
  deliveredScheduledTasks: number;
  lastAssistantMessage?: string;
}

export interface RunAssistantTuiOptions {
  root: string;
  config: MicroClawConfig;
  initialPrompt?: string;
  interactive?: boolean;
  output?: Writable;
  env?: NodeJS.ProcessEnv;
  jsonMode?: boolean;
  chatId?: string;
}

async function refreshUser(
  root: string,
  config: MicroClawConfig,
  chatId: string
): Promise<AssistantUserState> {
  const user = await getAssistantUserState(root, config, chatId);
  if (!user) {
    throw new Error(`Assistant user ${chatId} is missing.`);
  }

  return user;
}

async function persistState(state: AssistantTuiState): Promise<void> {
  await state.session.writeJson("assistant-tui-state.json", {
    chatId: state.chatId,
    turnCount: state.turnCount,
    deliveredReminders: state.deliveredReminders,
    deliveredScheduledTasks: state.deliveredScheduledTasks,
    lastAssistantMessage: state.lastAssistantMessage
  });
}

async function recordAssistantMessage(
  root: string,
  config: MicroClawConfig,
  state: AssistantTuiState,
  message: string,
  createdAt = new Date().toISOString()
): Promise<void> {
  await appendAssistantConversation(root, config, state.chatId, {
    role: "assistant",
    content: message,
    createdAt
  });
  state.user = await refreshUser(root, config, state.chatId);
  state.lastAssistantMessage = message;
}

async function drainInbox(options: {
  root: string;
  config: MicroClawConfig;
  state: AssistantTuiState;
  env?: NodeJS.ProcessEnv;
}): Promise<string[]> {
  const messages: string[] = [];
  const dueReminders = (await listDueAssistantReminders(options.root, options.config)).filter(
    (entry) => entry.chatId === options.state.chatId
  );

  for (const due of dueReminders) {
    const notification = formatReminderNotification(due.reminder);
    await markAssistantReminderDelivered(options.root, options.config, options.state.chatId, due.reminder.id);
    await recordAssistantMessage(options.root, options.config, options.state, notification);
    options.state.deliveredReminders += 1;
    messages.push(notification);
  }

  const dueTasks = (await listDueAssistantScheduledTasks(options.root, options.config)).filter(
    (task) => task.chatId === options.state.chatId
  );

  for (const task of dueTasks) {
    const scheduleLabel = formatAssistantSchedule(task.schedule);
    const lastRunAt = new Date().toISOString();

    try {
      const reply = await generateDailyAssistantReply({
        root: options.root,
        config: options.config,
        chatId: options.state.chatId,
        user: options.state.user,
        userInput: task.prompt,
        source: "scheduled",
        sourceLabel: scheduleLabel,
        env: options.env
      });
      const notification = `Scheduled task ${task.id.slice(0, 8)} (${scheduleLabel})\n${reply}`;
      await markAssistantScheduledTaskRun(options.root, options.config, task.id, {
        lastRunAt,
        lastResultSummary: reply
      });
      await recordAssistantMessage(options.root, options.config, options.state, notification, lastRunAt);
      options.state.deliveredScheduledTasks += 1;
      messages.push(notification);
    } catch (error) {
      const errorMessage = toErrorMessage(error);
      const nextRunAt = computeNextAssistantScheduleRun(task, new Date(lastRunAt));
      const notification = `Scheduled task ${task.id.slice(0, 8)} (${scheduleLabel}) failed.\n${errorMessage}\nNext run: ${formatReminderDate(nextRunAt)}`;
      await markAssistantScheduledTaskRun(options.root, options.config, task.id, {
        lastRunAt,
        lastError: errorMessage
      });
      await recordAssistantMessage(options.root, options.config, options.state, notification, lastRunAt);
      options.state.deliveredScheduledTasks += 1;
      messages.push(notification);
    }
  }

  await persistState(options.state);
  return messages;
}

async function handleCommand(options: {
  root: string;
  config: MicroClawConfig;
  state: AssistantTuiState;
  line: string;
}): Promise<string | "exit"> {
  const result = await handleAssistantCommand({
    root: options.root,
    config: options.config,
    chatId: options.state.chatId,
    line: options.line,
    user: options.state.user,
    allowExit: true
  });

  if (result.user) {
    options.state.user = result.user;
  }

  if (result.exit) {
    return "exit";
  }

  return result.handled ? result.reply ?? "" : "Unknown command. Type /help.";
}

export async function runAssistantTui(options: RunAssistantTuiOptions): Promise<AssistantTuiResult> {
  const output = options.output ?? process.stdout;
  const ui = createCliUi(output, options.env);
  const interactive =
    options.interactive ??
    (Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY) && !options.jsonMode);
  const chatId = options.chatId?.trim() || DEFAULT_CHAT_ID;
  const profile = await resolveAgentProfile({
    root: options.root,
    output,
    promptIfMissing: !options.jsonMode && Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY)
  });
  const session = await SessionStore.create(options.root, "assistant-tui");
  const boundary = inspectSecretgateBoundary(options.config, options.env);
  let provider = await diagnoseProvider(options.config);
  const initialUser = await touchAssistantUser(options.root, options.config, chatId, {
    username: "local-tui",
    displayName: "Local TUI"
  });
  const state: AssistantTuiState = {
    session,
    chatId,
    user: initialUser,
    turnCount: 0,
    deliveredReminders: 0,
    deliveredScheduledTasks: 0
  };

  await session.writeJson("agent-profile.json", profile);
  await session.writeJson("assistant-tui-meta.json", {
    chatId,
    workspaceDir: getAssistantWorkspacePaths(options.root, options.config, chatId).relativeDir,
    secretgateBoundary: boundary,
    provider
  });

  if (interactive) {
    if (ui.decorated) {
      await writeHero(output, {
        animate: true,
        env: options.env,
        subtitle: `${profile.name.toUpperCase()} // local assistant`
      });
      output.write(
        [
          ui.section("Assistant"),
          ui.renderRows([
            { label: "Session", value: session.sessionId, tone: "accent" },
            { label: "Chat ID", value: chatId, tone: "secondary" },
            { label: "Workspace", value: getAssistantWorkspacePaths(options.root, options.config, chatId).relativeDir },
            { label: "Behavior", value: profile.behavior },
            { label: "Secretgate", value: boundary.message, tone: boundary.ok ? "success" : "warning" },
            { label: "Provider", value: provider.message, tone: provider.ok ? "success" : "warning" }
          ]),
          "",
          ui.muted("Type /help for commands.")
        ].join("\n") + "\n"
      );
    } else {
      output.write(
        [
          `${profile.name} local assistant ${session.sessionId}`,
          `Chat ID: ${chatId}`,
          `Workspace: ${getAssistantWorkspacePaths(options.root, options.config, chatId).relativeDir}`,
          `Behavior: ${profile.behavior}`,
          `Secretgate: ${boundary.message}`,
          `Provider: ${provider.message}`,
          "Type /help for commands."
        ].join("\n") + "\n"
      );
    }
  }

  const printInboxMessages = async (): Promise<void> => {
    const inbox = await drainInbox({
      root: options.root,
      config: options.config,
      state,
      env: options.env
    });
    if (!options.jsonMode) {
      for (const message of inbox) {
        output.write(`${message}\n`);
      }
    }
  };

  const handleLine = async (line: string): Promise<void> => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    await printInboxMessages();

    if (trimmed.startsWith("/")) {
      const result = await handleCommand({
        root: options.root,
        config: options.config,
        state,
        line: trimmed
      });
      if (result === "exit") {
        throw new Error("__MICRO_CLAW_ASSISTANT_EXIT__");
      }

      state.turnCount += 1;
      state.lastAssistantMessage = result;
      await session.appendEvent({
        type: "assistant_tui_command",
        createdAt: new Date().toISOString(),
        command: trimmed
      });
      await recordAssistantMessage(options.root, options.config, state, result);
      await persistState(state);

      if (!options.jsonMode) {
        output.write(`${result}\n`);
      }
      return;
    }

    await appendAssistantConversation(options.root, options.config, state.chatId, {
      role: "user",
      content: trimmed,
      createdAt: new Date().toISOString()
    });
    state.user = await refreshUser(options.root, options.config, state.chatId);

    if (!provider.ok) {
      provider = await diagnoseProvider(options.config);
      if (!provider.ok) {
        const providerError = `Provider not ready. ${provider.message}`;
        state.turnCount += 1;
        await recordAssistantMessage(options.root, options.config, state, providerError);
        await persistState(state);

        if (!options.jsonMode) {
          output.write(`${providerError}\n`);
        }
        return;
      }
    }

    const canStream = !options.jsonMode && options.config.runtime.stream && isTtyWritable(output);
    if (!options.jsonMode) {
      output.write(`${ui.formatProgress("thinking...")}\n`);
    }

    let streamedAnyToken = false;
    let waitedSeconds = 0;
    const reply = await withProgressHeartbeat(
      () =>
        generateDailyAssistantReply({
          root: options.root,
          config: options.config,
          chatId: state.chatId,
          user: state.user,
          userInput: trimmed,
          source: "user",
          stream: canStream,
          onToken: async (token) => {
            if (!canStream || options.jsonMode) {
              return;
            }

            if (!streamedAnyToken) {
              output.write(ui.prompt("assistant"));
            }
            streamedAnyToken = true;
            output.write(token);
          },
          onProgress: async (message) => {
            if (options.jsonMode) {
              return;
            }

            output.write(`${ui.formatProgress(message)}\n`);
          },
          env: options.env
        }),
      () => {
        if (streamedAnyToken) {
          return;
        }

        waitedSeconds += 10;
        if (options.jsonMode) {
          return;
        }

        output.write(`${ui.formatProgress(`still waiting for the model (${waitedSeconds}s)`)}\n`);
      }
    );

    if (!options.jsonMode) {
      if (canStream) {
        output.write(streamedAnyToken ? "\n" : `${reply}\n`);
      } else {
        output.write(`${reply}\n`);
      }
    }

    state.turnCount += 1;
    await recordAssistantMessage(options.root, options.config, state, reply);
    await session.appendEvent({
      type: "assistant_tui_turn",
      createdAt: new Date().toISOString(),
      userInput: trimmed
    });
    await persistState(state);

  };

  try {
    await printInboxMessages();

    if (options.initialPrompt?.trim()) {
      await handleLine(options.initialPrompt.trim());
    }

    if (interactive) {
      const readline = createInterface({
        input: process.stdin,
        output,
        terminal: true
      });

      try {
        while (true) {
          const line = await readline.question(ui.prompt("assistant"));
          try {
            await handleLine(line);
          } catch (error) {
            if (error instanceof Error && error.message === "__MICRO_CLAW_ASSISTANT_EXIT__") {
              throw error;
            }

            output.write(`${ui.formatProgress(`error: ${toErrorMessage(error)}`)}\n`);
          }
        }
      } finally {
        readline.close();
      }
    }
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "__MICRO_CLAW_ASSISTANT_EXIT__") {
      throw error;
    }
  }

  const workspace = getAssistantWorkspacePaths(options.root, options.config, chatId);
  await session.writeText(
    "summary.md",
    [
      `# Assistant TUI ${session.sessionId}`,
      "",
      `Chat ID: ${chatId}`,
      `Workspace: ${workspace.relativeDir}`,
      `Turns: ${state.turnCount}`,
      `Delivered Reminders: ${state.deliveredReminders}`,
      `Delivered Scheduled Tasks: ${state.deliveredScheduledTasks}`,
      `Last Assistant Message: ${state.lastAssistantMessage ?? "none"}`
    ].join("\n")
  );

  return {
    sessionId: session.sessionId,
    sessionDir: session.sessionDir,
    chatId,
    workspaceDir: workspace.relativeDir,
    deliveredReminders: state.deliveredReminders,
    deliveredScheduledTasks: state.deliveredScheduledTasks,
    turnCount: state.turnCount,
    lastAssistantMessage: state.lastAssistantMessage
  };
}
