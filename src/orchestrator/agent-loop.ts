import type { AgentRunResult, MicroClawConfig } from "../core/types.js";
import { extractTaskKeywords } from "../core/utils.js";
import { SessionStore } from "../memory/session-store.js";
import { createDeterministicPlan } from "../planner/deterministic-planner.js";
import { routeTask } from "../router/model-router.js";
import { scanRepository } from "../scanner/repo-scanner.js";
import { inspectSecretgateBoundary } from "../security/secretgate-boundary.js";
import { isGitRepository } from "../tools/git-tool.js";
import { ToolExecutor } from "../tools/tool-executor.js";
import { runVerification } from "../verifier/verification-runner.js";

export interface RunAgentLoopOptions {
  root: string;
  task: string;
  config: MicroClawConfig;
  verify?: boolean;
}

export async function runAgentLoop(options: RunAgentLoopOptions): Promise<AgentRunResult> {
  const session = await SessionStore.create(options.root, options.task);
  const secretgateBoundary = inspectSecretgateBoundary(options.config);
  const repoSummary = await scanRepository(options.root);
  const routerDecision = routeTask(options.config, repoSummary, options.task);
  const plan = createDeterministicPlan(options.task, repoSummary, routerDecision, options.config);
  const executor = new ToolExecutor(options.root, options.config);
  const toolResults = [];

  await session.writeJson("secretgate-boundary.json", secretgateBoundary);
  await session.writeJson("repo-summary.json", repoSummary);
  await session.writeJson("router-decision.json", routerDecision);
  await session.writeJson("plan.json", plan);
  await session.appendEvent({ type: "plan", createdAt: new Date().toISOString(), task: options.task });

  if (await isGitRepository(options.root)) {
    const gitStatus = await executor.execute({
      tool: "git_status",
      input: {}
    });

    toolResults.push(gitStatus);
    await session.appendEvent({
      type: "tool",
      tool: gitStatus.tool,
      ok: gitStatus.ok,
      createdAt: new Date().toISOString()
    });
  }

  const searchKeyword = extractTaskKeywords(options.task)[0];
  if (searchKeyword) {
    const searchResult = await executor.execute({
      tool: "search",
      input: {
        query: searchKeyword,
        maxResults: 8
      }
    });

    toolResults.push(searchResult);
    await session.appendEvent({
      type: "tool",
      tool: searchResult.tool,
      ok: searchResult.ok,
      createdAt: new Date().toISOString(),
      query: searchKeyword
    });
  }

  const verification =
    options.verify === false
      ? {
          status: "skipped" as const,
          checks: [],
          summary: "Verification was skipped by the caller."
        }
      : await runVerification(executor, repoSummary);

  await session.writeJson("tool-results.json", toolResults);
  await session.writeJson("verification.json", verification);

  const result: AgentRunResult = {
    sessionId: session.sessionId,
    sessionDir: session.sessionDir,
    task: options.task,
    secretgateBoundary,
    repoSummary,
    routerDecision,
    plan,
    toolResults,
    verification,
    outcome: verification.status === "failed" ? "blocked" : "done",
    completedAt: new Date().toISOString()
  };

  await session.writeJson("result.json", result);
  await session.writeText(
    "summary.md",
    [
      `# Session ${result.sessionId}`,
      "",
      `Task: ${result.task}`,
      `Outcome: ${result.outcome}`,
      `Verification: ${result.verification.summary}`,
      "",
      "## Next Action",
      result.plan.nextAction,
      "",
      "## Verification Plan",
      ...result.plan.verificationPlan.map((item) => `- ${item}`)
    ].join("\n")
  );

  return result;
}
