export interface AuditEvent {
  id: string;
  timestamp: string;
  sessionId?: string;
  taskId?: string;
  eventType: AuditEventType;
  severity: AuditSeverity;
  message: string;
  metadata?: Record<string, unknown>;
  error?: string;
  durationMs?: number;
}

export type AuditEventType =
  | "session_start"
  | "session_end"
  | "task_start"
  | "task_end"
  | "task_retry"
  | "task_timeout"
  | "tool_call"
  | "tool_success"
  | "tool_failure"
  | "model_switch"
  | "memory_pressure"
  | "remote_fallback"
  | "verification_start"
  | "verification_pass"
  | "verification_fail"
  | "error_recovery"
  | "config_change"
  | "memory_cleanup";

export type AuditSeverity = "debug" | "info" | "warn" | "error" | "critical";

export interface AuditLogOptions {
  logDir: string;
  maxLogSizeMb: number;
  maxLogFiles: number;
  includeMetadata: boolean;
  redactSensitive: boolean;
}

export interface ObservabilityMetrics {
  timestamp: string;
  sessionId?: string;
  tasks: {
    total: number;
    completed: number;
    failed: number;
    retried: number;
    timedOut: number;
  };
  tools: {
    total: number;
    successful: number;
    failed: number;
    byType: Record<string, { total: number; successful: number; failed: number }>;
  };
  models: {
    switches: number;
    usedProfiles: Record<string, number>;
    remoteFallbacks: number;
  };
  memory: {
    avgUsedMb: number;
    peakUsedMb: number;
    pressureEvents: number;
  };
  performance: {
    avgTaskDurationMs: number;
    totalDurationMs: number;
    firstTokenLatencyMs: number;
  };
  errors: {
    total: number;
    byType: Record<string, number>;
  };
}

export interface RecoveryStrategy {
  strategy: "retry" | "fallback_model" | "fallback_remote" | "simplify_task" | "abort";
  reason: string;
  nextAction?: string;
  maxRetries?: number;
}

export interface TimeoutConfig {
  commandTimeoutMs: number;
  taskTimeoutMs: number;
  modelTimeoutMs: number;
  cleanupTimeoutMs: number;
}

export interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
  retryableErrors: string[];
}
