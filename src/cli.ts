#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { formatAgentProfile, loadAgentProfile, resolveAgentProfile, saveAgentProfile } from "./agent/agent-profile.js";
import { queueAgentTask, refreshAgentStatus, runResidentAgent } from "./agent/resident-agent.js";
import { runAssistantTui } from "./assistant/assistant-tui.js";
import { runChatSession } from "./chat/chat-session.js";
import { createCliUi, runWithSpinner, writeHero, type CliRow, type CliTone } from "./cli-ui.js";
import { loadConfig } from "./config/load-config.js";
import { loadEnvFiles } from "./config/load-env.js";
import { runHeartbeatService } from "./heartbeat/heartbeat-service.js";
import { runAgentLoop } from "./orchestrator/agent-loop.js";
import { createDeterministicPlan } from "./planner/deterministic-planner.js";
import { diagnoseProvider } from "./providers/provider-diagnostics.js";
import { routeTask } from "./router/model-router.js";
import { scanRepository } from "./scanner/repo-scanner.js";
import { enforceSecretgateBoundary, inspectSecretgateBoundary } from "./security/secretgate-boundary.js";
import { runBootstrap } from "./setup/bootstrap.js";
import { runOllamaSetup } from "./setup/ollama-setup.js";
import { createShellHelperAssets, createSkillScaffold } from "./skills/skill-scaffold.js";
import { createTelegramConnectInfo, formatTelegramConnectInfo, type TelegramConnectInfo } from "./telegram/telegram-connect.js";
import { TelegramClient } from "./telegram/telegram-client.js";
import { runTelegramService } from "./telegram/telegram-service.js";
import type {
  AgentRunResult,
  AssistantTuiResult,
  BootstrapResult,
  ChatSessionResult,
  HeartbeatRecord,
  OllamaSetupResult,
  RepoSummary,
  SkillScaffoldResult,
  TelegramServiceResult,
  TaskPlan
} from "./core/types.js";

type FlagValue = boolean | string;

interface ParsedArgs {
  command: string;
  positionals: string[];
  flags: Record<string, FlagValue>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = "help", ...rest] = argv;
  const positionals: string[] = [];
  const flags: Record<string, FlagValue> = {};

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];

    if (token === "--") {
      continue;
    }

    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const key = token.slice(2);
    const next = rest[index + 1];
    if (!next || next.startsWith("--")) {
      flags[key] = true;
      continue;
    }

    flags[key] = next;
    index += 1;
  }

  return {
    command,
    positionals,
    flags
  };
}

function getFlag(flags: Record<string, FlagValue>, key: string): string | undefined {
  const value = flags[key];
  return typeof value === "string" ? value : undefined;
}

function listValue(values: string[]): string {
  return values.join(", ") || "none";
}

function toneFromStatus(status: string): CliTone {
  switch (status) {
    case "healthy":
    case "done":
    case "passed":
    case "queued":
      return "success";
    case "degraded":
    case "working":
    case "blocked":
    case "skipped":
      return "warning";
    case "failed":
      return "danger";
    default:
      return "strong";
  }
}

function formatOptionalList(items: string[]): string[] {
  return items.length > 0 ? items : ["none"];
}

function renderRows(ui: ReturnType<typeof createCliUi>, rows: CliRow[]): string {
  return ui.renderRows(rows);
}

function renderSection(
  ui: ReturnType<typeof createCliUi>,
  title: string,
  content: string
): string {
  return [ui.section(title), content].join("\n");
}

function renderScanRich(ui: ReturnType<typeof createCliUi>, repoSummary: RepoSummary): string {
  return renderSection(
    ui,
    "Repository",
    renderRows(ui, [
      { label: "Root", value: repoSummary.root },
      { label: "Files", value: String(repoSummary.fileCount), tone: "accent" },
      {
        label: "Stacks",
        value: listValue(repoSummary.detectedStacks),
        tone: repoSummary.detectedStacks.length > 0 ? "secondary" : "muted"
      },
      {
        label: "Package Manager",
        value: repoSummary.packageManager ?? "none",
        tone: repoSummary.packageManager ? "secondary" : "muted"
      },
      {
        label: "Build Commands",
        value: listValue(repoSummary.buildCommands),
        tone: repoSummary.buildCommands.length > 0 ? "success" : "muted"
      },
      {
        label: "Test Commands",
        value: listValue(repoSummary.testCommands),
        tone: repoSummary.testCommands.length > 0 ? "success" : "muted"
      },
      {
        label: "Entry Points",
        value: listValue(repoSummary.entryPoints),
        tone: repoSummary.entryPoints.length > 0 ? "strong" : "muted"
      },
      {
        label: "Important Files",
        value: listValue(repoSummary.importantFiles),
        tone: repoSummary.importantFiles.length > 0 ? "strong" : "muted"
      }
    ])
  );
}

