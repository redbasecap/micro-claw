import { Writable } from "node:stream";
import { createInterface } from "node:readline/promises";
import process from "node:process";
import { resolveAgentProfile } from "../agent/agent-profile.js";
import { createCliUi, writeHero } from "../cli-ui.js";
import type {
  AgentProfile,
  ChatCompletionResult,
  ChatMessage,
  ChatSessionResult,
  MicroClawConfig,
  RepoSummary,
  RouterDecision,
  ToolCall,
  ToolName,
  ToolResult
} from "../core/types.js";
import { assertWithinRoot, extractTaskKeywords, pathExists, truncate, unique } from "../core/utils.js";
import { SessionStore } from "../memory/session-store.js";
import { runAgentLoop } from "../orchestrator/agent-loop.js";
import { createDeterministicPlan } from "../planner/deterministic-planner.js";
import { requestChatCompletion, listOllamaModels, resolveOllamaModel } from "../providers/chat-provider.js";
import { diagnoseProvider } from "../providers/provider-diagnostics.js";
import { routeTask } from "../router/model-router.js";
import { scanRepository } from "../scanner/repo-scanner.js";
import { inspectSecretgateBoundary } from "../security/secretgate-boundary.js";
import {
  createShellHelperAssets,
  createSkillScaffold,
  type CreateSkillScaffoldOptions
} from "../skills/skill-scaffold.js";
import { readTextFile, searchText } from "../tools/file-tool.js";
import { ToolExecutor } from "../tools/tool-executor.js";

const CHAT_HELP_LINES = [
  "/help                Show chat commands",
  "/profile             Show the saved agent name and behavior",
  "/scan                Refresh and print the repo summary",
  "/status              Print provider and Secretgate status",
  "/plan <task>         Build a deterministic plan",
  "/run <task>          Run the existing task loop",
  "/search <query>      Search the repo",
  "/read <path>         Read a file snippet",
  "/exit                Leave chat"
] as const;

interface ChatState {
  agentProfile: AgentProfile;
  session: SessionStore;
  repoSummary: RepoSummary;
  routerDecision: RouterDecision;
  messages: ChatMessage[];
  turnCount: number;
  lastAssistantMessage?: string;
  providerKind: RouterDecision["providerKind"];
  model: string;
  availableOllamaModels?: Array<{ name: string; size?: number }>;
}

interface ToolInstruction {
  type: "tool";
  tool: ToolName;
  input: Record<string, unknown>;
}

interface FinalInstruction {
  type: "final";
  content: string;
}

type AgentInstruction = ToolInstruction | FinalInstruction;

export interface RunChatSessionOptions {
  root: string;
  config: MicroClawConfig;
  initialPrompt?: string;
  interactive?: boolean;
  output?: Writable;
  env?: NodeJS.ProcessEnv;
  jsonMode?: boolean;
}

function formatRepoSummary(repoSummary: RepoSummary): string {
  return [
    `Root: ${repoSummary.root}`,
    `Files: ${repoSummary.fileCount}`,
    `Stacks: ${repoSummary.detectedStacks.join(", ") || "none"}`,
    `Build Commands: ${repoSummary.buildCommands.join(", ") || "none"}`,
    `Test Commands: ${repoSummary.testCommands.join(", ") || "none"}`,
    `Important Files: ${repoSummary.importantFiles.join(", ") || "none"}`
  ].join("\n");
}

function formatRepoSummaryRich(
  repoSummary: RepoSummary,
  ui: ReturnType<typeof createCliUi>
): string {
  return [
    ui.section("Repository"),
    ui.renderRows([
      { label: "Root", value: repoSummary.root },
      { label: "Files", value: String(repoSummary.fileCount), tone: "accent" },
      {
        label: "Stacks",
        value: repoSummary.detectedStacks.join(", ") || "none",
        tone: repoSummary.detectedStacks.length > 0 ? "secondary" : "muted"
      },
      {
        label: "Build Commands",
        value: repoSummary.buildCommands.join(", ") || "none",
        tone: repoSummary.buildCommands.length > 0 ? "success" : "muted"
      },
      {
        label: "Test Commands",
        value: repoSummary.testCommands.join(", ") || "none",
        tone: repoSummary.testCommands.length > 0 ? "success" : "muted"
      },
      {
        label: "Important Files",
        value: repoSummary.importantFiles.join(", ") || "none",
        tone: repoSummary.importantFiles.length > 0 ? "strong" : "muted"
      }
    ])
  ].join("\n");
}

