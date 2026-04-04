import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { EvalConfig, EvalTask, EvalTaskResult, ReleaseGateResult } from "../src/evals/types.js";
import { codingTaskCorpus, getSmallCodingTasks, getMediumCodingTasks } from "../src/evals/task-corpus.js";
import { checkReleaseGates } from "../src/evals/benchmark-runner.js";
import { assessMemoryPressure, checkSystemMemory } from "../src/router/memory-aware-router.js";
import { cleanupOldSessions, getStorageInfo } from "../src/observability/memory-cleanup.js";
import { AuditLogger, getAuditLogger } from "../src/observability/audit-logger.js";
import { analyzeFailure, withRetry, withTimeout, CircuitBreaker } from "../src/observability/failure-recovery.js";

const benchmarkTempDirs: string[] = [];

describe("Phase 5: Evaluation Harness", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.resetModules();
    vi.doUnmock("../src/evals/task-corpus.js");
    vi.doUnmock("../src/orchestrator/agent-loop.js");
    benchmarkTempDirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
  });

  describe("Task Corpus", () => {
    it("should have at least 5 coding tasks", () => {
      const codingTasks = [...getSmallCodingTasks(), ...getMediumCodingTasks()];
      expect(codingTasks.length).toBeGreaterThanOrEqual(5);
    });

    it("should have tasks in each required category", () => {
      const categories = new Set(codingTaskCorpus.map((t) => t.category));
      expect(categories.has("repo-understanding")).toBe(true);
      expect(categories.has("small-coding")).toBe(true);
      expect(categories.has("medium-coding")).toBe(true);
      expect(categories.has("repair-loop")).toBe(true);
    });

    it("should have verification criteria for each task", () => {
      for (const task of codingTaskCorpus) {
        expect(task.verificationCriteria.length).toBeGreaterThan(0);
      }
    });

    it("should have appropriate timeouts for each difficulty", () => {
      for (const task of codingTaskCorpus) {
        if (task.difficulty === "easy") {
          expect(task.timeoutSeconds).toBeLessThanOrEqual(120);
        }
        if (task.difficulty === "medium") {
          expect(task.timeoutSeconds).toBeLessThanOrEqual(300);
        }
        if (task.difficulty === "hard") {
          expect(task.timeoutSeconds).toBeLessThanOrEqual(600);
        }
      }
    });
  });

  describe("Benchmark Runner", () => {
    it("runs eval tasks with the benchmark runtime mode and profile", async () => {
      const task = createMockEvalTask("benchmark-config");
      const runAgentLoop = vi.fn(async () => ({
        toolResults: [{ tool: "search" }, { tool: "git_status" }]
      }));
      const { runBenchmark } = await loadBenchmarkRunnerWithMocks([task], runAgentLoop);
      const resultsDir = createBenchmarkResultsDir("config");

      const run = await runBenchmark(
        createEvalConfig(resultsDir, {
          runtimeMode: "remote",
          modelProfile: "remote-benchmark-profile"
        })
      );

      expect(runAgentLoop).toHaveBeenCalledTimes(1);
      expect(runAgentLoop).toHaveBeenCalledWith(
        expect.objectContaining({
          root: process.cwd(),
          task: task.prompt,
          verify: false,
          config: expect.objectContaining({
            runtime: expect.objectContaining({ mode: "remote" }),
            provider: expect.objectContaining({
              kind: "openai-compatible",
              model: "remote-benchmark-profile"
            }),
            profiles: {
              planner: "remote-benchmark-profile",
              coder: "remote-benchmark-profile",
              fallback: "remote-benchmark-profile"
            }
          })
        })
      );
      expect(run.runtimeMode).toBe("remote");
      expect(run.modelProfile).toBe("remote-benchmark-profile");
      expect(run.taskResults[0]?.toolCalls).toBe(2);
    });

    it("stores duration fields as durations instead of timestamps", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-04-04T10:00:00.000Z"));

      const durations = [125, 40];
      let callIndex = 0;
      const runAgentLoop = vi.fn(async () => {
        const duration = durations[callIndex] ?? durations[durations.length - 1];
        callIndex += 1;
        await vi.advanceTimersByTimeAsync(duration);
        return { toolResults: [{ tool: "search" }] };
      });
      const { runBenchmark } = await loadBenchmarkRunnerWithMocks(
        [createMockEvalTask("cold-start"), createMockEvalTask("warm-start")],
        runAgentLoop
      );
      const resultsDir = createBenchmarkResultsDir("timing");

      const run = await runBenchmark(createEvalConfig(resultsDir));
      const benchmarkDurationMs = Date.parse(run.completedAt) - Date.parse(run.startedAt);

      expect(run.runAt).toBe(run.startedAt);
      expect(benchmarkDurationMs).toBe(165);
      expect(run.coldStartMs).toBe(125);
      expect(run.warmStartMs).toBe(40);
      expect(run.firstTokenMs).toBe(0);
      expect(run.coldStartMs).toBeLessThanOrEqual(benchmarkDurationMs);
      expect(run.warmStartMs).toBeLessThanOrEqual(benchmarkDurationMs);
      expect(run.firstTokenMs).toBeLessThanOrEqual(benchmarkDurationMs);
      expect(run.taskResults.map((result) => result.durationMs)).toEqual([125, 40]);
    });
  });

  describe("Release Gates", () => {
    it("should pass gates when all tasks succeed", () => {
      const mockRun = createMockBenchmarkRun(1.0);
      const gates = checkReleaseGates(mockRun);
      
      expect(gates.criteria.some((c) => c.name.includes("pass-rate"))).toBe(true);
    });

    it("should fail gates when pass rate is too low", () => {
      const mockRun = createMockBenchmarkRun(0.3);
      const gates = checkReleaseGates(mockRun);
      
      const smallCodingGate = gates.criteria.find((c) => c.name.includes("small-coding"));
      expect(smallCodingGate?.passed).toBe(false);
    });
  });
});

