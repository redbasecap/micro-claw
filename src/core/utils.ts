import { access } from "node:fs/promises";
import path from "node:path";

export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

export function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, maxChars)}\n...[truncated ${value.length - maxChars} chars]`;
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

export function compact<T>(values: Array<T | null | undefined | false>): T[] {
  return values.filter(Boolean) as T[];
}

export function extractTaskKeywords(task: string): string[] {
  const stopWords = new Set([
    "the",
    "and",
    "that",
    "this",
    "with",
    "from",
    "into",
    "build",
    "project",
    "please",
    "make",
    "just",
    "then",
    "when",
    "have",
    "should",
    "would",
    "could"
  ]);

  return unique(
    task
      .toLowerCase()
      .split(/[^a-z0-9_/-]+/g)
      .map((part) => part.trim())
      .filter((part) => part.length >= 3 && !stopWords.has(part))
  ).slice(0, 6);
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function deepMerge<T>(base: T, override: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return (override === undefined ? base : override) as T;
  }

  const result: Record<string, unknown> = { ...base };

  for (const [key, value] of Object.entries(override)) {
    const current = result[key];
    if (isPlainObject(current) && isPlainObject(value)) {
      result[key] = deepMerge(current, value);
      continue;
    }

    result[key] = value;
  }

  return result as T;
}

export async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export function timestampId(now = new Date()): string {
  const iso = now.toISOString().replace(/[:.]/g, "-");
  return iso.replace("T", "_").replace("Z", "");
}

export function assertWithinRoot(root: string, targetPath: string): string {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(root, targetPath);

  if (resolvedTarget === resolvedRoot || resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) {
    return resolvedTarget;
  }

  throw new Error(`Path escapes repo root: ${targetPath}`);
}
