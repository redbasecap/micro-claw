import type { EvalTask } from "./types.js";

export const codingTaskCorpus: EvalTask[] = [
  {
    id: "small-rename-symbol",
    category: "small-coding",
    title: "Rename a symbol across files",
    description: "Rename a function or variable consistently across a codebase",
    prompt: "Rename the function 'getConfig' to 'loadConfiguration' in all TypeScript files. Use case-sensitive search.",
    expectedOutcomes: ["Function renamed in all occurrences", "No syntax errors introduced"],
    verificationCriteria: [
      { type: "command-exit-zero", command: "grep -r 'getConfig' --include='*.ts' | wc -l", pattern: "0", description: "No remaining 'getConfig' references" },
      { type: "command-exit-zero", command: "grep -r 'loadConfiguration' --include='*.ts' | wc -l", pattern: "[1-9]", description: "New name exists" },
      { type: "command-exit-zero", command: "pnpm build 2>&1 || npm run build 2>&1 || echo 'no build script'", pattern: "error", description: "No build errors" }
    ],
    timeoutSeconds: 120,
    difficulty: "easy"
  },
  {
    id: "small-add-config-flag",
    category: "small-coding",
    title: "Add a configuration flag",
    description: "Add a new boolean config option to an existing config structure",
    prompt: "Add a new boolean config option called 'enableDebugMode' with default value 'false' to the config file.",
    expectedOutcomes: ["Config option added", "Type correctly defined"],
    verificationCriteria: [
      { type: "file-matches", path: "micro-claw.config.yaml", pattern: "enableDebugMode", description: "Config key exists" },
      { type: "command-exit-zero", command: "node -e \"const c = require('./dist/config/config-loader.js'); console.log('ok')\" 2>&1 || echo 'no local config loader'", pattern: "error", description: "Config loads without errors" }
    ],
    timeoutSeconds: 120,
    difficulty: "easy"
  },
  {
    id: "small-fix-readme-link",
    category: "small-coding",
    title: "Fix a broken link in README",
    description: "Update an outdated or broken link in the documentation",
    prompt: "Find and fix any broken relative links in README.md that point to non-existent files.",
    expectedOutcomes: ["Broken links fixed or noted", "Documentation updated"],
    verificationCriteria: [
      { type: "command-exit-zero", command: "grep -o '\\[.*\\]\\([^)]*\\.md\\)' README.md 2>/dev/null || echo 'no links'", pattern: "\\[.*\\]\\([^)]*\\.md\\)", description: "Links are valid markdown" }
    ],
    timeoutSeconds: 60,
    difficulty: "easy"
  },
  {
    id: "medium-add-feature-flag",
    category: "medium-coding",
    title: "Add a feature flag with environment support",
    description: "Add a feature flag that can be toggled via environment variables",
    setup: "Ensure .env.micro-claw exists",
    prompt: "Add a feature flag called 'ENABLE_TELEGRAM' to the config system. It should read from environment variable TELEGRAM_ENABLED if set, otherwise use the config file value. Default to false.",
    expectedOutcomes: ["Feature flag works via env var", "Config file value is fallback"],
    verificationCriteria: [
      { type: "file-matches", path: "src/config/config-loader.ts", pattern: "TELEGRAM_ENABLED", description: "Env var handling exists" },
      { type: "file-matches", path: "micro-claw.config.yaml", pattern: "telegram.*enabled", description: "Config key exists" }
    ],
    timeoutSeconds: 300,
    difficulty: "medium"
  },
  {
    id: "medium-update-docs",
    category: "medium-coding",
    title: "Update documentation with code changes",
    description: "Update relevant docs when adding a new feature",
    prompt: "Add a section to docs/architecture.md explaining the new feature flag system.",
    expectedOutcomes: ["Documentation updated", "Consistent with code"],
    verificationCriteria: [
      { type: "file-matches", path: "docs/architecture.md", pattern: "feature.*flag|feature flag", description: "Feature flag docs exist" },
      { type: "command-exit-zero", command: "head -1 docs/architecture.md", pattern: ".", description: "Doc file exists and is readable" }
    ],
    timeoutSeconds: 180,
    difficulty: "medium"
  },
  {
    id: "medium-fix-test",
    category: "medium-coding",
    title: "Fix a failing test",
    description: "Fix a test that is failing due to changed behavior",
    prompt: "Run the tests and fix any failing tests. Focus on test assertions that need updating to match the current implementation.",
    expectedOutcomes: ["Tests pass", "Behavior preserved"],
    verificationCriteria: [
      { type: "command-exit-zero", command: "pnpm test 2>&1", pattern: "Test Files.*passed|0 failed", description: "All tests pass" }
    ],
    timeoutSeconds: 300,
    difficulty: "medium"
  },
  {
    id: "repair-parse-error",
    category: "repair-loop",
    title: "Recover from parse error",
    description: "The agent should detect a JSON parse error and recover gracefully",
    prompt: "Inject an invalid JSON file at test/invalid.json with content '{ invalid }' and then try to read and fix it.",
    expectedOutcomes: ["Error detected", "Graceful recovery", "File fixed or removed"],
    verificationCriteria: [
      { type: "file-matches", path: "test/invalid.json", pattern: '"valid":\\s*true', description: "File fixed or removed" }
    ],
    timeoutSeconds: 180,
    difficulty: "medium"
  },
  {
    id: "repair-timeout",
    category: "repair-loop",
    title: "Handle command timeout",
    description: "The agent should handle commands that timeout and retry with smaller scope",
    prompt: "Create a script that sleeps for 60 seconds. Run it with a 5 second timeout. The agent should detect the timeout, kill the process, and explain what happened.",
    expectedOutcomes: ["Timeout detected", "Process cleaned up", "Explanation provided"],
    verificationCriteria: [
      { type: "command-exit-zero", command: "ps aux | grep -E 'sleep.*60' | grep -v grep | wc -l", pattern: "0", description: "No zombie processes" },
      { type: "no-error-in-output", pattern: "timeout|signal|SIGTERM", description: "Timeout was handled gracefully" }
    ],
    timeoutSeconds: 300,
    difficulty: "hard"
  },
  {
    id: "repo-understanding-scan",
    category: "repo-understanding",
    title: "Repository scan and summary",
    description: "Scan the repository and produce a structural summary",
    prompt: "Scan this repository and produce a summary of: framework, package manager, entry points, test commands, and important modules.",
    expectedOutcomes: ["Framework identified", "Package manager detected", "Commands found"],
    verificationCriteria: [
      { type: "command-exit-zero", command: "node dist/cli.js scan --json 2>&1 | head -100", pattern: "packageManager|framework|testCommand", description: "Scan produces structured output" }
    ],
    timeoutSeconds: 120,
    difficulty: "easy"
  },
  {
    id: "repo-understanding-commands",
    category: "repo-understanding",
    title: "Discover build and test commands",
    description: "Find and verify executable commands in the project",
    prompt: "Discover all build and test commands available in this project by examining package.json and scripts.",
    expectedOutcomes: ["Build commands found", "Test commands found", "Commands are executable"],
    verificationCriteria: [
      { type: "command-exit-zero", command: "cat package.json | grep -E '\"(build|test)\"' | wc -l", pattern: "[1-9]", description: "Build/test scripts exist" }
    ],
    timeoutSeconds: 60,
    difficulty: "easy"
  }
];

export function getCorpusByCategory(category: EvalTask["category"]): EvalTask[] {
  return codingTaskCorpus.filter((task) => task.category === category);
}

export function getCorpusByDifficulty(difficulty: EvalTask["difficulty"]): EvalTask[] {
  return codingTaskCorpus.filter((task) => task.difficulty === difficulty);
}

export function getSmallCodingTasks(): EvalTask[] {
  return getCorpusByCategory("small-coding");
}

export function getMediumCodingTasks(): EvalTask[] {
  return getCorpusByCategory("medium-coding");
}

export function getRepairLoopTasks(): EvalTask[] {
  return getCorpusByCategory("repair-loop");
}

export function getRepoUnderstandingTasks(): EvalTask[] {
  return getCorpusByCategory("repo-understanding");
}