describe("Phase 4: Memory-Aware Routing", () => {
  it("should detect system memory pressure", () => {
    const memory = checkSystemMemory();
    
    expect(memory.totalMb).toBeGreaterThan(0);
    expect(memory.freeMb).toBeGreaterThanOrEqual(0);
    expect(memory.usedPercent).toBeGreaterThanOrEqual(0);
    expect(memory.usedPercent).toBeLessThanOrEqual(100);
    expect(["low", "medium", "high", "critical"]).toContain(memory.pressure);
  });

  it("should assess memory pressure correctly", () => {
    const pressure = assessMemoryPressure({
      runtime: { mode: "local" },
      policy: { preferMinRam: false }
    } as any);
    
    expect(pressure.level).toBeDefined();
    expect(pressure.recommendation).toBeDefined();
    expect(pressure.availableMb).toBeGreaterThanOrEqual(0);
  });
});

describe("Phase 7: Observability & Audit Logs", () => {
  const testDir = path.join(os.tmpdir(), `micro-claw-audit-test-${Date.now()}`);
  
  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  it("should write audit events to file", () => {
    const logger = new AuditLogger({ logDir: testDir });
    
    logger.log("session_start", "Test session started", "info", { testId: "123" });
    logger.log("tool_call", "shell command executed", "debug");
    
    const logFile = logger.getLogFile();
    expect(existsSync(logFile)).toBe(true);
    
    const content = readFileSync(logFile, "utf-8");
    expect(content).toContain("session_start");
    expect(content).toContain("Test session started");
  });

  it("should redact sensitive information", () => {
    const logger = new AuditLogger({ logDir: testDir, redactSensitive: true });
    
    logger.log("config_change", "API_KEY changed", "warn", { api_key: "secret123" });
    
    const logFile = logger.getLogFile();
    const content = readFileSync(logFile, "utf-8");
    
    expect(content).not.toContain("secret123");
    expect(content).toContain("[REDACTED]");
  });

  it("should get audit logger singleton", () => {
    const logger = getAuditLogger();
    expect(logger).toBeDefined();
    expect(typeof logger.log).toBe("function");
  });
});

