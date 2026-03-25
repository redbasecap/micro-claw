import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("launcher utils", () => {
  test("builds Windows command candidates with cmd and exe fallbacks", async () => {
    const { commandCandidates } = await import("../scripts/launcher-utils.mjs");

    expect(commandCandidates("pnpm", "win32")).toEqual(["pnpm.cmd", "pnpm.exe", "pnpm"]);
    expect(commandCandidates("pnpm", "linux")).toEqual(["pnpm"]);
  });

  test("falls back to corepack when pnpm is unavailable", async () => {
    const { resolvePackageManagerCommand } = await import("../scripts/launcher-utils.mjs");

    const result = resolvePackageManagerCommand({
      platform: "win32",
      detectCommand(command) {
        if (command === "pnpm") {
          return null;
        }

        if (command === "corepack") {
          return "corepack.cmd";
        }

        return null;
      }
    });

    expect(result).toEqual({
      command: "corepack.cmd",
      prefixArgs: ["pnpm"]
    });
  });

  test("detects supported config file names", async () => {
    const { hasConfigFile } = await import("../scripts/launcher-utils.mjs");
    const root = await mkdtemp(path.join(os.tmpdir(), "micro-claw-launcher-"));
    tempDirs.push(root);

    expect(await hasConfigFile(root)).toBe(false);

    await writeFile(path.join(root, "micro-claw.config.json"), "{}\n", "utf8");

    expect(await hasConfigFile(root)).toBe(true);
  });
});