function formatPlanText(plan: ReturnType<typeof createDeterministicPlan>): string {
  return [
    `Task: ${plan.taskSummary}`,
    "",
    "Constraints:",
    ...plan.constraints.map((item) => `- ${item}`),
    "",
    "Steps:",
    ...plan.steps.map((step) => `- ${step.id}: ${step.action} (${step.successSignal})`),
    "",
    "Verification:",
    ...plan.verificationPlan.map((item) => `- ${item}`)
  ].join("\n");
}

function formatPlanTextRich(
  plan: ReturnType<typeof createDeterministicPlan>,
  ui: ReturnType<typeof createCliUi>
): string {
  return [
    ui.section("Task"),
    ui.renderRows([
      { label: "Summary", value: plan.taskSummary },
      { label: "Next Action", value: plan.nextAction, tone: "accent" }
    ]),
    "",
    ui.section("Constraints"),
    ui.renderList(plan.constraints.length > 0 ? plan.constraints : ["none"]),
    "",
    ui.section("Steps"),
    ui.renderList(plan.steps.map((step) => `${step.id}: ${step.action} -> ${step.successSignal}`), "strong"),
    "",
    ui.section("Verification"),
    ui.renderList(plan.verificationPlan.length > 0 ? plan.verificationPlan : ["none"], "secondary")
  ].join("\n");
}

function formatSearchResults(results: Awaited<ReturnType<typeof searchText>>): string {
  if (results.length === 0) {
    return "No matches found.";
  }

  return results.map((match) => `${match.path}:${match.line} ${match.preview}`).join("\n");
}

function formatSearchResultsRich(
  results: Awaited<ReturnType<typeof searchText>>,
  ui: ReturnType<typeof createCliUi>
): string {
  if (results.length === 0) {
    return ui.muted("No matches found.");
  }

  return [ui.section("Matches"), ui.renderList(results.map((match) => `${match.path}:${match.line} ${match.preview}`))].join(
    "\n"
  );
}

function formatChatHelp(ui?: ReturnType<typeof createCliUi>): string {
  if (!ui?.decorated) {
    return ["Commands:", ...CHAT_HELP_LINES.map((line) => `  ${line}`)].join("\n");
  }

  return [ui.section("Commands"), ui.renderList([...CHAT_HELP_LINES], "strong")].join("\n");
}

function shouldUseAgentTools(userInput: string): boolean {
  const actionVerb =
    /\b(add|create|make|write|edit|change|update|delete|remove|fix|run|execute|install|test|build|compile|curl|fetch|download|mkdir|program|document|generate|scaffold|summarize)\b/i;
  const commandLike = /\b(cd|grep|rg|pwd|ls)\b/i;
  const repoArtifact =
    /\b(readme|reademe|markdown|docs?|documentation|file|files|folder|directory|repo|repository|summary|overview)\b/i;
  const repoIntent = /\b(add|create|make|write|document|generate|summarize|tell|describe|explain)\b/i;

  return actionVerb.test(userInput) || commandLike.test(userInput) || (repoArtifact.test(userInput) && repoIntent.test(userInput));
}

