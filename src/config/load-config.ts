import { readFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { defaultConfig } from "./defaults.js";
import type { MicroClawConfig, ProviderKind, RuntimeMode } from "../core/types.js";
import { deepMerge, isPlainObject, pathExists } from "../core/utils.js";

const DEFAULT_CONFIG_NAMES = [
  "micro-claw.config.yaml",
  "micro-claw.config.yml",
  "micro-claw.config.json"
];

function parseConfig(source: string, configPath: string): unknown {
  if (configPath.endsWith(".json")) {
    return JSON.parse(source);
  }

  return YAML.parse(source);
}

function toCamelCase(value: string): string {
  return value.replace(/[_-]([a-z])/g, (_, char: string) => char.toUpperCase());
}

function normalizeKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeKeys(item));
  }

  if (!isPlainObject(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, nestedValue]) => [toCamelCase(key), normalizeKeys(nestedValue)])
  );
}

function assertLiteral<T extends string>(value: unknown, allowed: readonly T[], label: string): asserts value is T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`Invalid ${label}: expected one of ${allowed.join(", ")}`);
  }
}

function validateConfig(config: MicroClawConfig): MicroClawConfig {
  assertLiteral<RuntimeMode>(config.runtime.mode, ["local", "remote"], "runtime.mode");
  assertLiteral<ProviderKind>(
    config.provider.kind,
    ["anthropic", "ollama", "openai-compatible", "none"],
    "provider.kind"
  );

  if (config.tools.maxCommandSeconds <= 0) {
    throw new Error("tools.maxCommandSeconds must be positive");
  }

  if (config.context.maxFileCharsPerFile <= 0) {
    throw new Error("context.maxFileCharsPerFile must be positive");
  }

  if (config.security.expectedProxyPort <= 0) {
    throw new Error("security.expectedProxyPort must be positive");
  }

  if (config.security.defaultHeartbeatIntervalSeconds <= 0) {
    throw new Error("security.defaultHeartbeatIntervalSeconds must be positive");
  }

  if (config.assistant.recentConversationMessages <= 0) {
    throw new Error("assistant.recentConversationMessages must be positive");
  }

  if (config.assistant.maxNotesPerUser <= 0) {
    throw new Error("assistant.maxNotesPerUser must be positive");
  }

  if (config.assistant.maxTodosPerUser <= 0) {
    throw new Error("assistant.maxTodosPerUser must be positive");
  }

  if (config.assistant.maxRemindersPerUser <= 0) {
    throw new Error("assistant.maxRemindersPerUser must be positive");
  }

  if (config.telegram.pollIntervalMs <= 0) {
    throw new Error("telegram.pollIntervalMs must be positive");
  }

  if (config.telegram.longPollSeconds < 0) {
    throw new Error("telegram.longPollSeconds must be zero or positive");
  }

  return config;
}

export async function resolveConfigPath(root: string, explicitPath?: string): Promise<string | undefined> {
  if (explicitPath) {
    return path.resolve(root, explicitPath);
  }

  for (const candidate of DEFAULT_CONFIG_NAMES) {
    const candidatePath = path.join(root, candidate);
    if (await pathExists(candidatePath)) {
      return candidatePath;
    }
  }

  return undefined;
}

export async function loadConfig(
  root: string,
  explicitPath?: string
): Promise<{ config: MicroClawConfig; configPath?: string }> {
  const configPath = await resolveConfigPath(root, explicitPath);

  if (!configPath) {
    return { config: defaultConfig };
  }

  const source = await readFile(configPath, "utf8");
  const parsed = parseConfig(source, configPath);

  if (!isPlainObject(parsed)) {
    throw new Error(`Config file must contain an object: ${configPath}`);
  }

  const normalized = normalizeKeys(parsed);
  const merged = deepMerge(defaultConfig, normalized);
  return {
    config: validateConfig(merged),
    configPath
  };
}
