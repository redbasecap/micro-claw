import { Writable } from "node:stream";
import type { AssistantUserState, ChatMessage, MicroClawConfig, ProviderKind } from "../core/types.js";
import { resolveAgentProfile } from "../agent/agent-profile.js";
import { runChatSession } from "../chat/chat-session.js";
import { requestChatCompletion, listOllamaModels, resolveOllamaModel } from "../providers/chat-provider.js";
import { truncate } from "../core/utils.js";
import { formatAssistantUserContext } from "./store.js";
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
      model: config.provider.model
    };
  }

  return {
    providerKind: "ollama",
    model: await resolveModel(config, config.profiles.planner, "ollama", {
      configuredModel: "qwen3:4b",
      preference: "smallest"
    })
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

  return completion.content.trim() || "I could not produce a useful reply.";
}
