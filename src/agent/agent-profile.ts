import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import type { Writable } from "node:stream";
import { createCliUi } from "../cli-ui.js";
import type { AgentProfile } from "../core/types.js";
import { assertWithinRoot, pathExists } from "../core/utils.js";

const DEFAULT_AGENT_NAME = "Micro Claw";
const DEFAULT_AGENT_BEHAVIOR = "Be concise, practical, calm, and transparent about what you actually ran or changed.";

function getProfilePaths(root: string): { profileJsonFile: string; profileMarkdownFile: string } {
  return {
    profileJsonFile: assertWithinRoot(root, ".micro-claw/agent/profile.json"),
    profileMarkdownFile: assertWithinRoot(root, ".micro-claw/agent/profile.md")
  };
}

function normalizeName(value: string | undefined): string {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : DEFAULT_AGENT_NAME;
}

function normalizeBehavior(value: string | undefined): string {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : DEFAULT_AGENT_BEHAVIOR;
}

function formatProfileMarkdown(profile: AgentProfile): string {
  return [
    "# Agent Profile",
    "",
    `Name: ${profile.name}`,
    `Behavior: ${profile.behavior}`,
    `Created At: ${profile.createdAt}`,
    `Updated At: ${profile.updatedAt}`,
    ""
  ].join("\n");
}

export function getDefaultAgentProfile(now = new Date()): AgentProfile {
  const timestamp = now.toISOString();
  return {
    name: DEFAULT_AGENT_NAME,
    behavior: DEFAULT_AGENT_BEHAVIOR,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

export async function loadAgentProfile(root: string): Promise<AgentProfile | undefined> {
  const { profileJsonFile } = getProfilePaths(root);
  if (!(await pathExists(profileJsonFile))) {
    return undefined;
  }

  const raw = await readFile(profileJsonFile, "utf8");
  const parsed = JSON.parse(raw) as Partial<AgentProfile>;

  if (typeof parsed.name !== "string" || typeof parsed.behavior !== "string") {
    throw new Error(`Invalid agent profile: ${profileJsonFile}`);
  }

  return {
    name: normalizeName(parsed.name),
    behavior: normalizeBehavior(parsed.behavior),
    createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : new Date().toISOString(),
    updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString()
  };
}

export async function saveAgentProfile(
  root: string,
  values: {
    name?: string;
    behavior?: string;
  }
): Promise<AgentProfile> {
  const existing = await loadAgentProfile(root).catch(() => undefined);
  const now = new Date().toISOString();
  const profile: AgentProfile = {
    name: normalizeName(values.name ?? existing?.name),
    behavior: normalizeBehavior(values.behavior ?? existing?.behavior),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  };

  const { profileJsonFile, profileMarkdownFile } = getProfilePaths(root);
  await mkdir(path.dirname(profileJsonFile), { recursive: true });
  await writeFile(profileJsonFile, `${JSON.stringify(profile, null, 2)}\n`, "utf8");
  await writeFile(profileMarkdownFile, formatProfileMarkdown(profile), "utf8");

  return profile;
}

export async function promptForAgentProfile(root: string, output: Writable = process.stdout): Promise<AgentProfile> {
  const ui = createCliUi(output, process.env);
  output.write(
    `${ui.decorated ? ui.renderCommandHeader("Agent Profile", "set the default name and behavior") : "Let's set up your agent before we start."}\n`
  );
  output.write(`${ui.muted("Press Enter to keep the defaults.")}\n`);

  const readline = createInterface({
    input: process.stdin,
    output,
    terminal: true
  });

  try {
    const name = await readline.question(
      ui.decorated
        ? `${ui.prompt("name")}default ${DEFAULT_AGENT_NAME}: `
        : `What should I call myself? [${DEFAULT_AGENT_NAME}] `
    );
    const behavior = await readline.question(
      ui.decorated
        ? `${ui.prompt("behavior")}default ${DEFAULT_AGENT_BEHAVIOR}: `
        : `How should I behave? [${DEFAULT_AGENT_BEHAVIOR}] `
    );
    return saveAgentProfile(root, {
      name,
      behavior
    });
  } finally {
    readline.close();
  }
}

export async function resolveAgentProfile(options: {
  root: string;
  output?: Writable;
  promptIfMissing?: boolean;
}): Promise<AgentProfile> {
  const existing = await loadAgentProfile(options.root);
  if (existing) {
    return existing;
  }

  if (options.promptIfMissing && process.stdin.isTTY && process.stdout.isTTY) {
    return promptForAgentProfile(options.root, options.output ?? process.stdout);
  }

  return getDefaultAgentProfile();
}

export function formatAgentProfile(profile: AgentProfile): string {
  return [
    `Name: ${profile.name}`,
    `Behavior: ${profile.behavior}`,
    `Created At: ${profile.createdAt}`,
    `Updated At: ${profile.updatedAt}`
  ].join("\n");
}
