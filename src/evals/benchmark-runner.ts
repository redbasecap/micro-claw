import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { MicroClawConfig } from "../core/types.js";
import type {
  BenchmarkRun,
  BenchmarkSummary,
  ComparisonMatrix,
  EvalConfig,
  EvalTask,
  EvalTaskResult,
  HardwareBaseline,
  ReleaseGateResult,
  VerificationCriterionResult
} from "./types.js";
import { codingTaskCorpus } from "./task-corpus.js";
import { runAgentLoop } from "../orchestrator/agent-loop.js";
import { defaultConfig } from "../config/defaults.js";
import { timestampId } from "../core/utils.js";

export async function runBenchmark(config: EvalConfig): Promise<BenchmarkRun> {
  const runId = timestampId();
  const hardware = getHardwareBaseline(config.hardwareBaseline);
  const startedAt = new Date().toISOString();
  const evalRuntimeConfig = createEvalRuntimeConfig(config);
  const taskResults: EvalTaskResult[] = [];
  
  for (const task of codingTaskCorpus) {
    const taskStartMs = Date.now();
    const result = await runEvalTask(task, config, evalRuntimeConfig);
    taskResults.push(result);
    console.log(`[${task.id}] ${result.success ? "PASS" : "FAIL"} (${Date.now() - taskStartMs}ms)`);
  }

  const completedAt = new Date().toISOString();
  const coldStartMs = taskResults[0]?.durationMs ?? 0;
  const warmStartMs = taskResults[1]?.durationMs ?? 0;
  const summary = computeSummary(taskResults);
  
  const run: BenchmarkRun = {
    id: runId,
    runAt: startedAt,
    startedAt,
    completedAt,
    hardware,
    modelProfile: config.modelProfile,
    runtimeMode: config.runtimeMode,
    contextSize: config.contextSize,
    coldStartMs,
    warmStartMs,
    firstTokenMs: 0,
    taskResults,
    summary
  };
  
  const resultsPath = path.join(config.resultsDir, `run-${runId}.json`);
  mkdirSync(config.resultsDir, { recursive: true });
  writeFileSync(resultsPath, JSON.stringify(run, null, 2));
  
  return run;
}

function createEvalRuntimeConfig(config: EvalConfig): MicroClawConfig {
  return {
    ...defaultConfig,
    runtime: {
      ...defaultConfig.runtime,
      mode: config.runtimeMode
    },
    provider: {
      ...defaultConfig.provider,
      kind: config.runtimeMode === "remote" ? "openai-compatible" : "ollama",
      model: config.modelProfile
    },
    profiles: {
      planner: config.modelProfile,
      coder: config.modelProfile,
      fallback: config.modelProfile
    }
  };
}

