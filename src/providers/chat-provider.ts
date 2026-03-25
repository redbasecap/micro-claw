import type {
  ChatCompletionResult,
  ChatMessage,
  MicroClawConfig,
  ProviderKind
} from "../core/types.js";
import { toErrorMessage } from "../core/utils.js";

interface ProviderChatRequest {
  config: MicroClawConfig;
  providerKind: ProviderKind;
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  onToken?: (token: string) => void | Promise<void>;
}

interface OllamaModelSummary {
  name: string;
  size?: number;
}

function ensureApiKey(config: MicroClawConfig): string {
  const apiKey = process.env[config.provider.apiKeyEnv];

  if (!apiKey) {
    throw new Error(`Missing ${config.provider.apiKeyEnv} in the environment.`);
  }

  return apiKey;
}

async function parseOllamaStream(
  response: Response,
  onToken?: (token: string) => void | Promise<void>
): Promise<{ content: string; finishReason?: string }> {
  if (!response.body) {
    throw new Error("Ollama stream response has no body.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let content = "";
  let finishReason: string | undefined;

  while (true) {
    const { done, value } = await reader.read();
    buffered += decoder.decode(value, { stream: !done });

    let newlineIndex = buffered.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = buffered.slice(0, newlineIndex).trim();
      buffered = buffered.slice(newlineIndex + 1);

      if (line.length > 0) {
        const parsed = JSON.parse(line) as {
          message?: { content?: string };
          done?: boolean;
          done_reason?: string;
        };
        const token = parsed.message?.content ?? "";

        if (token) {
          content += token;
          if (onToken) {
            await onToken(token);
          }
        }

        if (parsed.done) {
          finishReason = parsed.done_reason;
        }
      }

      newlineIndex = buffered.indexOf("\n");
    }

    if (done) {
      break;
    }
  }

  const trailing = buffered.trim();
  if (trailing.length > 0) {
    const parsed = JSON.parse(trailing) as {
      message?: { content?: string };
      done_reason?: string;
    };
    const token = parsed.message?.content ?? "";
    if (token) {
      content += token;
      if (onToken) {
        await onToken(token);
      }
    }
    finishReason = finishReason ?? parsed.done_reason;
  }

  return {
    content,
    finishReason
  };
}

async function requestOllamaChat(request: ProviderChatRequest): Promise<ChatCompletionResult> {
  const response = await fetch(`${request.config.provider.ollamaHost}/api/chat`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    signal: AbortSignal.timeout(request.config.provider.requestTimeoutSeconds * 1_000),
    body: JSON.stringify({
      model: request.model,
      messages: request.messages,
      stream: Boolean(request.stream)
    })
  });

  if (!response.ok) {
    throw new Error(`Ollama chat failed with HTTP ${response.status}.`);
  }

  if (request.stream) {
    const streamed = await parseOllamaStream(response, request.onToken);
    return {
      providerKind: "ollama",
      model: request.model,
      content: streamed.content,
      finishReason: streamed.finishReason
    };
  }

  const parsed = (await response.json()) as {
    message?: { content?: string };
    done_reason?: string;
  };

  return {
    providerKind: "ollama",
    model: request.model,
    content: parsed.message?.content ?? "",
    finishReason: parsed.done_reason
  };
}

async function requestAnthropicChat(request: ProviderChatRequest): Promise<ChatCompletionResult> {
  const apiKey = ensureApiKey(request.config);
  const system = request.messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");
  const messages = request.messages
    .filter((message) => message.role !== "system")
    .map((message) => ({
      role: message.role,
      content: message.content
    }));

  const response = await fetch(request.config.provider.baseUrl ?? "https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    signal: AbortSignal.timeout(request.config.provider.requestTimeoutSeconds * 1_000),
    body: JSON.stringify({
      model: request.model,
      max_tokens: request.config.provider.maxOutputTokens,
      system,
      messages
    })
  });

  if (!response.ok) {
    throw new Error(`Anthropic chat failed with HTTP ${response.status}.`);
  }

  const parsed = (await response.json()) as {
    stop_reason?: string;
    content?: Array<{ type?: string; text?: string }>;
  };
  const content = parsed.content
    ?.filter((item) => item.type === "text")
    .map((item) => item.text ?? "")
    .join("") ?? "";

  if (request.onToken && content) {
    await request.onToken(content);
  }

  return {
    providerKind: "anthropic",
    model: request.model,
    content,
    finishReason: parsed.stop_reason
  };
}

async function requestOpenAiCompatibleChat(request: ProviderChatRequest): Promise<ChatCompletionResult> {
  const apiKey = ensureApiKey(request.config);
  const baseUrl = request.config.provider.baseUrl;

  if (!baseUrl) {
    throw new Error("provider.baseUrl is required for openai-compatible mode.");
  }

  const response = await fetch(baseUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`
    },
    signal: AbortSignal.timeout(request.config.provider.requestTimeoutSeconds * 1_000),
    body: JSON.stringify({
      model: request.model,
      messages: request.messages,
      stream: false
    })
  });

  if (!response.ok) {
    throw new Error(`OpenAI-compatible chat failed with HTTP ${response.status}.`);
  }

  const parsed = (await response.json()) as {
    choices?: Array<{
      finish_reason?: string;
      message?: { content?: string };
    }>;
  };
  const choice = parsed.choices?.[0];
  const content = choice?.message?.content ?? "";

  if (request.onToken && content) {
    await request.onToken(content);
  }

  return {
    providerKind: "openai-compatible",
    model: request.model,
    content,
    finishReason: choice?.finish_reason
  };
}

export async function requestChatCompletion(request: ProviderChatRequest): Promise<ChatCompletionResult> {
  try {
    switch (request.providerKind) {
      case "ollama":
        return requestOllamaChat(request);
      case "anthropic":
        return requestAnthropicChat(request);
      case "openai-compatible":
        return requestOpenAiCompatibleChat(request);
      case "none":
      default:
        throw new Error(`Provider ${request.providerKind} cannot serve chat completions.`);
    }
  } catch (error) {
    throw new Error(`Chat completion failed: ${toErrorMessage(error)}`);
  }
}

export async function listOllamaModels(config: MicroClawConfig): Promise<OllamaModelSummary[]> {
  const response = await fetch(`${config.provider.ollamaHost}/api/tags`, {
    signal: AbortSignal.timeout(config.provider.requestTimeoutSeconds * 1_000)
  });

  if (!response.ok) {
    throw new Error(`Ollama model listing failed with HTTP ${response.status}.`);
  }

  const parsed = (await response.json()) as {
    models?: Array<{ name?: string; size?: number }>;
  };

  return (
    parsed.models
      ?.filter((item): item is { name: string; size?: number } => typeof item.name === "string" && item.name.length > 0)
      .map((item) => ({
        name: item.name,
        size: item.size
      })) ?? []
  );
}

export function resolveOllamaModel(
  availableModels: OllamaModelSummary[],
  desiredModel: string,
  configuredModel?: string
): string {
  const desired = availableModels.find((model) => model.name === desiredModel)?.name;
  if (desired) {
    return desired;
  }

  if (configuredModel) {
    const configured = availableModels.find((model) => model.name === configuredModel)?.name;
    if (configured) {
      return configured;
    }
  }

  const smallest = [...availableModels].sort((left, right) => (left.size ?? Number.MAX_SAFE_INTEGER) - (right.size ?? Number.MAX_SAFE_INTEGER))[0];
  if (smallest?.name) {
    return smallest.name;
  }

  return desiredModel || configuredModel || "";
}
