import type { RecoveryStrategy, RetryConfig, TimeoutConfig } from "./types.js";
import { logErrorRecovery, getAuditLogger } from "./audit-logger.js";

const DEFAULT_TIMEOUT_CONFIG: TimeoutConfig = {
  commandTimeoutMs: 30_000,
  taskTimeoutMs: 300_000,
  modelTimeoutMs: 60_000,
  cleanupTimeoutMs: 5_000
};

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30_000,
  backoffMultiplier: 2,
  retryableErrors: [
    "ECONNRESET",
    "ECONNREFUSED",
    "ETIMEDOUT",
    "NETWORK_ERROR",
    "timeout",
    "fetch failed",
    "Connection failed",
    " Ollama process not found",
    "model not loaded"
  ]
};

export function isRetryableError(error: string, config: RetryConfig): boolean {
  return config.retryableErrors.some(
    (pattern) => error.toLowerCase().includes(pattern.toLowerCase())
  );
}

export function computeRetryDelay(attempt: number, config: RetryConfig): number {
  const delay = config.baseDelayMs * Math.pow(config.backoffMultiplier, attempt);
  return Math.min(delay, config.maxDelayMs);
}

export function analyzeFailure(
  error: string,
  context: {
    taskAttempts: number;
    currentModel: string;
    memoryPressure?: string;
    lastToolResult?: { tool: string; ok: boolean };
  }
): RecoveryStrategy {
  if (isRetryableError(error, DEFAULT_RETRY_CONFIG)) {
    if (context.taskAttempts < DEFAULT_RETRY_CONFIG.maxRetries) {
      const delay = computeRetryDelay(context.taskAttempts, DEFAULT_RETRY_CONFIG);
      return {
        strategy: "retry",
        reason: `Retryable error detected: ${error}`,
        nextAction: `Retry after ${delay}ms delay`,
        maxRetries: DEFAULT_RETRY_CONFIG.maxRetries - context.taskAttempts
      };
    } else {
      return {
        strategy: "fallback_remote",
        reason: "Max retries exceeded, falling back to remote mode",
        nextAction: "Switch to remote API provider"
      };
    }
  }

  if (error.includes("out of memory") || error.includes("OOM") || context.memoryPressure === "critical") {
    return {
      strategy: "fallback_remote",
      reason: "Out of memory or critical memory pressure",
      nextAction: "Switch to remote mode to reduce local memory load"
    };
  }

  if (error.includes("model") && error.includes("not found")) {
    return {
      strategy: "fallback_model",
      reason: "Model not available, falling back to planner profile",
      nextAction: "Use smaller/fallback model"
    };
  }

  if (context.lastToolResult && !context.lastToolResult.ok) {
    return {
      strategy: "simplify_task",
      reason: `Last tool ${context.lastToolResult.tool} failed, simplifying approach`,
      nextAction: "Break down task into smaller steps"
    };
  }

  return {
    strategy: "abort",
    reason: `Non-recoverable error: ${error}`,
    nextAction: "Report failure to user"
  };
}

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutError: string
): Promise<T> {
  let timeoutHandle: NodeJS.Timeout;
  
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(timeoutError));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutHandle!);
  }
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  config: Partial<RetryConfig> = {},
  onRetry?: (attempt: number, delay: number, error: string) => void
): Promise<T> {
  const cfg = { ...DEFAULT_RETRY_CONFIG, ...config };
  let lastError: string = "";
  
  for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      
      if (!isRetryableError(lastError, cfg) || attempt === cfg.maxRetries) {
        throw error;
      }
      
      const delay = computeRetryDelay(attempt, cfg);
      logErrorRecovery(lastError, "retry");
      
      if (onRetry) {
        onRetry(attempt + 1, delay, lastError);
      }
      
      await sleep(delay);
    }
  }
  
  throw new Error(lastError);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class CircuitBreaker {
  private failures = 0;
  private lastFailureTime = 0;
  private state: "closed" | "open" | "half-open" = "closed";

  constructor(
    private readonly failureThreshold: number = 5,
    private readonly resetTimeoutMs: number = 60_000
  ) {}

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === "open") {
      const timeSinceLastFailure = Date.now() - this.lastFailureTime;
      if (timeSinceLastFailure < this.resetTimeoutMs) {
        throw new Error("Circuit breaker is open");
      }
      this.state = "half-open";
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess(): void {
    this.failures = 0;
    this.state = "closed";
  }

  private onFailure(): void {
    this.failures++;
    this.lastFailureTime = Date.now();
    
    if (this.failures >= this.failureThreshold) {
      this.state = "open";
      getAuditLogger().log(
        "error_recovery",
        `Circuit breaker opened after ${this.failures} failures`,
        "warn",
        { failureThreshold: this.failureThreshold }
      );
    }
  }

  getState(): string {
    return this.state;
  }

  reset(): void {
    this.failures = 0;
    this.state = "closed";
  }
}

export function createFailureRecoveryHandler(
  options: {
    timeoutConfig?: Partial<TimeoutConfig>;
    retryConfig?: Partial<RetryConfig>;
  } = {}
) {
  const timeoutConfig = { ...DEFAULT_TIMEOUT_CONFIG, ...options.timeoutConfig };
  const retryConfig = { ...DEFAULT_RETRY_CONFIG, ...options.retryConfig };
  const circuitBreaker = new CircuitBreaker();

  return {
    withTimeout: <T>(promise: Promise<T>, timeoutMs?: number, timeoutError?: string) =>
      withTimeout(promise, timeoutMs ?? timeoutConfig.taskTimeoutMs, timeoutError ?? "Operation timed out"),
    
    withRetry: <T>(fn: () => Promise<T>, onRetry?: (attempt: number, delay: number, error: string) => void) =>
      withRetry(fn, retryConfig, onRetry),
    
    analyzeFailure: (error: string, context: Parameters<typeof analyzeFailure>[1]) =>
      analyzeFailure(error, context),
    
    executeWithCircuitBreaker: <T>(fn: () => Promise<T>) =>
      circuitBreaker.execute(fn),
    
    getTimeoutConfig: () => timeoutConfig,
    getRetryConfig: () => retryConfig
  };
}
