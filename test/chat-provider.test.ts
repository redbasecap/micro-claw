import { afterEach, describe, expect, test, vi } from "vitest";
import { defaultConfig } from "../src/config/defaults.js";
import {
  _clearOllamaModelCacheForTests,
  requestChatCompletion,
  resolveOllamaModel
} from "../src/providers/chat-provider.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  _clearOllamaModelCacheForTests();
});

describe("resolveOllamaModel", () => {
  test("falls back to the smallest installed model when the desired one is missing", () => {
    const model = resolveOllamaModel(
      [
        { name: "large-model", size: 100 },
        { name: "small-model", size: 10 }
      ],
      "missing-model",
      "also-missing"
    );

    expect(model).toBe("small-model");
  });

  test("can prefer the largest installed model when requested", () => {
    const model = resolveOllamaModel(
      [
        { name: "large-model", size: 100 },
        { name: "small-model", size: 10 }
      ],
      "missing-model",
      "also-missing",
      "largest"
    );

    expect(model).toBe("large-model");
  });
});

describe("requestChatCompletion", () => {
  test("reads a non-streaming Ollama chat response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ message: { content: "hello from ollama" } }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      )
    );

    const result = await requestChatCompletion({
      config: defaultConfig,
      providerKind: "ollama",
      model: "llama3.2:latest",
      messages: [
        {
          role: "user",
          content: "hi"
        }
      ],
      stream: false
    });

    expect(result.providerKind).toBe("ollama");
    expect(result.content).toBe("hello from ollama");
  });

  test("keeps a streaming Ollama response alive while chunks continue arriving", async () => {
    const config = structuredClone(defaultConfig);
    config.provider.requestTimeoutSeconds = 0.05;
    const tokens: string[] = [];
    const encoder = new TextEncoder();

    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string | URL | RequestInfo, init?: RequestInit) => {
        const signal = init?.signal as AbortSignal | undefined;

        return new Response(
          new ReadableStream({
            start(controller) {
              signal?.addEventListener("abort", () => {
                controller.error(signal.reason ?? new Error("aborted"));
              });

              setTimeout(() => {
                controller.enqueue(
                  encoder.encode(`${JSON.stringify({ message: { content: "hel" } })}\n`)
                );
              }, 30);
              setTimeout(() => {
                controller.enqueue(
                  encoder.encode(
                    `${JSON.stringify({ message: { content: "lo" }, done: true, done_reason: "stop" })}\n`
                  )
                );
              }, 70);
              setTimeout(() => {
                controller.close();
              }, 75);
            }
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" }
          }
        );
      })
    );

    const result = await requestChatCompletion({
      config,
      providerKind: "ollama",
      model: "llama3.2:latest",
      messages: [
        {
          role: "user",
          content: "hi"
        }
      ],
      stream: true,
      onToken: async (token) => {
        tokens.push(token);
      }
    });

    expect(result.content).toBe("hello");
    expect(result.finishReason).toBe("stop");
    expect(tokens.join("")).toBe("hello");
  });
});
