import { Writable } from "node:stream";
import { createInterface } from "node:readline/promises";
import process from "node:process";
import path from "node:path";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolveAgentProfile } from "../agent/agent-profile.js";
import { createCliUi, writeHero, type CliTone } from "../cli-ui.js";
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
import { grepText } from "../tools/grep-tool.js";
import { ToolExecutor } from "../tools/tool-executor.js";

const CHAT_HELP_LINES = [
  "/help                Show chat commands",
  "/profile             Show the saved agent name and behavior",
  "/scan                Refresh and print the repo summary",
  "/status              Print provider and Secretgate status",
  "/plan <task>         Build a deterministic plan",
  "/run <task>          Run the existing task loop",
  "/search <query>      Search the repo",
  "/grep <query>        Search the repo with rg/grep",
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

interface PlanInstruction {
  type: "plan";
  summary: string;
  steps: string[];
  mode: "plan" | "execute";
}

type AgentInstruction = ToolInstruction | FinalInstruction | PlanInstruction;

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
    /\b(add|create|make|write|edit|change|update|delete|remove|fix|run|execute|install|test|build|compile|curl|fetch|download|mkdir|program|document|generate|scaffold|summarize|search|scan|list|read|find|erstelle|schreibe|ändere|aendere|loesche|lösche|suche|durchsuche|durchsuchen|liste|zeige|lies|finde|fasse|beschreibe|erkläre|erklaere)\b/i;
  const commandLike = /\b(cd|grep|rg|pwd|ls)\b/i;
  const repoArtifact =
    /\b(readme|reademe|markdown|docs?|documentation|dokumentation|file|files|datei|dateien|folder|directory|ordner|verzeichnis|repo|repository|projekt|summary|overview|inhalt|inhalte|alles)\b/i;
  const repoIntent =
    /\b(add|create|make|write|document|generate|summarize|tell|describe|explain|search|scan|list|show|find|erstelle|schreibe|suche|durchsuche|durchsuchen|liste|zeige|finde|fasse|beschreibe|erkläre|erklaere)\b/i;

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
  agentProfile: AgentProfile,
  brainContext?: BrainContext
): string {
  const brainLearning = brainContext ? buildBrainContext(brainContext) : "";
  const planningGuidance = brainContext ? buildPlanningPrompt("", brainContext) : "";
  
  return [
    `You are ${agentProfile.name} - an intelligent coding assistant with a dynamic brain.`,
    `Repo root: ${root}`,
    `Secretgate boundary: ${boundaryMessage}`,
    `Provider path: ${route.providerKind}`,
    `Behavior: ${agentProfile.behavior}`,
    "You NEVER pretend that commands ran or files changed unless they actually did.",
    brainLearning,
    "",
    "🎯 PLANNING SKILLS:",
    "1. INSPECT: Always understand the current state first (list_files, read_file, grep)",
    "2. ANALYZE: Understand what needs to change and plan the minimal steps",
    "3. EXECUTE: Make changes, prefer focused edits over rewrites",
    "4. VERIFY: Always test/run the result to confirm it works",
    "5. REFLECT: If it fails, analyze why and try a different approach",
    planningGuidance,
    "",
    "When the task needs actions, respond with exactly one JSON object:",
    '{"type":"tool","tool":"list_files","input":{"directory":".","maxResults":50}}',
    '{"type":"tool","tool":"read_file","input":{"path":"src/app.ts"}}',
    '{"type":"tool","tool":"search","input":{"query":"keyword","maxResults":20}}',
    '{"type":"tool","tool":"grep","input":{"query":"TODO|FIXME","maxResults":50}}',
    '{"type":"tool","tool":"write_file","input":{"path":"new.py","content":"print(1)"}}',
    '{"type":"tool","tool":"replace_text","input":{"path":"file.ts","search":"old","replace":"new"}}',
    '{"type":"tool","tool":"shell","input":{"command":"python file.py"}}',
    '{"type":"tool","tool":"shell","input":{"cwd":"dir","command":"npm test"}}',
    '{"type":"tool","tool":"git_status","input":{}}',
    '{"type":"tool","tool":"git_diff","input":{}}',
    'Plan mode (for complex tasks): {"type":"plan","summary":"analysis","steps":["1. inspect","2. create","3. test"],"mode":"plan"}',
    'Execute mode: {"type":"plan","summary":"now executing","steps":["step1","step2"],"mode":"execute"}',
    'Final answer: {"type":"final","content":"Completed task: X. Changes: Y. Verified: Z."}',
    "",
    "⚡ SMART RULES:",
    "- For BUILD/RUN tasks: write file → run it → fix errors → run again until it works",
    "- For EDIT tasks: read file → make change → run tests or lint",
    "- For CREATE tasks: inspect structure → create minimal viable → test",
    "- Always execute/verify the final result",
    "- If a tool fails, try a different approach",
    "- Use shell for running python/js/go/rust scripts",
    "- Do not stop after a single exploratory tool if the task still requires creation, editing, execution, or repo-wide evidence.",
    "- Use shell for execution, tests, curl, package installation, directory creation, and commands that need `cd`, pipes, `grep`, or `rg`.",
    "- The shell tool can receive `cwd` for folder-specific work, or you can use `cd <dir> && ...` inside the command.",
    "- One tool per reply.",
    "- After a tool result, decide the next best tool or return a final answer.",
    "- In the final answer, mention only files changed or commands run that appear in tool results from this loop.",
    "- Do not claim that a repo file changed just because it was present in the repo summary.",
    brainLearning,
    "",
    "Repo summary:",
    formatRepoSummary(repoSummary)
  ].join("\n");
}

