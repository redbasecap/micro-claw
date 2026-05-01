export interface AssistantEvalTask {
  id: string;
  title: string;
  prompt: string;
  command: string;
  expectedPatterns: string[];
}

export const assistantTaskCorpus: AssistantEvalTask[] = [
  {
    id: "assistant-brief",
    title: "Generate a compact briefing",
    prompt: "Summarize open todos, reminders, schedules, and memory.",
    command: "/brief",
    expectedPatterns: ["# Brief", "Open todos", "Memory"]
  },
  {
    id: "assistant-today",
    title: "Show today's operating view",
    prompt: "Show today's todos and reminders.",
    command: "/today",
    expectedPatterns: ["# Today", "Open Todos", "Today's Reminders"]
  },
  {
    id: "assistant-memory-forget",
    title: "Expose curated memory ids",
    prompt: "List remembered durable facts with stable ids.",
    command: "/memory",
    expectedPatterns: ["Curated memories", "Friday"]
  },
  {
    id: "assistant-inbox",
    title: "Report due work without sending it",
    prompt: "List due reminders and scheduled tasks.",
    command: "/inbox",
    expectedPatterns: ["# Inbox", "Due Reminders", "Due Scheduled Tasks"]
  }
];
