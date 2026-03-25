import type { MicroClawConfig, ProviderDiagnostic } from "../core/types.js";
import { toErrorMessage } from "../core/utils.js";

async function probeOllama(config: MicroClawConfig): Promise<ProviderDiagnostic> {
  const checkedAt = new Date().toISOString();

  try {
    const response = await fetch(`${config.provider.ollamaHost}/api/tags`, {
      signal: AbortSignal.timeout(config.provider.requestTimeoutSeconds * 1_000)
    });

    if (!response.ok) {
      return {
        kind: "ollama",
        ok: false,
        checkedAt,
        message: `Ollama responded with HTTP ${response.status}.`
      };
    }

    const body = (await response.json()) as { models?: Array<{ name?: string }> };

    return {
      kind: "ollama",
      ok: true,
      checkedAt,
      message: "Ollama is reachable.",
      details: {
        models: body.models?.map((item) => item.name).filter(Boolean) ?? []
      }
    };
  } catch (error) {
    return {
      kind: "ollama",
      ok: false,
      checkedAt,
      message: `Ollama probe failed: ${toErrorMessage(error)}`
    };
  }
}

function probeRemoteEnv(config: MicroClawConfig): ProviderDiagnostic {
  const checkedAt = new Date().toISOString();
  const envName = config.provider.apiKeyEnv;
  const hasKey = Boolean(process.env[envName]);

  return {
    kind: config.provider.kind,
    ok: hasKey,
    checkedAt,
    message: hasKey ? `Found ${envName} in the environment.` : `Missing ${envName} in the environment.`,
    details: {
      env: envName,
      model: config.provider.model,
      baseUrl: config.provider.baseUrl
    }
  };
}

export async function diagnoseProvider(config: MicroClawConfig): Promise<ProviderDiagnostic> {
  if (config.runtime.mode === "local" || config.provider.kind === "ollama") {
    return probeOllama(config);
  }

  if (config.provider.kind === "none") {
    return {
      kind: "none",
      ok: false,
      checkedAt: new Date().toISOString(),
      message: "No provider is configured."
    };
  }

  return probeRemoteEnv(config);
}