interface BrainContext {
  successfulPatterns: string[];
  failedPatterns: string[];
  filesAccessed: string[];
  commandsExecuted: string[];
  turnCount: number;
  insights: BrainInsight[];
  workflowSteps: string[];
  lastTask?: string;
  taskHistory: string[];
  intelligenceScore: number;
}

interface BrainInsight {
  key: string;
  value: string;
  strength: number;
  expiresAt: number;
  learnedFrom?: string;
}

interface PersistentBrain {
  version: number;
  updatedAt: string;
  skills: BrainSkill[];
  commands: BrainCommand[];
  patterns: BrainPattern[];
  totalLearnings: number;
}

interface BrainSkill {
  name: string;
  description: string;
  commands: string[];
  examples: string[];
  learnedAt: string;
  useCount: number;
}

interface BrainCommand {
  command: string;
  description: string;
  successRate: number;
  lastUsed: string;
  learnedFrom: string;
  useCount: number;
}

interface BrainPattern {
  trigger: string;
  response: string;
  successRate: number;
  useCount: number;
}

const MAX_INSIGHTS = 20;
const INSIGHT_TTL_MS = 60 * 60 * 1000;
const BRAIN_FILE = ".micro-claw/brain.json";
const BRAIN_VERSION = 1;

function createBrainContext(initialTask?: string): BrainContext {
  return {
    successfulPatterns: [],
    failedPatterns: [],
    filesAccessed: [],
    commandsExecuted: [],
    turnCount: 0,
    insights: [],
    workflowSteps: [],
    lastTask: initialTask,
    taskHistory: initialTask ? [initialTask] : [],
    intelligenceScore: 0.5
  };
}

function loadPersistentBrain(root: string): PersistentBrain {
  try {
    const brainPath = path.join(root, BRAIN_FILE);
    if (existsSync(brainPath)) {
      const content = readFileSync(brainPath, "utf-8");
      return JSON.parse(content);
    }
  } catch {}
  
  return {
    version: BRAIN_VERSION,
    updatedAt: new Date().toISOString(),
    skills: [],
    commands: [],
    patterns: [],
    totalLearnings: 0
  };
}

function savePersistentBrain(root: string, brain: PersistentBrain): void {
  try {
    const brainDir = path.join(root, ".micro-claw");
    if (!existsSync(brainDir)) {
      mkdirSync(brainDir, { recursive: true });
    }
    brain.updatedAt = new Date().toISOString();
    writeFileSync(path.join(brainDir, BRAIN_FILE), JSON.stringify(brain, null, 2));
  } catch (e) {
    // Ignore save errors
  }
}

