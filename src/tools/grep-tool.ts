import type { SearchMatch } from "../core/types.js";
import { runShellCommand } from "./shell-tool.js";

interface GrepTextOptions {
  root: string;
  query: string;
  maxResults: number;
  timeoutMs: number;
  outputLimit: number;
  caseSensitive?: boolean;
  fixedString?: boolean;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

function parseMatches(output: string, maxResults: number): SearchMatch[] {
  const matches: SearchMatch[] = [];

  for (const line of output.split(/\r?\n/g)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const match = trimmed.match(/^(.+?):(\d+):(.*)$/);
    if (!match) {
      continue;
    }

    matches.push({
      path: match[1].replace(/^\.\//, ""),
      line: Number.parseInt(match[2], 10),
      preview: match[3].trim()
    });

    if (matches.length >= maxResults) {
      break;
    }
  }

  return matches;
}

function buildRgCommand(query: string, caseSensitive: boolean, fixedString: boolean): string {
  const flags = [
    "--line-number",
    "--no-heading",
    "--color",
    "never",
    caseSensitive ? undefined : "-i",
    fixedString ? "-F" : undefined
  ]
    .filter((flag): flag is string => typeof flag === "string")
    .join(" ");

  return `rg ${flags} -- ${shellQuote(query)} .`;
}

function buildGrepCommand(query: string, caseSensitive: boolean, fixedString: boolean): string {
  const flags = [
    "-RIn",
    "--binary-files=without-match",
    "--exclude-dir=.git",
    "--exclude-dir=node_modules",
    "--exclude-dir=dist",
    "--exclude-dir=coverage",
    "--exclude-dir=.micro-claw",
    caseSensitive ? undefined : "-i",
    fixedString ? "-F" : undefined
  ]
    .filter((flag): flag is string => typeof flag === "string")
    .join(" ");

  return `grep ${flags} -- ${shellQuote(query)} .`;
}

export async function grepText(options: GrepTextOptions): Promise<SearchMatch[]> {
  const query = options.query.trim();
  if (!query) {
    throw new Error("grep query cannot be empty.");
  }

  const maxResults = Math.max(1, options.maxResults);
  const caseSensitive = options.caseSensitive === true;
  const fixedString = options.fixedString !== false;
  const rgCheck = await runShellCommand({
    command: "command -v rg >/dev/null 2>&1",
    cwd: options.root,
    timeoutMs: Math.min(options.timeoutMs, 5_000),
    outputLimit: 256
  });
  const command =
    rgCheck.exitCode === 0
      ? buildRgCommand(query, caseSensitive, fixedString)
      : buildGrepCommand(query, caseSensitive, fixedString);
  const result = await runShellCommand({
    command,
    cwd: options.root,
    timeoutMs: options.timeoutMs,
    outputLimit: options.outputLimit
  });

  if (result.exitCode !== 0 && result.exitCode !== 1) {
    throw new Error(result.stderr.trim() || `grep command exited with code ${result.exitCode}`);
  }

  return parseMatches(result.stdout, maxResults);
}
