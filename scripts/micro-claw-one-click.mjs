import path from "node:path";
import process from "node:process";
import {
  REPO_ROOT,
  detectAvailableCommand,
  hasConfigFile,
  isDirectRun,
  pathExists,
  resolvePackageManagerCommand,
  runCommand
} from "./launcher-utils.mjs";

export async function runOneClick(argv = process.argv.slice(2)) {
  const packageManager = resolvePackageManagerCommand();
  const cliPath = path.join(REPO_ROOT, "dist", "cli.js");

  if (!(await pathExists(path.join(REPO_ROOT, "node_modules")))) {
    await runCommand(packageManager.command, [...packageManager.prefixArgs, "install"], {
      cwd: REPO_ROOT
    });
  }

  await runCommand(packageManager.command, [...packageManager.prefixArgs, "build"], {
    cwd: REPO_ROOT
  });

  if (!(await hasConfigFile(REPO_ROOT))) {
    await runCommand(process.execPath, [cliPath, "bootstrap", "--allow-direct"], {
      cwd: REPO_ROOT
    });
  }

  const secretgateCommand = detectAvailableCommand("secretgate");
  if (secretgateCommand) {
    await runCommand(secretgateCommand, ["wrap", "--", process.execPath, cliPath, "telegram-start", ...argv], {
      cwd: REPO_ROOT
    });
    return;
  }

  await runCommand(process.execPath, [cliPath, "telegram-start", ...argv], {
    cwd: REPO_ROOT
  });
}

if (isDirectRun(import.meta.url)) {
  runOneClick().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
