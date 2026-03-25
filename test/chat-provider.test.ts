import { afterEach, describe, expect, test, vi } from "vitest";
import { defaultConfig } from "../src/config/defaults.js";
import { requestChatCompletion, resolveOllamaModel } from "../src/providers/chat-provider.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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
});