describe("Phase 7: Failure Recovery", () => {
  describe("withRetry", () => {
    it("should retry on retryable errors", async () => {
      let attempts = 0;
      
      const result = await withRetry(
        async () => {
          attempts++;
          if (attempts < 3) {
            throw new Error("ECONNRESET");
          }
          return "success";
        },
        { maxRetries: 3, retryableErrors: ["ECONNRESET"] }
      );
      
      expect(result).toBe("success");
      expect(attempts).toBe(3);
    });

    it("should not retry on non-retryable errors", async () => {
      let attempts = 0;
      
      await expect(
        withRetry(
          async () => {
            attempts++;
            throw new Error("SyntaxError");
          },
          { maxRetries: 3, retryableErrors: ["ECONNRESET"] }
        )
      ).rejects.toThrow("SyntaxError");
      
      expect(attempts).toBe(1);
    });
  });

  describe("withTimeout", () => {
    it("should complete before timeout", async () => {
      const result = await withTimeout(
        Promise.resolve("done"),
        1000,
        "Too slow"
      );
      
      expect(result).toBe("done");
    });

    it("should throw on timeout", async () => {
      await expect(
        withTimeout(
          new Promise((resolve) => setTimeout(() => resolve("done"), 500)),
          100,
          "Operation timed out"
        )
      ).rejects.toThrow("Operation timed out");
    });
  });

  describe("CircuitBreaker", () => {
    it("should open after threshold failures", async () => {
      const breaker = new CircuitBreaker(3, 60000);
      
      for (let i = 0; i < 3; i++) {
        await expect(
          breaker.execute(async () => {
            throw new Error("Failure");
          })
        ).rejects.toThrow("Failure");
      }
      
      expect(breaker.getState()).toBe("open");
      
      await expect(
        breaker.execute(async () => "success")
      ).rejects.toThrow("Circuit breaker is open");
    });

    it("should close after success", async () => {
      const breaker = new CircuitBreaker(3, 60000);
      
      const result = await breaker.execute(async () => "success");
      expect(result).toBe("success");
      expect(breaker.getState()).toBe("closed");
    });
  });

  describe("analyzeFailure", () => {
    it("should recommend retry for retryable errors", () => {
      const strategy = analyzeFailure("ECONNRESET", {
        taskAttempts: 1,
        currentModel: "coder"
      });
      
      expect(strategy.strategy).toBe("retry");
    });

    it("should recommend fallback for OOM errors", () => {
      const strategy = analyzeFailure("out of memory error", {
        taskAttempts: 0,
        currentModel: "fallback"
      });
      
      expect(strategy.strategy).toBe("fallback_remote");
    });

    it("should recommend abort for non-retryable errors", () => {
      const strategy = analyzeFailure("SyntaxError in code", {
        taskAttempts: 0,
        currentModel: "coder"
      });
      
      expect(strategy.strategy).toBe("abort");
    });
  });
});

describe("Phase 7: Memory Cleanup", () => {
  const testDir = path.join(os.tmpdir(), `micro-claw-cleanup-test-${Date.now()}`);
  
  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
    mkdirSync(path.join(testDir, ".micro-claw", "sessions"), { recursive: true });
  });

  it("should calculate directory size", async () => {
    const { calculateDirectorySize, formatBytes } = await import("../src/observability/memory-cleanup.js");
    const testFile = path.join(testDir, "test.txt");
    writeFileSync(testFile, "x".repeat(2000));
    
    const size = calculateDirectorySize(testDir);
    
    expect(size).toBeGreaterThanOrEqual(2000);
    expect(formatBytes(size)).toMatch(/\d+\.\d+\s*(KB|MB)/);
  });

  it("should get storage info", () => {
    const info = getStorageInfo(testDir);
    
    expect(info.sessionsCount).toBe(0);
    expect(info.sessionsSize).toBe("0 B");
  });

  it("should cleanup old sessions by keeping limit", () => {
    const cleanupDir = path.join(testDir, "cleanup-test-keep");
    const sessionPath = path.join(cleanupDir, ".micro-claw", "sessions", "session-1");
    mkdirSync(sessionPath, { recursive: true });
    writeFileSync(path.join(sessionPath, "file.txt"), "test");
    
    const result = cleanupOldSessions(cleanupDir, { maxSessionsToKeep: 0 });
    
    expect(result.remainingSessions).toBe(0);
    expect(existsSync(sessionPath)).toBe(false);
  });
});