function inferSimpleSkillRequest(userInput: string): Omit<CreateSkillScaffoldOptions, "root"> | undefined {
  const match = userInput.match(/\b(?:create|make|write|scaffold)\s+(?:a\s+)?skill(?:\s+for|\s+called)?\s+(.+)$/i);
  if (!match) {
    return undefined;
  }

  const rawName = match[1].trim().replace(/[.?!]+$/, "");
  if (!rawName) {
    return undefined;
  }

  const normalizedName = rawName
    .replace(/\bwith\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  const needsShellHelpers = /\b(cd|curl|grep|rg|shell|cli|terminal|command|smoke test|api)\b/i.test(
    `${userInput} ${normalizedName}`
  );

  return {
    name: normalizedName,
    description: `Use when the user needs ${rawName.toLowerCase()}.`,
    ...(needsShellHelpers ? createShellHelperAssets(normalizedName) : {})
  };
}

function buildToolPrompt(
  root: string,
  repoSummary: RepoSummary,
  route: RouterDecision,
  boundaryMessage: string,
  agentProfile: AgentProfile
): string {
  return [
    `You are ${agentProfile.name} operating in tool mode.`,
    `Repo root: ${root}`,
    `Secretgate boundary: ${boundaryMessage}`,
    `Provider path: ${route.providerKind}`,
    `Behavior preference: ${agentProfile.behavior}`,
    "You can use tools and must never pretend that a command ran or a file changed.",
    "When the task needs actions, respond with exactly one JSON object and nothing else.",
    "Tool schema:",
    '{"type":"tool","tool":"list_files","input":{"directory":".","maxResults":50}}',
    '{"type":"tool","tool":"read_file","input":{"path":"src/app.ts"}}',
    '{"type":"tool","tool":"search","input":{"query":"snake","maxResults":20}}',
    '{"type":"tool","tool":"write_file","input":{"path":"TEST/snake.py","content":"print(\\"hi\\")\\n"}}',
    '{"type":"tool","tool":"replace_text","input":{"path":"src/app.ts","search":"old","replace":"new","expectedReplacements":1}}',
    '{"type":"tool","tool":"delete_file","input":{"path":"tmp.txt"}}',
    '{"type":"tool","tool":"create_skill","input":{"name":"curl-checker","description":"Use when the user needs curl-based endpoint checks.","instructions":"# curl checker\\n\\n1. Read the target endpoint details.\\n2. Run focused curl commands.\\n3. Summarize the response and failures.","scripts":[{"name":"run.sh","content":"#!/usr/bin/env bash\\nset -euo pipefail\\ncurl -fsSL \\"$1\\"\\n","executable":true}]}}',
    '{"type":"tool","tool":"shell","input":{"command":"python3 TEST/snake.py"}}',
    '{"type":"tool","tool":"shell","input":{"cwd":"TEST","command":"pwd && ls"}}',
    '{"type":"tool","tool":"git_status","input":{}}',
    '{"type":"tool","tool":"git_diff","input":{}}',
    'Final answer schema: {"type":"final","content":"what you did, what changed, and what was verified"}',
    "Rules:",
    "- Prefer read_file, list_files, and search before writing.",
    "- Prefer write_file for new files and replace_text for focused edits.",
    "- Prefer create_skill when the user asks for a reusable skill, workflow, or tool folder.",
    "- Use shell for execution, tests, curl, package installation, directory creation, and commands that need `cd`, pipes, `grep`, or `rg`.",
    "- The shell tool can receive `cwd` for folder-specific work, or you can use `cd <dir> && ...` inside the command.",
    "- One tool per reply.",
    "- After a tool result, decide the next best tool or return a final answer.",
    "- In the final answer, mention only files changed or commands run that appear in tool results from this loop.",
    "- Do not claim that a repo file changed just because it was present in the repo summary.",
    "",
    "Repo summary:",
    formatRepoSummary(repoSummary)
  ].join("\n");
}

function extractJsonObject(text: string): string | undefined {
  const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fencedMatch?.[1]?.trim() ?? text.trim();

  if (candidate.startsWith("{") && candidate.endsWith("}")) {
    return candidate;
  }

  const firstBrace = candidate.indexOf("{");
  if (firstBrace < 0) {
    return undefined;
  }

  let depth = 0;
  let inString = false;
  let escaping = false;

  for (let index = firstBrace; index < candidate.length; index += 1) {
    const char = candidate[index];

    if (escaping) {
      escaping = false;
      continue;
    }

    if (char === "\\") {
      escaping = true;
      continue;
    }

    if (char === "\"") {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return candidate.slice(firstBrace, index + 1);
      }
    }
  }

  return undefined;
}

function parseAgentInstruction(content: string): AgentInstruction | undefined {
  const json = extractJsonObject(content);
  if (!json) {
    return undefined;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return undefined;
  }

  if (parsed.type === "final" && typeof parsed.content === "string") {
    return {
      type: "final",
      content: parsed.content
    };
  }

  if (
    parsed.type === "tool" &&
    typeof parsed.tool === "string" &&
    typeof parsed.input === "object" &&
    parsed.input !== null &&
    !Array.isArray(parsed.input)
  ) {
    return {
      type: "tool",
      tool: parsed.tool as ToolName,
      input: parsed.input as Record<string, unknown>
    };
  }

  return undefined;
}

function formatToolResult(result: ToolResult): string {
  const lines = [
    `Tool: ${result.tool}`,
    `Status: ${result.ok ? "ok" : "failed"}`,
    `Summary: ${result.summary}`
  ];

  if (result.error) {
    lines.push(`Error: ${result.error}`);
  }

  if (result.data !== undefined) {
    const serialized =
      typeof result.data === "string"
        ? result.data
        : JSON.stringify(result.data, null, 2);
    lines.push(`Data:\n${truncate(serialized, 6_000)}`);
  }

  return lines.join("\n");
}

function summarizeToolInstruction(instruction: ToolInstruction): string {
  switch (instruction.tool) {
    case "read_file":
    case "write_file":
    case "delete_file":
      return `${instruction.tool} ${String(instruction.input.path ?? "")}`.trim();
    case "replace_text":
      return `${instruction.tool} ${String(instruction.input.path ?? "")}`.trim();
    case "list_files":
      return `${instruction.tool} ${String(instruction.input.directory ?? ".")}`.trim();
    case "search":
      return `${instruction.tool} ${String(instruction.input.query ?? "")}`.trim();
    case "shell":
      return `${instruction.tool}${instruction.input.cwd ? ` [cwd=${String(instruction.input.cwd)}]` : ""} ${String(instruction.input.command ?? "")}`.trim();
    case "create_skill":
      return `${instruction.tool} ${String(instruction.input.name ?? "")}`.trim();
    case "git_status":
    case "git_diff":
    case "patch":
    default:
      return instruction.tool;
  }
}