function autoLearnFromTask(
  root: string,
  task: string,
  usedTools: ToolName[],
  executedCommands: string[],
  touchedFiles: string[],
  success: boolean
): void {
  const brain = loadPersistentBrain(root);
  
  if (executedCommands.length > 0) {
    for (const cmd of executedCommands) {
      if (cmd.includes("curl")) {
        learnSkill(brain, "curl", "HTTP requests with curl", cmd);
      }
      if (cmd.includes("grep") || cmd.includes("rg")) {
        learnSkill(brain, "grep/rg", "Text search in files", cmd);
      }
      if (cmd.includes("npm") || cmd.includes("pnpm")) {
        learnSkill(brain, "npm/pnpm", "Node package management", cmd);
      }
      if (cmd.includes("python")) {
        learnSkill(brain, "python", "Python scripting", cmd);
      }
      if (cmd.includes("git")) {
        learnSkill(brain, "git", "Version control", cmd);
      }
      
      const existingCmd = brain.commands.find(c => c.command === cmd);
      if (existingCmd) {
        existingCmd.useCount++;
        existingCmd.successRate = success ? Math.min(1, existingCmd.successRate + 0.1) : existingCmd.successRate;
        existingCmd.lastUsed = new Date().toISOString();
      } else {
        brain.commands.push({
          command: cmd,
          description: extractCommandPurpose(cmd),
          successRate: success ? 0.8 : 0.3,
          lastUsed: new Date().toISOString(),
          learnedFrom: task
        });
      }
    }
  }
  
  if (touchedFiles.length > 0) {
    const ext = touchedFiles[0]?.split(".").pop() || "";
    if (ext === "py") learnPattern(brain, "python", "Use python for scripting tasks");
    if (ext === "ts" || ext === "js") learnPattern(brain, "typescript", "Use TypeScript for Node.js tasks");
  }
  
  if (task.toLowerCase().includes("search") && task.toLowerCase().includes("internet")) {
    learnSkill(brain, "curl-http", "Internet requests with curl -s <url>", "curl -s https://api.example.com");
  }
  
  if (task.toLowerCase().includes("test")) {
    learnPattern(brain, "testing", "Run tests to verify changes work");
  }
  
  brain.totalLearnings++;
  savePersistentBrain(root, brain);
}

function learnSkill(brain: PersistentBrain, name: string, description: string, example: string): void {
  const existing = brain.skills.find(s => s.name === name);
  if (existing) {
    existing.useCount++;
    if (!existing.examples.includes(example)) {
      existing.examples.push(example);
    }
  } else {
    brain.skills.push({
      name,
      description,
      commands: [example],
      examples: [example],
      learnedAt: new Date().toISOString(),
      useCount: 1
    });
  }
}

function learnPattern(brain: PersistentBrain, trigger: string, response: string): void {
  const existing = brain.patterns.find(p => p.trigger === trigger);
  if (existing) {
    existing.useCount++;
  } else {
    brain.patterns.push({
      trigger,
      response,
      successRate: 0.7,
      useCount: 1
    });
  }
}

function extractCommandPurpose(cmd: string): string {
  if (cmd.includes("curl")) return "HTTP request";
  if (cmd.includes("grep")) return "Text search";
  if (cmd.includes("npm test")) return "Run tests";
  if (cmd.includes("npm run")) return "Run npm script";
  if (cmd.includes("python")) return "Python execution";
  if (cmd.includes("git")) return "Git version control";
  if (cmd.includes("mkdir")) return "Create directory";
  if (cmd.includes("rm")) return "Remove file/directory";
  return "Shell command";
}

function buildBrainContext(brain: BrainContext): string {
  if (brain.turnCount < 1) return "";
  
  const lines: string[] = [];
  lines.push("\n🧠 BRAIN CONTEXT:");
  
  if (brain.turnCount >= 2 && brain.intelligenceScore > 0.3) {
    lines.push(`Session intelligence: ${Math.round(brain.intelligenceScore * 100)}%`);
  }
  
  if (brain.insights.length > 0) {
    const activeInsights = brain.insights
      .filter(i => i.expiresAt > Date.now())
      .sort((a, b) => b.strength - a.strength)
      .slice(0, 5);
    
    if (activeInsights.length > 0) {
      lines.push("Learned insights:");
      for (const insight of activeInsights) {
        lines.push(`  • ${insight.key}: ${insight.value}`);
      }
    }
  }
  
  if (brain.taskHistory.length > 1) {
    const recent = brain.taskHistory.slice(-3);
    lines.push(`Recent tasks: ${recent.join(" → ")}`);
  }
  
  if (brain.workflowSteps.length > 2) {
    lines.push(`Effective workflow: ${brain.workflowSteps.slice(-3).join(" → ")}`);
  }
  
  if (brain.failedPatterns.length > 0) {
    const critical = brain.failedPatterns.slice(-2);
    lines.push(`⚠️ Avoid: ${critical.join(", ")}`);
  }
  
  return lines.join("\n");
}