function renderPlanRich(ui: ReturnType<typeof createCliUi>, plan: TaskPlan): string {
  return [
    renderSection(
      ui,
      "Task",
      renderRows(ui, [
        { label: "Summary", value: plan.taskSummary },
        { label: "Next Action", value: plan.nextAction, tone: "accent" }
      ])
    ),
    renderSection(ui, "Constraints", ui.renderList(formatOptionalList(plan.constraints))),
    renderSection(
      ui,
      "Steps",
      ui.renderList(plan.steps.map((step) => `${step.id}: ${step.action} -> ${step.successSignal}`), "strong")
    ),
    renderSection(ui, "Verification", ui.renderList(formatOptionalList(plan.verificationPlan), "secondary"))
  ].join("\n\n");
}

function renderRunResultRich(ui: ReturnType<typeof createCliUi>, result: AgentRunResult): string {
  return [
    renderSection(
      ui,
      "Run",
      renderRows(ui, [
        { label: "Session", value: result.sessionId, tone: "accent" },
        { label: "Artifacts", value: result.sessionDir },
        { label: "Outcome", value: result.outcome, tone: toneFromStatus(result.outcome) },
        { label: "Secretgate", value: result.secretgateBoundary.message, tone: toneFromStatus(result.secretgateBoundary.ok ? "done" : "blocked") },
        { label: "Verification", value: result.verification.summary, tone: toneFromStatus(result.verification.status) }
      ])
    ),
    renderSection(
      ui,
      "Routing",
      renderRows(ui, [
        { label: "Planner Model", value: result.routerDecision.plannerModel, tone: "secondary" },
        { label: "Coder Model", value: result.routerDecision.coderModel, tone: "secondary" }
      ])
    )
  ].join("\n\n");
}

function renderHeartbeatRich(ui: ReturnType<typeof createCliUi>, record: HeartbeatRecord): string {
  return [
    renderSection(
      ui,
      "Heartbeat",
      renderRows(ui, [
        { label: "Checked At", value: record.checkedAt },
        { label: "Status", value: record.status, tone: toneFromStatus(record.status) },
        { label: "Secretgate", value: record.boundary.message, tone: record.boundary.ok ? "success" : "danger" },
        { label: "Provider", value: record.provider.message, tone: record.provider.ok ? "success" : "danger" },
        { label: "Verification", value: record.verification.summary, tone: toneFromStatus(record.verification.status) }
      ])
    ),
    renderSection(
      ui,
      "Files",
      renderRows(ui, [
        { label: "Heartbeat File", value: record.heartbeatFile },
        { label: "Heartbeat JSON", value: record.heartbeatJsonFile }
      ])
    )
  ].join("\n\n");
}

function renderChatResultRich(ui: ReturnType<typeof createCliUi>, result: ChatSessionResult): string {
  return renderSection(
    ui,
    "Chat",
    renderRows(ui, [
      { label: "Session", value: result.sessionId, tone: "accent" },
      { label: "Artifacts", value: result.sessionDir },
      { label: "Provider", value: result.providerKind, tone: "secondary" },
      { label: "Model", value: result.model, tone: "secondary" },
      { label: "Turns", value: String(result.turnCount), tone: "accent" }
    ])
  );
}

function renderAssistantTuiRich(ui: ReturnType<typeof createCliUi>, result: AssistantTuiResult): string {
  return renderSection(
    ui,
    "Assistant TUI",
    renderRows(ui, [
      { label: "Session", value: result.sessionId, tone: "accent" },
      { label: "Chat ID", value: result.chatId, tone: "secondary" },
      { label: "Workspace", value: result.workspaceDir },
      { label: "Turns", value: String(result.turnCount), tone: "accent" },
      { label: "Delivered Reminders", value: String(result.deliveredReminders), tone: result.deliveredReminders > 0 ? "success" : "muted" },
      {
        label: "Delivered Scheduled Tasks",
        value: String(result.deliveredScheduledTasks),
        tone: result.deliveredScheduledTasks > 0 ? "success" : "muted"
      }
    ])
  );
}

function renderOllamaSetupRich(ui: ReturnType<typeof createCliUi>, result: OllamaSetupResult): string {
  return renderSection(
    ui,
    "Ollama Setup",
    renderRows(ui, [
      { label: "Ollama", value: result.ollamaVersion, tone: "secondary" },
      { label: "Dry Run", value: result.dryRun ? "yes" : "no", tone: result.dryRun ? "warning" : "strong" },
      { label: "Server Reachable", value: result.serverReachable ? "yes" : "no", tone: result.serverReachable ? "success" : "danger" },
      { label: "Started Server", value: result.startedServer ? "yes" : "no", tone: result.startedServer ? "accent" : "muted" },
      { label: "Pulled Models", value: listValue(result.pulledModels), tone: result.pulledModels.length > 0 ? "success" : "muted" },
      { label: "Created Profiles", value: listValue(result.createdProfiles), tone: result.createdProfiles.length > 0 ? "success" : "muted" },
      { label: "Available Models", value: listValue(result.availableModels), tone: result.availableModels.length > 0 ? "secondary" : "muted" },
      { label: "Fallback Pulled", value: result.skippedFallback ? "no" : "yes", tone: result.skippedFallback ? "muted" : "accent" }
    ])
  );
}

