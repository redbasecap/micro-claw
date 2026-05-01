import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  AssistantConversationMessage,
  AssistantMemoryEntry,
  AssistantMemoryKind,
  AssistantNote,
  AssistantReminder,
  AssistantState,
  AssistantTodo,
  AssistantUserState,
  MicroClawConfig
} from "../core/types.js";
import { assertWithinRoot, pathExists, timestampId } from "../core/utils.js";
import { getAssistantWorkspacePaths, syncAssistantWorkspace } from "./workspace.js";

function getAssistantPaths(root: string, config: MicroClawConfig): {
  stateFile: string;
  summaryFile: string;
} {
  return {
    stateFile: assertWithinRoot(root, config.assistant.stateFile),
    summaryFile: assertWithinRoot(root, config.assistant.summaryFile)
  };
}

function createEmptyState(now = new Date()): AssistantState {
  return {
    version: 1,
    updatedAt: now.toISOString(),
    users: {}
  };
}

function createUserState(chatId: string, now = new Date(), values?: { username?: string; displayName?: string }): AssistantUserState {
  const timestamp = now.toISOString();

  return {
    chatId,
    createdAt: timestamp,
    updatedAt: timestamp,
    lastSeenAt: timestamp,
    username: values?.username,
    displayName: values?.displayName,
    notes: [],
    todos: [],
    reminders: [],
    memories: [],
    conversation: []
  };
}

function formatTodo(todo: AssistantTodo): string {
  return `${todo.id.slice(0, 8)} ${todo.completedAt ? "[done]" : "[open]"} ${todo.text}`;
}

function formatReminder(reminder: AssistantReminder): string {
  return `${reminder.id.slice(0, 8)} [${reminder.deliveredAt ? "sent" : "pending"}] ${reminder.dueAt} ${reminder.text}`;
}

function formatMemory(memory: AssistantMemoryEntry): string {
  const expires = memory.expiresAt ? ` expires ${memory.expiresAt}` : "";
  return `${memory.id.slice(-8)} [${memory.kind}/${memory.source}/${memory.confidence.toFixed(2)}] ${memory.text}${expires}`;
}

function formatSummary(root: string, config: MicroClawConfig, state: AssistantState): string {
  const users = Object.values(state.users).sort((left, right) => left.chatId.localeCompare(right.chatId));

  return [
    "# Micro Claw Assistant State",
    "",
    `Updated At: ${state.updatedAt}`,
    `Users: ${users.length}`,
    "",
    ...users.flatMap((user) => [
      `## Chat ${user.chatId}`,
      "",
      `Workspace: ${getAssistantWorkspacePaths(root, config, user.chatId).relativeDir}`,
      `Display Name: ${user.displayName ?? "unknown"}`,
      `Username: ${user.username ?? "unknown"}`,
      `Last Seen: ${user.lastSeenAt}`,
      `Notes: ${user.notes.length}`,
      `Open Todos: ${user.todos.filter((todo) => !todo.completedAt).length}`,
      `Pending Reminders: ${user.reminders.filter((reminder) => !reminder.deliveredAt).length}`,
      `Curated Memories: ${user.memories.length}`,
      user.notes.length > 0 ? "Recent Notes:" : undefined,
      ...user.notes.slice(-3).map((note) => `- ${note.text}`),
      user.todos.length > 0 ? "Recent Todos:" : undefined,
      ...user.todos.slice(-3).map((todo) => `- ${formatTodo(todo)}`),
      user.reminders.length > 0 ? "Recent Reminders:" : undefined,
      ...user.reminders.slice(-3).map((reminder) => `- ${formatReminder(reminder)}`),
      user.memories.length > 0 ? "Recent Curated Memories:" : undefined,
      ...user.memories.slice(-5).map((memory) => `- ${formatMemory(memory)}`),
      ""
    ])
  ]
    .filter((line): line is string => typeof line === "string")
    .join("\n");
}

