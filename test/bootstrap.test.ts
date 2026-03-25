import { readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { afterEach, describe, expect, test } from "vitest";
import { defaultConfig } from "../src/config/defaults.js";
import { runBootstrap } from "../src/setup/bootstrap.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("runBootstrap", () => {
  test("creates env, config, and agent profile files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "micro-claw-bootstrap-"));
    tempDirs.push(root);

    const result = await runBootstrap({
      root,
      config: defaultConfig,
      allowDirect: true
    });

    expect(result.createdFiles.some((file) => file.endsWith(".env.micro-claw"))).toBe(true);
    expect(result.createdFiles.some((file) => file.endsWith("micro-claw.config.yaml"))).toBe(true);

    const envFile = await readFile(path.join(root, ".env.micro-claw"), "utf8");
    expect(envFile).toContain("TELEGRAM_BOT_TOKEN=");

    const configFile = await readFile(path.join(root, "micro-claw.config.yaml"), "utf8");
    expect(configFile).toContain("require_secretgate: false");

    const profileFile = await readFile(path.join(root, ".micro-claw", "agent", "profile.json"), "utf8");
    expect(profileFile).toContain("Micro Claw");
  });
});
