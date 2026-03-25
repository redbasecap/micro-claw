import type { MicroClawConfig, RepoSummary, RouterDecision } from "../core/types.js";

function scoreComplexity(task: string, repoSummary: RepoSummary): number {
  let score = 0;

  if (repoSummary.fileCount > 250) {
    score += 1;
  }

  if (repoSummary.fileCount > 1_000) {
    score += 1;
  }

  if (repoSummary.detectedStacks.length > 2) {
    score += 1;
  }

  if (/\b(refactor|multi|across|feature|migration|architecture|runtime)\b/i.test(task)) {
    score += 1;
  }

  return score;
}

export function routeTask(config: MicroClawConfig, repoSummary: RepoSummary, task: string): RouterDecision {
  if (config.runtime.mode === "remote") {
    const remoteModel = config.provider.model || config.profiles.coder;

    return {
      runtimeMode: "remote",
      providerKind: config.provider.kind,
      plannerModel: remoteModel,
      coderModel: remoteModel,
      fallbackModel: remoteModel,
      reason: "Remote mode is active, so routing stays on the hosted provider to minimize local RAM."
    };
  }

  const complexity = scoreComplexity(task, repoSummary);
  const coderModel = complexity >= 3 ? config.profiles.fallback : config.profiles.coder;

  return {
    runtimeMode: "local",
    providerKind: "ollama",
    plannerModel: config.profiles.planner,
    coderModel,
    fallbackModel: config.profiles.fallback,
    reason:
      complexity >= 3
        ? "The repo or task looks multi-file, so the coder role is escalated to the max-32 fallback profile."
        : "The task looks focused enough for the balanced local coder profile."
  };
}
