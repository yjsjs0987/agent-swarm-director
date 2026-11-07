/**
 * ASD Subagent Log Scanner (src/core/subagent-logs.ts)
 *
 * Pure data service for scanning subagent execution logs from .asd/sessions/.
 * No UI/server dependencies.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface SubagentLogRecord {
  sessionId: string;
  subSessionId: string;
  taskId: string;
  role: string;
  harness: string;
  model: string;
  harnessSessionId?: string | null;
  status: string;
  pid?: number;
  worktreePath?: string | null;
  allowedFiles?: string[];
  startedAt: number;
  finishedAt?: number;
  prompt: string;
  outputLog: string;
  artifactsPurged: boolean;
  dirPath: string;
}

export function scanSubagentLogs(projectRoot: string): SubagentLogRecord[] {
  const sessionsRoot = path.join(path.resolve(projectRoot), ".asd", "sessions");
  if (!fs.existsSync(sessionsRoot)) {
    return [];
  }

  const records: SubagentLogRecord[] = [];

  try {
    const sessionDirs = fs.readdirSync(sessionsRoot, { withFileTypes: true });
    for (const sDir of sessionDirs) {
      if (!sDir.isDirectory()) continue;
      const subagentsDir = path.join(sessionsRoot, sDir.name, "subagents");
      if (!fs.existsSync(subagentsDir)) continue;

      const subDirs = fs.readdirSync(subagentsDir, { withFileTypes: true });
      for (const subDir of subDirs) {
        if (!subDir.isDirectory()) continue;
        const dirPath = path.join(subagentsDir, subDir.name);
        const metaPath = path.join(dirPath, "meta.json");
        if (!fs.existsSync(metaPath)) continue;

        try {
          const metaStat = fs.statSync(metaPath);
          const meta = JSON.parse(fs.readFileSync(metaPath, "utf8")) as Record<string, unknown>;
          const promptPath = path.join(dirPath, "prompt.md");
          const outputPath = path.join(dirPath, "output.log");
          const hasPrompt = fs.existsSync(promptPath);
          const hasOutput = fs.existsSync(outputPath);
          const prompt = hasPrompt ? fs.readFileSync(promptPath, "utf8") : "";
          const outputLog = hasOutput ? fs.readFileSync(outputPath, "utf8") : "";
          const artifactsPurged = !hasPrompt && !hasOutput;
          const startedAt =
            typeof meta.startedAt === "number" && meta.startedAt > 0
              ? meta.startedAt
              : Math.round(metaStat.birthtimeMs || metaStat.mtimeMs || 0);
          records.push({
            sessionId: String(meta.parentSessionId ?? meta.mainSessionId ?? sDir.name),
            subSessionId: String(meta.subSessionId ?? subDir.name),
            taskId: String(meta.taskId ?? ""),
            role: String(meta.role ?? ""),
            harness: String(meta.harness ?? ""),
            model: String(meta.model ?? ""),
            harnessSessionId:
              typeof meta.harnessSessionId === "string" && meta.harnessSessionId.trim()
                ? meta.harnessSessionId.trim()
                : null,
            status: String(meta.status ?? "unknown"),
            pid: typeof meta.pid === "number" ? meta.pid : undefined,
            worktreePath: typeof meta.worktreePath === "string" ? meta.worktreePath : null,
            allowedFiles: Array.isArray(meta.allowedFiles)
              ? meta.allowedFiles.map((x) => String(x))
              : [],
            startedAt,
            finishedAt: typeof meta.finishedAt === "number" ? meta.finishedAt : undefined,
            prompt,
            outputLog,
            artifactsPurged,
            dirPath,
          });
        } catch {
          // Ignore malformed subagent meta
        }
      }
    }
  } catch {
    return [];
  }

  records.sort((a, b) => b.startedAt - a.startedAt);
  return records;
}

export function runAsdLogs(options?: {
  taskId?: string;
  projectRoot?: string;
  homeDir?: string;
}): { found: boolean; record: SubagentLogRecord | null; availableTaskIds: string[] } {
  const projectRoot = path.resolve(options?.projectRoot || process.cwd());
  const records = scanSubagentLogs(projectRoot);
  if (records.length === 0) {
    return { found: false, record: null, availableTaskIds: [] };
  }

  const targetTaskId = options?.taskId?.trim().toUpperCase();
  const availableTaskIds = [...new Set(records.map((r) => r.taskId || r.subSessionId).filter(Boolean))];

  const matched = targetTaskId
    ? records.find(
        (r) =>
          r.taskId.toUpperCase() === targetTaskId ||
          r.subSessionId.toUpperCase() === targetTaskId ||
          r.subSessionId.toUpperCase().includes(targetTaskId)
      ) ?? null
    : records[0] ?? null;

  return {
    found: matched !== null,
    record: matched,
    availableTaskIds,
  };
}