function renderSkillScaffoldRich(ui: ReturnType<typeof createCliUi>, result: SkillScaffoldResult): string {
  return renderSection(
    ui,
    "Skill Scaffold",
    renderRows(ui, [
      { label: "Skill", value: result.skillName, tone: "accent" },
      { label: "Slug", value: result.slug, tone: "secondary" },
      { label: "Directory", value: result.skillDir },
      { label: "Main File", value: result.skillFile },
      { label: "Created Files", value: listValue(result.createdFiles), tone: "success" }
    ])
  );
}

function renderBootstrapRich(ui: ReturnType<typeof createCliUi>, result: BootstrapResult): string {
  return renderSection(
    ui,
    "Bootstrap",
    renderRows(ui, [
      { label: "Root", value: result.root },
      { label: "Env File", value: result.envFile, tone: "secondary" },
      { label: "Config File", value: result.configPath ?? "none", tone: result.configPath ? "secondary" : "muted" },
      { label: "Created Files", value: listValue(result.createdFiles), tone: result.createdFiles.length > 0 ? "success" : "muted" },
      { label: "Note", value: result.note, tone: "accent" }
    ])
  );
}

function renderTelegramServiceRich(ui: ReturnType<typeof createCliUi>, result: TelegramServiceResult): string {
  return [
    renderSection(
      ui,
      "Telegram",
      renderRows(ui, [
        { label: "Checked At", value: result.checkedAt },
        { label: "Processed Updates", value: String(result.processedUpdates), tone: result.processedUpdates > 0 ? "accent" : "muted" },
        { label: "Delivered Reminders", value: String(result.deliveredReminders), tone: result.deliveredReminders > 0 ? "success" : "muted" },
        {
          label: "Delivered Scheduled Tasks",
          value: String(result.deliveredScheduledTasks),
          tone: result.deliveredScheduledTasks > 0 ? "success" : "muted"
        },
        { label: "Last Update Id", value: String(result.lastUpdateId ?? "none"), tone: "secondary" },
        { label: "Heartbeat", value: result.heartbeatStatus ?? "unknown", tone: toneFromStatus(result.heartbeatStatus ?? "blocked") },
        { label: "Note", value: result.note, tone: "secondary" }
      ])
    ),
    renderSection(
      ui,
      "Files",
      renderRows(ui, [
        { label: "Assistant State", value: result.stateFile },
        { label: "Telegram State", value: result.telegramStateFile },
        { label: "Status File", value: result.statusFile },
        { label: "Status JSON", value: result.statusJsonFile }
      ])
    )
  ].join("\n\n");
}

function renderAgentTaskRich(
  ui: ReturnType<typeof createCliUi>,
  task: import("./core/types.js").AgentTaskRecord
): string {
  return renderSection(
    ui,
    "Agent Task",
    renderRows(ui, [
      { label: "Task", value: task.title, tone: "accent" },
      { label: "Status", value: task.status, tone: toneFromStatus(task.status) },
      { label: "File", value: task.file },
      { label: "Source", value: task.source, tone: "secondary" },
      { label: "Created At", value: task.createdAt }
    ])
  );
}

function renderAgentStatusRich(
  ui: ReturnType<typeof createCliUi>,
  record: import("./core/types.js").AgentStatusRecord
): string {
  return [
    renderSection(
      ui,
      "Agent",
      renderRows(ui, [
        { label: "Checked At", value: record.checkedAt },
        { label: "Agent", value: record.agentProfile.name, tone: "accent" },
        { label: "Behavior", value: record.agentProfile.behavior },
        { label: "Processed Tasks", value: String(record.processedTasks), tone: "accent" },
        { label: "Current Task", value: record.currentTask ? `${record.currentTask.title} (${record.currentTask.file})` : "none", tone: record.currentTask ? "warning" : "muted" },
        { label: "Note", value: record.note, tone: "secondary" }
      ])
    ),
    renderSection(
      ui,
      "Queue",
      renderRows(ui, [
        { label: "Queued", value: String(record.counts.queued), tone: record.counts.queued > 0 ? "warning" : "muted" },
        { label: "Working", value: String(record.counts.working), tone: record.counts.working > 0 ? "accent" : "muted" },
        { label: "Done", value: String(record.counts.done), tone: record.counts.done > 0 ? "success" : "muted" },
        { label: "Failed", value: String(record.counts.failed), tone: record.counts.failed > 0 ? "danger" : "muted" }
      ])
    ),
    renderSection(
      ui,
      "Tasks",
      [
        ui.strong("Next"),
        ui.renderList(formatOptionalList(record.nextTasks.map((task) => task.title)), "strong"),
        "",
        ui.strong("Recent Completed"),
        ui.renderList(formatOptionalList(record.recentCompleted.map((task) => task.title)), "success"),
        "",
        ui.strong("Recent Failed"),
        ui.renderList(formatOptionalList(record.recentFailed.map((task) => task.title)), record.recentFailed.length > 0 ? "danger" : "muted")
      ].join("\n")
    ),
    renderSection(
      ui,
      "Files",
      renderRows(ui, [
        { label: "Status File", value: record.statusFile },
        { label: "Status JSON", value: record.statusJsonFile }
      ])
    )
  ].join("\n\n");
}

