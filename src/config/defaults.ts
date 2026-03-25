import type { MicroClawConfig } from "../core/types.js";

export const defaultConfig: MicroClawConfig = {
  runtime: {
    mode: "local",
    localFallback: true,
    stream: true,
    diskBackedMemory: true,
    inMemoryRetrieval: false,
    maxParallelRequests: 1
  },
  provider: {
    kind: "ollama",
    model: "qwen3-coder:30b",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    requestTimeoutSeconds: 120,
    maxOutputTokens: 4096,
    baseUrl: "https://api.anthropic.com/v1/messages",
    ollamaHost: "http://127.0.0.1:11434"
  },
  context: {
    keepRecentMessages: 8,
    keepFullTranscriptInMemory: false,
    summarizeAfterEachStep: true,
    maxOpenFiles: 6,
    maxFileCharsPerFile: 24_000
  },
  tools: {
    shellEnabled: true,
    patchEnabled: true,
    maxCommandSeconds: 120,
    captureCommandOutputLimit: 12_000
  },
  policy: {
    preferMinRam: false,
    startOllamaAutomatically: false,
    allowRemoteProvider: true,
    requireExplicitOptInForLocalModel: true
  },
  security: {
    requireSecretgate: true,
    proxyEnvNames: ["https_proxy", "HTTPS_PROXY", "http_proxy", "HTTP_PROXY"],
    certEnvNames: ["SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS"],
    expectedProxyHosts: ["127.0.0.1", "localhost", "::1"],
    expectedProxyPort: 8083,
    heartbeatFile: "heartbeat.md",
    heartbeatJsonFile: ".micro-claw/heartbeat.json",
    defaultHeartbeatIntervalSeconds: 300
  },
  profiles: {
    planner: "micro-claw-planner",
    coder: "micro-claw-coder",
    fallback: "qwen3-coder:30b"
  },
  assistant: {
    enabled: true,
    stateFile: ".micro-claw/assistant/state.json",
    summaryFile: ".micro-claw/assistant/state.md",
    statusFile: ".micro-claw/assistant/status.md",
    statusJsonFile: ".micro-claw/assistant/status.json",
    workspacesDir: ".micro-claw/assistant/chats",
    schedulesFile: ".micro-claw/assistant/schedules.json",
    schedulesSummaryFile: ".micro-claw/assistant/schedules.md",
    recentConversationMessages: 8,
    maxNotesPerUser: 50,
    maxTodosPerUser: 50,
    maxRemindersPerUser: 50
  },
  telegram: {
    enabled: true,
    botTokenEnv: "TELEGRAM_BOT_TOKEN",
    apiBaseUrl: "https://api.telegram.org",
    allowedChatIds: [],
    pollIntervalMs: 2_000,
    longPollSeconds: 20,
    stateFile: ".micro-claw/telegram/state.json"
  }
};
