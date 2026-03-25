import { Writable } from "node:stream";
import type { AssistantUserState, ChatMessage, MicroClawConfig } from "../core/types.js";
import { resolveAgentProfile } from "../agent/agent-profile.js";
import { runChatSession } from "../chat/chat-session.js";
import { requestChatCompletion, listOllamaModels, resolveOllamaModel } from "../providers/chat-provider.js";
import { routeTask } from "../router/model-router.js";
import { scanRepository } from "../scanner/repo-scanner.js";
import { formatAssistantUserContext } from "./store.js";

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

async function resolveModel(config: MicroClawConfig, desiredModel: string, providerKind: ReturnType<typeof routeTask>["providerKind"]): Promise<string> {
  if (providerKind !== "ollama") {
    return desiredModel || config.provider.model;
  }

  const available = await listOllamaModels(config);
  return resolveOllamaModel(available, desiredModel, config.provider.model);
}

function buildDailyMessages(
  profile: Awaited<ReturnType<typeof resolveAgentProfile>>,
  user: AssistantUserState | undefined,
  userInput: string,
  keepConversationMessages: number
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
        "Use the persistent user context when it is relevant, but do not dump it back verbatim.",
        "Be brief, clear, and action-oriented.",
        "If the user asks for repository automation or code execution, keep the answer practical."
      ].join("\n")
    },
    ...priorMessages,
    {
      role: "user",
      content: [
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
  user?: AssistantUserState;
  userInput: string;
  env?: NodeJS.ProcessEnv;
}): Promise<string> {
  if (shouldRouteToRepoAssistant(options.userInput)) {
    const chat = await runChatSession({
      root: options.root,
      config: options.config,
      initialPrompt: options.userInput,
      interactive: false,
      jsonMode: true,
      output: createSilentWritable(),
      env: options.env
    });

    return chat.lastAssistantMessage ?? "The repo task finished without a final assistant message.";
  }

  const repoSummary = await scanRepository(options.root);
  const route = routeTask(options.config, repoSummary, options.userInput);
  const profile = await resolveAgentProfile({
    root: options.root,
    promptIfMissing: false
  });
  const model = await resolveModel(options.config, route.coderModel, route.providerKind);
  const completion = await requestChatCompletion({
    config: options.config,
    providerKind: route.providerKind,
    model,
    messages: buildDailyMessages(
      profile,
      options.user,
      options.userInput,
      options.config.assistant.recentConversationMessages
    ),
    stream: false
  });

  return completion.content.trim() || "I could not produce a useful reply.";
}
