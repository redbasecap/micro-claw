import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PatchOperation, SearchMatch } from "../core/types.js";
import { assertWithinRoot, pathExists, truncate } from "../core/utils.js";

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) {
    return 0;
  }

  return haystack.split(needle).length - 1;
}

export async function readTextFile(root: string, repoPath: string, maxChars: number): Promise<string> {
  const absolutePath = assertWithinRoot(root, repoPath);
  const content = await readFile(absolutePath, "utf8");
  return truncate(content, maxChars);
}

async function walkSearchFiles(root: string, currentDir = root, files: string[] = []): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(currentDir, { withFileTypes: true });

  for (const entry of entries) {
    const absolutePath = path.join(currentDir, entry.name);
    const relativePath = path.relative(root, absolutePath);

    if (entry.isDirectory()) {
      if ([".git", ".micro-claw", "node_modules", "dist", "coverage"].includes(entry.name)) {
        continue;
      }

      await walkSearchFiles(root, absolutePath, files);
      continue;
    }

    if (entry.isFile()) {
      files.push(relativePath);
    }
  }

  return files;
}

export async function listFiles(root: string, directory = ".", maxResults = 200): Promise<string[]> {
  const baseDir = assertWithinRoot(root, directory);
  const files = await walkSearchFiles(root, baseDir);
  return files.sort().slice(0, maxResults);
}

export async function searchText(root: string, query: string, maxResults = 20): Promise<SearchMatch[]> {
  const matches: SearchMatch[] = [];
  const files = await walkSearchFiles(root);

  for (const file of files) {
    if (matches.length >= maxResults) {
      break;
    }

    const absolutePath = assertWithinRoot(root, file);
    const content = await readFile(absolutePath);

    if (content.includes(0)) {
      continue;
    }

    const text = content.toString("utf8");
    const lines = text.split(/\r?\n/g);

    for (let index = 0; index < lines.length; index += 1) {
      if (!lines[index].toLowerCase().includes(query.toLowerCase())) {
        continue;
      }

      matches.push({
        path: file,
        line: index + 1,
        preview: truncate(lines[index].trim(), 160)
      });

      if (matches.length >= maxResults) {
        break;
      }
    }
  }

  return matches;
}

export async function writeTextFile(root: string, repoPath: string, content: string): Promise<string> {
  const absolutePath = assertWithinRoot(root, repoPath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content, "utf8");
  return repoPath;
}

export async function replaceTextInFile(
  root: string,
  repoPath: string,
  search: string,
  replace: string,
  expectedReplacements?: number
): Promise<string> {
  const absolutePath = assertWithinRoot(root, repoPath);
  const current = await readFile(absolutePath, "utf8");
  const occurrences = countOccurrences(current, search);

  if (occurrences === 0) {
    throw new Error(`Text not found in ${repoPath}`);
  }

  if (expectedReplacements !== undefined && occurrences !== expectedReplacements) {
    throw new Error(`Expected ${expectedReplacements} replacements in ${repoPath}, found ${occurrences}`);
  }

  const next = current.split(search).join(replace);
  await writeFile(absolutePath, next, "utf8");
  return repoPath;
}

export async function deleteTextFile(root: string, repoPath: string): Promise<string> {
  const absolutePath = assertWithinRoot(root, repoPath);
  if (await pathExists(absolutePath)) {
    await unlink(absolutePath);
  }

  return repoPath;
}

export async function applyPatchOperations(root: string, operations: PatchOperation[]): Promise<string[]> {
  const touchedFiles: string[] = [];

  for (const operation of operations) {
    const absolutePath = assertWithinRoot(root, operation.path);

    if (operation.kind === "write_file") {
      await mkdir(path.dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, operation.content, "utf8");
      touchedFiles.push(operation.path);
      continue;
    }

    if (operation.kind === "delete_file") {
      if (await pathExists(absolutePath)) {
        await unlink(absolutePath);
        touchedFiles.push(operation.path);
      }
      continue;
    }

    const current = await readFile(absolutePath, "utf8");
    const occurrences = countOccurrences(current, operation.search);

    if (occurrences === 0) {
      throw new Error(`Text not found in ${operation.path}`);
    }

    if (operation.expectedReplacements !== undefined && occurrences !== operation.expectedReplacements) {
      throw new Error(
        `Expected ${operation.expectedReplacements} replacements in ${operation.path}, found ${occurrences}`
      );
    }

    const next = current.split(operation.search).join(operation.replace);
    await writeFile(absolutePath, next, "utf8");
    touchedFiles.push(operation.path);
  }

  return touchedFiles;
}
