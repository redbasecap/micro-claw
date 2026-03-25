import type { MicroClawConfig, PatchOperation, ShellCommandResult, ToolCall, ToolResult } from "../core/types.js";
import { assertWithinRoot, toErrorMessage } from "../core/utils.js";
import { createSkillScaffold } from "../skills/skill-scaffold.js";
import {
  applyPatchOperations,
  deleteTextFile,
  listFiles,
  readTextFile,
  replaceTextInFile,
  searchText,
  writeTextFile
} from "./file-tool.js";
import { getGitDiff, getGitStatus } from "./git-tool.js";
import { runShellCommand } from "./shell-tool.js";

export class ToolExecutor {
  constructor(
    private readonly root: string,
    private readonly config: MicroClawConfig
  ) {}

  async execute(call: ToolCall): Promise<ToolResult> {
    const startedAt = Date.now();

    try {
      const data = await this.dispatch(call);
      return {
        tool: call.tool,
        ok: true,
        summary: summarizeToolSuccess(call.tool, data),
        durationMs: Date.now() - startedAt,
        data
      };
    } catch (error) {
      return {
        tool: call.tool,
        ok: false,
        summary: `Tool ${call.tool} failed.`,
        durationMs: Date.now() - startedAt,
        error: toErrorMessage(error)
      };
    }
  }

  private async dispatch(call: ToolCall): Promise<unknown> {
    switch (call.tool) {
      case "shell":
        if (!this.config.tools.shellEnabled) {
          throw new Error("Shell tool is disabled.");
        }

        return runShellCommand({
          command: String(call.input.command ?? ""),
          cwd:
            call.input.cwd === undefined
              ? this.root
              : assertWithinRoot(this.root, String(call.input.cwd ?? ".")),
          timeoutMs: this.config.tools.maxCommandSeconds * 1_000,
          outputLimit: this.config.tools.captureCommandOutputLimit
        });
      case "read_file":
        return readTextFile(
          this.root,
          String(call.input.path ?? ""),
          this.config.context.maxFileCharsPerFile
        );
      case "list_files":
        return listFiles(
          this.root,
          String(call.input.directory ?? "."),
          Number(call.input.maxResults ?? 200)
        );
      case "search":
        return searchText(
          this.root,
          String(call.input.query ?? ""),
          Number(call.input.maxResults ?? 20)
        );
      case "write_file":
        return writeTextFile(
          this.root,
          String(call.input.path ?? ""),
          String(call.input.content ?? "")
        );
      case "replace_text":
        return replaceTextInFile(
          this.root,
          String(call.input.path ?? ""),
          String(call.input.search ?? ""),
          String(call.input.replace ?? ""),
          call.input.expectedReplacements === undefined
            ? undefined
            : Number(call.input.expectedReplacements)
        );
      case "delete_file":
        return deleteTextFile(this.root, String(call.input.path ?? ""));
      case "create_skill":
        return createSkillScaffold({
          root: this.root,
          name: String(call.input.name ?? ""),
          description:
            call.input.description === undefined ? undefined : String(call.input.description),
          instructions:
            call.input.instructions === undefined ? undefined : String(call.input.instructions),
          references: Array.isArray(call.input.references)
            ? call.input.references
                .filter(
                  (item): item is { name: string; content: string } =>
                    typeof item === "object" &&
                    item !== null &&
                    typeof (item as { name?: unknown }).name === "string" &&
                    typeof (item as { content?: unknown }).content === "string"
                )
                .map((item) => ({
                  name: item.name,
                  content: item.content
                }))
            : undefined,
          scripts: Array.isArray(call.input.scripts)
            ? call.input.scripts
                .filter(
                  (item): item is { name: string; content: string; executable?: boolean } =>
                    typeof item === "object" &&
                    item !== null &&
                    typeof (item as { name?: unknown }).name === "string" &&
                    typeof (item as { content?: unknown }).content === "string"
                )
                .map((item) => ({
                  name: item.name,
                  content: item.content,
                  executable: item.executable === true
                }))
            : undefined
        });
      case "patch":
        if (!this.config.tools.patchEnabled) {
          throw new Error("Patch tool is disabled.");
        }

        return applyPatchOperations(this.root, call.input.operations as PatchOperation[]);
      case "git_status":
        return getGitStatus(
          this.root,
          this.config.tools.maxCommandSeconds * 1_000,
          this.config.tools.captureCommandOutputLimit
        );
      case "git_diff":
        return getGitDiff(
          this.root,
          this.config.tools.maxCommandSeconds * 1_000,
          this.config.tools.captureCommandOutputLimit
        );
      default:
        throw new Error(`Unsupported tool: ${String(call.tool)}`);
    }
  }
}

function summarizeToolSuccess(tool: ToolCall["tool"], data: unknown): string {
  if (tool === "shell" || tool === "git_status" || tool === "git_diff") {
    const result = data as ShellCommandResult;
    return result.exitCode === 0
      ? `${tool} completed successfully.`
      : `${tool} exited with code ${result.exitCode}.`;
  }

  if (tool === "search") {
    return `search returned ${(data as unknown[]).length} matches.`;
  }

  if (tool === "list_files") {
    return `list_files returned ${(data as unknown[]).length} paths.`;
  }

  if (tool === "patch") {
    return `patch touched ${(data as string[]).length} files.`;
  }

  if (tool === "write_file" || tool === "replace_text" || tool === "delete_file") {
    return `${tool} completed for ${String(data)}.`;
  }

  if (tool === "create_skill") {
    return `create_skill scaffolded ${String((data as { skillFile?: string }).skillFile ?? "skill")}.`;
  }

  return `${tool} completed successfully.`;
}