function createMockBenchmarkRun(passRate: number): any {
  const totalTasks = codingTaskCorpus.length;
  const passedTasks = Math.round(totalTasks * passRate);
  const startedAt = new Date().toISOString();
  const completedAt = new Date().toISOString();
  
  return {
    id: "test-run",
    runAt: startedAt,
    startedAt,
    completedAt,
    hardware: {
      machineType: "test",
      totalRamMb: 16384,
      cpuCores: 8
    },
    modelProfile: "test-model",
    runtimeMode: "local",
    contextSize: 4096,
    coldStartMs: 1000,
    warmStartMs: 100,
    firstTokenMs: 500,
    taskResults: codingTaskCorpus.map((task, i) => ({
      taskId: task.id,
      runAt: new Date().toISOString(),
      durationMs: 5000,
      success: i < passedTasks,
      toolCalls: 5,
      retries: 0,
      verificationResults: []
    })),
    summary: {
      totalTasks,
      passedTasks,
      failedTasks: totalTasks - passedTasks,
      passRate,
      avgDurationMs: 5000,
      avgToolCalls: 5,
      totalRetries: 0,
      categoryBreakdown: {
        "small-coding": {
          total: getSmallCodingTasks().length,
          passed: Math.round(getSmallCodingTasks().length * passRate),
          passRate
        },
        "medium-coding": {
          total: getMediumCodingTasks().length,
          passed: Math.round(getMediumCodingTasks().length * passRate),
          passRate
        },
        "repo-understanding": { total: 2, passed: 2, passRate: 1 },
        "repair-loop": { total: 1, passed: 1, passRate: 1 }
      }
    }
  };
}

function createBenchmarkResultsDir(suffix: string): string {
  const dir = path.join(os.tmpdir(), `micro-claw-benchmark-${suffix}-${Date.now()}-${Math.random()}`);
  mkdirSync(dir, { recursive: true });
  benchmarkTempDirs.push(dir);
  return dir;
}

function createEvalConfig(resultsDir: string, overrides: Partial<EvalConfig> = {}): EvalConfig {
  return {
    taskCorpusPath: path.join(process.cwd(), "src", "evals", "task-corpus.ts"),
    resultsDir,
    hardwareBaseline: {
      machineType: "test",
      totalRamMb: 8192,
      cpuCores: 4
    },
    modelProfile: "local-benchmark-profile",
    runtimeMode: "local",
    contextSize: 4096,
    timeoutSeconds: 30,
    ...overrides
  };
}

function createMockEvalTask(id: string): EvalTask {
  return {
    id,
    category: "small-coding",
    title: `Task ${id}`,
    description: `Task ${id}`,
    prompt: `Run task ${id}`,
    expectedOutcomes: [],
    verificationCriteria: [],
    timeoutSeconds: 30,
    difficulty: "easy"
  };
}

async function loadBenchmarkRunnerWithMocks(
  tasks: EvalTask[],
  runAgentLoop: ReturnType<typeof vi.fn>
) {
  vi.resetModules();
  vi.doMock("../src/evals/task-corpus.js", () => ({
    codingTaskCorpus: tasks
  }));
  vi.doMock("../src/orchestrator/agent-loop.js", () => ({
    runAgentLoop
  }));

  const benchmarkRunner = await import("../src/evals/benchmark-runner.js");
  return {
    ...benchmarkRunner,
    runAgentLoop
  };
}
