import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { afterEach, describe, expect, test, vi } from "vitest";
import { saveAgentProfile } from "../src/agent/agent-profile.js";
import { defaultConfig } from "../src/config/defaults.js";
import { runChatSession } from "../src/chat/chat-session.js";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function createCaptureWritable() {
  let output = "";

  const sink = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    }
  });

  return {
    sink,
    read() {
      return output;
    }
  };
}

describe("runChatSession", () => {
  test("handles a one-shot prompt and persists the transcript", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "micro-claw-chat-"));
    tempDirs.push(root);

    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify(
        {
          name: "fixture",
          private: true
        },
        null,
        2
      ),
      "utf8"
    );
    await writeFile(path.join(root, "src", "index.ts"), "export const ok = true;\n", "utf8");
    await saveAgentProfile(root, {
      name: "Clawy",
      behavior: "brief and practical"
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | RequestInfo, init?: RequestInit) => {
        const url = String(input);

        if (url.endsWith("/api/tags")) {
          return new Response(
            JSON.stringify({
              models: [
                {
                  name: "llama3.2:latest",
                  size: 10
                }
              ]
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" }
            }
          );
        }

        if (url.endsWith("/api/chat")) {
          const body = JSON.parse(String(init?.body ?? "{}")) as {
            messages?: Array<{ role?: string; content?: string }>;
          };
          const systemMessage = body.messages?.find((message) => message.role === "system")?.content ?? "";
          expect(systemMessage).toContain("You are Clawy");
          expect(systemMessage).toContain("Behavior preference: brief and practical");

          return new Response(
            JSON.stringify({
              message: {
                content: "hello from micro claw"
              }
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" }
            }
          );
        }

        throw new Error(`Unexpected fetch URL: ${url}`);
      })
    );

    const { sink } = createCaptureWritable();

    const result = await runChatSession({
      root,
      config: defaultConfig,
      initialPrompt: "hello there",
      interactive: false,
      jsonMode: true,
      output: sink,
      env: {
        https_proxy: "http://127.0.0.1:8083",
        SSL_CERT_FILE: "/tmp/secretgate-ca.pem"
      }
    });

    expect(result.turnCount).toBe(1);
    expect(result.model).toBe("llama3.2:latest");
    expect(result.lastAssistantMessage).toBe("hello from micro claw");

    const transcript = await readFile(path.join(result.sessionDir, "chat-transcript.md"), "utf8");
    expect(transcript).toContain("hello there");
    expect(transcript).toContain("hello from micro claw");
  });

  test("explains shell commands pasted into chat instead of sending them to the model", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "micro-claw-chat-shell-hint-"));
    tempDirs.push(root);

    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify(
        {
          name: "fixture",
          private: true
        },
        null,
        2
      ),
      "utf8"
    );
    await writeFile(path.join(root, "src", "index.ts"), "export const ok = true;\n", "utf8");
    await saveAgentProfile(root, {
      name: "Clawy",
      behavior: "brief and practical"
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | RequestInfo) => {
        const url = String(input);

        if (url.endsWith("/api/tags")) {
          return new Response(
            JSON.stringify({
              models: [
                {
                  name: "llama3.2:latest",
                  size: 10
                }
              ]
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" }
            }
          );
        }

        throw new Error(`Unexpected fetch URL: ${url}`);
      })
    );

    const capture = createCaptureWritable();

    const result = await runChatSession({
      root,
      config: defaultConfig,
      initialPrompt: '\u001b[200~pnpm dev scan --json\u001b[201~',
      interactive: false,
      jsonMode: false,
      output: capture.sink,
      env: {
        https_proxy: "http://127.0.0.1:8083",
        SSL_CERT_FILE: "/tmp/secretgate-ca.pem"
      }
    });

    expect(result.turnCount).toBe(1);
    expect(result.lastAssistantMessage).toContain("Inside this chat, use /scan.");
    expect(capture.read()).toContain("That is a terminal command.");
  });

  test("uses tool mode for actionable prompts and creates files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "micro-claw-chat-tools-"));
    tempDirs.push(root);
    await saveAgentProfile(root, {
      name: "Clawy",
      behavior: "brief and practical"
    });

    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify(
        {
          name: "fixture",
          private: true
        },
        null,
        2
      ),
      "utf8"
    );

    let chatCallCount = 0;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | RequestInfo) => {
        const url = String(input);

        if (url.endsWith("/api/tags")) {
          return new Response(
            JSON.stringify({
              models: [
                {
                  name: "llama3.2:latest",
                  size: 10
                }
              ]
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" }
            }
          );
        }

        if (url.endsWith("/api/chat")) {
          chatCallCount += 1;

          if (chatCallCount === 1) {
            return new Response(
              JSON.stringify({
                message: {
                  content: JSON.stringify({
                    type: "tool",
                    tool: "write_file",
                    input: {
                      path: "TEST/hello.py",
                      content: "print('hello from tool mode')\n"
                    }
                  })
                }
              }),
              {
                status: 200,
                headers: { "content-type": "application/json" }
              }
            );
          }

          if (chatCallCount === 2) {
            return new Response(
              JSON.stringify({
                message: {
                  content: JSON.stringify({
                    type: "tool",
                    tool: "shell",
                    input: {
                      command: "python3 TEST/hello.py"
                    }
                  })
                }
              }),
              {
                status: 200,
                headers: { "content-type": "application/json" }
              }
            );
          }

          return new Response(
            JSON.stringify({
              message: {
                content: JSON.stringify({
                  type: "final",
                  content: "Created TEST/hello.py and ran it with python3."
                })
              }
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" }
            }
          );
        }

        throw new Error(`Unexpected fetch URL: ${url}`);
      })
    );

    const capture = createCaptureWritable();

    const result = await runChatSession({
      root,
      config: defaultConfig,
      initialPrompt: "create a folder TEST with a python file and run it",
      interactive: false,
      jsonMode: false,
      output: capture.sink,
      env: {
        https_proxy: "http://127.0.0.1:8083",
        SSL_CERT_FILE: "/tmp/secretgate-ca.pem"
      }
    });

    expect(result.turnCount).toBe(1);
    expect(result.lastAssistantMessage).toContain("Changed files: TEST/hello.py.");
    expect(result.lastAssistantMessage).toContain("Commands run: python3 TEST/hello.py.");

    const createdFile = await readFile(path.join(root, "TEST", "hello.py"), "utf8");
    expect(createdFile).toContain("hello from tool mode");

    const transcript = await readFile(path.join(result.sessionDir, "chat-transcript.md"), "utf8");
    expect(transcript).toContain("[tool request]");
    expect(transcript).toContain("python3 TEST/hello.py");

    const output = capture.read();
    expect(output).toContain("progress> tool mode enabled");
    expect(output).toContain("progress> running write_file TEST/hello.py");
    expect(output).toContain("progress> shell completed");
  });

  test("uses tool mode for readme-style requests instead of telling the user to run commands", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "micro-claw-chat-readme-"));
    tempDirs.push(root);
    await saveAgentProfile(root, {
      name: "Clawy",
      behavior: "brief and practical"
    });

    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify(
        {
          name: "fixture",
          private: true
        },
        null,
        2
      ),
      "utf8"
    );
    await writeFile(path.join(root, "src", "index.ts"), "export const ok = true;\n", "utf8");

    let chatCallCount = 0;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | RequestInfo) => {
        const url = String(input);

        if (url.endsWith("/api/tags")) {
          return new Response(
            JSON.stringify({
              models: [
                {
                  name: "llama3.2:latest",
                  size: 10
                }
              ]
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" }
            }
          );
        }

        if (url.endsWith("/api/chat")) {
          chatCallCount += 1;

          if (chatCallCount === 1) {
            return new Response(
              JSON.stringify({
                message: {
                  content: JSON.stringify({
                    type: "tool",
                    tool: "write_file",
                    input: {
                      path: "README.md",
                      content: "# Fixture\n\nThis repo contains a small TypeScript fixture.\n"
                    }
                  })
                }
              }),
              {
                status: 200,
                headers: { "content-type": "application/json" }
              }
            );
          }

          return new Response(
            JSON.stringify({
              message: {
                content: JSON.stringify({
                  type: "final",
                  content: "Created README.md with repository information."
                })
              }
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" }
            }
          );
        }

        throw new Error(`Unexpected fetch URL: ${url}`);
      })
    );

    const capture = createCaptureWritable();

    const result = await runChatSession({
      root,
      config: defaultConfig,
      initialPrompt: "add a reademe file and tell all infoas about the repo",
      interactive: false,
      jsonMode: false,
      output: capture.sink,
      env: {
        https_proxy: "http://127.0.0.1:8083",
        SSL_CERT_FILE: "/tmp/secretgate-ca.pem"
      }
    });

    expect(result.turnCount).toBe(1);
    expect(result.lastAssistantMessage).toContain("Changed files: README.md.");
    expect(result.lastAssistantMessage).not.toContain("/plan");
    expect(result.lastAssistantMessage).not.toContain("/run");

    const readme = await readFile(path.join(root, "README.md"), "utf8");
    expect(readme).toContain("# Fixture");

    const output = capture.read();
    expect(output).toContain("progress> tool mode enabled");
    expect(output).toContain("progress> running write_file README.md");
  });

  test("uses tool mode for german search requests instead of giving shell advice", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "micro-claw-chat-german-search-"));
    tempDirs.push(root);
    await saveAgentProfile(root, {
      name: "Clawy",
      behavior: "brief and practical"
    });

    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify(
        {
          name: "fixture",
          private: true
        },
        null,
        2
      ),
      "utf8"
    );
    await writeFile(path.join(root, "src", "index.ts"), "export const ok = true;\n", "utf8");

    let chatCallCount = 0;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | RequestInfo) => {
        const url = String(input);

        if (url.endsWith("/api/tags")) {
          return new Response(
            JSON.stringify({
              models: [
                {
                  name: "llama3.2:latest",
                  size: 10
                }
              ]
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" }
            }
          );
        }

        if (url.endsWith("/api/chat")) {
          chatCallCount += 1;

          if (chatCallCount === 1) {
            return new Response(
              JSON.stringify({
                message: {
                  content: JSON.stringify({
                    type: "tool",
                    tool: "list_files",
                    input: {
                      directory: ".",
                      maxResults: 50
                    }
                  })
                }
              }),
              {
                status: 200,
                headers: { "content-type": "application/json" }
              }
            );
          }

          if (chatCallCount === 2) {
            return new Response(
              JSON.stringify({
                message: {
                  content: JSON.stringify({
                    type: "tool",
                    tool: "read_file",
                    input: {
                      path: "src/index.ts"
                    }
                  })
                }
              }),
              {
                status: 200,
                headers: { "content-type": "application/json" }
              }
            );
          }

          return new Response(
            JSON.stringify({
              message: {
                content: JSON.stringify({
                  type: "final",
                  content: "Listed the repository files."
                })
              }
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" }
            }
          );
        }

        throw new Error(`Unexpected fetch URL: ${url}`);
      })
    );

    const capture = createCaptureWritable();

    const result = await runChatSession({
      root,
      config: defaultConfig,
      initialPrompt: "durchsuche alle dateien",
      interactive: false,
      jsonMode: false,
      output: capture.sink,
      env: {
        https_proxy: "http://127.0.0.1:8083",
        SSL_CERT_FILE: "/tmp/secretgate-ca.pem"
      }
    });

    expect(result.turnCount).toBe(1);
    expect(result.lastAssistantMessage).toContain("Tools used: list_files, read_file");
    expect(result.lastAssistantMessage).toContain("Final result: Listed the repository files.");

    const output = capture.read();
    expect(output).toContain("progress> tool mode enabled");
    expect(output).toContain("progress> running list_files .");
    expect(output).toContain("progress> running read_file src/index.ts");
    expect(output).not.toContain("find . -type f");
  });

  test("repairs malformed tool json and runs grep successfully", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "micro-claw-chat-grep-repair-"));
    tempDirs.push(root);
    await saveAgentProfile(root, {
      name: "Clawy",
      behavior: "brief and practical"
    });

    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify(
        {
          name: "fixture",
          private: true
        },
        null,
        2
      ),
      "utf8"
    );
    await writeFile(path.join(root, "src", "notes.txt"), "prosa appears here\n", "utf8");

    let chatCallCount = 0;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | RequestInfo) => {
        const url = String(input);

        if (url.endsWith("/api/tags")) {
          return new Response(
            JSON.stringify({
              models: [
                {
                  name: "llama3.2:latest",
                  size: 10
                }
              ]
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" }
            }
          );
        }

        if (url.endsWith("/api/chat")) {
          chatCallCount += 1;

          if (chatCallCount === 1) {
            return new Response(
              JSON.stringify({
                message: {
                  content: '{"type":"tool","tool":"grep","input":{"query":"prosa",maxResults":50}}'
                }
              }),
              {
                status: 200,
                headers: { "content-type": "application/json" }
              }
            );
          }

          return new Response(
            JSON.stringify({
              message: {
                content: JSON.stringify({
                  type: "final",
                  content: "Searched the repo with grep."
                })
              }
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" }
            }
          );
        }

        throw new Error(`Unexpected fetch URL: ${url}`);
      })
    );

    const capture = createCaptureWritable();

    const result = await runChatSession({
      root,
      config: defaultConfig,
      initialPrompt: "erstelle ein tool um alles zu druchsuchen mit GREP",
      interactive: false,
      jsonMode: false,
      output: capture.sink,
      env: {
        https_proxy: "http://127.0.0.1:8083",
        SSL_CERT_FILE: "/tmp/secretgate-ca.pem"
      }
    });

    expect(result.turnCount).toBe(1);
    expect(result.lastAssistantMessage).toContain("Commands run: grep prosa.");
    expect(result.lastAssistantMessage).not.toContain("Tool-mode reply was not valid JSON");

    const transcript = await readFile(path.join(result.sessionDir, "chat-transcript.md"), "utf8");
    expect(transcript).toContain('"tool":"grep"');

    const output = capture.read();
    expect(output).toContain("progress> running grep prosa");
    expect(output).toContain("progress> grep completed");
  });

  test("creates a simple skill scaffold directly from a chat prompt", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "micro-claw-chat-skill-"));
    tempDirs.push(root);
    await saveAgentProfile(root, {
      name: "Clawy",
      behavior: "brief and practical"
    });

    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify(
        {
          name: "fixture",
          private: true
        },
        null,
        2
      ),
      "utf8"
    );

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | RequestInfo) => {
        const url = String(input);

        if (url.endsWith("/api/tags")) {
          return new Response(
            JSON.stringify({
              models: [
                {
                  name: "llama3.2:latest",
                  size: 10
                }
              ]
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" }
            }
          );
        }

        throw new Error(`Unexpected fetch URL: ${url}`);
      })
    );

    const capture = createCaptureWritable();

    const result = await runChatSession({
      root,
      config: defaultConfig,
      initialPrompt: "create a skill for curl smoke tests",
      interactive: false,
      jsonMode: false,
      output: capture.sink,
      env: {
        https_proxy: "http://127.0.0.1:8083",
        SSL_CERT_FILE: "/tmp/secretgate-ca.pem"
      }
    });

    expect(result.turnCount).toBe(1);
    expect(result.lastAssistantMessage).toContain("curl-smoke-tests");

    const skill = await readFile(path.join(root, "skills", "curl-smoke-tests", "SKILL.md"), "utf8");
    const commandsReference = await readFile(
      path.join(root, "skills", "curl-smoke-tests", "references", "commands.md"),
      "utf8"
    );
    const helperScript = await readFile(path.join(root, "skills", "curl-smoke-tests", "scripts", "run.sh"), "utf8");
    expect(skill).toContain("name: curl-smoke-tests");
    expect(commandsReference).toContain("curl -fsSL");
    expect(helperScript).toContain('cd "$TARGET_DIR"');

    const output = capture.read();
    expect(output).toContain("progress> creating skill scaffold");
    expect(output).toContain("progress> created skills/curl-smoke-tests/SKILL.md");
  });
});
