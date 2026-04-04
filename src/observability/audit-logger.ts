import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AuditEvent, AuditEventType, AuditLogOptions, AuditSeverity, ObservabilityMetrics } from "./types.js";
import { timestampId } from "../core/utils.js";

const DEFAULT_OPTIONS: AuditLogOptions = {
  logDir: ".micro-claw/audit",
  maxLogSizeMb: 10,
  maxLogFiles: 5,
  includeMetadata: true,
  redactSensitive: true
};

const SENSITIVE_PATTERNS = [
  /api[_-]?key/i,
  /password/i,
  /token/i,
  /secret/i,
  /bearer/i,
  /auth/i
];

export class AuditLogger {
  private readonly options: AuditLogOptions;
  private readonly logFile: string;
  private eventCount = 0;

  constructor(options: Partial<AuditLogOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.logFile = path.join(this.options.logDir, `audit-${new Date().toISOString().split("T")[0]}.jsonl`);
    this.ensureLogDir();
  }

  private ensureLogDir(): void {
    if (!existsSync(this.options.logDir)) {
      mkdirSync(this.options.logDir, { recursive: true });
    }
  }

  log(
    eventType: AuditEventType,
    message: string,
    severity: AuditSeverity = "info",
    metadata?: Record<string, unknown>
  ): void {
    const event: AuditEvent = {
      id: timestampId(),
      timestamp: new Date().toISOString(),
      eventType,
      severity,
      message: this.redactSensitive(message),
      metadata: this.options.includeMetadata ? this.redactMetadata(metadata) : undefined
    };

    this.writeEvent(event);
    this.eventCount++;
    
    if (severity === "error" || severity === "critical") {
      console.error(`[AUDIT ${severity.toUpperCase()}] ${eventType}: ${message}`);
    } else if (severity === "warn") {
      console.warn(`[AUDIT WARN] ${eventType}: ${message}`);
    }
  }

  private redactSensitive(text: string): string {
    if (!this.options.redactSensitive) return text;
    
    let result = text;
    for (const pattern of SENSITIVE_PATTERNS) {
      result = result.replace(pattern, "[REDACTED]");
    }
    return result;
  }

  private redactMetadata(metadata?: Record<string, unknown>): Record<string, unknown> | undefined {
    if (!metadata || !this.options.redactSensitive) return metadata;
    
    const redacted: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(metadata)) {
      if (SENSITIVE_PATTERNS.some((p) => p.test(key))) {
        redacted[key] = "[REDACTED]";
      } else if (typeof value === "object" && value !== null) {
        redacted[key] = this.redactMetadata(value as Record<string, unknown>);
      } else {
        redacted[key] = value;
      }
    }
    return redacted;
  }

  private writeEvent(event: AuditEvent): void {
    try {
      appendFileSync(this.logFile, JSON.stringify(event) + "\n", "utf8");
      this.rotateLogsIfNeeded();
    } catch (error) {
      console.error("Failed to write audit event:", error);
    }
  }

  private rotateLogsIfNeeded(): void {
    try {
      const stats = statSync(this.logFile);
      const sizeMb = stats.size / (1024 * 1024);
      
      if (sizeMb > this.options.maxLogSizeMb) {
        const archiveName = `${this.logFile.replace(".jsonl", "")}-${timestampId()}.jsonl`;
        const { renameSync } = require("node:fs");
        renameSync(this.logFile, archiveName);
        this.cleanupOldLogs();
      }
    } catch {
      // File might not exist yet, ignore
    }
  }

  private cleanupOldLogs(): void {
    try {
      const files = readdirSync(this.options.logDir)
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => ({
          name: f,
          path: path.join(this.options.logDir, f),
          time: statSync(path.join(this.options.logDir, f)).mtime.getTime()
        }))
        .sort((a, b) => b.time - a.time);

      for (let i = this.options.maxLogFiles; i < files.length; i++) {
        unlinkSync(files[i].path);
      }
    } catch {
      // Ignore cleanup errors
    }
  }

  getEventCount(): number {
    return this.eventCount;
  }

  getLogFile(): string {
    return this.logFile;
  }
}

let globalAuditLogger: AuditLogger | undefined;

export function getAuditLogger(): AuditLogger {
  if (!globalAuditLogger) {
    globalAuditLogger = new AuditLogger();
  }
  return globalAuditLogger;
}

export function initAuditLogger(options?: Partial<AuditLogOptions>): AuditLogger {
  globalAuditLogger = new AuditLogger(options);
  return globalAuditLogger;
}

export function logSessionStart(sessionId: string, metadata?: Record<string, unknown>): void {
  getAuditLogger().log("session_start", `Session ${sessionId} started`, "info", metadata);
}

export function logSessionEnd(sessionId: string, durationMs: number, metadata?: Record<string, unknown>): void {
  getAuditLogger().log("session_end", `Session ${sessionId} ended after ${durationMs}ms`, "info", { ...metadata, durationMs });
}

export function logTaskStart(taskId: string, prompt: string, metadata?: Record<string, unknown>): void {
  getAuditLogger().log("task_start", `Task ${taskId} started`, "info", { ...metadata, promptLength: prompt.length });
}

export function logTaskEnd(taskId: string, success: boolean, durationMs: number, metadata?: Record<string, unknown>): void {
  getAuditLogger().log(
    success ? "task_end" : "task_timeout",
    `Task ${taskId} ${success ? "completed" : "failed/timeout"} in ${durationMs}ms`,
    success ? "info" : "warn",
    metadata
  );
}

export function logToolCall(tool: string, success: boolean, durationMs: number, metadata?: Record<string, unknown>): void {
  getAuditLogger().log(
    success ? "tool_success" : "tool_failure",
    `Tool ${tool} ${success ? "succeeded" : "failed"} in ${durationMs}ms`,
    success ? "debug" : "warn",
    metadata
  );
}

export function logMemoryPressure(level: string, usedPercent: number, metadata?: Record<string, unknown>): void {
  getAuditLogger().log(
    "memory_pressure",
    `Memory pressure ${level} (${usedPercent.toFixed(0)}% used)`,
    level === "critical" || level === "high" ? "warn" : "info",
    metadata
  );
}

export function logModelSwitch(fromModel: string, toModel: string, reason: string): void {
  getAuditLogger().log("model_switch", `Switched from ${fromModel} to ${toModel}: ${reason}`, "info", {
    fromModel,
    toModel,
    reason
  });
}

export function logErrorRecovery(error: string, strategy: string, metadata?: Record<string, unknown>): void {
  getAuditLogger().log("error_recovery", `Recovering from error: ${error} using strategy: ${strategy}`, "warn", metadata);
}
