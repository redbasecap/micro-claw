import { mkdir, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { slugify, timestampId } from "../core/utils.js";

export class SessionStore {
  readonly sessionId: string;
  readonly sessionDir: string;

  private constructor(sessionId: string, sessionDir: string) {
    this.sessionId = sessionId;
    this.sessionDir = sessionDir;
  }

  static async create(repoRoot: string, task: string): Promise<SessionStore> {
    const sessionId = `${timestampId()}-${slugify(task || "run") || "run"}`;
    const sessionDir = path.join(repoRoot, ".micro-claw", "sessions", sessionId);
    await mkdir(sessionDir, { recursive: true });
    return new SessionStore(sessionId, sessionDir);
  }

  async writeJson(name: string, data: unknown): Promise<void> {
    await writeFile(path.join(this.sessionDir, name), `${JSON.stringify(data, null, 2)}\n`, "utf8");
  }

  async writeText(name: string, data: string): Promise<void> {
    await writeFile(path.join(this.sessionDir, name), data, "utf8");
  }

  async appendEvent(event: unknown): Promise<void> {
    await appendFile(path.join(this.sessionDir, "events.jsonl"), `${JSON.stringify(event)}\n`, "utf8");
  }
}