function writeProgress(
  output: Writable,
  enabled: boolean,
  message: string,
  ui: ReturnType<typeof createCliUi>
): void {
  if (!enabled) {
    return;
  }

  output.write(`${ui.formatProgress(message)}\n`);
}

function buildToolLoopSummary(
  touchedFiles: string[],
  executedCommands: string[],
  failures: string[]
): string {
  const lines: string[] = [];

  if (touchedFiles.length > 0) {
    lines.push(`Changed files: ${unique(touchedFiles).join(", ")}.`);
  }

  if (executedCommands.length > 0) {
    lines.push(`Commands run: ${unique(executedCommands).join(", ")}.`);
  }

  if (failures.length > 0) {
    lines.push(`Recovered from failures: ${unique(failures).join(", ")}.`);
  }

  if (lines.length === 0) {
    return "Tool loop completed with no tracked file changes or commands.";
  }

  return lines.join(" ");
}

function buildSystemPromptInternal(
  root: string,
  repoSummary: RepoSummary,
  route: RouterDecision,
  boundaryMessage: string,
  includeRepoSummary: boolean,
  agentProfile: AgentProfile
): string {
  return [
    `You are ${agentProfile.name}, a concise coding assistant for a local repository.`,
    `Repo root: ${root}`,
    `Secretgate boundary: ${boundaryMessage}`,
    `Active provider path: ${route.providerKind}`,
    `Primary chat model intent: ${route.coderModel}`,
    `Behavior preference: ${agentProfile.behavior}`,
    "Rules:",
    "- Ground replies in the repo facts and supplied search or file context.",
    "- Do not claim to have run commands or changed files unless that was actually done by a slash command.",
    "- Answer directly instead of turning normal requests into instructions for the user.",
    includeRepoSummary ? "" : undefined,
    includeRepoSummary ? "Repo summary:" : undefined,
    includeRepoSummary ? formatRepoSummary(repoSummary) : undefined
  ]
    .filter((part): part is string => typeof part === "string")
    .join("\n");
}

function isRepoFocusedInput(userInput: string): boolean {
  return (
    /\b(repo|repository|file|files|code|build|test|plan|run|patch|bug|fix|readme|src|docs)\b/i.test(userInput) ||
    /[A-Za-z0-9_./-]+\.[A-Za-z0-9_-]+/.test(userInput)
  );
}

async function buildGroundingContext(
  root: string,
  config: MicroClawConfig,
  repoSummary: RepoSummary,
  userInput: string
): Promise<string | undefined> {
  const explicitFileCandidates = userInput.match(/[A-Za-z0-9_./-]+\.[A-Za-z0-9_-]+/g) ?? [];
  const repoFocused = isRepoFocusedInput(userInput);

  if (!repoFocused && explicitFileCandidates.length === 0) {
    return undefined;
  }

  return buildGroundingContextInternal(root, config, repoSummary, userInput, explicitFileCandidates);
}

async function buildGroundingContextInternal(
  root: string,
  config: MicroClawConfig,
  repoSummary: RepoSummary,
  userInput: string,
  explicitFileCandidates: string[]
): Promise<string> {
  const keywords = extractTaskKeywords(userInput);
  const searchResults =
    keywords.length > 0
      ? await searchText(root, keywords[0], Math.min(config.context.maxOpenFiles, 6))
      : [];

  const candidateFiles = unique([
    ...explicitFileCandidates,
    ...searchResults.map((match) => match.path)
  ]);

  const fileSnippets: string[] = [];

  for (const candidate of candidateFiles.slice(0, Math.min(2, config.context.maxOpenFiles))) {
    try {
      const absolutePath = assertWithinRoot(root, candidate);
      if (!(await pathExists(absolutePath))) {
        continue;
      }

      const content = await readTextFile(root, candidate, Math.floor(config.context.maxFileCharsPerFile / 4));
      fileSnippets.push(`File: ${candidate}\n${content}`);
    } catch {
      continue;
    }
  }

  return [
    "Current repo context:",
    formatRepoSummary(repoSummary),
    "",
    searchResults.length > 0 ? `Search matches for "${keywords[0]}":\n${formatSearchResults(searchResults)}` : "No automatic search matches were added for this turn.",
    "",
    fileSnippets.length > 0 ? `Relevant file snippets:\n${fileSnippets.join("\n\n")}` : "No file snippet was attached for this turn.",
    "",
    `User request:\n${userInput}`
  ].join("\n");
}

