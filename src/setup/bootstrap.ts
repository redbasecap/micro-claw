import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import type { BootstrapResult, MicroClawConfig } from "../core/types.js";
import { loadAgentProfile, saveAgentProfile } from "../agent/agent-profile.js";
import { pathExists } from "../core/utils.js";

export interface RunBootstrapOptions {
  root: string;
  config: MicroClawConfig;
  allowDirect?: boolean;
}

function buildEnvTemplate(config: MicroClawConfig): string {
  return [
    "# Fill in the values you need before starting the assistant.",
    `${config.telegram.botTokenEnv}=`,
    `${config.provider.apiKeyEnv}=`,
    ""
  ].join("\n");
}

function buildConfigTemplate(allowDirect: boolean): string {
  return YAML.stringify({
    provider: {
      kind: "ollama",
      model: "micro-claw-coder"
    },
    security: {
      require_secretgate: allowDirect ? false : true
    },
    telegram: {
      enabled: true,
      allowed_chat_ids: []
    },
    assistant: {
      enabled: true
    }
  }).trimEnd() + "\n";
}

export async function runBootstrap(options: RunBootstrapOptions): Promise<BootstrapResult> {
  const envFile = path.join(options.root, ".env.micro-claw");
  const configPath = path.join(options.root, "micro-claw.config.yaml");
  const createdFiles: string[] = [];

  await mkdir(path.join(options.root, ".micro-claw"), { recursive: true });

  if (!(await pathExists(envFile))) {
    await writeFile(envFile, buildEnvTemplate(options.config), "utf8");
    createdFiles.push(envFile);
  }

  if (!(await pathExists(configPath))) {
    await writeFile(configPath, buildConfigTemplate(Boolean(options.allowDirect)), "utf8");
    createdFiles.push(configPath);
  }

  if (!(await loadAgentProfile(options.root))) {
    const profile = await saveAgentProfile(options.root, {
      name: "Micro Claw",
      behavior: "Be concise, practical, and helpful in daily life and repo work."
    });
    createdFiles.push(path.join(options.root, ".micro-claw", "agent", "profile.json"));
    createdFiles.push(path.join(options.root, ".micro-claw", "agent", "profile.md"));

    return {
      root: options.root,
      createdFiles,
      configPath,
      envFile,
      note: `Bootstrap completed. Agent profile created for ${profile.name}. Fill in ${envFile} and start with pnpm one-click.`
    };
  }

  return {
    root: options.root,
    createdFiles,
    configPath,
    envFile,
    note:
      createdFiles.length > 0
        ? `Bootstrap completed. Fill in ${envFile} and start with pnpm one-click.`
        : "Bootstrap found the expected files already in place."
  };
}