function renderDoctorRich(
  ui: ReturnType<typeof createCliUi>,
  repoSummary: RepoSummary,
  boundary: { ok: boolean; message: string },
  provider: { ok: boolean; message: string },
  routeReason: string
): string {
  return [
    renderScanRich(ui, repoSummary),
    renderSection(
      ui,
      "Runtime",
      renderRows(ui, [
        { label: "Secretgate", value: boundary.message, tone: boundary.ok ? "success" : "danger" },
        { label: "Provider", value: provider.message, tone: provider.ok ? "success" : "danger" },
        { label: "Route", value: routeReason, tone: "secondary" }
      ])
    )
  ].join("\n\n");
}

function formatScan(repoSummary: RepoSummary): string {
  return [
    `Root: ${repoSummary.root}`,
    `Files: ${repoSummary.fileCount}`,
    `Stacks: ${repoSummary.detectedStacks.join(", ") || "none"}`,
    `Package Manager: ${repoSummary.packageManager ?? "none"}`,
    `Build Commands: ${repoSummary.buildCommands.join(", ") || "none"}`,
    `Test Commands: ${repoSummary.testCommands.join(", ") || "none"}`,
    `Entry Points: ${repoSummary.entryPoints.join(", ") || "none"}`,
    `Important Files: ${repoSummary.importantFiles.join(", ") || "none"}`
  ].join("\n");
}

function formatPlan(plan: TaskPlan): string {
  return [
    `Task: ${plan.taskSummary}`,
    "",
    "Constraints:",
    ...plan.constraints.map((item) => `- ${item}`),
    "",
    "Steps:",
    ...plan.steps.map((step) => `- ${step.id}: ${step.action} (${step.successSignal})`),
    "",
    "Next Action:",
    plan.nextAction,
    "",
    "Verification:",
    ...plan.verificationPlan.map((item) => `- ${item}`)
  ].join("\n");
}

function formatRunResult(result: AgentRunResult): string {
  return [
    `Session: ${result.sessionId}`,
    `Artifacts: ${result.sessionDir}`,
    `Outcome: ${result.outcome}`,
    `Secretgate: ${result.secretgateBoundary.message}`,
    `Verification: ${result.verification.summary}`,
    `Planner Model: ${result.routerDecision.plannerModel}`,
    `Coder Model: ${result.routerDecision.coderModel}`
  ].join("\n");
}

function formatHeartbeat(record: HeartbeatRecord): string {
  return [
    `Checked At: ${record.checkedAt}`,
    `Status: ${record.status}`,
    `Secretgate: ${record.boundary.message}`,
    `Provider: ${record.provider.message}`,
    `Verification: ${record.verification.summary}`,
    `Heartbeat File: ${record.heartbeatFile}`,
    `Heartbeat JSON: ${record.heartbeatJsonFile}`
  ].join("\n");
}

function formatChatResult(result: ChatSessionResult): string {
  return [
    `Session: ${result.sessionId}`,
    `Artifacts: ${result.sessionDir}`,
    `Provider: ${result.providerKind}`,
    `Model: ${result.model}`,
    `Turns: ${result.turnCount}`
  ].join("\n");
}

function formatOllamaSetupResult(result: OllamaSetupResult): string {
  return [
    `Ollama: ${result.ollamaVersion}`,
    `Dry Run: ${result.dryRun ? "yes" : "no"}`,
    `Server Reachable: ${result.serverReachable ? "yes" : "no"}`,
    `Started Server: ${result.startedServer ? "yes" : "no"}`,
    `Pulled Models: ${result.pulledModels.join(", ") || "none"}`,
    `Created Profiles: ${result.createdProfiles.join(", ") || "none"}`,
    `Available Models: ${result.availableModels.join(", ") || "none"}`,
    `Fallback Pulled: ${result.skippedFallback ? "no" : "yes"}`
  ].join("\n");
}

function formatSkillScaffoldResult(result: SkillScaffoldResult): string {
  return [
    `Skill: ${result.skillName}`,
    `Slug: ${result.slug}`,
    `Directory: ${result.skillDir}`,
    `Main File: ${result.skillFile}`,
    `Created Files: ${result.createdFiles.join(", ")}`
  ].join("\n");
}

function formatBootstrapResult(result: BootstrapResult): string {
  return [
    `Root: ${result.root}`,
    `Env File: ${result.envFile}`,
    `Config File: ${result.configPath ?? "none"}`,
    `Created Files: ${result.createdFiles.join(", ") || "none"}`,
    `Note: ${result.note}`
  ].join("\n");
}

function formatTelegramServiceResult(result: TelegramServiceResult): string {
  return [
    `Checked At: ${result.checkedAt}`,
    `Processed Updates: ${result.processedUpdates}`,
    `Delivered Reminders: ${result.deliveredReminders}`,
    `Delivered Scheduled Tasks: ${result.deliveredScheduledTasks}`,
    `Last Update Id: ${result.lastUpdateId ?? "none"}`,
    `Heartbeat: ${result.heartbeatStatus ?? "unknown"}`,
    `Assistant State: ${result.stateFile}`,
    `Telegram State: ${result.telegramStateFile}`,
    `Status File: ${result.statusFile}`,
    `Status JSON: ${result.statusJsonFile}`,
    `Note: ${result.note}`
  ].join("\n");
}