async function persistChatState(state: ChatState): Promise<void> {
  await state.session.writeJson("chat-messages.json", state.messages);
  await state.session.writeText(
    "chat-transcript.md",
    state.messages
      .map((message) => `## ${message.role}\n\n${message.content}\n`)
      .join("\n")
  );
}

function selectRecentMessages(messages: ChatMessage[], keepRecentMessages: number): ChatMessage[] {
  const limit = Math.max(keepRecentMessages * 2, 6);
  return messages.slice(-limit);
}

async function resolveChatModel(
  state: ChatState,
  config: MicroClawConfig,
  desiredModel: string
): Promise<string> {
  if (state.providerKind !== "ollama") {
    return desiredModel;
  }

  if (!state.availableOllamaModels) {
    state.availableOllamaModels = await listOllamaModels(config);
  }

  return resolveOllamaModel(state.availableOllamaModels, desiredModel, config.provider.model);
}

async function executeUserTurn(
  userInput: string,
  state: ChatState,
  root: string,
  config: MicroClawConfig,
  output: Writable,
  boundaryMessage: string,
  stream: boolean,
  echoResponse: boolean
): Promise<ChatCompletionResult> {
  const route = routeTask(config, state.repoSummary, userInput);
  const groundingContext = await buildGroundingContext(root, config, state.repoSummary, userInput);
  const recentMessages = selectRecentMessages(state.messages, config.context.keepRecentMessages);
  const model = await resolveChatModel(state, config, route.coderModel);
  const requestMessages: ChatMessage[] = [
    {
      role: "system",
      content: buildSystemPromptInternal(
        root,
        state.repoSummary,
        route,
        boundaryMessage,
        Boolean(groundingContext),
        state.agentProfile
      )
    },
    ...recentMessages.slice(0, -1),
    {
      role: "user",
      content: groundingContext ?? userInput
    }
  ];

  const completion = await requestChatCompletion({
    config,
    providerKind: state.providerKind,
    model,
    messages: requestMessages,
    stream,
    onToken: async (token) => {
      if (!stream || !echoResponse) {
        return;
      }

      output.write(token);
    }
  });

  if (!stream && echoResponse) {
    output.write(`${completion.content}\n`);
  } else if (stream && echoResponse) {
    output.write("\n");
  }

  state.messages.push({
    role: "assistant",
    content: completion.content
  });
  state.turnCount += 1;
  state.lastAssistantMessage = completion.content;
  state.model = completion.model;
  state.routerDecision = route;

  await state.session.appendEvent({
    type: "chat_turn",
    createdAt: new Date().toISOString(),
    userInput,
    model: completion.model
  });
  await persistChatState(state);

  return completion;
}

