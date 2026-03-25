import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SkillScaffoldResult } from "../core/types.js";
import { assertWithinRoot, slugify } from "../core/utils.js";

export interface SkillReferenceFile {
  name: string;
  content: string;
}

export interface SkillScriptFile {
  name: string;
  content: string;
  executable?: boolean;
}

export interface CreateSkillScaffoldOptions {
  root: string;
  name: string;
  description?: string;
  instructions?: string;
  references?: SkillReferenceFile[];
  scripts?: SkillScriptFile[];
}

function escapeYamlString(value: string): string {
  return JSON.stringify(value);
}

function defaultSkillDescription(name: string): string {
  return `Use when the user asks for ${name.toLowerCase()} work and a focused workflow would help.`;
}

function defaultSkillBody(name: string): string {
  return [
    `# ${name}`,
    "",
    "Use this skill when the task clearly matches this domain.",
    "",
    "## Workflow",
    "",
    "1. Inspect the relevant local files and inputs first.",
    "2. Keep changes focused and grounded in the current repo.",
    "3. Verify the result with the smallest relevant check.",
    "",
    "## Notes",
    "",
    "- Add domain-specific references in `references/` when needed.",
    "- Add deterministic helpers in `scripts/` only when repetition or reliability justifies them.",
    "- Shell-driven skills can use helpers that call `cd`, `curl`, `grep`, `rg`, and pipes."
  ].join("\n");
}

export function createShellHelperAssets(name: string): Pick<
  CreateSkillScaffoldOptions,
  "instructions" | "references" | "scripts"
> {
  const slug = slugify(name) || "shell-helper";

  return {
    instructions: [
      `# ${name}`,
      "",
      "Use this skill when the task needs a repeatable shell workflow.",
      "",
      "## Workflow",
      "",
      "1. Confirm the target folder, URL, file pattern, and expected output.",
      "2. Use the shell tool with either `cwd` or `cd <dir> && ...` when work must happen in another folder.",
      "3. Use `curl` for HTTP checks and `grep` or `rg` for focused matching.",
      "4. Keep reusable command sequences in `scripts/` so future runs stay deterministic.",
      "5. Report the exact command that ran and the meaningful output or failure.",
      "",
      "## Bundled Helpers",
      "",
      "- `scripts/run.sh` is a starter wrapper for `cd` plus `curl` or text matching checks.",
      "- `references/commands.md` contains copyable command patterns for `cd`, `curl`, `grep`, and `rg`.",
      "",
      "## Notes",
      "",
      "- Prefer `rg` over `grep -R` for repo searches when available.",
      "- Use `curl -fsSL` for smoke tests so HTTP failures do not look successful."
    ].join("\n"),
    references: [
      {
        name: "commands.md",
        content: [
          "# Shell Command Patterns",
          "",
          "Run inside another folder:",
          "",
          "```bash",
          "cd path/to/workdir && pwd",
          "```",
          "",
          "Use the structured shell tool with `cwd` when available:",
          "",
          "```json",
          '{"tool":"shell","input":{"cwd":"path/to/workdir","command":"pwd"}}',
          "```",
          "",
          "Fetch a page and search for expected text:",
          "",
          "```bash",
          "curl -fsSL https://example.com | grep -i \"expected text\"",
          "```",
          "",
          "Search the repo quickly:",
          "",
          "```bash",
          "rg -n \"TODO|FIXME\" .",
          "```"
        ].join("\n")
      }
    ],
    scripts: [
      {
        name: "run.sh",
        executable: true,
        content: [
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          "",
          'TARGET_DIR="${1:-.}"',
          'TARGET_URL="${2:-}"',
          'MATCH_TEXT="${3:-}"',
          "",
          'cd "$TARGET_DIR"',
          "",
          'if [[ -z "$TARGET_URL" ]]; then',
          '  echo "working directory: $(pwd)"',
          "  exit 0",
          "fi",
          "",
          'if [[ -n "$MATCH_TEXT" ]]; then',
          '  curl -fsSL "$TARGET_URL" | grep -i -- "$MATCH_TEXT"',
          "  exit 0",
          "fi",
          "",
          'curl -fsSL "$TARGET_URL"'
        ].join("\n")
      },
      {
        name: `${slug}.sh`,
        executable: true,
        content: [
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          "",
          '# Wrapper around scripts/run.sh so the skill has a named entrypoint.',
          'SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
          'exec "$SCRIPT_DIR/run.sh" "$@"'
        ].join("\n")
      }
    ]
  };
}

function buildSkillMarkdown(name: string, description: string, instructions?: string): string {
  return [
    "---",
    `name: ${slugify(name) || "skill"}`,
    `description: ${escapeYamlString(description)}`,
    "---",
    "",
    instructions?.trim() || defaultSkillBody(name),
    ""
  ].join("\n");
}

export async function createSkillScaffold(options: CreateSkillScaffoldOptions): Promise<SkillScaffoldResult> {
  const skillName = options.name.trim();
  if (!skillName) {
    throw new Error("Skill name is required.");
  }

  const slug = slugify(skillName);
  if (!slug) {
    throw new Error("Skill name must contain letters or numbers.");
  }

  const skillDirRelative = path.join("skills", slug);
  const skillDir = assertWithinRoot(options.root, skillDirRelative);
  const skillFileRelative = path.join(skillDirRelative, "SKILL.md");
  const skillFile = assertWithinRoot(options.root, skillFileRelative);
  const createdFiles: string[] = [];

  await mkdir(skillDir, { recursive: true });
  await writeFile(
    skillFile,
    buildSkillMarkdown(
      skillName,
      options.description?.trim() || defaultSkillDescription(skillName),
      options.instructions
    ),
    "utf8"
  );
  createdFiles.push(skillFileRelative);

  for (const reference of options.references ?? []) {
    const referenceName = reference.name.trim();
    if (!referenceName) {
      continue;
    }

    const referenceRelative = path.join(skillDirRelative, "references", referenceName);
    const referencePath = assertWithinRoot(options.root, referenceRelative);
    await mkdir(path.dirname(referencePath), { recursive: true });
    await writeFile(referencePath, `${reference.content.trim()}\n`, "utf8");
    createdFiles.push(referenceRelative);
  }

  for (const script of options.scripts ?? []) {
    const scriptName = script.name.trim();
    if (!scriptName) {
      continue;
    }

    const scriptRelative = path.join(skillDirRelative, "scripts", scriptName);
    const scriptPath = assertWithinRoot(options.root, scriptRelative);
    await mkdir(path.dirname(scriptPath), { recursive: true });
    await writeFile(scriptPath, `${script.content.trim()}\n`, "utf8");
    if (script.executable) {
      await chmod(scriptPath, 0o755);
    }
    createdFiles.push(scriptRelative);
  }

  return {
    skillName,
    slug,
    skillDir,
    skillFile,
    createdFiles
  };
}
