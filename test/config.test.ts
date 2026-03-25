import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { loadConfig } from "../src/config/load-config.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("loadConfig", () => {
  test("merges yaml config with defaults", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "micro-claw-config-"));
    tempDirs.push(root);

    await writeFile(
      path.join(root, "micro-claw.config.yaml"),
      [
        "runtime:",
        "  mode: remote",
        "provider:",
        "  kind: anthropic",
        "  model: claude-test",
        "  api_key_env: CLAUDE_TEST_KEY",
        "tools:",
        "  max_command_seconds: 45"
      ].join("\n"),
      "utf8"
    );

    const { config, configPath } = await loadConfig(root);

    expect(configPath).toBe(path.join(root, "micro-claw.config.yaml"));
    expect(config.runtime.mode).toBe("remote");
    expect(config.provider.kind).toBe("anthropic");
    expect(config.provider.model).toBe("claude-test");
    expect(config.provider.apiKeyEnv).toBe("CLAUDE_TEST_KEY");
    expect(config.tools.maxCommandSeconds).toBe(45);
    expect(config.context.maxFileCharsPerFile).toBe(24_000);
    expect(config.security.requireSecretgate).toBe(true);
    expect(config.security.expectedProxyPort).toBe(8083);
    expect(config.assistant.enabled).toBe(true);
    expect(config.telegram.botTokenEnv).toBe("TELEGRAM_BOT_TOKEN");
  });
});
