import type { MicroClawConfig, RepoSummary, RouterDecision, TaskPlan } from "../core/types.js";
import { compact, extractTaskKeywords, unique } from "../core/utils.js";

function selectNeededContext(task: string, repoSummary: RepoSummary): string[] {
  const keywords = extractTaskKeywords(task);
  const matches = repoSummary.importantFiles.filter((file) =>
    keywords.some((keyword) => file.toLowerCase().includes(keyword))
  );

  return unique([...matches, ...repoSummary.importantFiles]).slice(0, 6);
}

function inferTaskKind(task: string): "docs" | "code" | "analysis" {
  if (/\b(doc|readme|document|explain|architecture)\b/i.test(task)) {
    return "docs";
  }

  if (/\b(scan|plan|inspect|analyze|understand)\b/i.test(task)) {
    return "analysis";
  }

  return "code";
}

export function createDeterministicPlan(
  task: string,
  repoSummary: RepoSummary,
  routerDecision: RouterDecision,
  config: MicroClawConfig
): TaskPlan {
  const taskKind = inferTaskKind(task);
  const neededContext = selectNeededContext(task, repoSummary);
  const verificationPlan =
    repoSummary.buildCommands.length + repoSummary.testCommands.length > 0
      ? [...repoSummary.buildCommands, ...repoSummary.testCommands].slice(0, 3)
      : ["Report the verification gap explicitly because no project command was discovered."];

  return {
    taskSummary: task.trim(),
    constraints: compact([
      "Stay inside the current repository root.",
      "Prefer focused patches over broad rewrites.",
      config.security.requireSecretgate ? "Remain inside the required Secretgate proxy boundary." : undefined,
      config.runtime.mode === "remote"
        ? "Do not wake local inference while remote minimum-RAM mode is active."
        : "Keep the local model profile constrained to one active heavyweight model at a time."
    ]),
    assumptions: compact([
      repoSummary.fileCount === 0 ? "The repository is empty or fully ignored." : undefined,
      taskKind === "code" ? "The task likely ends in a focused diff plus verification evidence." : undefined,
      routerDecision.runtimeMode === "remote"
        ? "A hosted provider will be used when inference is needed."
        : "Local planning and coding profiles will be preferred."
    ]),
    neededContext,
    nextAction:
      neededContext.length > 0
        ? `Inspect ${neededContext.slice(0, 3).join(", ")} before changing files.`
        : "Inspect the top-level project files before changing anything.",
    expectedResult:
      taskKind === "docs"
        ? "A scoped documentation update with matching repo references."
        : taskKind === "analysis"
          ? "A compact repo summary and an ordered execution plan."
          : "A minimal code change plus verification evidence.",
    steps: [
      {
        id: "scan",
        action: "Inspect the relevant project files and confirm the execution surface.",
        successSignal: "The target files and commands are identified."
      },
      {
        id: "patch",
        action:
          taskKind === "analysis"
            ? "Record the plan and safe next actions without changing unrelated files."
            : "Apply the smallest viable patch for the task.",
        successSignal: "The diff matches the requested outcome."
      },
      {
        id: "verify",
        action: "Run the most relevant discovered build or test command.",
        successSignal: "Checks pass or the remaining gap is explicit."
      }
    ],
    verificationPlan,
    stopCondition: "Stop when the requested outcome exists and the verification state is explicit."
  };
}
