export type RuntimeMode = "local" | "remote";

export type ProviderKind = "anthropic" | "ollama" | "openai-compatible" | "none";
export type ChatRole = "system" | "user" | "assistant";

export type MemoryPressure = "low" | "medium" | "high" | "critical";

export interface SystemMemoryStatus {
  totalMb: number;
  freeMb: number;
  usedMb: number;
  usedPercent: number;
  pressure: MemoryPressure;
  ollamaMemoryMb?: number;
}

export type ToolName =
  | "shell"
  | "read_file"
  | "list_files"
  | "search"
  | "grep"
  | "patch"
  | "write_file"
  | "replace_text"
  | "delete_file"
  | "create_skill"
  | "git_status"
  | "git_diff";

export type VerificationStatus = "passed" | "failed" | "skipped";

export interface MicroClawConfig {
  runtime: {
    mode: RuntimeMode;
    localFallback: boolean;
    stream: boolean;
    diskBackedMemory: boolean;
    inMemoryRetrieval: boolean;
    maxParallelRequests: number;
  };
  provider: {
    kind: ProviderKind;
    model: string;
    apiKeyEnv: string;
    requestTimeoutSeconds: number;
    maxOutputTokens: number;
    baseUrl?: string;
    ollamaHost: string;
  };
  context: {
    keepRecentMessages: number;
    keepFullTranscriptInMemory: boolean;
    summarizeAfterEachStep: boolean;
    maxOpenFiles: number;
    maxFileCharsPerFile: number;
  };
  tools: {
    shellEnabled: boolean;
    patchEnabled: boolean;
    maxCommandSeconds: number;
    captureCommandOutputLimit: number;
  };
  policy: {
    preferMinRam: boolean;
    startOllamaAutomatically: boolean;
    allowRemoteProvider: boolean;
    requireExplicitOptInForLocalModel: boolean;
  };
  security: {
    requireSecretgate: boolean;
    proxyEnvNames: string[];
    certEnvNames: string[];
    expectedProxyHosts: string[];
    expectedProxyPort: number;
    heartbeatFile: string;
    heartbeatJsonFile: string;
    defaultHeartbeatIntervalSeconds: number;
  };
  profiles: {
    planner: string;
    coder: string;
    fallback: string;
  };
  assistant: {
    enabled: boolean;
    stateFile: string;
    summaryFile: string;
    statusFile: string;
    statusJsonFile: string;
    workspacesDir: string;
    schedulesFile: string;
    schedulesSummaryFile: string;
    recentConversationMessages: number;
    maxNotesPerUser: number;
    maxTodosPerUser: number;
    maxRemindersPerUser: number;
  };
  telegram: {
    enabled: boolean;
    botTokenEnv: string;
    apiBaseUrl: string;
    allowedChatIds: string[];
    pollIntervalMs: number;
    longPollSeconds: number;
    stateFile: string;
  };
}

export interface RepoSummary {
  root: string;
  fileCount: number;
  packageManager?: string;
  detectedStacks: string[];
  entryPoints: string[];
  buildCommands: string[];
  testCommands: string[];
  importantFiles: string[];
  topLevelDirectories: string[];
  notes: string[];
}

export interface PlanStep {
  id: string;
  action: string;
  successSignal: string;
}

export interface TaskPlan {
  taskSummary: string;
  constraints: string[];
  assumptions: string[];
  neededContext: string[];
  nextAction: string;
  expectedResult: string;
  steps: PlanStep[];
  verificationPlan: string[];
  stopCondition: string;
}

export interface RouterDecision {
  runtimeMode: RuntimeMode;
  providerKind: ProviderKind;
  plannerModel: string;
  coderModel: string;
  fallbackModel: string;
  reason: string;
}

export type PatchOperation =
  | {
      kind: "write_file";
      path: string;
      content: string;
    }
  | {
      kind: "replace_text";
      path: string;
      search: string;
      replace: string;
      expectedReplacements?: number;
    }
  | {
      kind: "delete_file";
      path: string;
    };

export interface ToolCall {
  tool: ToolName;
  input: Record<string, unknown>;
}

export interface ToolResult {
  tool: ToolName;
  ok: boolean;
  summary: string;
  durationMs: number;
  data?: unknown;
  error?: string;
}