async function executeAgentTurn(
  userInput: string,
  state: ChatState,
  root: string,
  config: MicroClawConfig,
  output: Writable,
  boundaryMessage: string,
  echoResponse: boolean,
  ui: ReturnType<typeof createCliUi>
): Promise<ChatCompletionResult> {
  const route = routeTask(config, state.repoSummary, userInput);
  const recentMessages = selectRecentMessages(state.messages, config.context.keepRecentMessages);
  const model = await resolveChatModel(state, config, route.coderModel);
  const executor = new ToolExecutor(root, config);
  const groundingContext = await buildGroundingContext(root, config, state.repoSummary, userInput);
  const workMessages: ChatMessage[] = [
    ...recentMessages.slice(0, -1),
    {
      role: "user",
      content: groundingContext ?? userInput
    }
  ];

  writeProgress(output, echoResponse, `tool mode enabled for: ${userInput}`, ui);
  let finalCompletion: ChatCompletionResult | undefined;
  const touchedFiles: string[] = [];
  const executedCommands: string[] = [];
  const failures: string[] = [];

  for (let step = 0; step < 8; step += 1) {
    writeProgress(output, echoResponse, `planning step ${step + 1}`, ui);
    const completion = await requestChatCompletion({
      config,
      providerKind: state.providerKind,
      model,
      messages: [
        {
          role: "system",
          content: buildToolPrompt(root, state.repoSummary, route, boundaryMessage, state.agentProfile)
        },
        ...workMessages
      ],
      stream: false
    });

    const instruction = parseAgentInstruction(completion.content);

    if (!instruction) {
      writeProgress(output, echoResponse, "model reply was not valid tool JSON; returning raw output", ui);
      finalCompletion = {
        ...completion,
        content: `Tool-mode reply was not valid JSON. Raw model output:\n\n${completion.content}`
      };
      break;
    }

    if (instruction.type === "final") {
      writeProgress(output, echoResponse, "tool loop finished", ui);
      finalCompletion = {
        ...completion,
        content: instruction.content
      };
      break;
    }

    writeProgress(output, echoResponse, `running ${summarizeToolInstruction(instruction)}`, ui);
    const toolCall: ToolCall = {
      tool: instruction.tool,
      input: instruction.input
    };
    const toolResult = await executor.execute(toolCall);
    writeProgress(output, echoResponse, `${instruction.tool} ${toolResult.ok ? "completed" : "failed"}: ${toolResult.summary}`, ui);

    if (!toolResult.ok) {
      failures.push(`${instruction.tool}: ${toolResult.error ?? toolResult.summary}`);
    }

    if (instruction.tool === "shell") {
      const command = String(instruction.input.command ?? "").trim();
      if (command) {
        executedCommands.push(command);
      }
    }

    if (instruction.tool === "write_file" || instruction.tool === "replace_text" || instruction.tool === "delete_file") {
      const targetPath = String(instruction.input.path ?? "").trim();
      if (targetPath) {
        touchedFiles.push(targetPath);
      }
    }

    if (instruction.tool === "patch" && Array.isArray(toolResult.data)) {
      for (const file of toolResult.data) {
        if (typeof file === "string") {
          touchedFiles.push(file);
        }
      }
    }

    if (instruction.tool === "create_skill") {
      const data = toolResult.data as { createdFiles?: unknown } | undefined;
      if (Array.isArray(data?.createdFiles)) {
        for (const file of data.createdFiles) {
          if (typeof file === "string") {
            touchedFiles.push(file);
          }
        }
      }
    }

    workMessages.push({
      role: "assistant",
      content: JSON.stringify(instruction)
    });
    workMessages.push({
      role: "user",
      content: `Tool result:\n${formatToolResult(toolResult)}`
    });

    state.messages.push({
      role: "assistant",
      content: `[tool request] ${JSON.stringify(instruction)}`
    });
    state.messages.push({
      role: "user",
      content: `[tool result]\n${formatToolResult(toolResult)}`
    });

    await state.session.appendEvent({
      type: "chat_tool",
      createdAt: new Date().toISOString(),
      tool: instruction.tool,
      ok: toolResult.ok
    });

    if (instruction.tool === "list_files" || instruction.tool === "write_file" || instruction.tool === "replace_text" || instruction.tool === "delete_file") {
      state.repoSummary = await scanRepository(root);
      await state.session.writeJson("repo-summary.json", state.repoSummary);
    }
  }

  const completion =
    finalCompletion ??
    ({
      providerKind: state.providerKind,
      model,
      content: "Stopped after reaching the tool step limit. Summarize the current state and continue with a narrower request."
    } satisfies ChatCompletionResult);

  if (touchedFiles.length > 0 || executedCommands.length > 0 || failures.length > 0) {
    completion.content = buildToolLoopSummary(touchedFiles, executedCommands, failures);
  }

  if (echoResponse) {
    writeProgress(output, echoResponse, "sending final answer", ui);
    output.write(`${completion.content}\n`);
  }

  state.messages.push({
    role: "assistant",
    content: completion.content
  });
  state.turnCount += 1;
  state.lastAssistantMessage = completion.content;
  state.model = completion.model;
  state.routerDecision = route;

  await state.session.appendEvent({
    type: "chat_turn",
    createdAt: new Date().toISOString(),
    userInput,
    model: completion.model,
    toolMode: true
  });
  await persistChatState(state);

  return completion;
}

function parseSlashCommand(line: string): { command: string; argument: string } {
  const trimmed = line.trim();
  const firstSpace = trimmed.indexOf(" ");

  if (firstSpace < 0) {
    return {
      command: trimmed.slice(1),
      argument: ""
    };
  }

  return {
    command: trimmed.slice(1, firstSpace),
    argument: trimmed.slice(firstSpace + 1).trim()
  };
}

