import { readFile, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import type { MicroClawConfig, OllamaProfileSetup, OllamaSetupResult } from "../core/types.js";
import { unique } from "../core/utils.js";
import { listOllamaModels } from "../providers/chat-provider.js";
import { runShellCommand } from "../tools/shell-tool.js";

export interface RunOllamaSetupOptions {
  root: string;
  config: MicroClawConfig;
  includeFallback?: boolean;
  startServerIfNeeded?: boolean;
  dryRun?: boolean;
}

function shellQuote(value: string): string {
  return JSON.stringify(value);
}

export function parseBaseModelFromModelfileSource(source: string): string {
  const line = source
    .split(/\r?\n/g)
    .map((part) => part.trim())
    .find((part) => part.startsWith("FROM "));

  if (!line) {
    throw new Error("Modelfile is missing a FROM line.");
  }

  return line.slice("FROM ".length).trim();
}

async function readProfileFromModelfile(name: string, modelfilePath: string): Promise<OllamaProfileSetup> {
  const source = await readFile(modelfilePath, "utf8");
  return {
    name,
    baseModel: parseBaseModelFromModelfileSource(source),
    modelfilePath
  };
}

async function resolveProfiles(root: string): Promise<OllamaProfileSetup[]> {
  return Promise.all([
    readProfileFromModelfile("micro-claw-planner", path.join(root, "examples", "planner.Modelfile")),
    readProfileFromModelfile("micro-claw-coder", path.join(root, "examples", "coder.Modelfile"))
  ]);
}

async function isOllamaReachable(config: MicroClawConfig): Promise<boolean> {
  try {
    const response = await fetch(`${config.provider.ollamaHost}/api/tags`, {
      signal: AbortSignal.timeout(2_500)
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForOllama(config: MicroClawConfig, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await isOllamaReachable(config)) {
      return true;
    }

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 500);
    });
  }

  return false;
}

async function startOllamaServe(root: string): Promise<void> {
  const logDir = path.join(root, ".micro-claw");
  await mkdir(logDir, { recursive: true });

  const child = spawn(process.env.SHELL || "/bin/sh", ["-lc", `ollama serve >> ${shellQuote(path.join(logDir, "ollama-serve.log"))} 2>&1`], {
    cwd: root,
    detached: true,
    stdio: "ignore",
    env: process.env
  });

  child.unref();
}

async function runCheckedCommand(command: string, root: string): Promise<string> {
  const result = await runShellCommand({
    command,
    cwd: root,
    timeoutMs: 60 * 60 * 1_000,
    outputLimit: 48_000
  });

  if (result.exitCode !== 0) {
    throw new Error(
      `Command failed: ${command}\n${result.stdout}\n${result.stderr}`.trim()
    );
  }

  return `${result.stdout}${result.stderr}`.trim();
}

export async function runOllamaSetup(options: RunOllamaSetupOptions): Promise<OllamaSetupResult> {
  const versionOutput = await runCheckedCommand("ollama -v", options.root);
  const profiles = await resolveProfiles(options.root);
  let startedServer = false;
  let serverReachable = await isOllamaReachable(options.config);

  if (!serverReachable && options.startServerIfNeeded !== false) {
    await startOllamaServe(options.root);
    startedServer = true;
    serverReachable = await waitForOllama(options.config, 15_000);
  }

  if (!serverReachable) {
    throw new Error(
      `Ollama is not reachable at ${options.config.provider.ollamaHost}. Start Ollama and rerun the setup command.`
    );
  }

  const pulledModels: string[] = [];
  const createdProfiles: string[] = [];
  const baseModels = unique(profiles.map((profile) => profile.baseModel));

  if (options.includeFallback) {
    baseModels.push(options.config.profiles.fallback);
  }

  const uniqueBaseModels = unique(baseModels);

  if (options.dryRun) {
    const availableModels = serverReachable ? await listOllamaModels(options.config) : [];
    return {
      ollamaVersion: versionOutput,
      serverReachable,
      startedServer,
      pulledModels: uniqueBaseModels,
      createdProfiles: profiles.map((profile) => profile.name),
      availableModels: availableModels.map((model) => model.name),
      skippedFallback: !options.includeFallback,
      dryRun: true
    };
  }

  for (const model of uniqueBaseModels) {
    await runCheckedCommand(`ollama pull ${shellQuote(model)}`, options.root);
    pulledModels.push(model);
  }

  for (const profile of profiles) {
    await runCheckedCommand(
      `ollama create ${shellQuote(profile.name)} -f ${shellQuote(profile.modelfilePath)}`,
      options.root
    );
    createdProfiles.push(profile.name);
  }

  const availableModels = await listOllamaModels(options.config);

  return {
    ollamaVersion: versionOutput,
    serverReachable,
    startedServer,
    pulledModels,
    createdProfiles,
    availableModels: availableModels.map((model) => model.name),
    skippedFallback: !options.includeFallback,
    dryRun: false
  };
}
