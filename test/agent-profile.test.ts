import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { getDefaultAgentProfile, loadAgentProfile, saveAgentProfile } from "../src/agent/agent-profile.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("agent profile", () => {
  test("saves and reloads a named agent profile", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "micro-claw-profile-"));
    tempDirs.push(root);

    const saved = await saveAgentProfile(root, {
      name: "Clawy",
      behavior: "brief and proactive"
    });
    const loaded = await loadAgentProfile(root);

    expect(saved.name).toBe("Clawy");
    expect(saved.behavior).toBe("brief and proactive");
    expect(loaded?.name).toBe("Clawy");
    expect(loaded?.behavior).toBe("brief and proactive");

    const profileMarkdown = await readFile(path.join(root, ".micro-claw", "agent", "profile.md"), "utf8");
    expect(profileMarkdown).toContain("Name: Clawy");
    expect(profileMarkdown).toContain("Behavior: brief and proactive");
  });

  test("provides a sensible default profile", () => {
    const profile = getDefaultAgentProfile(new Date("2026-03-24T22:00:00.000Z"));
    expect(profile.name).toBe("Micro Claw");
    expect(profile.behavior).toContain("concise");
  });
});