async function executeSlashCommand(
  line: string,
  state: ChatState,
  root: string,
  config: MicroClawConfig,
  output: Writable,
  boundaryMessage: string,
  ui: ReturnType<typeof createCliUi>
): Promise<"continue" | "exit"> {
  const { command, argument } = parseSlashCommand(line);

  switch (command) {
    case "help":
      output.write(`${formatChatHelp(ui)}\n`);
      return "continue";
    case "profile":
      output.write(
        (ui.decorated
          ? [
              ui.section("Profile"),
              ui.renderRows([
                { label: "Name", value: state.agentProfile.name, tone: "accent" },
                { label: "Behavior", value: state.agentProfile.behavior }
              ])
            ].join("\n")
          : [`Name: ${state.agentProfile.name}`, `Behavior: ${state.agentProfile.behavior}`].join("\n")) + "\n"
      );
      return "continue";
    case "exit":
    case "quit":
      return "exit";
    case "scan":
      state.repoSummary = await scanRepository(root);
      output.write(`${ui.decorated ? formatRepoSummaryRich(state.repoSummary, ui) : formatRepoSummary(state.repoSummary)}\n`);
      await state.session.writeJson("repo-summary.json", state.repoSummary);
      return "continue";
    case "status": {
      const provider = await diagnoseProvider(config);
      output.write(
        (ui.decorated
          ? [
              ui.section("Status"),
              ui.renderRows([
                { label: "Secretgate", value: boundaryMessage, tone: "success" },
                { label: "Provider", value: provider.message, tone: provider.ok ? "success" : "danger" },
                { label: "Model", value: state.model, tone: "secondary" }
              ])
            ].join("\n")
          : [`Secretgate: ${boundaryMessage}`, `Provider: ${provider.message}`, `Model: ${state.model}`].join("\n")) +
          "\n"
      );
      return "continue";
    }
    case "plan": {
      if (!argument) {
        output.write(`${ui.decorated ? ui.warning("Usage: /plan <task>") : "Usage: /plan <task>"}\n`);
        return "continue";
      }

      const route = routeTask(config, state.repoSummary, argument);
      const plan = createDeterministicPlan(argument, state.repoSummary, route, config);
      output.write(`${ui.decorated ? formatPlanTextRich(plan, ui) : formatPlanText(plan)}\n`);
      return "continue";
    }
    case "run": {
      if (!argument) {
        output.write(`${ui.decorated ? ui.warning("Usage: /run <task>") : "Usage: /run <task>"}\n`);
        return "continue";
      }

      const result = await runAgentLoop({
        root,
        task: argument,
        config
      });
      state.repoSummary = result.repoSummary;
      output.write(
        (ui.decorated
          ? [
              ui.section("Run"),
              ui.renderRows([
                { label: "Session", value: result.sessionId, tone: "accent" },
                { label: "Outcome", value: result.outcome, tone: result.outcome === "done" ? "success" : "warning" },
                { label: "Verification", value: result.verification.summary, tone: result.verification.status === "passed" ? "success" : "warning" }
              ])
            ].join("\n")
          : [`Session: ${result.sessionId}`, `Outcome: ${result.outcome}`, `Verification: ${result.verification.summary}`].join("\n")) +
          "\n"
      );
      return "continue";
    }
    case "search": {
      if (!argument) {
        output.write(`${ui.decorated ? ui.warning("Usage: /search <query>") : "Usage: /search <query>"}\n`);
        return "continue";
      }

      const results = await searchText(root, argument, 10);
      output.write(`${ui.decorated ? formatSearchResultsRich(results, ui) : formatSearchResults(results)}\n`);
      return "continue";
    }
    case "read": {
      if (!argument) {
        output.write(`${ui.decorated ? ui.warning("Usage: /read <path>") : "Usage: /read <path>"}\n`);
        return "continue";
      }

      const content = await readTextFile(root, argument, config.context.maxFileCharsPerFile);
      output.write(
        `${ui.decorated ? [ui.section("File"), ui.renderRows([{ label: "Path", value: argument, tone: "accent" }]), "", content].join("\n") : `File: ${argument}\n${content}`}\n`
      );
      return "continue";
    }
    default:
      output.write(
        `${ui.decorated ? ui.danger(`Unknown slash command: /${command}`) : `Unknown slash command: /${command}`}\n${formatChatHelp(ui)}\n`
      );
      return "continue";
  }
}