async function saveAssistantState(root: string, config: MicroClawConfig, state: AssistantState): Promise<AssistantState> {
  const paths = getAssistantPaths(root, config);
  await mkdir(path.dirname(paths.stateFile), { recursive: true });
  await mkdir(path.dirname(paths.summaryFile), { recursive: true });
  await writeFile(paths.stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await writeFile(paths.summaryFile, formatSummary(root, config, state), "utf8");
  return state;
}

export async function loadAssistantState(root: string, config: MicroClawConfig): Promise<AssistantState> {
  const { stateFile } = getAssistantPaths(root, config);
  if (!(await pathExists(stateFile))) {
    return createEmptyState();
  }

  const source = await readFile(stateFile, "utf8");
  const parsed = JSON.parse(source) as Partial<AssistantState>;

  if (!parsed || typeof parsed !== "object" || typeof parsed.users !== "object" || parsed.users === null) {
    throw new Error(`Invalid assistant state: ${stateFile}`);
  }

  return {
    version: typeof parsed.version === "number" ? parsed.version : 1,
    updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
    users: Object.fromEntries(
      Object.entries(parsed.users as Record<string, AssistantUserState>).map(([chatId, user]) => [
        chatId,
        {
          ...createUserState(chatId),
          ...user,
          notes: Array.isArray(user.notes) ? user.notes : [],
          todos: Array.isArray(user.todos) ? user.todos : [],
          reminders: Array.isArray(user.reminders) ? user.reminders : [],
          memories: Array.isArray(user.memories) ? user.memories : [],
          conversation: Array.isArray(user.conversation) ? user.conversation : []
        }
      ])
    )
  };
}

async function updateAssistantState(
  root: string,
  config: MicroClawConfig,
  updater: (state: AssistantState) => AssistantState | void
): Promise<AssistantState> {
  const state = await loadAssistantState(root, config);
  const next = updater(state) ?? state;
  next.updatedAt = new Date().toISOString();
  return saveAssistantState(root, config, next);
}

export async function touchAssistantUser(
  root: string,
  config: MicroClawConfig,
  chatId: string,
  values?: { username?: string; displayName?: string }
): Promise<AssistantUserState> {
  const state = await updateAssistantState(root, config, (draft) => {
    const existing = draft.users[chatId] ?? createUserState(chatId, new Date(), values);
    const now = new Date().toISOString();
    draft.users[chatId] = {
      ...existing,
      updatedAt: now,
      lastSeenAt: now,
      username: values?.username ?? existing.username,
      displayName: values?.displayName ?? existing.displayName
    };
  });

  await syncAssistantWorkspace(root, config, state.users[chatId]);
  return state.users[chatId];
}

export async function appendAssistantConversation(
  root: string,
  config: MicroClawConfig,
  chatId: string,
  entry: AssistantConversationMessage
): Promise<AssistantUserState> {
  const state = await updateAssistantState(root, config, (draft) => {
    const user = draft.users[chatId] ?? createUserState(chatId);
    const conversation = [...user.conversation, entry].slice(-config.assistant.recentConversationMessages * 4);
    draft.users[chatId] = {
      ...user,
      updatedAt: entry.createdAt,
      lastSeenAt: entry.createdAt,
      conversation
    };
  });

  await syncAssistantWorkspace(root, config, state.users[chatId]);
  return state.users[chatId];
}

export async function addAssistantNote(
  root: string,
  config: MicroClawConfig,
  chatId: string,
  text: string
): Promise<AssistantNote> {
  const note: AssistantNote = {
    id: timestampId(),
    text: text.trim(),
    createdAt: new Date().toISOString()
  };

  const state = await updateAssistantState(root, config, (draft) => {
    const user = draft.users[chatId] ?? createUserState(chatId);
    draft.users[chatId] = {
      ...user,
      updatedAt: note.createdAt,
      lastSeenAt: note.createdAt,
      notes: [...user.notes, note].slice(-config.assistant.maxNotesPerUser)
    };
  });

  await syncAssistantWorkspace(root, config, state.users[chatId]);
  return state.users[chatId].notes[state.users[chatId].notes.length - 1];
}

export async function addAssistantTodo(
  root: string,
  config: MicroClawConfig,
  chatId: string,
  text: string
): Promise<AssistantTodo> {
  const todo: AssistantTodo = {
    id: timestampId(),
    text: text.trim(),
    createdAt: new Date().toISOString()
  };

  const state = await updateAssistantState(root, config, (draft) => {
    const user = draft.users[chatId] ?? createUserState(chatId);
    draft.users[chatId] = {
      ...user,
      updatedAt: todo.createdAt,
      lastSeenAt: todo.createdAt,
      todos: [...user.todos, todo].slice(-config.assistant.maxTodosPerUser)
    };
  });

  await syncAssistantWorkspace(root, config, state.users[chatId]);
  return state.users[chatId].todos[state.users[chatId].todos.length - 1];
}

export async function completeAssistantTodo(
  root: string,
  config: MicroClawConfig,
  chatId: string,
  todoIdPrefix: string
): Promise<AssistantTodo | undefined> {
  const normalized = todoIdPrefix.trim().toLowerCase();
  let completed: AssistantTodo | undefined;

  await updateAssistantState(root, config, (draft) => {
    const user = draft.users[chatId];
    if (!user) {
      return;
    }

    const todos = user.todos.map((todo) => {
      if (completed || todo.completedAt || !todo.id.toLowerCase().startsWith(normalized)) {
        return todo;
      }

      completed = {
        ...todo,
        completedAt: new Date().toISOString()
      };

      return completed;
    });

    draft.users[chatId] = {
      ...user,
      updatedAt: new Date().toISOString(),
      todos
    };
  });

  if (completed) {
    const user = await getAssistantUserState(root, config, chatId);
    if (user) {
      await syncAssistantWorkspace(root, config, user);
    }
  }

  return completed;
}

export async function addAssistantReminder(
  root: string,
  config: MicroClawConfig,
  chatId: string,
  input: { dueAt: string; text: string }
): Promise<AssistantReminder> {
  const reminder: AssistantReminder = {
    id: timestampId(),
    text: input.text.trim(),
    dueAt: input.dueAt,
    createdAt: new Date().toISOString()
  };

  const state = await updateAssistantState(root, config, (draft) => {
    const user = draft.users[chatId] ?? createUserState(chatId);
    const reminders = [...user.reminders, reminder]
      .sort((left, right) => left.dueAt.localeCompare(right.dueAt))
      .slice(-config.assistant.maxRemindersPerUser);

    draft.users[chatId] = {
      ...user,
      updatedAt: reminder.createdAt,
      lastSeenAt: reminder.createdAt,
      reminders
    };
  });

  await syncAssistantWorkspace(root, config, state.users[chatId]);
  return state.users[chatId].reminders.find((entry) => entry.id === reminder.id) ?? reminder;
}

export async function markAssistantReminderDelivered(
  root: string,
  config: MicroClawConfig,
  chatId: string,
  reminderId: string
): Promise<AssistantReminder | undefined> {
  let delivered: AssistantReminder | undefined;

  await updateAssistantState(root, config, (draft) => {
    const user = draft.users[chatId];
    if (!user) {
      return;
    }

    const reminders = user.reminders.map((reminder) => {
      if (delivered || reminder.id !== reminderId || reminder.deliveredAt) {
        return reminder;
      }

      delivered = {
        ...reminder,
        deliveredAt: new Date().toISOString()
      };

      return delivered;
    });

    draft.users[chatId] = {
      ...user,
      updatedAt: new Date().toISOString(),
      reminders
    };
  });

  if (delivered) {
    const user = await getAssistantUserState(root, config, chatId);
    if (user) {
      await syncAssistantWorkspace(root, config, user);
    }
  }

  return delivered;
}

function normalizeMemoryKind(kind: string | undefined): AssistantMemoryKind {
  switch (kind) {
    case "fact":
    case "preference":
    case "routine":
    case "project":
    case "other":
      return kind;
    default:
      return "other";
  }
}

export async function addAssistantMemory(
  root: string,
  config: MicroClawConfig,
  chatId: string,
  input: {
    text: string;
    kind?: AssistantMemoryKind | string;
    source?: AssistantMemoryEntry["source"];
    confidence?: number;
    expiresAt?: string;
  }
): Promise<AssistantMemoryEntry | undefined> {
  const text = input.text.trim().replace(/\s+/g, " ");
  if (!text) {
    return undefined;
  }

  const now = new Date().toISOString();
  let savedMemory: AssistantMemoryEntry | undefined;

  const state = await updateAssistantState(root, config, (draft) => {
    const user = draft.users[chatId] ?? createUserState(chatId);
    const existingIndex = user.memories.findIndex((memory) => memory.text.toLowerCase() === text.toLowerCase());
    const confidence = Math.min(1, Math.max(0, input.confidence ?? 0.7));

    const memories = [...user.memories];
    if (existingIndex >= 0) {
      savedMemory = {
        ...memories[existingIndex],
        kind: normalizeMemoryKind(input.kind),
        source: input.source ?? memories[existingIndex].source,
        confidence: Math.max(memories[existingIndex].confidence, confidence),
        lastUsedAt: now,
        expiresAt: input.expiresAt ?? memories[existingIndex].expiresAt
      };
      memories[existingIndex] = savedMemory;
    } else {
      savedMemory = {
        id: timestampId(),
        kind: normalizeMemoryKind(input.kind),
        text,
        source: input.source ?? "curated",
        confidence,
        createdAt: now,
        lastUsedAt: now,
        expiresAt: input.expiresAt
      };
      memories.push(savedMemory);
    }

    draft.users[chatId] = {
      ...user,
      updatedAt: now,
      lastSeenAt: now,
      memories: memories
        .sort((left, right) => {
          const leftDate = left.lastUsedAt ?? left.createdAt;
          const rightDate = right.lastUsedAt ?? right.createdAt;
          return leftDate.localeCompare(rightDate);
        })
        .slice(-config.assistant.maxCuratedMemoriesPerUser)
    };
  });

  await syncAssistantWorkspace(root, config, state.users[chatId]);
  return savedMemory;
}

export async function forgetAssistantMemory(
  root: string,
  config: MicroClawConfig,
  chatId: string,
  memoryIdPrefix: string
): Promise<AssistantMemoryEntry | undefined> {
  const normalized = memoryIdPrefix.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  let removed: AssistantMemoryEntry | undefined;
  const state = await updateAssistantState(root, config, (draft) => {
    const user = draft.users[chatId];
    if (!user) {
      return;
    }

    const matches = user.memories.filter((memory) => {
      const id = memory.id.toLowerCase();
      return id.startsWith(normalized) || id.endsWith(normalized);
    });
    if (matches.length !== 1) {
      return;
    }

    removed = matches[0];
    draft.users[chatId] = {
      ...user,
      updatedAt: new Date().toISOString(),
      memories: user.memories.filter((memory) => memory.id !== removed?.id)
    };
  });

  const user = state.users[chatId];
  if (user) {
    await syncAssistantWorkspace(root, config, user);
  }

  return removed;
}

export async function listDueAssistantReminders(
  root: string,
  config: MicroClawConfig,
  now = new Date()
): Promise<Array<{ chatId: string; reminder: AssistantReminder }>> {
  const state = await loadAssistantState(root, config);
  const due: Array<{ chatId: string; reminder: AssistantReminder }> = [];
  const nowMs = now.getTime();

  for (const [chatId, user] of Object.entries(state.users)) {
    for (const reminder of user.reminders) {
      const dueAt = new Date(reminder.dueAt);
      if (!reminder.deliveredAt && !Number.isNaN(dueAt.getTime()) && dueAt.getTime() <= nowMs) {
        due.push({ chatId, reminder });
      }
    }
  }

  return due.sort((left, right) => left.reminder.dueAt.localeCompare(right.reminder.dueAt));
}

export async function getAssistantUserState(
  root: string,
  config: MicroClawConfig,
  chatId: string
): Promise<AssistantUserState | undefined> {
  const state = await loadAssistantState(root, config);
  return state.users[chatId];
}

export function formatAssistantUserContext(user: AssistantUserState | undefined, keepConversationMessages: number): string {
  if (!user) {
    return "No persistent user context is stored yet.";
  }

  const openTodos = user.todos.filter((todo) => !todo.completedAt);
  const pendingReminders = user.reminders.filter((reminder) => !reminder.deliveredAt);
  const activeMemories = user.memories.filter((memory) => {
    if (!memory.expiresAt) {
      return true;
    }

    const expiresAt = new Date(memory.expiresAt);
    return Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() > Date.now();
  });
  const recentConversation = user.conversation.slice(-keepConversationMessages * 2);

  return [
    `Display name: ${user.displayName ?? "unknown"}`,
    `Username: ${user.username ?? "unknown"}`,
    user.notes.length > 0 ? `Notes:\n${user.notes.slice(-5).map((note) => `- ${note.text}`).join("\n")}` : "Notes: none",
    openTodos.length > 0 ? `Open todos:\n${openTodos.slice(-5).map((todo) => `- ${todo.id.slice(0, 8)} ${todo.text}`).join("\n")}` : "Open todos: none",
    pendingReminders.length > 0
      ? `Pending reminders:\n${pendingReminders.slice(-5).map((reminder) => `- ${reminder.id.slice(0, 8)} ${reminder.dueAt} ${reminder.text}`).join("\n")}`
      : "Pending reminders: none",
    activeMemories.length > 0
      ? `Curated memories:\n${activeMemories.slice(-8).map((memory) => `- ${memory.id.slice(-8)} [${memory.kind}] ${memory.text}`).join("\n")}`
      : "Curated memories: none",
    recentConversation.length > 0
      ? `Recent conversation:\n${recentConversation.map((entry) => `- ${entry.role}: ${entry.content}`).join("\n")}`
      : "Recent conversation: none"
  ].join("\n\n");
}

export function getAssistantStateFiles(root: string, config: MicroClawConfig): {
  stateFile: string;
  summaryFile: string;
} {
  return getAssistantPaths(root, config);
}
