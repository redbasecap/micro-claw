import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "os";
import {
  AuditLogger,
  initAuditLogger,
  logSessionStart,
  logSessionEnd,
  logTaskStart,
  logTaskEnd,
  logToolCall,
  logMemoryPressure,
  logModelSwitch,
  logErrorRecovery
} from "../src/observability/audit-logger";
import {
  cleanupOldSessions,
  getStorageInfo,
  getMemoryMetrics,
  writeMetricsSnapshot
} from "../src/observability/memory-cleanup";
import {
  analyzeFailure,
  withRetry,
  withTimeout,
  CircuitBreaker,
  isRetryableError,
  computeRetryDelay
} from "../src/observability/failure-recovery";

describe("Observability Module", () => {
  const testDir = path.join(os.tmpdir(), `micro-claw-obs-test-${Date.now()}`);
  
  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
    mkdirSync(path.join(testDir, ".micro-claw", "sessions"), { recursive: true });
    mkdirSync(path.join(testDir, ".micro-claw", "audit"), { recursive: true });
  });
  
  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });

  describe("AuditLogger", () => {
    it("should create and use audit logger", () => {
      const logger = new AuditLogger({ logDir: path.join(testDir, ".micro-claw", "audit") });
      
      logger.log("session_start", "Test session started", "info");
      logger.log("tool_call", "shell executed", "debug");
      
      expect(existsSync(logger.getLogFile())).toBe(true);
    });

    it("should redact sensitive data", () => {
      const logger = new AuditLogger({
        logDir: path.join(testDir, ".micro-claw", "audit"),
        redactSensitive: true
      });
      
      logger.log("config_change", "Setting changed", "info", { api_key: "secret123", password: "pass456" });
      
      const content = readFileSync(logger.getLogFile(), "utf-8");
      expect(content).not.toContain("secret123");
      expect(content).not.toContain("pass456");
    });

    it("should track event count", () => {
      const logger = new AuditLogger({ logDir: path.join(testDir, ".micro-claw", "audit") });
      
      logger.log("session_start", "First event", "info");
      logger.log("session_end", "Second event", "debug");
      
      expect(logger.getEventCount()).toBe(2);
    });
  });

  describe("Audit Helper Functions", () => {
    it("should log session start", () => {
      const logger = initAuditLogger({ logDir: path.join(testDir, ".micro-claw", "audit") });
      
      logSessionStart("test-session-123", { userId: "user1" });
      
      const content = readFileSync(logger.getLogFile(), "utf-8");
      expect(content).toContain("session_start");
      expect(content).toContain("test-session-123");
    });

    it("should log task events", () => {
      const logger = initAuditLogger({ logDir: path.join(testDir, ".micro-claw", "audit") });
      
      logTaskStart("task-1", "Fix the bug", { priority: "high" });
      logTaskEnd("task-1", true, 5000);
      
      const content = readFileSync(logger.getLogFile(), "utf-8");
      expect(content).toContain("task_start");
      expect(content).toContain("task_end");
    });

    it("should log memory pressure", () => {
      const logger = initAuditLogger({ logDir: path.join(testDir, ".micro-claw", "audit") });
      
      logMemoryPressure("high", 85.5);
      
      const content = readFileSync(logger.getLogFile(), "utf-8");
      expect(content).toContain("memory_pressure");
    });

    it("should log model switches", () => {
      const logger = initAuditLogger({ logDir: path.join(testDir, ".micro-claw", "audit") });
      
      logModelSwitch("micro-claw-coder", "micro-claw-fallback", "Memory pressure increased");
      
      const content = readFileSync(logger.getLogFile(), "utf-8");
      expect(content).toContain("model_switch");
      expect(content).toContain("micro-claw-coder");
    });
  });

  describe("Memory Cleanup", () => {
    it("should get storage info for empty sessions", () => {
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

    it("should respect max sessions to keep", () => {
      for (let i = 0; i < 10; i++) {
        const sessionPath = path.join(testDir, ".micro-claw", "sessions", `session-${i}`);
        mkdirSync(sessionPath);
        writeFileSync(path.join(sessionPath, "file.txt"), `session-${i}`);
        const timestamp = new Date(Date.now() - (10 - i) * 60_000);
        utimesSync(sessionPath, timestamp, timestamp);
      }
      
      const result = cleanupOldSessions(testDir, {
        maxSessionAgeHours: Number.POSITIVE_INFINITY,
        maxSessionsToKeep: 3
      });
      
      expect(result.remainingSessions).toBe(3);
      expect(existsSync(path.join(testDir, ".micro-claw", "sessions", "session-0"))).toBe(false);
      expect(existsSync(path.join(testDir, ".micro-claw", "sessions", "session-6"))).toBe(false);
      expect(existsSync(path.join(testDir, ".micro-claw", "sessions", "session-7"))).toBe(true);
      expect(existsSync(path.join(testDir, ".micro-claw", "sessions", "session-9"))).toBe(true);
    });
  });

  describe("Failure Recovery", () => {
    it("should identify retryable errors", () => {
      expect(isRetryableError("ECONNRESET", { retryableErrors: ["ECONNRESET"], maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 30000, backoffMultiplier: 2 })).toBe(true);
      expect(isRetryableError("SyntaxError", { retryableErrors: ["ECONNRESET"], maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 30000, backoffMultiplier: 2 })).toBe(false);
    });

    it("should compute exponential backoff delay", () => {
      const delay1 = computeRetryDelay(0, { retryableErrors: [], maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 30000, backoffMultiplier: 2 });
      const delay2 = computeRetryDelay(1, { retryableErrors: [], maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 30000, backoffMultiplier: 2 });
      const delay3 = computeRetryDelay(2, { retryableErrors: [], maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 30000, backoffMultiplier: 2 });
      
      expect(delay1).toBe(1000);
      expect(delay2).toBe(2000);
      expect(delay3).toBe(4000);
    });

    it("should not exceed max delay", () => {
      const delay = computeRetryDelay(10, { retryableErrors: [], maxRetries: 10, baseDelayMs: 1000, maxDelayMs: 10000, backoffMultiplier: 2 });
      
      expect(delay).toBeLessThanOrEqual(10000);
    });

    it("should analyze failure and recommend retry", () => {
      const strategy = analyzeFailure("ECONNRESET", {
        taskAttempts: 1,
        currentModel: "coder"
      });
      
      expect(strategy.strategy).toBe("retry");
      expect(strategy.maxRetries).toBeDefined();
    });

    it("should analyze failure and recommend fallback for OOM", () => {
      const strategy = analyzeFailure("out of memory", {
        taskAttempts: 0,
        currentModel: "fallback"
      });
      
      expect(strategy.strategy).toBe("fallback_remote");
    });

    it("should analyze failure and recommend abort for unknown errors", () => {
      const strategy = analyzeFailure("Unknown error xyz", {
        taskAttempts: 0,
        currentModel: "coder"
      });
      
      expect(strategy.strategy).toBe("abort");
    });

    it("should retry successfully after transient failure", async () => {
      let attempts = 0;
      
      const result = await withRetry(async () => {
        attempts++;
        if (attempts < 2) {
          throw new Error("ECONNRESET");
        }
        return "success";
      });
      
      expect(result).toBe("success");
      expect(attempts).toBe(2);
    });

    it("should timeout long operations", async () => {
      await expect(
        withTimeout(
          new Promise((resolve) => setTimeout(() => resolve("done"), 500)),
          50,
          "Custom timeout"
        )
      ).rejects.toThrow("Custom timeout");
    });

    it("should complete before timeout", async () => {
      const result = await withTimeout(
        Promise.resolve("done"),
        1000,
        "Should not timeout"
      );
      
      expect(result).toBe("done");
    });

    it("should open circuit breaker after failures", async () => {
      const breaker = new CircuitBreaker(2, 60000);
      
      for (let i = 0; i < 2; i++) {
        try {
          await breaker.execute(async () => {
            throw new Error("Fail");
          });
        } catch {}
      }
      
      expect(breaker.getState()).toBe("open");
    });

    it("should reset circuit breaker after success", async () => {
      const breaker = new CircuitBreaker(2, 60000);
      
      await breaker.execute(async () => "success");
      
      expect(breaker.getState()).toBe("closed");
    });
  });
});
