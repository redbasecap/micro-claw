import { spawn } from "node:child_process";
import type { ShellCommandResult } from "../core/types.js";
import { truncate } from "../core/utils.js";

const DANGEROUS_COMMANDS = [
  /\bgit\s+reset\s+--hard\b/,
  /\brm\s+-rf\s+\/\b/,
  /\bmkfs\b/,
  /\bshutdown\b/,
  /\breboot\b/
];

interface RunShellCommandOptions {
  command: string;
  cwd: string;
  timeoutMs: number;
  outputLimit: number;
  allowDestructive?: boolean;
}

export async function runShellCommand(options: RunShellCommandOptions): Promise<ShellCommandResult> {
  if (!options.allowDestructive && DANGEROUS_COMMANDS.some((pattern) => pattern.test(options.command))) {
    throw new Error(`Blocked destructive command: ${options.command}`);
  }

  const shell = process.env.SHELL || "/bin/sh";
  const startedAt = Date.now();
  let stdout = "";
  let stderr = "";
  let timedOut = false;

  return new Promise<ShellCommandResult>((resolve, reject) => {
    const child = spawn(shell, ["-lc", options.command], {
      cwd: options.cwd,
      env: {
        ...process.env,
        FORCE_COLOR: "0"
      }
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) {
          child.kill("SIGKILL");
        }
      }, 2_000).unref();
    }, options.timeoutMs);

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
      stdout = truncate(stdout, options.outputLimit);
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
      stderr = truncate(stderr, options.outputLimit);
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolve({
        command: options.command,
        cwd: options.cwd,
        exitCode,
        signal,
        stdout,
        stderr,
        timedOut,
        durationMs: Date.now() - startedAt
      });
    });
  });
}
