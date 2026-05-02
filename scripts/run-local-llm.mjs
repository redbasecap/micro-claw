#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, open, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  REPO_ROOT,
  detectAvailableCommand,
  isDirectRun,
  pathExists,
  resolvePackageManagerCommand,
  runCommand
} from "./launcher-utils.mjs";

function parseArgs(argv) {
  const flags = {};
  const positionals = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      positionals.push(token);
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

  return { flags, positionals };
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function expandHome(value) {
  if (!value) {
    return value;
  }

  if (value === "~") {
    return process.env.HOME ?? value;
  }

  if (value.startsWith("~/")) {
    return path.join(process.env.HOME ?? "~", value.slice(2));
  }

  return value;
}

function configForOllama(model, host) {
  return [
    "runtime:",
    "  mode: local",
    "  stream: true",
    "",
    "provider:",
    "  kind: ollama",
    `  model: ${model}`,
    `  ollama_host: ${host}`,
    "",
    "profiles:",
    `  planner: ${model}`,
    `  coder: ${model}`,
    `  fallback: ${model}`,
    "",
    "assistant:",
    "  enabled: true",
    `  reply_model: ${model}`,
    `  memory_model: ${model}`,
    `  briefing_model: ${model}`,
    `  repo_delegation_model: ${model}`,
    "  enable_memory_curation: true",
    "  enable_proactive_briefings: true",
    "",
    "security:",
    "  require_secretgate: false",
    "",
    "telegram:",
    "  enabled: true",
    ""
  ].join("\n");
}

function configForLlamaCpp(model, port) {
  return [
    "runtime:",
    "  mode: remote",
    "  stream: false",
    "",
    "provider:",
    "  kind: openai-compatible",
    `  model: ${model}`,
    `  base_url: http://127.0.0.1:${port}/v1/chat/completions`,
    "  api_key_env: LLAMACPP_API_KEY",
    "",
    "profiles:",
    `  planner: ${model}`,
    `  coder: ${model}`,
    `  fallback: ${model}`,
    "",
    "assistant:",
    "  enabled: true",
    `  reply_model: ${model}`,
    `  memory_model: ${model}`,
    `  briefing_model: ${model}`,
    `  repo_delegation_model: ${model}`,
    "  enable_memory_curation: true",
    "  enable_proactive_briefings: true",
    "",
    "security:",
    "  require_secretgate: false",
    "",
    "telegram:",
    "  enabled: true",
    ""
  ].join("\n");
}

async function ensureBuild() {
  if (await pathExists(path.join(REPO_ROOT, "dist", "cli.js"))) {
    return;
  }

  const pm = resolvePackageManagerCommand();
  await runCommand(pm.command, [...pm.prefixArgs, "build"], { cwd: REPO_ROOT });
}

async function waitForHttp(url, timeoutMs = 20_000) {
  const started = Date.now();
  let lastError;

  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(`Timed out waiting for ${url}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function ensureOllama(model, host, shouldPull) {
  const ollama = detectAvailableCommand("ollama", { checkArgs: ["--version"] });
  if (!ollama) {
    throw new Error("ollama was not found. Install Ollama or use --provider llamacpp.");
  }

  try {
    await waitForHttp(`${host}/api/tags`, 2_000);
  } catch {
    const logDir = path.join(REPO_ROOT, ".micro-claw", "logs");
    await mkdir(logDir, { recursive: true });
    spawn(process.env.SHELL || "/bin/sh", ["-lc", `${ollama} serve >> ${shellQuote(path.join(logDir, "ollama-serve.log"))} 2>&1`], {
      cwd: REPO_ROOT,
      detached: true,
      stdio: "ignore"
    }).unref();
    await waitForHttp(`${host}/api/tags`, 20_000);
  }

  if (shouldPull) {
    await runCommand(ollama, ["pull", model], { cwd: REPO_ROOT });
  }
}

function isEnabledFlag(value) {
  return value === true || value === "1" || value === "true" || value === "yes";
}

async function startLlamaCppServer({ gguf, port, ctx, ngl, verboseServer }) {
  const server = detectAvailableCommand("llama-server", { checkArgs: ["--help"] });
  if (!server) {
    throw new Error("llama-server was not found. Install llama.cpp, then rerun this command.");
  }

  const modelPath = path.resolve(expandHome(gguf));
  const args = ["-m", modelPath, "--host", "127.0.0.1", "--port", String(port), "-c", String(ctx), "-ngl", String(ngl)];
  const logDir = path.join(REPO_ROOT, ".micro-claw", "logs");
  await mkdir(logDir, { recursive: true });
  const logPath = path.join(logDir, `llama-server-${port}.log`);
  const logHandle = verboseServer ? undefined : await open(logPath, "a");
  const child = spawn(server, args, {
    cwd: REPO_ROOT,
    stdio: verboseServer ? ["ignore", "inherit", "inherit"] : ["ignore", logHandle.fd, logHandle.fd]
  });

  child.on("exit", (code) => {
    void logHandle?.close();
    if (code !== 0 && code !== null) {
      process.stderr.write(`llama-server exited with code ${code}\n`);
    }
  });
  child.on("error", () => {
    void logHandle?.close();
  });

  if (!verboseServer) {
    process.stdout.write(`llama-server logs: ${logPath}\n`);
  }

  await waitForHttp(`http://127.0.0.1:${port}/v1/models`, 45_000);
  return child;
}

async function writeRuntimeConfig(provider, source) {
  const runtimeDir = path.join(REPO_ROOT, ".micro-claw", "runtime");
  await mkdir(runtimeDir, { recursive: true });
  const configPath = path.join(runtimeDir, `local-${provider}.yaml`);
  await writeFile(configPath, source, "utf8");
  return configPath;
}

async function runMicroClaw({ configPath, command, prompt, chatId, model, runtime }) {
  const env = {
    ...process.env,
    NODE_OPTIONS: "",
    LLAMACPP_API_KEY: process.env.LLAMACPP_API_KEY || "local"
  };

  const args =
    command === "assistant-eval"
      ? ["dist/cli.js", "assistant-eval", "--config", configPath, "--model", model, "--runtime", runtime, "--json"]
      : ["dist/cli.js", command, ...(prompt ? [prompt] : []), "--config", configPath, "--chat-id", chatId];

  await runCommand(process.execPath, args, { cwd: REPO_ROOT, env });
}

export async function main(argv = process.argv.slice(2)) {
  const { flags } = parseArgs(argv);
  const provider = flags.provider === "llamacpp" ? "llamacpp" : "ollama";
  const command = typeof flags.command === "string" ? flags.command : "assistant-tui";
  const prompt = typeof flags.prompt === "string" ? flags.prompt : undefined;
  const chatId = typeof flags["chat-id"] === "string" ? flags["chat-id"] : "local-tui";
  const port = typeof flags.port === "string" ? Number.parseInt(flags.port, 10) : 8080;
  const ctx = typeof flags.ctx === "string" ? Number.parseInt(flags.ctx, 10) : 8192;
  const ngl = typeof flags.ngl === "string" ? Number.parseInt(flags.ngl, 10) : 99;
  const verboseServer = isEnabledFlag(flags["verbose-server"]);
  let serverProcess;

  await ensureBuild();

  if (provider === "ollama") {
    const model = typeof flags.model === "string" ? flags.model : "qwen3:4b";
    const host = typeof flags.host === "string" ? flags.host : "http://127.0.0.1:11434";
    await ensureOllama(model, host, flags["no-pull"] !== true);
    const configPath = await writeRuntimeConfig("ollama", configForOllama(model, host));
    await runMicroClaw({ configPath, command, prompt, chatId, model, runtime: "local" });
    return;
  }

  const gguf = typeof flags.gguf === "string" ? flags.gguf : process.env.LLAMACPP_GGUF;
  if (!gguf) {
    throw new Error("llama.cpp mode requires --gguf ~/models/model.gguf or LLAMACPP_GGUF.");
  }

  const model = typeof flags.model === "string" ? flags.model : "local-gguf";
  if (flags["no-server"] !== true) {
    serverProcess = await startLlamaCppServer({ gguf, port, ctx, ngl, verboseServer });
  }

  try {
    const configPath = await writeRuntimeConfig("llamacpp", configForLlamaCpp(model, port));
    await runMicroClaw({ configPath, command, prompt, chatId, model, runtime: "remote" });
  } finally {
    serverProcess?.kill("SIGTERM");
  }
}

if (isDirectRun(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
