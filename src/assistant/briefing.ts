import type { AssistantScheduledTask, AssistantUserState, MicroClawConfig } from "../core/types.js";
import { truncate } from "../core/utils.js";
import { formatReminderDate } from "./reminder-parser.js";
import { formatAssistantSchedule } from "./schedule-parser.js";
import { listAssistantScheduledTasks, listDueAssistantScheduledTasks } from "./schedule-store.js";
import { readAssistantWorkspaceMemory } from "./workspace.js";

function formatList(lines: string[], empty: string): string[] {
  return lines.length > 0 ? lines.map((line) => `- ${line}`) : [`- ${empty}`];
}

function isSameLocalDate(left: Date, right: Date): boolean {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

function formatSchedule(task: AssistantScheduledTask): string {
  return `${task.id.slice(0, 8)} ${formatAssistantSchedule(task.schedule)} next ${formatReminderDate(task.nextRunAt)} :: ${truncate(task.prompt, 120)}`;
}

export async function buildAssistantBriefing(options: {
  root: string;
  config: MicroClawConfig;
  chatId: string;
  user?: AssistantUserState;
  now?: Date;
  mode?: "brief" | "today" | "review" | "inbox";
}): Promise<string> {
  const now = options.now ?? new Date();
  const user = options.user;
  const openTodos = user?.todos.filter((todo) => !todo.completedAt) ?? [];
  const pendingReminders = user?.reminders.filter((reminder) => !reminder.deliveredAt) ?? [];
  const dueReminders = pendingReminders.filter((reminder) => {
    const dueAt = new Date(reminder.dueAt);
    return !Number.isNaN(dueAt.getTime()) && dueAt.getTime() <= now.getTime();
  });
  const todayReminders = pendingReminders.filter((reminder) => {
    const dueAt = new Date(reminder.dueAt);
    return !Number.isNaN(dueAt.getTime()) && isSameLocalDate(dueAt, now);
  });
  const schedules = await listAssistantScheduledTasks(options.root, options.config, options.chatId);
  const dueSchedules = (await listDueAssistantScheduledTasks(options.root, options.config, now)).filter(
    (task) => task.chatId === options.chatId
  );
  const workspaceMemory = await readAssistantWorkspaceMemory(options.root, options.config, options.chatId);
  const memories = user?.memories ?? [];
  const recentNotes = user?.notes.slice(-5) ?? [];
  const recentConversation = user?.conversation.slice(-6) ?? [];

  if (options.mode === "inbox") {
    return [
      "# Inbox",
      "",
      "## Due Reminders",
      ...formatList(
        dueReminders.map((reminder) => `${reminder.id.slice(0, 8)} ${reminder.text} (${formatReminderDate(reminder.dueAt)})`),
        "No due reminders."
      ),
      "",
      "## Due Scheduled Tasks",
      ...formatList(dueSchedules.map((task) => formatSchedule(task)), "No due scheduled tasks.")
    ].join("\n");
  }

  if (options.mode === "today") {
    return [
      "# Today",
      "",
      "## Open Todos",
      ...formatList(openTodos.slice(0, 10).map((todo) => `${todo.id.slice(0, 8)} ${todo.text}`), "No open todos."),
      "",
      "## Today's Reminders",
      ...formatList(
        todayReminders.map((reminder) => `${reminder.id.slice(0, 8)} ${formatReminderDate(reminder.dueAt)} ${reminder.text}`),
        "No reminders due today."
      ),
      "",
      "## Next Schedules",
      ...formatList(schedules.slice(0, 5).map((task) => formatSchedule(task)), "No scheduled tasks.")
    ].join("\n");
  }

  if (options.mode === "review") {
    return [
      "# Review",
      "",
      "## Recent Notes",
      ...formatList(recentNotes.map((note) => `${note.id.slice(0, 8)} ${note.text}`), "No recent notes."),
      "",
      "## Curated Memories",
      ...formatList(memories.slice(-10).map((memory) => `${memory.id.slice(-8)} [${memory.kind}] ${memory.text}`), "No curated memories."),
      "",
      "## Recent Conversation",
      ...formatList(
        recentConversation.map((entry) => `${entry.role}: ${truncate(entry.content.replace(/\s+/g, " "), 160)}`),
        "No recent conversation."
      )
    ].join("\n");
  }

  return [
    "# Brief",
    "",
    "## Snapshot",
    `- Open todos: ${openTodos.length}`,
    `- Pending reminders: ${pendingReminders.length}`,
    `- Scheduled tasks: ${schedules.length}`,
    `- Curated memories: ${memories.length}`,
    "",
    "## Next Actions",
    ...formatList(openTodos.slice(0, 5).map((todo) => `${todo.id.slice(0, 8)} ${todo.text}`), "No open todos."),
    "",
    "## Upcoming",
    ...formatList(
      pendingReminders
        .slice(0, 5)
        .map((reminder) => `${reminder.id.slice(0, 8)} ${formatReminderDate(reminder.dueAt)} ${reminder.text}`),
      "No pending reminders."
    ),
    "",
    "## Memory",
    truncate(workspaceMemory.trim() || "No workspace memory saved yet.", 700)
  ].join("\n");
}
