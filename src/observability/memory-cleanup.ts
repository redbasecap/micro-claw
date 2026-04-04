import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ObservabilityMetrics } from "./types.js";
import { getAuditLogger } from "./audit-logger.js";

interface CleanupOptions {
  maxSessionAgeHours: number;
  maxSessionsToKeep: number;
  maxSessionSizeMb: number;
  cleanEmptyDirs: boolean;
  trackMetrics: boolean;
}

const DEFAULT_CLEANUP_OPTIONS: CleanupOptions = {
  maxSessionAgeHours: 72,
  maxSessionsToKeep: 50,
  maxSessionSizeMb: 100,
  cleanEmptyDirs: true,
  trackMetrics: true
};

export function calculateDirectorySize(dirPath: string): number {
  let totalSize = 0;
  
  try {
    const entries = readdirSync(dirPath, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      
      if (entry.isDirectory()) {
        totalSize += calculateDirectorySize(fullPath);
      } else {
        const stats = statSync(fullPath);
        totalSize += stats.size;
      }
    }
  } catch {
    // Ignore permission errors
  }
  
  return totalSize;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function getSessionAge(sessionPath: string): number {
  try {
    const stats = statSync(sessionPath);
    const ageMs = Date.now() - stats.mtime.getTime();
    return ageMs / (1000 * 60 * 60);
  } catch {
    return Infinity;
  }
}

export interface CleanupResult {
  cleanedSessions: string[];
  freedBytes: number;
  freedBytesFormatted: string;
  remainingSessions: number;
  errors: string[];
}

export function cleanupOldSessions(
  rootDir: string,
  options: Partial<CleanupOptions> = {}
): CleanupResult {
  const opts = { ...DEFAULT_CLEANUP_OPTIONS, ...options };
  const sessionsDir = path.join(rootDir, ".micro-claw", "sessions");
  const audit = getAuditLogger();
  
  const result: CleanupResult = {
    cleanedSessions: [],
    freedBytes: 0,
    freedBytesFormatted: "0 B",
    remainingSessions: 0,
    errors: []
  };

  if (!existsSync(sessionsDir)) {
    return result;
  }

  try {
    const sessions = getSessionDirectories(sessionsDir)
      .map((sessionPath) => {
        const stats = statSync(sessionPath);
        return {
          name: path.basename(sessionPath),
          path: sessionPath,
          ageHours: getSessionAge(sessionPath),
          sizeBytes: calculateDirectorySize(sessionPath),
          mtimeMs: stats.mtime.getTime()
        };
      })
      .sort((a, b) => a.mtimeMs - b.mtimeMs);

    const toClean: typeof sessions = [];
    const toKeep: typeof sessions = [];

    for (const session of sessions) {
      if (
        session.ageHours >= opts.maxSessionAgeHours ||
        session.sizeBytes > opts.maxSessionSizeMb * 1024 * 1024
      ) {
        toClean.push(session);
      } else {
        toKeep.push(session);
      }
    }

    if (toKeep.length > opts.maxSessionsToKeep) {
      const overflowCount = toKeep.length - opts.maxSessionsToKeep;
      toClean.push(...toKeep.slice(0, overflowCount));
    }

    for (const session of toClean) {
      try {
        const size = calculateDirectorySize(session.path);
        deleteDirectory(session.path);
        if (!existsSync(session.path)) {
          result.cleanedSessions.push(session.name);
          result.freedBytes += size;
          
          audit.log(
            "memory_cleanup",
            `Cleaned session ${session.name}: ${formatBytes(size)} freed`,
            "info",
            { sessionName: session.name, ageHours: session.ageHours, sizeBytes: size }
          );
        } else {
          result.errors.push(`Failed to clean ${session.name}: directory still exists after deletion attempt`);
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        result.errors.push(`Failed to clean ${session.name}: ${msg}`);
      }
    }

    if (opts.cleanEmptyDirs) {
      cleanupEmptyDirectories(sessionsDir);
    }

    result.remainingSessions = getSessionDirectories(sessionsDir).length;
  } catch (error) {
    result.errors.push(error instanceof Error ? error.message : String(error));
  }

  result.freedBytesFormatted = formatBytes(result.freedBytes);
  return result;
}

function deleteDirectory(dirPath: string): void {
  if (!existsSync(dirPath)) return;
  rmSync(dirPath, { recursive: true, force: true });
}

function cleanupEmptyDirectories(rootDir: string): void {
  try {
    const entries = readdirSync(rootDir, { withFileTypes: true });
    
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const fullPath = path.join(rootDir, entry.name);
        cleanupEmptyDirectories(fullPath);
        
        if (existsSync(fullPath) && readdirSync(fullPath).length === 0) {
          rmSync(fullPath, { recursive: false, force: false });
        }
      }
    }
  } catch {
    // Ignore errors during cleanup
  }
}

