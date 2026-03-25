import path from "node:path";
import process from "node:process";
import {
  REPO_ROOT,
  detectAvailableCommand,
  isDirectRun,
  pathExists,
  runCommand
} from "./launcher-utils.mjs";

export async function runSafe(argv = process.argv.slice(2)) {
  const cliPath = path.join(REPO_ROOT, "dist", "cli.js");
  if (!(await pathExists(cliPath))) {
    throw new Error("dist/cli.js is missing. Run 'pnpm build' first.");
  }

  const secretgateCommand = detectAvailableCommand("secretgate");
  if (!secretgateCommand) {
    throw new Error("secretgate is not installed or not on PATH.");
  }

  await runCommand(secretgateCommand, ["wrap", "--", process.execPath, cliPath, ...argv], {
    cwd: REPO_ROOT
  });
}

if (isDirectRun(import.meta.url)) {
  runSafe().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