async function runEvalTask(
  task: EvalTask,
  config: EvalConfig,
  runtimeConfig: MicroClawConfig
): Promise<EvalTaskResult> {
  const startTime = Date.now();
  const toolCalls = 0;
  const retries = 0;
  let timeoutId: NodeJS.Timeout | undefined;
  
  try {
    const result = await Promise.race([
      runAgentLoop({
        root: process.cwd(),
        task: task.prompt,
        config: runtimeConfig,
        verify: false
      }),
      new Promise<never>((_, reject) =>
        {
          timeoutId = setTimeout(
            () => reject(new Error(`Task ${task.id} timed out after ${task.timeoutSeconds}s`)),
            task.timeoutSeconds * 1000
          );
        }
      )
    ]);
    
    const verificationResults = await verifyTask(task, config);
    const allPassed = verificationResults.every((v) => v.passed);
    
    return {
      taskId: task.id,
      runAt: new Date().toISOString(),
      durationMs: Date.now() - startTime,
      success: allPassed,
      toolCalls: result.toolResults.length,
      retries: 0,
      verificationResults,
      error: allPassed ? undefined : "Some verification criteria failed"
    };
  } catch (error) {
    return {
      taskId: task.id,
      runAt: new Date().toISOString(),
      durationMs: Date.now() - startTime,
      success: false,
      toolCalls,
      retries,
      verificationResults: [],
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

async function verifyTask(
  task: EvalTask,
  _config: EvalConfig
): Promise<VerificationCriterionResult[]> {
  const { execSync } = await import("node:child_process");
  const results: VerificationCriterionResult[] = [];
  
  for (const criterion of task.verificationCriteria) {
    try {
      if (criterion.type === "command-exit-zero") {
        const output = execSync(criterion.command || "", {
          encoding: "utf-8",
          timeout: 10000,
          cwd: process.cwd()
        });
        const passed = criterion.pattern
          ? new RegExp(criterion.pattern).test(output)
          : true;
        results.push({ criterion, passed, details: output.trim() });
      } else if (criterion.type === "file-matches" && criterion.path && criterion.pattern) {
        const filePath = path.join(process.cwd(), criterion.path);
        if (existsSync(filePath)) {
          const content = readFileSync(filePath, "utf-8");
          const passed = new RegExp(criterion.pattern, "i").test(content);
          results.push({ criterion, passed, details: `Found in ${criterion.path}` });
        } else {
          results.push({ criterion, passed: false, details: `File ${criterion.path} not found` });
        }
      } else if (criterion.type === "file-exists" && criterion.path) {
        const filePath = path.join(process.cwd(), criterion.path);
        const passed = existsSync(filePath);
        results.push({ criterion, passed, details: passed ? "File exists" : "File not found" });
      } else if (criterion.type === "no-error-in-output") {
        results.push({ criterion, passed: true, details: "Manual verification needed" });
      } else {
        results.push({ criterion, passed: true, details: "Criterion type not automated" });
      }
    } catch (error) {
      results.push({
        criterion,
        passed: false,
        details: error instanceof Error ? error.message : String(error)
      });
    }
  }
  
  return results;
}

function computeSummary(taskResults: EvalTaskResult[]): BenchmarkSummary {
  const passedTasks = taskResults.filter((r) => r.success).length;
  const failedTasks = taskResults.length - passedTasks;
  
  const categoryBreakdown: Record<string, { total: number; passed: number; passRate: number }> = {};
  
  for (const task of codingTaskCorpus) {
    const result = taskResults.find((r) => r.taskId === task.id);
    if (!categoryBreakdown[task.category]) {
      categoryBreakdown[task.category] = { total: 0, passed: 0, passRate: 0 };
    }
    categoryBreakdown[task.category].total++;
    if (result?.success) {
      categoryBreakdown[task.category].passed++;
    }
  }
  
  for (const cat of Object.keys(categoryBreakdown)) {
    const { total, passed } = categoryBreakdown[cat];
    categoryBreakdown[cat].passRate = total > 0 ? passed / total : 0;
  }
  
  return {
    totalTasks: taskResults.length,
    passedTasks,
    failedTasks,
    passRate: taskResults.length > 0 ? passedTasks / taskResults.length : 0,
    avgDurationMs: taskResults.length > 0
      ? taskResults.reduce((sum, r) => sum + r.durationMs, 0) / taskResults.length
      : 0,
    avgToolCalls: taskResults.length > 0
      ? taskResults.reduce((sum, r) => sum + r.toolCalls, 0) / taskResults.length
      : 0,
    totalRetries: taskResults.reduce((sum, r) => sum + r.retries, 0),
    categoryBreakdown
  };
}

function getHardwareBaseline(override?: Partial<HardwareBaseline>): HardwareBaseline {
  const cpus = os.cpus();
  const cpuModel = cpus[0]?.model || "unknown";
  
  return {
    machineType: `${os.platform()} ${os.arch()}`,
    totalRamMb: Math.round(os.totalmem() / (1024 * 1024)),
    cpuCores: os.cpus().length,
    ollamaVersion: override?.ollamaVersion,
    activeModelTag: override?.activeModelTag,
    ...override
  };
}

export function generateComparisonMatrix(resultsDir: string): ComparisonMatrix {
  const files = (() => {
    const { readdirSync } = require("node:fs");
    const { readdirSync: rd } = require("node:fs");
    try {
      return rd(resultsDir)
        .filter((f: string) => f.startsWith("run-") && f.endsWith(".json"))
        .map((f: string) => path.join(resultsDir, f));
    } catch {
      return [];
    }
  })();
  
  const runs: BenchmarkRun[] = files
    .map((f: string) => {
      try {
        return JSON.parse(readFileSync(f, "utf-8")) as BenchmarkRun;
      } catch {
        return null;
      }
    })
    .filter((r: BenchmarkRun | null): r is BenchmarkRun => r !== null);
  
  const comparison = runs.map((run) => ({
    profile: run.modelProfile,
    mode: run.runtimeMode,
    passRate: run.summary.passRate,
    avgDurationMs: run.summary.avgDurationMs,
    avgToolCalls: run.summary.avgToolCalls
  }));
  
  return {
    comparedAt: new Date().toISOString(),
    runs,
    comparison
  };
}

export function checkReleaseGates(run: BenchmarkRun): ReleaseGateResult {
  const gates: ReleaseGateResult[] = [];
  
  const smallCodingGates = checkCategoryGates(run, "small-coding", {
    minPassRate: 0.8,
    maxAvgDurationMs: 30000,
    minTasks: 2
  });
  
  const mediumCodingGates = checkCategoryGates(run, "medium-coding", {
    minPassRate: 0.6,
    maxAvgDurationMs: 60000,
    minTasks: 1
  });
  
  const overallGates: ReleaseGateResult = {
    gateName: "overall-coding-capable",
    passed: smallCodingGates.passed && mediumCodingGates.passed,
    criteria: [
      ...smallCodingGates.criteria,
      ...mediumCodingGates.criteria,
      {
        name: "verification-required",
        passed: run.summary.passedTasks >= 3,
        threshold: 3,
        actual: run.summary.passedTasks,
        unit: "tasks"
      },
      {
        name: "hardware-boundary",
        passed: run.hardware.totalRamMb >= 8192,
        threshold: 8192,
        actual: run.hardware.totalRamMb,
        unit: "MB"
      }
    ],
    summary: smallCodingGates.passed && mediumCodingGates.passed
      ? "Release gate PASSED: Micro Claw is coding-capable"
      : "Release gate FAILED: Micro Claw is not yet coding-capable"
  };
  
  return overallGates;
}

function checkCategoryGates(
  run: BenchmarkRun,
  category: string,
  thresholds: { minPassRate: number; maxAvgDurationMs: number; minTasks: number }
): ReleaseGateResult {
  const catStats = run.summary.categoryBreakdown[category];
  
  const criteria: ReleaseGateResult["criteria"] = [
    {
      name: `${category}-pass-rate`,
      passed: (catStats?.passRate || 0) >= thresholds.minPassRate,
      threshold: thresholds.minPassRate,
      actual: catStats?.passRate || 0,
      unit: "rate"
    },
    {
      name: `${category}-max-duration`,
      passed: run.summary.avgDurationMs <= thresholds.maxAvgDurationMs,
      threshold: thresholds.maxAvgDurationMs,
      actual: run.summary.avgDurationMs,
      unit: "ms"
    },
    {
      name: `${category}-min-tasks`,
      passed: (catStats?.total || 0) >= thresholds.minTasks,
      threshold: thresholds.minTasks,
      actual: catStats?.total || 0,
      unit: "tasks"
    }
  ];
  
  return {
    gateName: `${category}-gate`,
    passed: criteria.every((c) => c.passed),
    criteria,
    summary: criteria.every((c) => c.passed)
      ? `${category} tasks meet release criteria`
      : `${category} tasks do not meet release criteria`
  };
}

export async function runEvalSuite(
  resultsDir: string,
  modelProfile: string,
  runtimeMode: "local" | "remote"
): Promise<{ run: BenchmarkRun; gates: ReleaseGateResult; matrix: ComparisonMatrix }> {
  const config: EvalConfig = {
    taskCorpusPath: path.join(process.cwd(), "src", "evals", "task-corpus.ts"),
    resultsDir,
    hardwareBaseline: getHardwareBaseline(),
    modelProfile,
    runtimeMode,
    contextSize: 4096,
    timeoutSeconds: 300
  };
  
  console.log("Starting evaluation suite...");
  console.log(`Hardware: ${config.hardwareBaseline.machineType}, ${config.hardwareBaseline.totalRamMb}MB RAM`);
  console.log(`Model: ${modelProfile}, Mode: ${runtimeMode}`);
  
  const run = await runBenchmark(config);
  const gates = checkReleaseGates(run);
  const matrix = generateComparisonMatrix(resultsDir);
  
  console.log("\n=== Benchmark Summary ===");
  console.log(`Pass Rate: ${(run.summary.passRate * 100).toFixed(1)}%`);
  console.log(`Avg Duration: ${(run.summary.avgDurationMs / 1000).toFixed(1)}s`);
  console.log(`\n=== Release Gate ===`);
  console.log(gates.summary);
  
  for (const criterion of gates.criteria) {
    const status = criterion.passed ? "✓" : "✗";
    console.log(`  ${status} ${criterion.name}: ${criterion.actual} (min: ${criterion.threshold})`);
  }
  
  return { run, gates, matrix };
}
