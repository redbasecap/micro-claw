import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { RepoSummary } from "../core/types.js";
import { compact, unique, toErrorMessage } from "../core/utils.js";

const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".micro-claw",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo"
]);

async function walkFiles(root: string, currentDir = root, files: string[] = []): Promise<string[]> {
  const entries = await readdir(currentDir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORIES.has(entry.name)) {
        await walkFiles(root, path.join(currentDir, entry.name), files);
      }
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    files.push(path.relative(root, path.join(currentDir, entry.name)));
  }

  return files;
}

function detectPackageManager(files: string[]): string | undefined {
  if (files.includes("pnpm-lock.yaml")) {
    return "pnpm";
  }

  if (files.includes("yarn.lock")) {
    return "yarn";
  }

  if (files.includes("package-lock.json")) {
    return "npm";
  }

  if (files.includes("bun.lock") || files.includes("bun.lockb")) {
    return "bun";
  }

  if (files.includes("package.json")) {
    return "npm";
  }

  return undefined;
}

function detectStacks(files: string[]): string[] {
  const stacks = compact([
    files.includes("package.json") ? "node" : undefined,
    files.some((file) => file.endsWith(".ts") || file === "tsconfig.json") ? "typescript" : undefined,
    files.includes("pyproject.toml") || files.includes("requirements.txt") ? "python" : undefined,
    files.includes("Cargo.toml") ? "rust" : undefined,
    files.includes("go.mod") ? "go" : undefined,
    files.includes("pom.xml") ? "java" : undefined,
    files.every((file) => file.startsWith("docs/") || file.endsWith(".md")) ? "docs-first" : undefined
  ]);

  return unique(stacks);
}

function detectEntryPoints(files: string[]): string[] {
  const preferred = [
    "src/index.ts",
    "src/main.ts",
    "src/cli.ts",
    "src/cli/index.ts",
    "index.ts",
    "main.ts",
    "package.json",
    "README.md"
  ];

  return preferred.filter((file) => files.includes(file));
}

function scoreImportantFile(filePath: string): number {
  const basename = path.basename(filePath);
  let score = 0;

  if (basename === "package.json" || basename === "README.md" || basename === "tsconfig.json") {
    score += 30;
  }

  if (filePath.startsWith("src/")) {
    score += 20;
  }

  if (filePath.includes("config") || filePath.includes("cli") || filePath.includes("orchestrator")) {
    score += 10;
  }

  if (filePath.startsWith("docs/")) {
    score += 5;
  }

  score -= filePath.length / 100;
  return score;
}

async function readPackageScripts(root: string): Promise<Record<string, string>> {
  try {
    const source = await readFile(path.join(root, "package.json"), "utf8");
    const parsed = JSON.parse(source) as { scripts?: Record<string, string> };
    return parsed.scripts ?? {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }

    throw error;
  }
}

function prefixScript(packageManager: string | undefined, script: string): string {
  switch (packageManager) {
    case "pnpm":
      return `pnpm ${script}`;
    case "yarn":
      return `yarn ${script}`;
    case "bun":
      return `bun run ${script}`;
    case "npm":
    default:
      return `npm run ${script}`;
  }
}

function deriveCommands(packageManager: string | undefined, scripts: Record<string, string>, files: string[]) {
  const buildCommands: string[] = [];
  const testCommands: string[] = [];

  for (const scriptName of ["build", "check", "typecheck"]) {
    if (scripts[scriptName]) {
      buildCommands.push(prefixScript(packageManager, scriptName));
    }
  }

  for (const scriptName of ["test", "lint"]) {
    if (scripts[scriptName]) {
      testCommands.push(prefixScript(packageManager, scriptName));
    }
  }

  if (buildCommands.length === 0 && files.includes("Cargo.toml")) {
    buildCommands.push("cargo build");
  }

  if (testCommands.length === 0 && files.includes("Cargo.toml")) {
    testCommands.push("cargo test");
  }

  if (buildCommands.length === 0 && files.includes("go.mod")) {
    buildCommands.push("go build ./...");
  }

  if (testCommands.length === 0 && files.includes("go.mod")) {
    testCommands.push("go test ./...");
  }

  if (buildCommands.length === 0 && files.includes("pyproject.toml")) {
    buildCommands.push("python -m build");
  }

  if (testCommands.length === 0 && (files.includes("pyproject.toml") || files.includes("requirements.txt"))) {
    testCommands.push("pytest");
  }

  return {
    buildCommands: unique(buildCommands),
    testCommands: unique(testCommands)
  };
}

export async function scanRepository(root: string): Promise<RepoSummary> {
  const files = (await walkFiles(root)).sort();
  const packageManager = detectPackageManager(files);
  const detectedStacks = detectStacks(files);
  const scripts = await readPackageScripts(root);
  const commands = deriveCommands(packageManager, scripts, files);
  const topLevelDirectories = unique(
    files
      .filter((file) => file.includes("/"))
      .map((file) => file.split("/")[0])
      .filter((segment) => segment.length > 0)
  ).sort();

  const importantFiles = [...files]
    .sort((left, right) => scoreImportantFile(right) - scoreImportantFile(left))
    .slice(0, 10);

  const notes = compact([
    detectedStacks.includes("docs-first")
      ? "Repository currently looks documentation-heavy, so coding entrypoints may need to be created."
      : undefined,
    packageManager ? `Detected package manager: ${packageManager}.` : "No package manager detected from lockfiles.",
    commands.buildCommands.length > 0
      ? `Discovered build checks: ${commands.buildCommands.join(", ")}.`
      : "No build command was discovered automatically.",
    commands.testCommands.length > 0
      ? `Discovered test checks: ${commands.testCommands.join(", ")}.`
      : "No test command was discovered automatically."
  ]);

  return {
    root,
    fileCount: files.length,
    packageManager,
    detectedStacks,
    entryPoints: detectEntryPoints(files),
    buildCommands: commands.buildCommands,
    testCommands: commands.testCommands,
    importantFiles,
    topLevelDirectories,
    notes
  };
}

export function summarizeScanError(error: unknown): string {
  return `Repo scan failed: ${toErrorMessage(error)}`;
}
