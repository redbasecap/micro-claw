import path from "node:path";
import { pathExists } from "../core/utils.js";
import { runShellCommand } from "./shell-tool.js";

export async function isGitRepository(root: string): Promise<boolean> {
  return pathExists(path.join(root, ".git"));
}

export async function getGitStatus(root: string, timeoutMs: number, outputLimit: number) {
  return runShellCommand({
    command: "git status --short",
    cwd: root,
    timeoutMs,
    outputLimit
  });
}

export async function getGitDiff(root: string, timeoutMs: number, outputLimit: number) {
  return runShellCommand({
    command: "git diff --stat",
    cwd: root,
    timeoutMs,
    outputLimit
  });
}