function addInsight(brain: BrainContext, key: string, value: string): void {
  const existing = brain.insights.findIndex(i => i.key === key);
  if (existing >= 0) {
    brain.insights[existing].strength = Math.min(1, brain.insights[existing].strength + 0.1);
    brain.insights[existing].value = value;
    brain.insights[existing].expiresAt = Date.now() + INSIGHT_TTL_MS;
  } else {
    brain.insights.push({
      key,
      value,
      strength: 0.5,
      expiresAt: Date.now() + INSIGHT_TTL_MS
    });
  }
  
  if (brain.insights.length > MAX_INSIGHTS) {
    brain.insights.sort((a, b) => b.strength - a.strength);
    brain.insights = brain.insights.slice(0, MAX_INSIGHTS);
  }
}

function updateIntelligence(brain: BrainContext, success: boolean, hasInsight: boolean): void {
  const delta = success ? 0.05 : -0.02;
  const insightBonus = hasInsight ? 0.02 : 0;
  brain.intelligenceScore = Math.max(0.1, Math.min(1, brain.intelligenceScore + delta + insightBonus));
}

function learnFromTask(brain: BrainContext, task: string, tools: ToolName[], success: boolean): void {
  if (task !== brain.lastTask) {
    brain.taskHistory.push(task);
    brain.lastTask = task;
  }
  
  const toolChain = tools.slice(-3).join(" → ");
  if (toolChain && success) {
    addInsight(brain, "workflow", toolChain);
    brain.workflowSteps.push(toolChain);
  }
  
  updateIntelligence(brain, success, brain.insights.length > 0);
  
  brain.insights = brain.insights.filter(i => i.expiresAt > Date.now());
}