function getSessionDirectories(sessionsDir: string): string[] {
  if (!existsSync(sessionsDir)) {
    return [];
  }

  return readdirSync(sessionsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(sessionsDir, entry.name));
}

export function getMemoryMetrics(rootDir: string): ObservabilityMetrics["memory"] {
  const sessionsDir = path.join(rootDir, ".micro-claw", "sessions");
  
  let totalSize = 0;
  let fileCount = 0;
  
  if (existsSync(sessionsDir)) {
    totalSize = calculateDirectorySize(sessionsDir);
    const sessions = readdirSync(sessionsDir, { withFileTypes: true });
    for (const session of sessions) {
      if (session.isDirectory()) {
        fileCount += countFiles(path.join(sessionsDir, session.name));
      }
    }
  }

  const usedMb = totalSize / (1024 * 1024);
  
  return {
    avgUsedMb: usedMb,
    peakUsedMb: usedMb,
    pressureEvents: 0
  };
}

function countFiles(dirPath: string): number {
  let count = 0;
  try {
    const entries = readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        count += countFiles(path.join(dirPath, entry.name));
      } else {
        count++;
      }
    }
  } catch {
    // Ignore errors
  }
  return count;
}

export function writeMetricsSnapshot(
  rootDir: string,
  metrics: ObservabilityMetrics
): void {
  const metricsDir = path.join(rootDir, ".micro-claw", "metrics");
  
  if (!existsSync(metricsDir)) {
    mkdirSync(metricsDir, { recursive: true });
  }

  const date = new Date().toISOString().split("T")[0];
  const filePath = path.join(metricsDir, `metrics-${date}.json`);
  
  let snapshots: ObservabilityMetrics[] = [];
  
  if (existsSync(filePath)) {
    try {
      snapshots = JSON.parse(readFileSync(filePath, "utf-8"));
    } catch {
      snapshots = [];
    }
  }
  
  snapshots.push(metrics);
  
  const maxSnapshots = 24 * 7;
  if (snapshots.length > maxSnapshots) {
    snapshots = snapshots.slice(-maxSnapshots);
  }
  
  writeFileSync(filePath, JSON.stringify(snapshots, null, 2));
}

export function getStorageInfo(rootDir: string): {
  sessionsSize: string;
  sessionsCount: number;
  oldestSession: string | null;
  newestSession: string | null;
} {
  const sessionsDir = path.join(rootDir, ".micro-claw", "sessions");
  
  if (!existsSync(sessionsDir)) {
    return {
      sessionsSize: "0 B",
      sessionsCount: 0,
      oldestSession: null,
      newestSession: null
    };
  }

  const sessions = readdirSync(sessionsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({
      name: e.name,
      path: path.join(sessionsDir, e.name),
      mtime: statSync(path.join(sessionsDir, e.name)).mtime.getTime()
    }))
    .sort((a, b) => a.mtime - b.mtime);

  return {
    sessionsSize: formatBytes(calculateDirectorySize(sessionsDir)),
    sessionsCount: sessions.length,
    oldestSession: sessions.length > 0 ? sessions[0].name : null,
    newestSession: sessions.length > 0 ? sessions[sessions.length - 1].name : null
  };
}
