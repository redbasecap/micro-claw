import { Writable } from "node:stream";
import type {
  AssistantMemoryKind,
  AssistantUserState,
  ChatMessage,
  MicroClawConfig,
  ProviderKind,
  ShellCommandResult
} from "../core/types.js";
import { resolveAgentProfile } from "../agent/agent-profile.js";
import { runChatSession } from "../chat/chat-session.js";
import { requestChatCompletion, listOllamaModels, resolveOllamaModel } from "../providers/chat-provider.js";
import { truncate } from "../core/utils.js";
import { ToolExecutor } from "../tools/tool-executor.js";
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
  const asksAboutLocalCommand =
    /\b(version|installed|available|path|where|which)\b/i.test(userInput) &&
    /\b(homebrew|brew|node|npm|pnpm|python|python3|git|ollama|llama|llama-server|cargo|rust|go|uv)\b/i.test(userInput);

  return (
    asksAboutLocalCommand ||
    /\b(create|make|write|edit|change|update|delete|remove|fix|run|execute|install|test|build|compile|curl|mkdir|grep|rg|ls|pwd)\b/i.test(
      userInput
    ) ||
    /\b(repo|repository|code|file|files|src|docs|readme|package\.json|tsconfig|git)\b/i.test(userInput)
  );
}

interface LocalCommandQuestion {
  command: string;
  label: string;
  kind: "path" | "version";
}

function detectLocalCommandQuestion(userInput: string): LocalCommandQuestion | undefined {
  const wantsVersion =
    /\b(version|installed|available)\b/i.test(userInput) || /\bwhich\s+version\b/i.test(userInput);
  const wantsPath = /\b(where|path)\b/i.test(userInput) || (/\bwhich\b/i.test(userInput) && !wantsVersion);
  if (!wantsVersion && !wantsPath) {
    return undefined;
  }

  const tools = [
    { pattern: /\b(homebrew|brew)\b/i, label: "Homebrew", binary: "brew", version: "brew --version" },
    { pattern: /\bnode\b/i, label: "Node.js", binary: "node", version: "node --version" },
    { pattern: /\bnpm\b/i, label: "npm", binary: "npm", version: "npm --version" },
    { pattern: /\bpnpm\b/i, label: "pnpm", binary: "pnpm", version: "pnpm --version" },
    { pattern: /\bpython3\b/i, label: "Python 3", binary: "python3", version: "python3 --version" },
    { pattern: /\bpython\b/i, label: "Python", binary: "python", version: "python --version" },
    { pattern: /\bgit\b/i, label: "Git", binary: "git", version: "git --version" },
    { pattern: /\bollama\b/i, label: "Ollama", binary: "ollama", version: "ollama --version" },
    { pattern: /\bllama-server\b/i, label: "llama-server", binary: "llama-server", version: "llama-server --version" },
    { pattern: /\buv\b/i, label: "uv", binary: "uv", version: "uv --version" },
    { pattern: /\bcargo\b/i, label: "Cargo", binary: "cargo", version: "cargo --version" },
    { pattern: /\brust\b/i, label: "Rust", binary: "rustc", version: "rustc --version" },
    { pattern: /\bgo\b/i, label: "Go", binary: "go", version: "go version" }
  ] as const;

  const tool = tools.find((candidate) => candidate.pattern.test(userInput));
  if (!tool) {
    return undefined;
  }

  return {
    command: wantsPath ? `command -v ${tool.binary}` : tool.version,
    label: tool.label,
    kind: wantsPath ? "path" : "version"
  };
}

async function answerLocalCommandQuestion(options: {
  root: string;
  config: MicroClawConfig;
  userInput: string;
  onProgress?: (message: string) => void | Promise<void>;
}): Promise<string | undefined> {
  const question = detectLocalCommandQuestion(options.userInput);
  if (!question) {
    return undefined;
  }

  await options.onProgress?.(`running ${question.command}`);
  const executor = new ToolExecutor(options.root, options.config);
  const result = await executor.execute({
    tool: "shell",
    input: {
      command: question.command
    }
  });

  const shellResult = result.data as ShellCommandResult | undefined;
  const output = [shellResult?.stdout.trim(), shellResult?.stderr.trim()].filter(Boolean).join("\n");
  const noun = question.kind === "path" ? "path" : "version";

  if (!result.ok || shellResult?.exitCode !== 0) {
    return [
      `I ran \`${question.command}\`, but I could not read the ${question.label} ${noun}.`,
      output ? `\n${truncate(output, 600)}` : result.error ? `\n${result.error}` : ""
    ].join("");
  }

  return [`${question.label} ${noun}:`, truncate(output || "(no output)", 600), "", `Command: \`${question.command}\``].join(
    "\n"
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
  const localCommandReply = await answerLocalCommandQuestion(options);
  if (localCommandReply) {
    return localCommandReply;
  }

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
