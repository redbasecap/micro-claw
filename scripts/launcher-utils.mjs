import { spawn, spawnSync } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
export const CONFIG_FILE_NAMES = [
  "micro-claw.config.yaml",
  "micro-claw.config.yml",
  "micro-claw.config.json"
];

export async function pathExists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function hasConfigFile(root = REPO_ROOT) {
  for (const fileName of CONFIG_FILE_NAMES) {
    if (await pathExists(path.join(root, fileName))) {
      return true;
    }
  }

  return false;
}

export function commandCandidates(command, platform = process.platform) {
  if (platform === "win32") {
    return [`${command}.cmd`, `${command}.exe`, command];
  }

  return [command];
}

export function detectAvailableCommand(command, { platform = process.platform, checkArgs = ["--help"] } = {}) {
  for (const candidate of commandCandidates(command, platform)) {
    const result = spawnSync(candidate, checkArgs, {
      stdio: "ignore"
    });

    if (!result.error || result.error.code !== "ENOENT") {
      return candidate;
    }
  }

  return null;
}

export function resolvePackageManagerCommand({
  platform = process.platform,
  detectCommand = (command, options) => detectAvailableCommand(command, options)
} = {}) {
  const pnpmCommand = detectCommand("pnpm", { platform });
  if (pnpmCommand) {
    return {
      command: pnpmCommand,
      prefixArgs: []
    };
  }

  const corepackCommand = detectCommand("corepack", { platform });
  if (corepackCommand) {
    return {
      command: corepackCommand,
      prefixArgs: ["pnpm"]
    };
  }

  throw new Error(
    "pnpm is required for the one-click launcher. Install pnpm or use Node.js 20.10+ with Corepack available."
  );
}

export async function runCommand(command, args, { cwd = REPO_ROOT, env = process.env } = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: "inherit"
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      if (signal) {
        reject(new Error(`Command was terminated by signal ${signal}: ${command} ${args.join(" ")}`));
        return;
      }

      reject(new Error(`Command failed with exit code ${code}: ${command} ${args.join(" ")}`));
    });
  });
}

export function isDirectRun(scriptUrl) {
  if (!process.argv[1]) {
    return false;
  }

  return path.resolve(process.argv[1]) === fileURLToPath(scriptUrl);
}

