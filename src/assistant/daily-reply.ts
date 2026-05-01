import { Writable } from "node:stream";
import type { AssistantMemoryKind, AssistantUserState, ChatMessage, MicroClawConfig, ProviderKind } from "../core/types.js";
import { resolveAgentProfile } from "../agent/agent-profile.js";
import { runChatSession } from "../chat/chat-session.js";
import { requestChatCompletion, listOllamaModels, resolveOllamaModel } from "../providers/chat-provider.js";
import { truncate } from "../core/utils.js";
import { addAssistantMemory, formatAssistantUserContext } from "./store.js";
import { readAssistantWorkspaceMemory } from "./workspace.js";

function createSilentWritable(): Writable {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    }
  });
}

function shouldRouteToRepoAssistant(userInput: string): boolean {
  return (
    /\b(create|make|write|edit|change|update|delete|remove|fix|run|execute|install|test|build|compile|curl|mkdir|grep|rg|ls|pwd)\b/i.test(
      userInput
    ) ||
    /\b(repo|repository|code|file|files|src|docs|readme|package\.json|tsconfig|git)\b/i.test(userInput)
  );
}

async function resolveModel(
  config: MicroClawConfig,
  desiredModel: string,
  providerKind: ProviderKind,
  options?: { configuredModel?: string; preference?: "smallest" | "largest" }
): Promise<string> {
  if (providerKind !== "ollama") {
    return desiredModel || options?.configuredModel || config.provider.model;
  }

  const available = await listOllamaModels(config);
  return resolveOllamaModel(
    available,
    desiredModel,
    options?.configuredModel ?? config.provider.model,
    options?.preference ?? "largest"
  );
}

async function resolveAssistantReplyTarget(config: MicroClawConfig): Promise<{
  providerKind: ProviderKind;
  model: string;
}> {
  if (config.runtime.mode === "remote") {
    return {
      providerKind: config.provider.kind,
      model: config.assistant.replyModel || config.provider.model
    };
  }

  return {
    providerKind: "ollama",
    model: await resolveModel(config, config.assistant.replyModel || config.profiles.planner, "ollama", {
      configuredModel: config.assistant.replyModel ?? "qwen3:4b",
      preference: "smallest"
    })
  };
}

async function resolveAssistantMemoryTarget(config: MicroClawConfig): Promise<{
  providerKind: ProviderKind;
  model: string;
}> {
  if (config.runtime.mode === "remote") {
    return {
      providerKind: config.provider.kind,
      model: config.assistant.memoryModel || config.assistant.replyModel || config.provider.model
    };
  }

  return {
    providerKind: "ollama",
    model: await resolveModel(
      config,
      config.assistant.memoryModel || config.assistant.replyModel || config.profiles.planner,
      "ollama",
      {
        configuredModel: config.assistant.memoryModel ?? config.assistant.replyModel ?? "qwen3:4b",
        preference: "smallest"
      }
    )
  };
}

function buildDailyMessages(
  profile: Awaited<ReturnType<typeof resolveAgentProfile>>,
  user: AssistantUserState | undefined,
  workspaceMemory: string,
  userInput: string,
  keepConversationMessages: number,
  source: "user" | "scheduled",
  sourceLabel?: string
): ChatMessage[] {
  const recentConversation = [...(user?.conversation.slice(-keepConversationMessages * 2) ?? [])];
  const lastConversationEntry = recentConversation[recentConversation.length - 1];
  if (lastConversationEntry?.role === "user" && lastConversationEntry.content === userInput) {
    recentConversation.pop();
  }
  const priorMessages = recentConversation.map((entry) => ({
    role: entry.role,
    content: entry.content
  })) satisfies ChatMessage[];

  return [
    {
      role: "system",
      content: [
        `You are ${profile.name}, a concise daily-life assistant reached over Telegram.`,
        `Behavior preference: ${profile.behavior}`,
        "You help with planning, reminders, todos, notes, and practical everyday questions.",
        "Each Telegram chat has its own isolated workspace memory file. Use it as durable context.",
        "Use the persistent user context when it is relevant, but do not dump it back verbatim.",
        "Be brief, clear, and action-oriented.",
        "If the user asks for repository automation or code execution, keep the answer practical."
      ].join("\n")
    },
    ...priorMessages,
    {
      role: "user",
      content: [
        `Trigger: ${source === "scheduled" ? `scheduled task (${sourceLabel ?? "scheduled"})` : "direct Telegram message"}`,
        "",
        "Workspace memory (CLAUDE.md):",
        truncate(workspaceMemory.trim() || "No workspace memory saved yet.", 4_000),
        "",
        "Persistent user context:",
        formatAssistantUserContext(user, keepConversationMessages),
        "",
        "Latest Telegram message:",
        userInput
      ].join("\n")
    }
  ];
}

