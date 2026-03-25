import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathExists } from "../core/utils.js";

const DEFAULT_ENV_FILES = [".env.micro-claw", ".env"];

function parseEnvLine(line: string): { key: string; value: string } | undefined {
  const trimmed = line.trim();

  if (!trimmed || trimmed.startsWith("#")) {
    return undefined;
  }

  const equalsIndex = trimmed.indexOf("=");
  if (equalsIndex <= 0) {
    return undefined;
  }

  const key = trimmed.slice(0, equalsIndex).trim();
  let value = trimmed.slice(equalsIndex + 1).trim();

  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }

  return key ? { key, value } : undefined;
}

export async function loadEnvFiles(root: string, explicitPath?: string): Promise<string[]> {
  const candidates = explicitPath ? [explicitPath] : DEFAULT_ENV_FILES;
  const loaded: string[] = [];

  for (const candidate of candidates) {
    const targetPath = path.resolve(root, candidate);
    if (!(await pathExists(targetPath))) {
      continue;
    }

    const source = await readFile(targetPath, "utf8");
    for (const line of source.split(/\r?\n/g)) {
      const parsed = parseEnvLine(line);
      if (!parsed) {
        continue;
      }

      if (!process.env[parsed.key]) {
        process.env[parsed.key] = parsed.value;
      }
    }

    loaded.push(targetPath);
  }

  return loaded;
}
