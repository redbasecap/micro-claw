import os from "node:os";
import { execSync } from "node:child_process";
import type { MicroClawConfig, RepoSummary, RouterDecision, SystemMemoryStatus } from "../core/types.js";

export interface MemoryPressureLevel {
  level: "low" | "medium" | "high" | "critical";
  availableMb: number;
  totalMb: number;
  usedPercent: number;
  ollamaMemoryMb?: number;
  recommendation: string;
}

export function checkSystemMemory(): SystemMemoryStatus {
  const totalMb = Math.round(os.totalmem() / (1024 * 1024));
  const freeMb = Math.round(os.freemem() / (1024 * 1024));
  const usedMb = totalMb - freeMb;
  const usedPercent = (usedMb / totalMb) * 100;
  
  let ollamaMemoryMb: number | undefined;
  try {
    const psOutput = execSync("ps aux | grep ollama | grep -v grep || echo ''", {
      encoding: "utf-8",
      timeout: 5000
    }).trim();
    
    if (psOutput && !psOutput.includes("grep")) {
      const match = psOutput.match(/RSS.*?\s+(\d+)/);
      if (match) {
        ollamaMemoryMb = Math.round(parseInt(match[1], 10) / 1024);
      }
    }
  } catch {
    // Ollama memory check failed, ignore
  }
  
  let level: SystemMemoryStatus["pressure"] = "low";
  if (usedPercent >= 90) level = "critical";
  else if (usedPercent >= 80) level = "high";
  else if (usedPercent >= 70) level = "medium";
  
  return {
    totalMb,
    freeMb,
    usedMb,
    usedPercent,
    pressure: level,
    ollamaMemoryMb
  };
}

export function assessMemoryPressure(config: MicroClawConfig): MemoryPressureLevel {
  const mem = checkSystemMemory();
  
  let level: MemoryPressureLevel["level"];
  let recommendation: string;
  
  if (mem.usedPercent >= 90) {
    level = "critical";
    recommendation = "Switch to remote mode or use smallest available model. Consider terminating background processes.";
  } else if (mem.usedPercent >= 80) {
    level = "high";
    recommendation = "Use smaller model profile. Consider clearing caches or switching to remote API mode.";
  } else if (mem.usedPercent >= 70) {
    level = "medium";
    recommendation = "Monitor memory usage. Prefer balanced profiles over large fallback models.";
  } else {
    level = "low";
    recommendation = "Memory pressure is low. All model profiles should work well.";
  }
  
  if (mem.ollamaMemoryMb && mem.ollamaMemoryMb > 12000) {
    if (level !== "critical") {
      level = "high";
      recommendation = `Ollama is using ${mem.ollamaMemoryMb}MB. Consider using a smaller model or remote mode.`;
    }
  }
  
  return {
    level,
    availableMb: mem.freeMb,
    totalMb: mem.totalMb,
    usedPercent: mem.usedPercent,
    ollamaMemoryMb: mem.ollamaMemoryMb,
    recommendation
  };
}

export function getRecommendedModelProfile(
  config: MicroClawConfig,
  memoryPressure: MemoryPressureLevel,
  requestedComplexity: number
): string {
  if (memoryPressure.level === "critical" || memoryPressure.level === "high") {
    return config.profiles.planner;
  }
  
  if (memoryPressure.level === "medium") {
    if (requestedComplexity >= 3) {
      return config.profiles.coder;
    }
    return config.profiles.planner;
  }
  
  if (requestedComplexity >= 3) {
    return config.profiles.fallback;
  }
  
  return config.profiles.coder;
}

export function shouldSwitchToRemoteMode(
  config: MicroClawConfig,
  memoryPressure: MemoryPressureLevel
): boolean {
  if (memoryPressure.level === "critical") {
    return true;
  }
  
  if (memoryPressure.level === "high" && config.policy.preferMinRam) {
    return true;
  }
  
  return false;
}

function scoreComplexity(task: string, repoSummary: RepoSummary): number {
  let score = 0;

  if (repoSummary.fileCount > 250) {
    score += 1;
  }

  if (repoSummary.fileCount > 1_000) {
    score += 1;
  }

  if (repoSummary.detectedStacks.length > 2) {
    score += 1;
  }

  if (/\b(refactor|multi|across|feature|migration|architecture|runtime)\b/i.test(task)) {
    score += 1;
  }

  if (
    /\b(repo|repository|all files|every file|readme|documentation|summary|overview|tool|workflow|agent|grep|search|scan|durchsuche|durchsuchen|dateien|dokumentation|zusammenfassung)\b/i.test(
      task
    )
  ) {
    score += 2;
  }

  if (
    /\b(add|create|write|edit|change|update|fix|document|generate|erstelle|schreibe|ändere|aendere|suche|fasse|beschreibe)\b/i.test(
      task
    )
  ) {
    score += 1;
  }

  return score;
}

export function routeTaskWithMemoryAwareness(
  config: MicroClawConfig,
  repoSummary: RepoSummary,
  task: string
): RouterDecision & { memoryPressure: MemoryPressureLevel } {
  if (config.runtime.mode === "remote") {
    const remoteModel = config.provider.model || config.profiles.coder;

    return {
      runtimeMode: "remote",
      providerKind: config.provider.kind,
      plannerModel: remoteModel,
      coderModel: remoteModel,
      fallbackModel: remoteModel,
      reason: "Remote mode is active, so routing stays on the hosted provider to minimize local RAM.",
      memoryPressure: {
        level: "low",
        availableMb: 0,
        totalMb: 0,
        usedPercent: 0,
        recommendation: "Running in remote mode."
      }
    };
  }

  const memoryPressure = assessMemoryPressure(config);
  const complexity = scoreComplexity(task, repoSummary);

  if (shouldSwitchToRemoteMode(config, memoryPressure)) {
    return {
      runtimeMode: "remote",
      providerKind: config.provider.kind,
      plannerModel: config.provider.model || config.profiles.planner,
      coderModel: config.provider.model || config.profiles.coder,
      fallbackModel: config.provider.model || config.profiles.fallback,
      reason: `Memory pressure is ${memoryPressure.level} (${memoryPressure.usedPercent.toFixed(0)}% used). Switching to remote mode.`,
      memoryPressure
    };
  }

  const recommendedModel = getRecommendedModelProfile(config, memoryPressure, complexity);
  
  let coderModel: string;
  if (memoryPressure.level === "medium" && complexity >= 3) {
    coderModel = config.profiles.coder;
  } else if (memoryPressure.level === "low" && complexity >= 3) {
    coderModel = config.profiles.fallback;
  } else if (memoryPressure.level === "high") {
    coderModel = config.profiles.planner;
  } else {
    coderModel = config.profiles.coder;
  }

  return {
    runtimeMode: "local",
    providerKind: "ollama",
    plannerModel: config.profiles.planner,
    coderModel,
    fallbackModel: config.profiles.fallback,
    reason: `Memory at ${memoryPressure.usedPercent.toFixed(0)}%, pressure ${memoryPressure.level}. Using ${coderModel} for this task.`,
    memoryPressure
  };
}

export function createMemoryAwareRouter(config: MicroClawConfig) {
  return {
    route: (repoSummary: RepoSummary, task: string) =>
      routeTaskWithMemoryAwareness(config, repoSummary, task),
    checkMemory: () => checkSystemMemory(),
    assessPressure: () => assessMemoryPressure(config)
  };
}
