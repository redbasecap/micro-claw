#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { REPO_ROOT, isDirectRun, pathExists, runCommand } from "./launcher-utils.mjs";

const HYPERAGENTS_URL = "https://github.com/quantumnic/HyperAgents-Locally.git";

function parseArgs(argv) {
  const flags = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }

    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      flags[key] = true;
      continue;
    }

    flags[key] = next;
    index += 1;
  }

  return flags;
}

function timestampId() {
  return new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

async function findLatestAssistantEval() {
  const evalDir = path.join(REPO_ROOT, ".micro-claw", "evals", "assistant");
  if (!(await pathExists(evalDir))) {
    return undefined;
  }

  const files = (await readdir(evalDir))
    .filter((file) => file.startsWith("assistant-run-") && file.endsWith(".json"))
    .sort();
  const latest = files.at(-1);
  return latest ? path.join(evalDir, latest) : undefined;
}

async function ensureHyperAgentsRepo(repoPath, clone) {
  if (await pathExists(repoPath)) {
    return;
  }

  if (!clone) {
    throw new Error(`HyperAgents-Locally repo not found at ${repoPath}. Rerun with --clone or clone ${HYPERAGENTS_URL}.`);
  }

  const parent = path.dirname(repoPath);
  await mkdir(parent, { recursive: true });
  await runCommand("git", ["clone", HYPERAGENTS_URL, repoPath], { cwd: parent });
}

async function packageAssistantEval({ repoPath, model, runInstall }) {
  const latestEval = await findLatestAssistantEval();
  if (!latestEval) {
    throw new Error("No assistant eval artifact found. Run `pnpm local:ollama -- --command assistant-eval --model qwen3:4b` first.");
  }

  const packageDir = path.join(REPO_ROOT, ".micro-claw", "hyperagents", `package-${timestampId()}`);
  await mkdir(packageDir, { recursive: true });

  const evalSource = await readFile(latestEval, "utf8");
  const evalJson = JSON.parse(evalSource);
  const summary = {
    source: latestEval,
    packagedAt: new Date().toISOString(),
    model,
    passRate: evalJson.summary?.passRate,
    totalTasks: evalJson.summary?.totalTasks,
    failedTasks: evalJson.summary?.failedTasks,
    taskResults: evalJson.taskResults?.map((task) => ({
      taskId: task.taskId,
      passed: task.passed,
      missingPatterns: task.missingPatterns
    }))
  };

  await writeFile(path.join(packageDir, "assistant-eval.json"), evalSource, "utf8");
  await writeFile(path.join(packageDir, "assistant-eval-summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  await writeFile(
    path.join(packageDir, "hyperagents.env"),
    [
      "OLLAMA_BASE_URL=http://localhost:11434",
      "LLAMACPP_BASE_URL=http://localhost:8080",
      `MODEL_NAME=${model}`,
      ""
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    path.join(packageDir, "README.md"),
    [
      "# Micro Claw Assistant Eval Package",
      "",
      "This package is safe input for HyperAgents-Locally experiments.",
      "Do not run reset/clean-based HyperAgents loops inside the Micro Claw repository.",
      "",
      "## Files",
      "",
      "- `assistant-eval.json` full Micro Claw assistant eval run",
      "- `assistant-eval-summary.json` compact result summary",
      "- `hyperagents.env` local model environment hints",
      "",
      "## Suggested HyperAgents Commands",
      "",
      "```bash",
      `cd ${repoPath}`,
      "bash install.sh",
      "source venv/bin/activate",
      `python python/comms/loop.py --task free --topic ${JSON.stringify(`Improve Micro Claw assistant behavior using eval package ${packageDir}`)} --model ${model}`,
      "```",
      ""
    ].join("\n"),
    "utf8"
  );

  if (runInstall) {
    await runCommand("bash", ["install.sh"], { cwd: repoPath });
  }

  return packageDir;
}

export async function main(argv = process.argv.slice(2)) {
  const flags = parseArgs(argv);
  const repoPath = path.resolve(
    REPO_ROOT,
    typeof flags.repo === "string" ? flags.repo : "../HyperAgents-Locally"
  );
  const model = typeof flags.model === "string" ? flags.model : "ollama/qwen3:4b";

  await ensureHyperAgentsRepo(repoPath, flags.clone === true);
  const packageDir = await packageAssistantEval({
    repoPath,
    model,
    runInstall: flags.install === true
  });

  const command = [
    `cd ${repoPath}`,
    "source venv/bin/activate",
    `python python/comms/loop.py --task free --topic ${JSON.stringify(`Improve Micro Claw assistant behavior using eval package ${packageDir}`)} --model ${model}`
  ].join("\n");

  process.stdout.write(
    [
      `Packaged assistant eval for HyperAgents-Locally: ${packageDir}`,
      "",
      "Run this HyperAgents command:",
      command,
      ""
    ].join("\n")
  );
}

if (isDirectRun(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