export async function runChatSession(options: RunChatSessionOptions): Promise<ChatSessionResult> {
  const output = options.output ?? process.stdout;
  const ui = createCliUi(output, options.env);
  const interactive =
    options.interactive ??
    (Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY) && !options.jsonMode);
  const agentProfile = await resolveAgentProfile({
    root: options.root,
    output,
    promptIfMissing: !options.jsonMode && Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY)
  });
  const session = await SessionStore.create(options.root, "chat");
  const repoSummary = await scanRepository(options.root);
  const boundary = inspectSecretgateBoundary(options.config, options.env);
  const provider = await diagnoseProvider(options.config);
  const routerDecision = routeTask(options.config, repoSummary, options.initialPrompt || "interactive chat");
  const providerKind = routerDecision.providerKind;
  const state: ChatState = {
    agentProfile,
    session,
    repoSummary,
    routerDecision,
    messages: [],
    turnCount: 0,
    providerKind,
    model: routerDecision.coderModel
  };

  if (providerKind === "ollama") {
    try {
      state.availableOllamaModels = await listOllamaModels(options.config);
      state.model = resolveOllamaModel(state.availableOllamaModels, routerDecision.coderModel, options.config.provider.model);
    } catch {
      state.model = options.config.provider.model || routerDecision.coderModel;
    }
  }

  await session.writeJson("repo-summary.json", repoSummary);
  await session.writeJson("router-decision.json", routerDecision);
  await session.writeJson("secretgate-boundary.json", boundary);
  await session.writeJson("provider-diagnostic.json", provider);
  await session.writeJson("agent-profile.json", agentProfile);

  const initialPrompt = options.initialPrompt?.trim() ?? "";
  const stream =
    !options.jsonMode &&
    options.config.runtime.stream &&
    providerKind === "ollama" &&
    Boolean(process.stdout.isTTY);

  if (interactive) {
    if (ui.decorated) {
      await writeHero(output, {
        animate: true,
        env: options.env,
        subtitle: `${agentProfile.name.toUpperCase()} // live chat session`
      });
      output.write(
        [
          ui.section("Session"),
          ui.renderRows([
            { label: "Session", value: session.sessionId, tone: "accent" },
            { label: "Root", value: options.root },
            { label: "Behavior", value: agentProfile.behavior },
            { label: "Secretgate", value: boundary.message, tone: "success" },
            { label: "Provider", value: provider.message, tone: provider.ok ? "success" : "danger" },
            { label: "Model", value: state.model, tone: "secondary" }
          ]),
          "",
          ui.muted("Type /help for commands.")
        ].join("\n") + "\n"
      );
    } else {
      output.write(
        [
          `${agentProfile.name} chat session ${session.sessionId}`,
          `Root: ${options.root}`,
          `Behavior: ${agentProfile.behavior}`,
          `Secretgate: ${boundary.message}`,
          `Provider: ${provider.message}`,
          `Model: ${state.model}`,
          "Type /help for commands."
        ].join("\n") + "\n"
      );
    }
  }

  const handleLine = async (line: string): Promise<void> => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    if (trimmed.startsWith("/")) {
      const control = await executeSlashCommand(trimmed, state, options.root, options.config, output, boundary.message, ui);
      if (control === "exit") {
        throw new Error("__MICRO_CLAW_EXIT__");
      }
      return;
    }

    const directSkillRequest = inferSimpleSkillRequest(trimmed);
    if (directSkillRequest) {
      writeProgress(output, !options.jsonMode, `creating skill scaffold ${directSkillRequest.name}`, ui);
      const result = await createSkillScaffold({
        root: options.root,
        ...directSkillRequest
      });
      writeProgress(output, !options.jsonMode, `created ${result.createdFiles.join(", ")}`, ui);

      const response = `Created skill scaffold ${result.slug} at ${result.createdFiles.join(", ")}.`;
      state.messages.push({
        role: "user",
        content: trimmed
      });
      state.messages.push({
        role: "assistant",
        content: response
      });
      state.turnCount += 1;
      state.lastAssistantMessage = response;
      await state.session.appendEvent({
        type: "chat_skill_scaffold",
        createdAt: new Date().toISOString(),
        slug: result.slug
      });
      await persistChatState(state);

      if (!options.jsonMode) {
        output.write(`${response}\n`);
      }
      return;
    }

    state.messages.push({
      role: "user",
      content: trimmed
    });
    await session.appendEvent({
      type: "chat_user",
      createdAt: new Date().toISOString(),
      content: trimmed
    });
    await persistChatState(state);

    if (interactive && !options.jsonMode) {
      output.write(ui.prompt("assistant"));
    }

    if (shouldUseAgentTools(trimmed)) {
      await executeAgentTurn(
        trimmed,
        state,
        options.root,
        options.config,
        output,
        boundary.message,
        !options.jsonMode,
        ui
      );
      return;
    }

    await executeUserTurn(trimmed, state, options.root, options.config, output, boundary.message, stream, !options.jsonMode);
  };

  try {
    if (initialPrompt) {
      await handleLine(initialPrompt);
    }

    if (interactive) {
      const readline = createInterface({
        input: process.stdin,
        output,
        terminal: true
      });

      try {
        while (true) {
          const line = await readline.question(ui.prompt("micro-claw"));
          await handleLine(line);
        }
      } finally {
        readline.close();
      }
    }
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "__MICRO_CLAW_EXIT__") {
      throw error;
    }
  }

  return {
    sessionId: session.sessionId,
    sessionDir: session.sessionDir,
    providerKind,
    model: state.model,
    turnCount: state.turnCount,
    lastAssistantMessage: state.lastAssistantMessage
  };
}