function parseMemoryKind(value: unknown): AssistantMemoryKind {
  switch (value) {
    case "fact":
    case "preference":
    case "routine":
    case "project":
    case "other":
      return value;
    default:
      return "other";
  }
}

function extractJsonObject(source: string): unknown {
  const trimmed = source.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
  }

  return undefined;
}

async function curateAssistantMemory(options: {
  root: string;
  config: MicroClawConfig;
  chatId: string;
  user?: AssistantUserState;
  userInput: string;
  assistantReply: string;
  workspaceMemory: string;
}): Promise<void> {
  if (!options.config.assistant.enableMemoryCuration) {
    return;
  }

  const target = await resolveAssistantMemoryTarget(options.config);
  const completion = await requestChatCompletion({
    config: options.config,
    providerKind: target.providerKind,
    model: target.model,
    messages: [
      {
        role: "system",
        content: [
          "Extract only durable assistant memory from the latest user turn.",
          "Return JSON only with this shape:",
          '{"memories":[{"text":"short durable fact","kind":"fact|preference|routine|project|other","confidence":0.0}]}',
          "Use an empty memories array when nothing stable should be remembered.",
          "Do not store one-off small talk, transient commands, or sensitive secrets."
        ].join("\n")
      },
      {
        role: "user",
        content: [
          "Existing workspace memory:",
          truncate(options.workspaceMemory, 1_500),
          "",
          "Persistent user context:",
          formatAssistantUserContext(options.user, options.config.assistant.recentConversationMessages),
          "",
          "Latest user message:",
          options.userInput,
          "",
          "Assistant reply:",
          truncate(options.assistantReply, 1_200)
        ].join("\n")
      }
    ],
    stream: false
  });

  const parsed = extractJsonObject(completion.content) as
    | { memories?: Array<{ text?: unknown; kind?: unknown; confidence?: unknown }> }
    | undefined;
  if (!parsed || !Array.isArray(parsed.memories)) {
    return;
  }

  for (const item of parsed.memories.slice(0, 3)) {
    if (typeof item.text !== "string" || !item.text.trim()) {
      continue;
    }

    await addAssistantMemory(options.root, options.config, options.chatId, {
      text: item.text,
      kind: parseMemoryKind(item.kind),
      source: "curated",
      confidence: typeof item.confidence === "number" ? item.confidence : 0.65
    });
  }
}

export async function generateDailyAssistantReply(options: {
  root: string;
  config: MicroClawConfig;
  chatId: string;
  user?: AssistantUserState;
  userInput: string;
  source?: "user" | "scheduled";
  sourceLabel?: string;
  stream?: boolean;
  onToken?: (token: string) => void | Promise<void>;
  onProgress?: (message: string) => void | Promise<void>;
  env?: NodeJS.ProcessEnv;
}): Promise<string> {
  const source = options.source ?? "user";

  if (shouldRouteToRepoAssistant(options.userInput)) {
    await options.onProgress?.("delegating to the repo assistant");
    const chat = await runChatSession({
      root: options.root,
      config: options.config,
      initialPrompt:
        source === "scheduled"
          ? `Scheduled task (${options.sourceLabel ?? "scheduled"}): ${options.userInput}`
          : options.userInput,
      interactive: false,
      jsonMode: true,
      output: createSilentWritable(),
      env: options.env
    });

    return chat.lastAssistantMessage ?? "The repo task finished without a final assistant message.";
  }

  const profile = await resolveAgentProfile({
    root: options.root,
    promptIfMissing: false
  });
  await options.onProgress?.("loading workspace memory");
  const workspaceMemory = await readAssistantWorkspaceMemory(options.root, options.config, options.chatId);
  const target = await resolveAssistantReplyTarget(options.config);
  await options.onProgress?.(`requesting a reply from ${target.providerKind}`);
  const completion = await requestChatCompletion({
    config: options.config,
    providerKind: target.providerKind,
    model: target.model,
    messages: buildDailyMessages(
      profile,
      options.user,
      workspaceMemory,
      options.userInput,
      options.config.assistant.recentConversationMessages,
      source,
      options.sourceLabel
    ),
    stream: options.stream === true,
    onToken: options.onToken
  });

  const reply = completion.content.trim() || "I could not produce a useful reply.";

  if (source === "user") {
    try {
      await curateAssistantMemory({
        root: options.root,
        config: options.config,
        chatId: options.chatId,
        user: options.user,
        userInput: options.userInput,
        assistantReply: reply,
        workspaceMemory
      });
    } catch (error) {
      await options.onProgress?.(`memory curation skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return reply;
}