export interface ShellCommandResult {
  command: string;
  cwd: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export interface SearchMatch {
  path: string;
  line: number;
  preview: string;
}

export interface VerificationCheck {
  command: string;
  ok: boolean;
  exitCode: number | null;
  output: string;
  durationMs: number;
}

export interface VerificationResult {
  status: VerificationStatus;
  checks: VerificationCheck[];
  summary: string;
}

export interface ProviderDiagnostic {
  kind: ProviderKind;
  ok: boolean;
  message: string;
  checkedAt: string;
  details?: Record<string, unknown>;
}

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatCompletionResult {
  providerKind: ProviderKind;
  model: string;
  content: string;
  finishReason?: string;
}

export interface ChatSessionResult {
  sessionId: string;
  sessionDir: string;
  providerKind: ProviderKind;
  model: string;
  turnCount: number;
  lastAssistantMessage?: string;
}

export interface OllamaProfileSetup {
  name: string;
  baseModel: string;
  modelfilePath: string;
}

export interface OllamaSetupResult {
  ollamaVersion: string;
  serverReachable: boolean;
  startedServer: boolean;
  pulledModels: string[];
  createdProfiles: string[];
  availableModels: string[];
  skippedFallback: boolean;
  dryRun: boolean;
}

export interface SkillScaffoldResult {
  skillName: string;
  slug: string;
  skillDir: string;
  skillFile: string;
  createdFiles: string[];
}

export interface SecretgateBoundaryStatus {
  ok: boolean;
  proxyConfigured: boolean;
  certConfigured: boolean;
  proxyEnvName?: string;
  certEnvName?: string;
  proxyUrl?: string;
  certPath?: string;
  message: string;
}

export type HeartbeatHealth = "healthy" | "degraded" | "blocked";

export type AgentTaskStatus = "queued" | "working" | "done" | "failed";

export interface AgentTaskRecord {
  id: string;
  slug: string;
  title: string;
  prompt: string;
  status: AgentTaskStatus;
  createdAt: string;
  updatedAt: string;
  source: string;
  attempts: number;
  file: string;
  sessionId?: string;
  sessionDir?: string;
  summary?: string;
  error?: string;
}

export interface AgentQueueCounts {
  queued: number;
  working: number;
  done: number;
  failed: number;
}

export interface AgentProfile {
  name: string;
  behavior: string;
  createdAt: string;
  updatedAt: string;
}

export interface AssistantNote {
  id: string;
  text: string;
  createdAt: string;
}

export interface AssistantTodo {
  id: string;
  text: string;
  createdAt: string;
  completedAt?: string;
}

export interface AssistantReminder {
  id: string;
  text: string;
  createdAt: string;
  dueAt: string;
  deliveredAt?: string;
}

export interface AssistantConversationMessage {
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export interface AssistantUserState {
  chatId: string;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string;
  username?: string;
  displayName?: string;
  notes: AssistantNote[];
  todos: AssistantTodo[];
  reminders: AssistantReminder[];
  conversation: AssistantConversationMessage[];
}

export interface AssistantState {
  version: number;
  updatedAt: string;
  users: Record<string, AssistantUserState>;
}

export type AssistantSchedulePattern =
  | {
      kind: "interval";
      every: number;
      unit: "minutes" | "hours" | "days";
    }
  | {
      kind: "daily";
      hour: number;
      minute: number;
      weekdaysOnly: boolean;
    }
  | {
      kind: "weekly";
      weekday: number;
      hour: number;
      minute: number;
    };

export interface AssistantScheduledTask {
  id: string;
  chatId: string;
  prompt: string;
  createdAt: string;
  updatedAt: string;
  nextRunAt: string;
  lastRunAt?: string;
  lastResultSummary?: string;
  lastError?: string;
  schedule: AssistantSchedulePattern;
}

export interface AssistantScheduleState {
  version: number;
  updatedAt: string;
  tasks: AssistantScheduledTask[];
}

export interface AssistantScheduleParseResult {
  prompt: string;
  nextRunAt: string;
  schedule: AssistantSchedulePattern;
}

export interface TelegramRuntimeState {
  lastUpdateId?: number;
  updatedAt: string;
}

export interface AgentStatusRecord {
  checkedAt: string;
  root: string;
  agentProfile: AgentProfile;
  counts: AgentQueueCounts;
  currentTask?: {
    id: string;
    title: string;
    file: string;
  };
  nextTasks: Array<{
    id: string;
    title: string;
    file: string;
  }>;
  recentCompleted: Array<{
    id: string;
    title: string;
    file: string;
    summary?: string;
  }>;
  recentFailed: Array<{
    id: string;
    title: string;
    file: string;
    error?: string;
  }>;
  lastTask?: {
    id: string;
    title: string;
    status: AgentTaskStatus;
    file: string;
    sessionDir?: string;
    summary?: string;
    error?: string;
  };
  processedTasks: number;
  note: string;
  heartbeatStatus?: HeartbeatHealth;
  heartbeatFile?: string;
  heartbeatJsonFile?: string;
  statusFile: string;
  statusJsonFile: string;
}

export interface HeartbeatRecord {
  checkedAt: string;
  root: string;
  status: HeartbeatHealth;
  iteration: number;
  pid: number;
  intervalSeconds: number;
  boundary: SecretgateBoundaryStatus;
  provider: ProviderDiagnostic;
  repoSummary: RepoSummary;
  routerDecision: RouterDecision;
  verification: VerificationResult;
  note: string;
  heartbeatFile: string;
  heartbeatJsonFile: string;
}

export interface ReminderParseResult {
  dueAt: string;
  text: string;
}

export interface BootstrapResult {
  root: string;
  createdFiles: string[];
  configPath?: string;
  envFile: string;
  note: string;
}

export interface TelegramServiceResult {
  checkedAt: string;
  root: string;
  processedUpdates: number;
  deliveredReminders: number;
  deliveredScheduledTasks: number;
  lastUpdateId?: number;
  heartbeatStatus?: HeartbeatHealth;
  stateFile: string;
  telegramStateFile: string;
  statusFile: string;
  statusJsonFile: string;
  note: string;
}

export interface AssistantTuiResult {
  sessionId: string;
  sessionDir: string;
  chatId: string;
  workspaceDir: string;
  deliveredReminders: number;
  deliveredScheduledTasks: number;
  turnCount: number;
  lastAssistantMessage?: string;
}

export interface AgentRunResult {
  sessionId: string;
  sessionDir: string;
  task: string;
  secretgateBoundary: SecretgateBoundaryStatus;
  repoSummary: RepoSummary;
  routerDecision: RouterDecision;
  plan: TaskPlan;
  toolResults: ToolResult[];
  verification: VerificationResult;
  outcome: "done" | "blocked";
  completedAt: string;
}
