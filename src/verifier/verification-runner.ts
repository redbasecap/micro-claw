import type { RepoSummary, VerificationCheck, VerificationResult } from "../core/types.js";
import { unique } from "../core/utils.js";
import { ToolExecutor } from "../tools/tool-executor.js";

export function discoverVerificationCommands(repoSummary: RepoSummary): string[] {
  const ordered = [
    ...repoSummary.buildCommands,
    ...repoSummary.testCommands
  ];

  return unique(ordered).slice(0, 3);
}

export async function runVerification(
  executor: ToolExecutor,
  repoSummary: RepoSummary
): Promise<VerificationResult> {
  const commands = discoverVerificationCommands(repoSummary);

  if (commands.length === 0) {
    return {
      status: "skipped",
      checks: [],
      summary: "No verification command was discovered automatically."
    };
  }

  const checks: VerificationCheck[] = [];

  for (const command of commands) {
    const result = await executor.execute({
      tool: "shell",
      input: { command }
    });

    const shellResult = result.data as
      | {
          exitCode: number | null;
          stdout: string;
          stderr: string;
          durationMs: number;
        }
      | undefined;

    checks.push({
      command,
      ok: result.ok && shellResult?.exitCode === 0,
      exitCode: shellResult?.exitCode ?? null,
      output: `${shellResult?.stdout ?? ""}${shellResult?.stderr ?? ""}`.trim(),
      durationMs: shellResult?.durationMs ?? result.durationMs
    });

    if (!result.ok || shellResult?.exitCode !== 0) {
      return {
        status: "failed",
        checks,
        summary: `Verification failed on: ${command}`
      };
    }
  }

  return {
    status: "passed",
    checks,
    summary: `Verification passed with ${checks.length} command${checks.length === 1 ? "" : "s"}.`
  };
}
