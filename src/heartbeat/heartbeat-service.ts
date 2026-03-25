import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { HeartbeatRecord, MicroClawConfig } from "../core/types.js";
import { assertWithinRoot } from "../core/utils.js";
import { diagnoseProvider } from "../providers/provider-diagnostics.js";
import { routeTask } from "../router/model-router.js";
import { scanRepository } from "../scanner/repo-scanner.js";
import { inspectSecretgateBoundary } from "../security/secretgate-boundary.js";
import { ToolExecutor } from "../tools/tool-executor.js";
import { runVerification } from "../verifier/verification-runner.js";

export interface WriteHeartbeatOptions {
  root: string;
  config: MicroClawConfig;
  intervalSeconds: number;
  iteration: number;
  verify?: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface RunHeartbeatServiceOptions {
  root: string;
  config: MicroClawConfig;
  intervalSeconds?: number;
  verify?: boolean;
  once?: boolean;
  env?: NodeJS.ProcessEnv;
}

function resolveHeartbeatTarget(root: string, configuredPath: string): string {
  return assertWithinRoot(root, configuredPath);
}

function deriveHeartbeatStatus(record: Omit<HeartbeatRecord, "status" | "note">): {
  status: HeartbeatRecord["status"];
  note: string;
} {
  if (!record.boundary.ok) {
    return {
      status: "blocked",
      note: "Micro Claw is outside the required Secretgate boundary and should not be treated as safe."
    };
  }

  if (!record.provider.ok) {
    return {
      status: "degraded",
      note: "Secretgate is active, but the configured provider is not healthy."
    };
  }

  if (record.verification.status === "failed") {
    return {
      status: "degraded",
      note: "Secretgate is active, but repo verification is currently failing."
    };
  }

  if (record.verification.status === "skipped") {
    return {
      status: "healthy",
      note: "Secretgate is active and heartbeat checks passed. Verification was skipped for this cycle."
    };
  }

  return {
    status: "healthy",
    note: "Secretgate is active and the heartbeat cycle passed its verification checks."
  };
}

function formatHeartbeatMarkdown(record: HeartbeatRecord): string {
  return [
    "# Micro Claw Heartbeat",
    "",
    `Checked At: ${record.checkedAt}`,
    `Status: ${record.status}`,
    `PID: ${record.pid}`,
    `Iteration: ${record.iteration}`,
    `Interval Seconds: ${record.intervalSeconds}`,
    "",
    "## Secretgate",
    `- Active: ${record.boundary.ok ? "yes" : "no"}`,
    `- Message: ${record.boundary.message}`,
    `- Proxy: ${record.boundary.proxyUrl ?? "missing"}`,
    `- Certificate: ${record.boundary.certPath ?? "missing"}`,
    "",
    "## Provider",
    `- Healthy: ${record.provider.ok ? "yes" : "no"}`,
    `- Message: ${record.provider.message}`,
    "",
    "## Verification",
    `- Status: ${record.verification.status}`,
    `- Summary: ${record.verification.summary}`,
    ...record.verification.checks.map((check) => `- ${check.command}: ${check.ok ? "ok" : "failed"} (${check.durationMs} ms)`),
    "",
    "## Repo",
    `- Root: ${record.root}`,
    `- Files: ${record.repoSummary.fileCount}`,
    `- Build Commands: ${record.repoSummary.buildCommands.join(", ") || "none"}`,
    `- Test Commands: ${record.repoSummary.testCommands.join(", ") || "none"}`,
    `- Route: ${record.routerDecision.reason}`,
    "",
    "## Note",
    record.note,
    ""
  ].join("\n");
}

export async function writeHeartbeat(options: WriteHeartbeatOptions): Promise<HeartbeatRecord> {
  const heartbeatFile = resolveHeartbeatTarget(options.root, options.config.security.heartbeatFile);
  const heartbeatJsonFile = resolveHeartbeatTarget(options.root, options.config.security.heartbeatJsonFile);
  const repoSummary = await scanRepository(options.root);
  const provider = await diagnoseProvider(options.config);
  const boundary = inspectSecretgateBoundary(options.config, options.env);
  const routerDecision = routeTask(options.config, repoSummary, "maintain secure heartbeat");
  const verification =
    options.verify === true
      ? await runVerification(new ToolExecutor(options.root, options.config), repoSummary)
      : {
          status: "skipped" as const,
          checks: [],
          summary: "Heartbeat verification skipped for this cycle."
        };

  const baseRecord = {
    checkedAt: new Date().toISOString(),
    root: options.root,
    iteration: options.iteration,
    pid: process.pid,
    intervalSeconds: options.intervalSeconds,
    boundary,
    provider,
    repoSummary,
    routerDecision,
    verification,
    heartbeatFile,
    heartbeatJsonFile
  };

  const derived = deriveHeartbeatStatus(baseRecord);
  const record: HeartbeatRecord = {
    ...baseRecord,
    status: derived.status,
    note: derived.note
  };

  await mkdir(path.dirname(heartbeatFile), { recursive: true });
  await mkdir(path.dirname(heartbeatJsonFile), { recursive: true });
  await writeFile(heartbeatFile, formatHeartbeatMarkdown(record), "utf8");
  await writeFile(heartbeatJsonFile, `${JSON.stringify(record, null, 2)}\n`, "utf8");

  return record;
}

async function sleepWithStop(ms: number, shouldStop: () => boolean): Promise<void> {
  if (ms <= 0) {
    return;
  }

  const stepMs = 250;
  let remaining = ms;

  while (remaining > 0 && !shouldStop()) {
    const slice = Math.min(stepMs, remaining);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, slice);
    });
    remaining -= slice;
  }
}

export async function runHeartbeatService(options: RunHeartbeatServiceOptions): Promise<HeartbeatRecord> {
  const intervalSeconds = options.intervalSeconds ?? options.config.security.defaultHeartbeatIntervalSeconds;
  let iteration = 1;
  let stopRequested = false;
  let lastRecord: HeartbeatRecord | undefined;

  const onStop = () => {
    stopRequested = true;
  };

  process.on("SIGINT", onStop);
  process.on("SIGTERM", onStop);

  try {
    do {
      lastRecord = await writeHeartbeat({
        root: options.root,
        config: options.config,
        intervalSeconds,
        iteration,
        verify: options.verify,
        env: options.env
      });

      if (options.once) {
        return lastRecord;
      }

      iteration += 1;
      await sleepWithStop(intervalSeconds * 1_000, () => stopRequested);
    } while (!stopRequested);
  } finally {
    process.off("SIGINT", onStop);
    process.off("SIGTERM", onStop);
  }

  if (!lastRecord) {
    throw new Error("Heartbeat service stopped before writing a heartbeat.");
  }

  return lastRecord;
}
