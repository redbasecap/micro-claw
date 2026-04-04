import { describe, expect, it, vi, beforeEach } from "vitest";
import type { MicroClawConfig } from "../src/core/types.js";
import { routeTaskWithMemoryAwareness, createMemoryAwareRouter } from "../src/router/memory-aware-router";

describe("Memory-Aware Router", () => {
  const mockConfig: MicroClawConfig = {
    runtime: { mode: "local", localFallback: true, stream: true, diskBackedMemory: true, inMemoryRetrieval: false, maxParallelRequests: 1 },
    provider: { kind: "ollama", model: "test-model", apiKeyEnv: "", requestTimeoutSeconds: 60, maxOutputTokens: 4096, ollamaHost: "http://localhost:11434" },
    context: { keepRecentMessages: 10, keepFullTranscriptInMemory: false, summarizeAfterEachStep: true, maxOpenFiles: 100, maxFileCharsPerFile: 50000 },
    tools: { shellEnabled: true, patchEnabled: true, maxCommandSeconds: 30, captureCommandOutputLimit: 10000 },
    policy: { preferMinRam: false, startOllamaAutomatically: true, allowRemoteProvider: true, requireExplicitOptInForLocalModel: false },
    security: { requireSecretgate: false, proxyEnvNames: [], certEnvNames: [], expectedProxyHosts: [], expectedProxyPort: 8080, heartbeatFile: "", heartbeatJsonFile: "", defaultHeartbeatIntervalSeconds: 60 },
    profiles: { planner: "micro-claw-planner", coder: "micro-claw-coder", fallback: "micro-claw-fallback" },
    assistant: { enabled: false, stateFile: "", summaryFile: "", statusFile: "", statusJsonFile: "", workspacesDir: "", schedulesFile: "", schedulesSummaryFile: "", recentConversationMessages: 10, maxNotesPerUser: 100, maxTodosPerUser: 50, maxRemindersPerUser: 50 },
    telegram: { enabled: false, botTokenEnv: "", apiBaseUrl: "", allowedChatIds: [], pollIntervalMs: 5000, longPollSeconds: 30, stateFile: "" }
  };

  const mockRepoSummary = {
    root: "/test",
    fileCount: 100,
    packageManager: "npm",
    detectedStacks: ["typescript"],
    entryPoints: ["src/index.ts"],
    buildCommands: ["npm run build"],
    testCommands: ["npm test"],
    importantFiles: ["package.json"],
    topLevelDirectories: ["src", "test"],
    notes: []
  };

  describe("routeTaskWithMemoryAwareness", () => {
    it("should route to remote mode when config is remote", () => {
      const remoteConfig = { ...mockConfig, runtime: { ...mockConfig.runtime, mode: "remote" as const } };
      const result = routeTaskWithMemoryAwareness(remoteConfig, mockRepoSummary, "test task");
      
      expect(result.runtimeMode).toBe("remote");
    });

    it("should include memory pressure in routing decision", () => {
      const result = routeTaskWithMemoryAwareness(mockConfig, mockRepoSummary, "test task");
      
      expect(result.memoryPressure).toBeDefined();
      expect(result.memoryPressure.level).toMatch(/low|medium|high|critical/);
    });

    it("should use fallback model for complex tasks when memory allows", () => {
      const complexTask = "refactor multi-file feature migration across architecture";
      const result = routeTaskWithMemoryAwareness(mockConfig, mockRepoSummary, complexTask);
      
      expect(result.coderModel).toBeDefined();
    });

    it("should include reason for routing decision", () => {
      const result = routeTaskWithMemoryAwareness(mockConfig, mockRepoSummary, "simple task");
      
      expect(result.reason).toBeDefined();
      expect(result.reason.length).toBeGreaterThan(0);
    });
  });

  describe("createMemoryAwareRouter", () => {
    it("should create router with all methods", () => {
      const router = createMemoryAwareRouter(mockConfig);
      
      expect(typeof router.route).toBe("function");
      expect(typeof router.checkMemory).toBe("function");
      expect(typeof router.assessPressure).toBe("function");
    });

    it("should route tasks correctly", () => {
      const router = createMemoryAwareRouter(mockConfig);
      const result = router.route(mockRepoSummary, "test task");
      
      expect(result.runtimeMode).toBeDefined();
      expect(result.memoryPressure).toBeDefined();
    });

    it("should check memory", () => {
      const router = createMemoryAwareRouter(mockConfig);
      const memory = router.checkMemory();
      
      expect(memory.totalMb).toBeGreaterThan(0);
      expect(memory.pressure).toMatch(/low|medium|high|critical/);
    });

    it("should assess pressure", () => {
      const router = createMemoryAwareRouter(mockConfig);
      const pressure = router.assessPressure();
      
      expect(pressure.level).toBeDefined();
      expect(pressure.recommendation).toBeDefined();
    });
  });
});