function formatAssistantTuiResult(result: AssistantTuiResult): string {
  return [
    `Session: ${result.sessionId}`,
    `Chat ID: ${result.chatId}`,
    `Workspace: ${result.workspaceDir}`,
    `Turns: ${result.turnCount}`,
    `Delivered Reminders: ${result.deliveredReminders}`,
    `Delivered Scheduled Tasks: ${result.deliveredScheduledTasks}`,
    `Last Assistant Message: ${result.lastAssistantMessage ?? "none"}`
  ].join("\n");
}

function formatTelegramQrResult(info: TelegramConnectInfo): string {
  return formatTelegramConnectInfo(info);
}

function formatAgentTaskResult(task: import("./core/types.js").AgentTaskRecord): string {
  return [
    `Task: ${task.title}`,
    `Status: ${task.status}`,
    `File: ${task.file}`,
    `Source: ${task.source}`,
    `Created At: ${task.createdAt}`
  ].join("\n");
}

function formatAgentStatus(record: import("./core/types.js").AgentStatusRecord): string {
  return [
    `Checked At: ${record.checkedAt}`,
    `Agent: ${record.agentProfile.name}`,
    `Behavior: ${record.agentProfile.behavior}`,
    `Processed Tasks: ${record.processedTasks}`,
    `Queued: ${record.counts.queued}`,
    `Working: ${record.counts.working}`,
    `Done: ${record.counts.done}`,
    `Failed: ${record.counts.failed}`,
    `Current Task: ${record.currentTask ? `${record.currentTask.title} (${record.currentTask.file})` : "none"}`,
    `Next Tasks: ${record.nextTasks.map((task) => task.title).join(", ") || "none"}`,
    `Recent Completed: ${record.recentCompleted.map((task) => task.title).join(", ") || "none"}`,
    `Recent Failed: ${record.recentFailed.map((task) => task.title).join(", ") || "none"}`,
    `Status File: ${record.statusFile}`,
    `Status JSON: ${record.statusJsonFile}`,
    `Note: ${record.note}`
  ].join("\n");
}

function helpText(ui?: ReturnType<typeof createCliUi>): string {
  const setupLines = [
    "bootstrap [--root PATH] [--config PATH] [--json] [--allow-direct]",
    "ollama-setup [--root PATH] [--config PATH] [--json] [--include-fallback] [--no-start] [--dry-run]",
    'skill-create "<name>" [--root PATH] [--json] [--description TEXT] [--instructions TEXT] [--shell-helpers]'
  ];
  const chatLines = ['chat ["<prompt>"] [--root PATH] [--config PATH] [--json]'];
  const assistantLines = ['assistant-tui ["<prompt>"] [--root PATH] [--config PATH] [--json] [--chat-id ID]'];
  const runLines = [
    "scan [--root PATH] [--config PATH] [--json]",
    'plan "<task>" [--root PATH] [--config PATH] [--json]',
    'run "<task>" [--root PATH] [--config PATH] [--json] [--verify]',
    "heartbeat [--root PATH] [--config PATH] [--json] [--once] [--verify] [--interval-seconds N]",
    "doctor [--root PATH] [--config PATH] [--json]",
    "telegram-qr [--root PATH] [--config PATH] [--json]",
    "telegram-start [--root PATH] [--config PATH] [--json] [--once] [--verify]"
  ];
  const agentLines = [
    "agent-profile [--root PATH] [--json] [--name TEXT] [--behavior TEXT]",
    'agent-submit "<task>" [--root PATH] [--json] [--source NAME] [--title TEXT]',
    "agent-status [--root PATH] [--json]",
    "agent-run-once [--root PATH] [--config PATH] [--json] [--verify]",
    "agent-start [--root PATH] [--config PATH] [--json] [--verify] [--interval-seconds N]"
  ];
  const examples = [
    "micro-claw bootstrap --allow-direct",
    "pnpm ollama:setup",
    "micro-claw ollama-setup --include-fallback",
    'micro-claw skill-create "python-game-builder"',
    "micro-claw scan --json",
    "micro-claw telegram-qr",
    "micro-claw assistant-tui",
    'micro-claw chat "hello"',
    'micro-claw plan "add a build pipeline"',
    'micro-claw run "inspect this repo and propose the next coding step"',
    'micro-claw agent-profile --name "Clawy" --behavior "brief, helpful, and proactive"',
    'micro-claw agent-submit "create a skill for curl smoke tests"',
    "micro-claw agent-run-once --verify",
    "secretgate wrap -- node dist/cli.js agent-start --verify"
  ];

  if (!ui?.decorated) {
    return [
      "micro-claw",
      "",
      "Setup:",
      ...setupLines.map((line) => `  ${line}`),
      "",
      "Live Chat:",
      ...chatLines.map((line) => `  ${line}`),
      "",
      "Assistant TUI:",
      ...assistantLines.map((line) => `  ${line}`),
      "",
      "Task Runs:",
      ...runLines.map((line) => `  ${line}`),
      "",
      "Always-On Agent:",
      ...agentLines.map((line) => `  ${line}`),
      "",
      "Examples:",
      ...examples.map((line) => `  ${line}`)
    ].join("\n");
  }

  return [
    renderSection(ui, "Setup", ui.renderList(setupLines, "strong")),
    renderSection(ui, "Live Chat", ui.renderList(chatLines, "strong")),
    renderSection(ui, "Assistant TUI", ui.renderList(assistantLines, "strong")),
    renderSection(ui, "Task Runs", ui.renderList(runLines, "strong")),
    renderSection(ui, "Always-On Agent", ui.renderList(agentLines, "strong")),
    renderSection(ui, "Examples", ui.renderList(examples, "secondary"))
  ].join("\n\n");
}

