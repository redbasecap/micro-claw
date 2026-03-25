import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createShellHelperAssets, createSkillScaffold } from "../src/skills/skill-scaffold.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("createSkillScaffold", () => {
  test("writes a simple skills/<slug>/SKILL.md scaffold", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "micro-claw-skill-"));
    tempDirs.push(root);

    const result = await createSkillScaffold({
      root,
      name: "Curl Smoke Tests",
      description: "Use when the user needs a repeatable curl smoke test workflow."
    });

    expect(result.slug).toBe("curl-smoke-tests");
    expect(result.createdFiles).toContain("skills/curl-smoke-tests/SKILL.md");

    const content = await readFile(path.join(root, "skills", "curl-smoke-tests", "SKILL.md"), "utf8");
    expect(content).toContain("name: curl-smoke-tests");
    expect(content).toContain("Use when the user needs a repeatable curl smoke test workflow.");
    expect(content).toContain("# Curl Smoke Tests");
  });

  test("can scaffold shell helper scripts and references for command-driven skills", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "micro-claw-skill-shell-"));
    tempDirs.push(root);

    const result = await createSkillScaffold({
      root,
      name: "Curl Smoke Tests",
      description: "Use when the user needs a repeatable curl smoke test workflow.",
      ...createShellHelperAssets("Curl Smoke Tests")
    });

    expect(result.createdFiles).toContain("skills/curl-smoke-tests/references/commands.md");
    expect(result.createdFiles).toContain("skills/curl-smoke-tests/scripts/run.sh");

    const skill = await readFile(path.join(root, "skills", "curl-smoke-tests", "SKILL.md"), "utf8");
    const reference = await readFile(
      path.join(root, "skills", "curl-smoke-tests", "references", "commands.md"),
      "utf8"
    );
    const script = await readFile(path.join(root, "skills", "curl-smoke-tests", "scripts", "run.sh"), "utf8");

    expect(skill).toContain("Use the shell tool with either `cwd` or `cd <dir> && ...`");
    expect(reference).toContain("curl -fsSL");
    expect(reference).toContain("rg -n");
    expect(script).toContain('cd "$TARGET_DIR"');
    expect(script).toContain('curl -fsSL "$TARGET_URL"');
  });
});
