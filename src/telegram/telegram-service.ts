import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  AssistantReminder,
  AssistantUserState,
  MicroClawConfig,
  TelegramRuntimeState,
  TelegramServiceResult
} from "../core/types.js";
import { appendAssistantConversation, addAssistantNote, addAssistantReminder, addAssistantTodo, completeAssistantTodo, formatAssistantUserContext, getAssistantStateFiles, getAssistantUserState, listDueAssistantReminders, markAssistantReminderDelivered, touchAssistantUser } from "../assistant/store.js";
import { formatReminderDate, parseReminderRequest } from "../assistant/reminder-parser.js";
import { generateDailyAssistantReply } from "../assistant/daily-reply.js";
import { writeHeartbeat } from "../heartbeat/heartbeat-service.js";
import { assertWithinRoot, pathExists, toErrorMessage } from "../core/utils.js";
import { TelegramClient, type TelegramMessage, type TelegramUpdate } from "./telegram-client.js";

export interface RunTelegramServiceOptions {
  root: string;
  config: MicroClawConfig;
  once?: boolean;
  verify?: boolean;
  env?: NodeJS.ProcessEnv;
  output?: NodeJS.WritableStream;
}

function formatTelegramHelp(): string {
  return [
    "Commands:",
    "/help",
    "/status",
    "/whoami",
    "/note <text>",
    "/notes",
    "/todo <text>",
    "/todos",
    "/done <id-prefix>",
    "/remind in 2h buy milk",
    "/remind today 18:30 call mom",
    "/remind 2026-03-25 09:00 standup",
    "/reminders",
    "",
    "Every other text message is answered by the assistant."
  ].join("\n");
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

function parseCommand(text: string): { command: string; args: string } | undefined {
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

function formatDisplayName(message: TelegramMessage): string {
  return message.from?.first_name || message.chat.first_name || message.chat.title || message.chat.username || String(message.chat.id);
}

function getTelegramStatePath(root: string, config: MicroClawConfig): string {
  return assertWithinRoot(root, config.telegram.stateFile);
}

async function loadTelegramRuntimeState(root: string, config: MicroClawConfig): Promise<TelegramRuntimeState> {
  const stateFile = getTelegramStatePath(root, config);
  if (!(await pathExists(stateFile))) {
    return {
      updatedAt: new Date().toISOString()
    };
  }

  const source = await readFile(stateFile, "utf8");
  const parsed = JSON.parse(source) as Partial<TelegramRuntimeState>;
  return {
    lastUpdateId: typeof parsed.lastUpdateId === "number" ? parsed.lastUpdateId : undefined,
    updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString()
  };
}

async function saveTelegramRuntimeState(
  root: string,
  config: MicroClawConfig,
  state: TelegramRuntimeState
): Promise<TelegramRuntimeState> {
  const stateFile = getTelegramStatePath(root, config);
  await mkdir(path.dirname(stateFile), { recursive: true });
  await writeFile(
    stateFile,
    `${JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2)}\n`,
    "utf8"
  );
  return {
    ...state,
    updatedAt: new Date().toISOString()
  };
}

function formatReminderNotification(reminder: AssistantReminder): string {
  return `Reminder: ${reminder.text}\nDue: ${formatReminderDate(reminder.dueAt)}`;
}

function formatStatusMarkdown(result: TelegramServiceResult): string {
  return [
    "# Micro Claw Telegram Service",
    "",
    `Checked At: ${result.checkedAt}`,
    `Processed Updates: ${result.processedUpdates}`,
    `Delivered Reminders: ${result.deliveredReminders}`,
    `Last Update Id: ${result.lastUpdateId ?? "none"}`,
    `Heartbeat: ${result.heartbeatStatus ?? "unknown"}`,
    `Assistant State: ${result.stateFile}`,
    `Telegram State: ${result.telegramStateFile}`,
    "",
    "## Note",
    result.note,
    ""
  ].join("\n");
}

async function writeTelegramServiceStatus(
  root: string,
  config: MicroClawConfig,
  result: TelegramServiceResult
): Promise<TelegramServiceResult> {
  const statusFile = assertWithinRoot(root, config.assistant.statusFile);
  const statusJsonFile = assertWithinRoot(root, config.assistant.statusJsonFile);
  await mkdir(path.dirname(statusFile), { recursive: true });
  await mkdir(path.dirname(statusJsonFile), { recursive: true });
  await writeFile(statusFile, formatStatusMarkdown(result), "utf8");
  await writeFile(statusJsonFile, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return result;
}

function isAllowedChat(config: MicroClawConfig, chatId: string): boolean {
  return config.telegram.allowedChatIds.length === 0 || config.telegram.allowedChatIds.includes(chatId);
}

async function sendAndPersistAssistantReply(options: {
  root: string;
  config: MicroClawConfig;
  client: TelegramClient;
  chatId: string;
  reply: string;
}): Promise<void> {
  await options.client.sendMessage(options.chatId, options.reply);
  await appendAssistantConversation(options.root, options.config, options.chatId, {
    role: "assistant",
    content: options.reply,
    createdAt: new Date().toISOString()
  });
}

async function handleTelegramCommand(options: {
  root: string;
  config: MicroClawConfig;
  client: TelegramClient;
  message: TelegramMessage;
  user: AssistantUserState | undefined;
}): Promise<boolean> {
  const parsed = parseCommand(options.message.text ?? "");
  if (!parsed) {
    return false;
  }

  const chatId = String(options.message.chat.id);
  let reply: string | undefined;

  switch (parsed.command) {
    case "start":
    case "help":
      reply = formatTelegramHelp();
      break;
    case "whoami":
      reply = `Chat ID: ${chatId}\nDisplay Name: ${formatDisplayName(options.message)}\nUsername: ${options.message.from?.username ?? "unknown"}`;
      break;
    case "status":
      reply = [
        `Notes: ${options.user?.notes.length ?? 0}`,
        `Open todos: ${options.user?.todos.filter((todo) => !todo.completedAt).length ?? 0}`,
        `Pending reminders: ${options.user?.reminders.filter((reminder) => !reminder.deliveredAt).length ?? 0}`
      ].join("\n");
      break;
    case "note":
      if (!parsed.args) {
        reply = "Usage: /note <text>";
        break;
      }
      await addAssistantNote(options.root, options.config, chatId, parsed.args);
      reply = "Note saved.";
      break;
    case "notes":
      reply = formatNotes(await getAssistantUserState(options.root, options.config, chatId));
      break;
    case "todo":
      if (!parsed.args) {
        reply = "Usage: /todo <text>";
        break;
      }
      await addAssistantTodo(options.root, options.config, chatId, parsed.args);
      reply = "Todo added.";
      break;
    case "todos":
      reply = formatTodos(await getAssistantUserState(options.root, options.config, chatId));
      break;
    case "done": {
      if (!parsed.args) {
        reply = "Usage: /done <id-prefix>";
        break;
      }
      const completed = await completeAssistantTodo(options.root, options.config, chatId, parsed.args);
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
        await addAssistantReminder(options.root, options.config, chatId, reminder);
        reply = `Reminder saved for ${formatReminderDate(reminder.dueAt)}.`;
      } catch (error) {
        reply = toErrorMessage(error);
      }
      break;
    case "reminders":
      reply = formatReminders(await getAssistantUserState(options.root, options.config, chatId));
      break;
    default:
      return false;
  }

  if (reply) {
    await sendAndPersistAssistantReply({
      root: options.root,
      config: options.config,
      client: options.client,
      chatId,
      reply
    });
  }

  return true;
}

async function deliverDueReminders(options: {
  root: string;
  config: MicroClawConfig;
  client: TelegramClient;
}): Promise<number> {
  let delivered = 0;
  const dueReminders = await listDueAssistantReminders(options.root, options.config);

  for (const due of dueReminders) {
    await options.client.sendMessage(due.chatId, formatReminderNotification(due.reminder));
    await markAssistantReminderDelivered(options.root, options.config, due.chatId, due.reminder.id);
    await appendAssistantConversation(options.root, options.config, due.chatId, {
      role: "assistant",
      content: formatReminderNotification(due.reminder),
      createdAt: new Date().toISOString()
    });
    delivered += 1;
  }

  return delivered;
}

async function processTelegramUpdate(options: {
  root: string;
  config: MicroClawConfig;
  client: TelegramClient;
  update: TelegramUpdate;
  env?: NodeJS.ProcessEnv;
}): Promise<number> {
  const message = options.update.message;
  if (!message?.text) {
    return 0;
  }

  const chatId = String(message.chat.id);
  if (!isAllowedChat(options.config, chatId)) {
    return 0;
  }

  await touchAssistantUser(options.root, options.config, chatId, {
    username: message.from?.username ?? message.chat.username,
    displayName: formatDisplayName(message)
  });
  await appendAssistantConversation(options.root, options.config, chatId, {
    role: "user",
    content: message.text,
    createdAt: new Date().toISOString()
  });

  const user = await getAssistantUserState(options.root, options.config, chatId);
  const handled = await handleTelegramCommand({
    root: options.root,
    config: options.config,
    client: options.client,
    message,
    user
  });

  if (handled) {
    return 1;
  }

  const reply = await generateDailyAssistantReply({
    root: options.root,
    config: options.config,
    user,
    userInput: message.text,
    env: options.env
  });

  await sendAndPersistAssistantReply({
    root: options.root,
    config: options.config,
    client: options.client,
    chatId,
    reply
  });

  return 1;
}

export async function runTelegramService(options: RunTelegramServiceOptions): Promise<TelegramServiceResult> {
  if (!options.config.telegram.enabled || !options.config.assistant.enabled) {
    throw new Error("Telegram assistant service is disabled in config.");
  }

  const token = process.env[options.config.telegram.botTokenEnv];
  if (!token) {
    throw new Error(`Missing ${options.config.telegram.botTokenEnv} in the environment.`);
  }

  const client = new TelegramClient({
    token,
    apiBaseUrl: options.config.telegram.apiBaseUrl,
    timeoutSeconds: Math.max(
      options.config.provider.requestTimeoutSeconds,
      options.config.telegram.longPollSeconds + 10
    )
  });
  const assistantFiles = getAssistantStateFiles(options.root, options.config);
  let telegramState = await loadTelegramRuntimeState(options.root, options.config);
  let stopRequested = false;
  let lastResult: TelegramServiceResult | undefined;

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
        intervalSeconds: Math.max(1, Math.floor(options.config.telegram.pollIntervalMs / 1_000)),
        iteration: 1,
        verify: options.verify,
        env: options.env
      });
      const deliveredReminders = await deliverDueReminders({
        root: options.root,
        config: options.config,
        client
      });
      const updates = await client.getUpdates(
        telegramState.lastUpdateId,
        options.once ? 0 : options.config.telegram.longPollSeconds
      );

      let processedUpdates = 0;
      for (const update of updates) {
        processedUpdates += await processTelegramUpdate({
          root: options.root,
          config: options.config,
          client,
          update,
          env: options.env
        });

        telegramState = await saveTelegramRuntimeState(options.root, options.config, {
          lastUpdateId: update.update_id + 1,
          updatedAt: new Date().toISOString()
        });
      }

      if (updates.length === 0) {
        telegramState = await saveTelegramRuntimeState(options.root, options.config, telegramState);
      }

      lastResult = await writeTelegramServiceStatus(options.root, options.config, {
        checkedAt: new Date().toISOString(),
        root: options.root,
        processedUpdates,
        deliveredReminders,
        lastUpdateId: telegramState.lastUpdateId,
        heartbeatStatus: heartbeat.status,
        stateFile: assistantFiles.stateFile,
        telegramStateFile: getTelegramStatePath(options.root, options.config),
        statusFile: assertWithinRoot(options.root, options.config.assistant.statusFile),
        statusJsonFile: assertWithinRoot(options.root, options.config.assistant.statusJsonFile),
        note:
          processedUpdates > 0 || deliveredReminders > 0
            ? "Telegram assistant processed activity successfully."
            : "Telegram assistant is idle and waiting for the next message."
      });

      options.output?.write(
        `telegram> processed=${processedUpdates} reminders=${deliveredReminders} last_update=${lastResult.lastUpdateId ?? "none"}\n`
      );

      if (options.once) {
        return lastResult;
      }

      if (updates.length === 0 && !stopRequested) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, options.config.telegram.pollIntervalMs);
        });
      }
    } while (!stopRequested);
  } finally {
    process.off("SIGINT", onStop);
    process.off("SIGTERM", onStop);
  }

  if (!lastResult) {
    throw new Error("Telegram assistant stopped before producing a status record.");
  }

  return lastResult;
}