async function resolveTelegramConnectInfo(config: import("./core/types.js").MicroClawConfig): Promise<TelegramConnectInfo> {
  const token = process.env[config.telegram.botTokenEnv];
  if (!token) {
    throw new Error(`Missing ${config.telegram.botTokenEnv} in the environment.`);
  }

  const client = new TelegramClient({
    token,
    apiBaseUrl: config.telegram.apiBaseUrl,
    timeoutSeconds: Math.max(config.provider.requestTimeoutSeconds, config.telegram.longPollSeconds + 10)
  });
  const bot = await client.getMe();
  return createTelegramConnectInfo(bot);
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  const ui = createCliUi(process.stdout, process.env);
  const jsonOutput = Boolean(parsed.flags.json);
  const root = path.resolve(getFlag(parsed.flags, "root") ?? process.cwd());
  const configPath = getFlag(parsed.flags, "config");
  const decorate = ui.decorated && !jsonOutput;

  const writeHeader = (title: string, subtitle: string): void => {
    if (!decorate) {
      return;
    }

    process.stdout.write(`${ui.renderCommandHeader(title, subtitle)}\n`);
  };

  const runTask = async <T>(label: string, task: () => Promise<T>): Promise<T> => {
    if (!decorate) {
      return task();
    }

    return runWithSpinner(process.stdout, label, task, {
      env: process.env
    });
  };

  if (parsed.command === "help" || parsed.command === "--help" || parsed.command === "-h") {
    if (decorate) {
      await writeHero(process.stdout, {
        animate: true
      });
      process.stdout.write(`${helpText(ui)}\n`);
      return;
    }

    process.stdout.write(`${helpText()}\n`);
    return;
  }

  await loadEnvFiles(root);
  const { config } = await loadConfig(root, configPath);

  if (parsed.command === "bootstrap") {
    writeHeader("Bootstrap", "prepare env, config, and profile");
    const result = await runTask("Writing bootstrap files", () =>
      runBootstrap({
        root,
        config,
        allowDirect: Boolean(parsed.flags["allow-direct"])
      })
    );

    process.stdout.write(
      jsonOutput
        ? `${JSON.stringify(result, null, 2)}\n`
        : `${decorate ? renderBootstrapRich(ui, result) : formatBootstrapResult(result)}\n`
    );
    return;
  }

  if (parsed.command === "doctor") {
    writeHeader("Doctor", "runtime and repository diagnostics");
    const result = await runTask("Inspecting runtime and repository", async () => {
      const repoSummary = await scanRepository(root);
      const boundary = inspectSecretgateBoundary(config);
      const provider = await diagnoseProvider(config);
      const routerDecision = routeTask(config, repoSummary, "doctor runtime");
      return {
        repoSummary,
        boundary,
        provider,
        routerDecision
      };
    });
    const payload = {
      root,
      config,
      boundary: result.boundary,
      provider: result.provider,
      routerDecision: result.routerDecision
    };

    process.stdout.write(
      jsonOutput
        ? `${JSON.stringify(payload, null, 2)}\n`
        : `${decorate
            ? renderDoctorRich(ui, result.repoSummary, result.boundary, result.provider, result.routerDecision.reason)
            : `${formatScan(result.repoSummary)}\n\nSecretgate: ${result.boundary.message}\nProvider: ${result.provider.message}\nRoute: ${result.routerDecision.reason}`}\n`
    );
    return;
  }

  if (parsed.command === "ollama-setup") {
    writeHeader("Ollama Setup", "profiles, pulls, and connectivity");
    const result = await runTask("Preparing Ollama runtime", () =>
      runOllamaSetup({
        root,
        config,
        includeFallback: Boolean(parsed.flags["include-fallback"]),
        startServerIfNeeded: parsed.flags["no-start"] ? false : true,
        dryRun: Boolean(parsed.flags["dry-run"])
      })
    );

    process.stdout.write(
      jsonOutput
        ? `${JSON.stringify(result, null, 2)}\n`
        : `${decorate ? renderOllamaSetupRich(ui, result) : formatOllamaSetupResult(result)}\n`
    );
    return;
  }

  if (parsed.command === "agent-profile") {
    writeHeader("Agent Profile", "default identity and behavior");
    const name = getFlag(parsed.flags, "name");
    const behavior = getFlag(parsed.flags, "behavior");
    const profile =
      name !== undefined || behavior !== undefined
        ? await saveAgentProfile(root, {
            name,
            behavior
          })
        : await (async () => {
            const existing = await loadAgentProfile(root);
            if (existing) {
              return existing;
            }

            return resolveAgentProfile({
              root,
              output: process.stdout,
              promptIfMissing: !jsonOutput && Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY)
            });
          })();

    process.stdout.write(
      jsonOutput
        ? `${JSON.stringify(profile, null, 2)}\n`
        : `${decorate
            ? renderSection(
                ui,
                "Agent Profile",
                renderRows(ui, [
                  { label: "Name", value: profile.name, tone: "accent" },
                  { label: "Behavior", value: profile.behavior },
                  { label: "Created At", value: profile.createdAt },
                  { label: "Updated At", value: profile.updatedAt }
                ])
              )
            : formatAgentProfile(profile)}\n`
    );
    return;
  }

  if (parsed.command === "agent-submit") {
    writeHeader("Agent Submit", "queue work for the resident agent");
    const task = parsed.positionals.join(" ").trim();
    if (!task) {
      throw new Error("agent-submit requires a task string");
    }

    const createdTask = await queueAgentTask({
      root,
      prompt: task,
      source: getFlag(parsed.flags, "source"),
      title: getFlag(parsed.flags, "title")
    });

    process.stdout.write(
      jsonOutput
        ? `${JSON.stringify(createdTask, null, 2)}\n`
        : `${decorate ? renderAgentTaskRich(ui, createdTask) : formatAgentTaskResult(createdTask)}\n`
    );
    return;
  }

  if (parsed.command === "agent-status") {
    writeHeader("Agent Status", "queue and worker overview");
    const record = await runTask("Refreshing agent status", () =>
      refreshAgentStatus(root, {
        note: "Status refreshed from CLI."
      })
    );

    process.stdout.write(
      jsonOutput
        ? `${JSON.stringify(record, null, 2)}\n`
        : `${decorate ? renderAgentStatusRich(ui, record) : formatAgentStatus(record)}\n`
    );
    return;
  }

  enforceSecretgateBoundary(config);

  if (parsed.command === "skill-create") {
    writeHeader("Skill Create", "scaffold a reusable workflow");
    const name = parsed.positionals.join(" ").trim();
    if (!name) {
      throw new Error("skill-create requires a skill name");
    }

    const result = await runTask("Scaffolding skill files", () =>
      createSkillScaffold({
        root,
        name,
        description: getFlag(parsed.flags, "description"),
        instructions: getFlag(parsed.flags, "instructions"),
        ...(parsed.flags["shell-helpers"] ? createShellHelperAssets(name) : {})
      })
    );

    process.stdout.write(
      jsonOutput
        ? `${JSON.stringify(result, null, 2)}\n`
        : `${decorate ? renderSkillScaffoldRich(ui, result) : formatSkillScaffoldResult(result)}\n`
    );
    return;
  }

  if (parsed.command === "scan") {
    writeHeader("Scan", "repository snapshot");
    const repoSummary = await runTask("Scanning repository", () => scanRepository(root));
    process.stdout.write(
      jsonOutput
        ? `${JSON.stringify(repoSummary, null, 2)}\n`
        : `${decorate ? renderScanRich(ui, repoSummary) : formatScan(repoSummary)}\n`
    );
    return;
  }

  if (parsed.command === "chat") {
    const initialPrompt = parsed.positionals.join(" ").trim();
    const interactiveChat = initialPrompt.length === 0 && !jsonOutput && Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
    if (decorate && !interactiveChat) {
      writeHeader("Chat", "single prompt session");
    }
    const result = await runChatSession({
      root,
      config,
      initialPrompt: initialPrompt || undefined,
      jsonMode: jsonOutput,
      interactive: initialPrompt.length === 0 && !jsonOutput ? undefined : false,
      env: process.env
    });

    if (jsonOutput) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }

    if (!process.stdin.isTTY || initialPrompt.length > 0) {
      process.stdout.write(`${decorate ? renderChatResultRich(ui, result) : formatChatResult(result)}\n`);
    }
    return;
  }

  if (parsed.command === "assistant-tui") {
    const initialPrompt = parsed.positionals.join(" ").trim();
    const interactiveAssistant =
      initialPrompt.length === 0 && !jsonOutput && Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
    if (decorate && !interactiveAssistant) {
      writeHeader("Assistant TUI", initialPrompt.length > 0 ? "single prompt session" : "local assistant session");
    }
    const result = await runAssistantTui({
      root,
      config,
      initialPrompt: initialPrompt || undefined,
      jsonMode: jsonOutput,
      interactive: initialPrompt.length === 0 && !jsonOutput ? undefined : false,
      env: process.env,
      chatId: getFlag(parsed.flags, "chat-id")
    });

    if (jsonOutput) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }

    if (!process.stdin.isTTY || initialPrompt.length > 0) {
      process.stdout.write(`${decorate ? renderAssistantTuiRich(ui, result) : formatAssistantTuiResult(result)}\n`);
    }
    return;
  }

  if (parsed.command === "plan") {
    writeHeader("Plan", "deterministic execution plan");
    const task = parsed.positionals.join(" ").trim();
    if (!task) {
      throw new Error("plan requires a task string");
    }

    const plan = await runTask("Building deterministic plan", async () => {
      const repoSummary = await scanRepository(root);
      const routerDecision = routeTask(config, repoSummary, task);
      return createDeterministicPlan(task, repoSummary, routerDecision, config);
    });
    process.stdout.write(
      jsonOutput
        ? `${JSON.stringify(plan, null, 2)}\n`
        : `${decorate ? renderPlanRich(ui, plan) : formatPlan(plan)}\n`
    );
    return;
  }

  if (parsed.command === "heartbeat") {
    writeHeader("Heartbeat", parsed.flags.once ? "single status pulse" : "continuous heartbeat service");
    const intervalFlag = getFlag(parsed.flags, "interval-seconds");
    const intervalSeconds = intervalFlag
      ? Number.parseInt(intervalFlag, 10)
      : config.security.defaultHeartbeatIntervalSeconds;

    if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) {
      throw new Error("heartbeat requires a positive --interval-seconds value");
    }

    const record = await runTask("Maintaining heartbeat", () =>
      runHeartbeatService({
        root,
        config,
        intervalSeconds,
        once: Boolean(parsed.flags.once),
        verify: Boolean(parsed.flags.verify),
        env: process.env
      })
    );

    process.stdout.write(
      jsonOutput
        ? `${JSON.stringify(record, null, 2)}\n`
        : `${decorate ? renderHeartbeatRich(ui, record) : formatHeartbeat(record)}\n`
    );
    return;
  }

  if (parsed.command === "telegram-start") {
    writeHeader(
      "Telegram",
      parsed.flags.once ? "single telegram sync cycle" : "telegram assistant service"
    );

    if (!jsonOutput) {
      const connectInfo = await runTask("Resolving Telegram bot QR", () => resolveTelegramConnectInfo(config));
      process.stdout.write(`${formatTelegramQrResult(connectInfo)}\n\n`);
    }

    const result = await runTelegramService({
      root,
      config,
      once: Boolean(parsed.flags.once),
      verify: Boolean(parsed.flags.verify),
      env: process.env,
      output: jsonOutput ? undefined : process.stdout
    });

    process.stdout.write(
      jsonOutput
        ? `${JSON.stringify(result, null, 2)}\n`
        : `${decorate ? renderTelegramServiceRich(ui, result) : formatTelegramServiceResult(result)}\n`
    );
    return;
  }

  if (parsed.command === "telegram-qr") {
    writeHeader("Telegram QR", "scan to open the bot chat");
    const result = await runTask("Resolving Telegram bot QR", () => resolveTelegramConnectInfo(config));
    process.stdout.write(
      jsonOutput
        ? `${JSON.stringify(result, null, 2)}\n`
        : `${formatTelegramQrResult(result)}\n`
    );
    return;
  }

  if (parsed.command === "run") {
    writeHeader("Run", "task loop execution");
    const task = parsed.positionals.join(" ").trim();
    if (!task) {
      throw new Error("run requires a task string");
    }

    const result = await runTask("Running agent loop", () =>
      runAgentLoop({
        root,
        task,
        config,
        verify: parsed.flags["no-verify"] ? false : true
      })
    );

    process.stdout.write(
      jsonOutput
        ? `${JSON.stringify(result, null, 2)}\n`
        : `${decorate ? renderRunResultRich(ui, result) : formatRunResult(result)}\n`
    );
    return;
  }

  if (parsed.command === "agent-run-once" || parsed.command === "agent-start") {
    writeHeader(parsed.command === "agent-run-once" ? "Agent Run Once" : "Agent Start", "resident agent drain loop");
    const intervalFlag = getFlag(parsed.flags, "interval-seconds");
    const intervalSeconds = intervalFlag
      ? Number.parseInt(intervalFlag, 10)
      : config.security.defaultHeartbeatIntervalSeconds;

    if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) {
      throw new Error(`${parsed.command} requires a positive --interval-seconds value`);
    }

    const record = await runResidentAgent({
      root,
      config,
      intervalSeconds,
      once: parsed.command === "agent-run-once",
      verify: Boolean(parsed.flags.verify),
      env: process.env,
      output: jsonOutput ? undefined : process.stdout
    });

    process.stdout.write(
      jsonOutput
        ? `${JSON.stringify(record, null, 2)}\n`
        : `${decorate ? renderAgentStatusRich(ui, record) : formatAgentStatus(record)}\n`
    );
    return;
  }

  throw new Error(`Unknown command: ${parsed.command}`);
}

main().catch((error) => {
  const stderrUi = createCliUi(process.stderr, process.env);
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${stderrUi.decorated ? stderrUi.danger(message) : message}\n`);
  process.exitCode = 1;
});
