export interface EvalTask {
  id: string;
  category: "repo-understanding" | "small-coding" | "medium-coding" | "repair-loop";
  title: string;
  description: string;
  setup?: string;
  prompt: string;
  expectedOutcomes: string[];
  verificationCriteria: VerificationCriterion[];
  timeoutSeconds: number;
  difficulty: "easy" | "medium" | "hard";
}

export interface VerificationCriterion {
  type: "file-exists" | "file-matches" | "command-exit-zero" | "no-error-in-output";
  path?: string;
  command?: string;
  pattern?: string;
  description: string;
}

export interface EvalTaskResult {
  taskId: string;
  runAt: string;
  durationMs: number;
  success: boolean;
  reason?: string;
  toolCalls: number;
  retries: number;
  verificationResults: VerificationCriterionResult[];
  error?: string;
}

export interface VerificationCriterionResult {
  criterion: VerificationCriterion;
  passed: boolean;
  details?: string;
}

export interface BenchmarkRun {
  id: string;
  runAt: string;
  startedAt: string;
  completedAt: string;
  hardware: HardwareBaseline;
  modelProfile: string;
  runtimeMode: "local" | "remote";
  contextSize: number;
  coldStartMs: number;
  warmStartMs: number;
  firstTokenMs: number;
  taskResults: EvalTaskResult[];
  summary: BenchmarkSummary;
}

export interface HardwareBaseline {
  machineType: string;
  totalRamMb: number;
  cpuCores: number;
  gpuInfo?: string;
  ollamaVersion?: string;
  activeModelTag?: string;
}

export interface BenchmarkSummary {
  totalTasks: number;
  passedTasks: number;
  failedTasks: number;
  passRate: number;
  avgDurationMs: number;
  avgToolCalls: number;
  totalRetries: number;
  categoryBreakdown: Record<string, { total: number; passed: number; passRate: number }>;
}

export interface EvalConfig {
  taskCorpusPath: string;
  resultsDir: string;
  hardwareBaseline: HardwareBaseline;
  modelProfile: string;
  runtimeMode: "local" | "remote";
  contextSize: number;
  timeoutSeconds: number;
}

export interface ReleaseGateResult {
  gateName: string;
  passed: boolean;
  criteria: ReleaseGateCriteria[];
  summary: string;
}

export interface ReleaseGateCriteria {
  name: string;
  passed: boolean;
  threshold: number;
  actual: number;
  unit: string;
}

export interface ComparisonMatrix {
  comparedAt: string;
  runs: BenchmarkRun[];
  comparison: {
    profile: string;
    mode: string;
    passRate: number;
    avgDurationMs: number;
    avgToolCalls: number;
  }[];
}