function buildPlanningPrompt(task: string, brain?: BrainContext): string {
  const lines: string[] = [];
  lines.push("\n📋 PLANNING PHASE:");
  lines.push("For this task, first create a plan with:");
  lines.push("1. Inspect - what files/structure exist?");
  lines.push("2. Analyze - what needs to change?");
  lines.push("3. Execute - make the changes");
  lines.push("4. Verify - run/test the result");
  
  if (brain && brain.insights.length > 0) {
    lines.push("\n💡 From past experience:");
    const relevant = brain.insights.filter(i => 
      i.key === "workflow" || i.key === "file-structure"
    ).slice(0, 2);
    for (const insight of relevant) {
      lines.push(`  • ${insight.value}`);
    }
  }
  
  return lines.join("\n");
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

function repairJsonObject(source: string): string {
  let repaired = source
    .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)"\s*:/g, '$1"$2":')
    .replace(/([{,]\s*)"([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":')
    .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":')
    .replace(/,\s*([}\]])/g, "$1");
  
  repaired = repaired.replace(/"tool"\s*:\s*"(\w+)"/g, (match, toolName) => {
    const validTools = ["list_files", "read_file", "write_file", "replace_text", "delete_file", "search", "grep", "shell", "git_status", "git_diff", "patch", "create_skill"];
    if (!validTools.includes(toolName)) {
      if (toolName === "new_file" || toolName === "create_file") return '"tool":"write_file"';
      if (toolName === "edit_file" || toolName === "modify") return '"tool":"replace_text"';
      if (toolName === "run" || toolName === "exec" || toolName === "execute") return '"tool":"shell"';
      if (toolName === "find" || toolName === "search") return '"tool":"search"';
    }
    return match;
  });
  
  if (repaired.includes('"type":"tool"') && !repaired.includes('"type":"write_file"') && 
      (repaired.includes('"new_file"') || repaired.includes('"create_file"'))) {
    repaired = repaired.replace(/"type":"tool"\s*,\s*"tool"\s*:\s*"(?:new_file|create_file)"/g, '"type":"tool","tool":"write_file"');
  }
  
  return repaired;
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
    try {
      parsed = JSON.parse(repairJsonObject(json)) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }

  if (parsed.type === "final" && typeof parsed.content === "string") {
    return {
      type: "final",
      content: parsed.content
    };
  }

  if (parsed.type === "plan" && Array.isArray(parsed.steps) && typeof parsed.summary === "string") {
    return {
      type: "plan",
      summary: parsed.summary as string,
      steps: parsed.steps as string[],
      mode: (parsed.mode as "plan" | "execute") || "plan"
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
    case "grep":
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

function buildToolLoopSummary(
  usedTools: ToolName[],
  touchedFiles: string[],
  executedCommands: string[],
  failures: string[]
): string {
  const lines: string[] = [];

  if (usedTools.length > 0) {
    lines.push(`Tools used: ${unique(usedTools).join(", ")}.`);
  }

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

function writeAgentNote(
  output: Writable,
  enabled: boolean,
  message: string,
  ui: ReturnType<typeof createCliUi>,
  tone: CliTone = "secondary"
): void {
  if (!enabled) {
    return;
  }

  output.write(`${ui.formatAgent(message, tone)}\n`);
}

function summarizeToolPreview(result: ToolResult): string[] {
  if (result.data === undefined) {
    return [];
  }

  if (Array.isArray(result.data)) {
    if (result.data.length === 0) {
      return ["no rows returned"];
    }

    const preview = result.data
      .slice(0, 4)
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }

        if (
          typeof item === "object" &&
          item !== null &&
          typeof (item as { path?: unknown }).path === "string"
        ) {
          const path = String((item as { path: string }).path);
          const line =
            typeof (item as { line?: unknown }).line === "number"
              ? `:${String((item as { line: number }).line)}`
              : "";
          const previewText =
            typeof (item as { preview?: unknown }).preview === "string"
              ? ` ${(item as { preview: string }).preview}`
              : "";
          return `${path}${line}${previewText}`.trim();
        }

        return truncate(JSON.stringify(item), 120);
      })
      .join(" | ");

    return [`preview: ${preview}`];
  }

  if (
    typeof result.data === "object" &&
    result.data !== null &&
    typeof (result.data as { command?: unknown }).command === "string"
  ) {
    const shellResult = result.data as {
      command: string;
      exitCode?: number | null;
      stdout?: string;
      stderr?: string;
      cwd?: string;
    };
    const outputPreview = [shellResult.stdout, shellResult.stderr]
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .join("\n")
      .trim();

    return [
      `cwd: ${shellResult.cwd ?? "."}`,
      `exit: ${shellResult.exitCode ?? "none"}`,
      outputPreview ? `output: ${truncate(outputPreview.replace(/\s+/g, " "), 160)}` : "output: none"
    ];
  }

  if (typeof result.data === "string") {
    return [`output: ${truncate(result.data.replace(/\s+/g, " "), 160)}`];
  }

  return [`data: ${truncate(JSON.stringify(result.data), 160)}`];
}

function shouldKeepWorking(
  userInput: string,
  usedTools: ToolName[],
  touchedFiles: string[],
  executedCommands: string[]
): string | undefined {
  const uniqueTools = unique(usedTools);
  const hasInspection = usedTools.some((tool) =>
    ["list_files", "read_file", "search", "grep", "git_status", "git_diff"].includes(tool)
  );
  const hasAction = usedTools.some((tool) =>
    ["write_file", "replace_text", "delete_file", "patch", "shell", "create_skill"].includes(tool)
  );
  const hasShellExecution = usedTools.includes("shell") || executedCommands.length > 0;
  const wantsSearch = /\b(search|scan|grep|rg|find|look for|suche|durchsuche|durchsuchen|finde)\b/i.test(userInput);
  const wantsExplicitGrep = /\b(grep|rg)\b/i.test(userInput);
  const wantsChange =
    /\b(add|create|make|write|edit|change|update|delete|remove|fix|document|generate|erstelle|schreibe|ändere|aendere|loesche|lösche)\b/i.test(
      userInput
    );
  const wantsBroadCoverage =
    /\b(all|everything|entire|whole|repo|repository|project|overview|summary|readme|documentation|alle|alles|dateien|datei|projekt|readme)\b/i.test(
      userInput
    );
  const wantsBuild =
    /\b(build|run|execute|test|compile|start|launch|install|deploy|build|bauen|ausführen|starten|testen)\b/i.test(userInput);
  const wantsPython = /\b(python|py|skript|script)\b/i.test(userInput);
  const wantsGame = /\b(game|spiel|game)\b/i.test(userInput);
  const isExecutable = wantsBuild || wantsGame || wantsPython;

  if (wantsExplicitGrep && !usedTools.includes("grep") && !executedCommands.some((command) => /\b(grep|rg)\b/.test(command))) {
    return "The user explicitly asked for grep or rg evidence.";
  }

  if (wantsSearch && !hasInspection) {
    return "The task still needs a repo-wide inspection result.";
  }

  if (wantsChange && !hasAction && touchedFiles.length === 0) {
    return "The task asks for a change, but no file change or command action happened yet.";
  }

  if ((wantsChange || wantsBroadCoverage) && uniqueTools.length < 2) {
    return "Use at least two different tools so the result is backed by inspection plus action or verification.";
  }

  if (isExecutable && touchedFiles.length > 0 && !hasShellExecution) {
    const ext = touchedFiles[0]?.split(".").pop();
    if (["py", "js", "ts", "sh", "rb", "go", "rs"].includes(ext || "")) {
      return "The task involves running an executable file - run it to verify it works.";
    }
    return "The task requires running or testing the created file.";
  }

  return undefined;
}

function sanitizeChatInput(line: string): string {
  return line.replace(/\u001b\[200~/g, "").replace(/\u001b\[201~/g, "").trim();
}

function explainShellCommandInChat(line: string): string | undefined {
  const trimmed = line.trim();
  if (
    !/^(?:pnpm|npm|yarn|bun|npx|node|micro-claw|secretgate|\.\.?[\\/]|[A-Za-z]:\\)/i.test(trimmed)
  ) {
    return undefined;
  }

  if (/\bscan\b/i.test(trimmed)) {
    return "That is a terminal command. Inside this chat, use /scan. If you want the shell command, leave chat first with /exit or Ctrl+C.";
  }

  if (/\bplan\b/i.test(trimmed)) {
    return "That is a terminal command. Inside this chat, use /plan <task>. If you want the shell command, leave chat first with /exit or Ctrl+C.";
  }

  if (/\brun\b/i.test(trimmed)) {
    return "That is a terminal command. Inside this chat, use /run <task>. If you want the shell command, leave chat first with /exit or Ctrl+C.";
  }

  if (/\bskill-create\b/i.test(trimmed)) {
    return "That is a terminal command. Inside this chat, ask for the skill directly, for example: create a skill for curl smoke tests.";
  }

  if (/\bchat\b/i.test(trimmed)) {
    const quotedPrompt = trimmed.match(/\bchat\b\s+["']([\s\S]+?)["']\s*$/i)?.[1];
    return quotedPrompt
      ? `You are already in chat. Type the request directly instead: ${quotedPrompt}`
      : "You are already in the Micro Claw chat prompt. Type the request directly here, or leave chat with /exit before running shell commands.";
  }

  return "That looks like a terminal command, not a chat message. Use a slash command here, or leave chat with /exit before running shell commands.";
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
  desiredModel: string,
  options?: {
    preference?: "smallest" | "largest";
  }
): Promise<string> {
  if (state.providerKind !== "ollama") {
    return desiredModel;
  }

  if (!state.availableOllamaModels) {
    state.availableOllamaModels = await listOllamaModels(config);
  }

  return resolveOllamaModel(
    state.availableOllamaModels,
    desiredModel,
    config.provider.model,
    options?.preference ?? "smallest"
  );
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
  const model = await resolveChatModel(state, config, route.fallbackModel || route.coderModel, {
    preference: "largest"
  });
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
  writeAgentNote(output, echoResponse, `goal: ${userInput}`, ui, "accent");
  writeAgentNote(output, echoResponse, `model: ${model}`, ui, "secondary");
  writeAgentNote(output, echoResponse, `route: ${route.reason}`, ui, "muted");
  let finalCompletion: ChatCompletionResult | undefined;
  const usedTools: ToolName[] = [];
  const touchedFiles: string[] = [];
  const executedCommands: string[] = [];
  const failures: string[] = [];
  const successfulPatterns: string[] = [];
  const failedPatterns: string[] = [];
  let invalidJsonReplies = 0;
  const maxToolSteps = 20;
  const maxJsonRetries = 4;

  const brainContext = createBrainContext(userInput);

  for (let step = 0; step < maxToolSteps; step += 1) {
    writeProgress(output, echoResponse, `step ${step + 1}/${maxToolSteps}`, ui);
    let waitSeconds = 0;
    const completion = await withProgressHeartbeat(
      () =>
        requestChatCompletion({
          config,
          providerKind: state.providerKind,
          model,
          messages: [
            {
              role: "system",
              content: buildToolPrompt(root, state.repoSummary, route, boundaryMessage, state.agentProfile, brainContext)
            },
            ...workMessages
          ],
          stream: false
        }),
      () => {
        waitSeconds += 10;
        writeProgress(output, echoResponse, `waiting for model (${waitSeconds}s)`, ui);
      }
    );

    const instruction = parseAgentInstruction(completion.content);

    if (!instruction) {
      invalidJsonReplies += 1;
      if (invalidJsonReplies < maxJsonRetries) {
        writeProgress(output, echoResponse, `invalid JSON (attempt ${invalidJsonReplies}/${maxJsonRetries}); retrying...`, ui);
        workMessages.push({
          role: "assistant",
          content: completion.content
        });
        workMessages.push({
          role: "user",
          content: `INVALID. You MUST respond with EXACTLY ONE of these formats:\n{"type":"tool","tool":"shell","input":{"command":"echo hello"}}\n{"type":"final","content":"your answer"}\n\nDo NOT include any other text. Only the JSON.`
        });
        continue;
      }

      writeProgress(output, echoResponse, "giving up on JSON, using raw output", ui);
      finalCompletion = {
        ...completion,
        content: completion.content
      };
      break;
    }

    if (instruction.type === "final") {
      const reasonToContinue = shouldKeepWorking(userInput, usedTools, touchedFiles, executedCommands);
      if (reasonToContinue) {
        writeProgress(output, echoResponse, `final answer rejected: ${reasonToContinue}`, ui);
        workMessages.push({
          role: "assistant",
          content: completion.content
        });
        workMessages.push({
          role: "user",
          content: `Do not stop yet. ${reasonToContinue} Use another tool and continue.`
        });
        continue;
      }

      writeProgress(output, echoResponse, "tool loop finished", ui);
      finalCompletion = {
        ...completion,
        content: instruction.content
      };
      break;
    }

    if (instruction.type === "plan") {
      writeProgress(output, echoResponse, `planning: ${instruction.summary}`, ui);
      for (const step of instruction.steps) {
        writeAgentNote(output, echoResponse, `  - ${step}`, ui, "muted");
      }
      
      if (instruction.mode === "execute") {
        writeProgress(output, echoResponse, "executing plan...", ui);
      } else {
        workMessages.push({
          role: "assistant",
          content: JSON.stringify(instruction)
        });
        workMessages.push({
          role: "user",
          content: `Execute this plan step by step. For each step, respond with: {"type":"tool","tool":"<tool>","input":{...}}`
        });
        continue;
      }
    }

    if (instruction.type !== "tool") {
      writeProgress(output, echoResponse, "unknown instruction type, skipping", ui);
      continue;
    }

    writeProgress(output, echoResponse, `running ${summarizeToolInstruction(instruction)}`, ui);
    const toolCall: ToolCall = {
      tool: instruction.tool,
      input: instruction.input
    };
    const toolResult = await executor.execute(toolCall);
    usedTools.push(instruction.tool);
    invalidJsonReplies = 0;
    writeProgress(output, echoResponse, `${instruction.tool} ${toolResult.ok ? "completed" : "failed"}: ${toolResult.summary}`, ui);
    for (const previewLine of summarizeToolPreview(toolResult)) {
      writeAgentNote(output, echoResponse, previewLine, ui, toolResult.ok ? "muted" : "warning");
    }
    writeAgentNote(output, echoResponse, `tools: ${unique(usedTools).join(", ")}`, ui, "muted");

    if (!toolResult.ok) {
      failures.push(`${instruction.tool}: ${toolResult.error ?? toolResult.summary}`);
      failedPatterns.push(`${instruction.tool} failed - ${truncate(toolResult.error ?? "unknown", 50)}`);
    } else {
      successfulPatterns.push(`${instruction.tool} succeeded`);
    }

    if (instruction.tool === "shell") {
      const command = String(instruction.input.command ?? "").trim();
      if (command) {
        executedCommands.push(command);
        if (toolResult.ok) {
          brainContext.commandsExecuted.push(command);
        }
      }
    }

    if (instruction.tool === "grep") {
      const query = String(instruction.input.query ?? "").trim();
      if (query) {
        executedCommands.push(`grep ${query}`);
      }
      if (toolResult.ok) {
        addInsight(brainContext, "search-pattern", query);
      }
    }

    if (instruction.tool === "write_file" || instruction.tool === "replace_text" || instruction.tool === "delete_file") {
      const targetPath = String(instruction.input.path ?? "").trim();
      if (targetPath) {
        touchedFiles.push(targetPath);
        brainContext.filesAccessed.push(targetPath);
        if (toolResult.ok) {
          const ext = targetPath.split(".").pop() || "";
          addInsight(brainContext, "file-structure", `${ext}: ${targetPath}`);
        }
      }
    }

    if (instruction.tool === "read_file") {
      const targetPath = String(instruction.input.path ?? "").trim();
      if (targetPath) {
        brainContext.filesAccessed.push(targetPath);
      }
    }

    if (instruction.tool === "patch" && Array.isArray(toolResult.data)) {
      for (const file of toolResult.data) {
        if (typeof file === "string") {
          touchedFiles.push(file);
          brainContext.filesAccessed.push(file);
        }
      }
    }

    if (instruction.tool === "create_skill") {
      const data = toolResult.data as { createdFiles?: unknown } | undefined;
      if (Array.isArray(data?.createdFiles)) {
        for (const file of data.createdFiles) {
          if (typeof file === "string") {
            touchedFiles.push(file);
            brainContext.filesAccessed.push(file);
          }
        }
      }
    }
    
    if (instruction.tool === "shell" && toolResult.ok) {
      const cmd = String(instruction.input.command ?? "").split(" ")[0];
      addInsight(brainContext, "shell-command", cmd);
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
    
    brainContext.turnCount++;
  }

  learnFromTask(brainContext, userInput, usedTools, failures.length === 0);

  const completion =
    finalCompletion ??
    ({
      providerKind: state.providerKind,
      model,
      content: "Stopped after reaching the tool step limit. Summarize the current state, the tools used, and the remaining gap."
    } satisfies ChatCompletionResult);

  if (echoResponse) {
    writeProgress(output, echoResponse, "sending final answer", ui);
    
    let finalContent = completion.content;
    if (usedTools.length > 0 || touchedFiles.length > 0 || executedCommands.length > 0 || failures.length > 0) {
      const loopSummary = buildToolLoopSummary(usedTools, touchedFiles, executedCommands, failures);
      if (finalContent.trim().length > 0) {
        finalContent = `${finalContent}\n\n${loopSummary}`;
      } else {
        finalContent = loopSummary;
      }
    }
    output.write(`${finalContent}\n`);
  }
  
  if (usedTools.length > 0 || touchedFiles.length > 0 || executedCommands.length > 0 || failures.length > 0) {
    const loopSummary = buildToolLoopSummary(usedTools, touchedFiles, executedCommands, failures);
    if (completion.content.trim().length > 0) {
      completion.content = `${loopSummary}\n\nFinal result: ${completion.content}`;
    } else {
      completion.content = loopSummary;
    }
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
    case "grep": {
      if (!argument) {
        output.write(`${ui.decorated ? ui.warning("Usage: /grep <query>") : "Usage: /grep <query>"}\n`);
        return "continue";
      }

      const results = await grepText({
        root,
        query: argument,
        maxResults: 20,
        timeoutMs: config.tools.maxCommandSeconds * 1_000,
        outputLimit: config.tools.captureCommandOutputLimit
      });
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
      state.model = resolveOllamaModel(
        state.availableOllamaModels,
        routerDecision.fallbackModel || routerDecision.coderModel,
        options.config.provider.model,
        "largest"
      );
    } catch {
      state.model = options.config.provider.model || routerDecision.fallbackModel || routerDecision.coderModel;
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
    const trimmed = sanitizeChatInput(line);
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

    const shellCommandHint = explainShellCommandInChat(trimmed);
    if (shellCommandHint) {
      state.messages.push({
        role: "user",
        content: trimmed
      });
      state.messages.push({
        role: "assistant",
        content: shellCommandHint
      });
      state.turnCount += 1;
      state.lastAssistantMessage = shellCommandHint;
      await session.appendEvent({
        type: "chat_user",
        createdAt: new Date().toISOString(),
        content: trimmed
      });
      await session.appendEvent({
        type: "chat_turn",
        createdAt: new Date().toISOString(),
        userInput: trimmed,
        model: state.model,
        shellHint: true
      });
      await persistChatState(state);

      if (!options.jsonMode) {
        output.write(`${shellCommandHint}\n`);
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
