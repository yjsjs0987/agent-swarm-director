/**
 * ASD Session Services (src/core/session-services.ts)
 *
 * Pure data services for session memo management and dashboard state snapshots.
 * No UI/server dependencies.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { atomicWriteFileSync, renderPlanMd } from "./render.ts";
import {
  type DebateRow,
  type DriverRow,
  openProjectDb,
  type SessionRow,
  SqliteDriver,
  type TaskRow,
} from "./db.ts";
import {
  buildDefaultHarnessCommand,
  buildRound1Prompt,
  buildRound2Prompt,
  parseReviewerOpening,
  synthesizeInsightVerdict,
} from "./debate.ts";
import {
  createTaskWorktree,
  verifyAndCommitLightTask,
  verifyAndMergeHeavyTask,
} from "./workspace.ts";
import {
  inferModelFamily,
  normalizeAgentRole,
  resolveFallback,
  resolveNextLightSubagentFallback,
} from "./router.ts";
import {
  type CommandRunner,
  DEFAULT_DEBATE_TIMEOUT_MS,
  DEFAULT_IDLE_TIMEOUT_MS,
  killProcessTree,
  finalizeSubagentArtifacts,
  spawnSubagent,
} from "./spawner.ts";
import { buildPromptForTask } from "../mcp/server.ts";
import { buildResumeHarnessCommand, readCliRecentSessions } from "./session-tracker.ts";
import { loadRoutingConfig, resolveAsdPaths } from "./config.ts";
import { scanSubagentLogs, type SubagentLogRecord } from "./subagent-logs.ts";
import { runAsdDoctor, syncAgentModelsIfNeeded } from "../adapters/installer.ts";
import type { CliRecentSessionEntry } from "./types.ts";
import type { HarnessModelCatalog, DashboardSnapshot } from "./models.ts";
import { discoverHarnessModels } from "./models.ts";
import { ASD_VERSION } from "./types.ts";

const doctorCache = new Map<string, DashboardSnapshot["harnesses"]>();
const modelCatalogCache = new Map<string, HarnessModelCatalog>();

const worktreeStatusCache = new Map<
  string,
  { lines: string[]; expiresAt: number }
>();
const WORKTREE_STATUS_CACHE_TTL_MS = 3500;

const transcriptSyncThrottleCache = new Map<string, number>();
export const TRANSCRIPT_SYNC_THROTTLE_MS = 15_000;

export function resetDashboardTranscriptSyncThrottle(): void {
  transcriptSyncThrottleCache.clear();
}

function readMainJsonMeta(projectRoot: string, sessionId: string): Record<string, unknown> | null {
  try {
    const mainJsonPath = path.join(projectRoot, ".asd", "sessions", sessionId, "main.json");
    if (!fs.existsSync(mainJsonPath)) return null;
    return JSON.parse(fs.readFileSync(mainJsonPath, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }

}

function tryRefreshDebateVerdictFromLog(
  projectRoot: string,
  homeDir: string | undefined,
  sessionId: string,
  taskId: string,
  subSessionId: string,
  role: string,
  harness: string,
  model: string,
  rawOutput: string
): void {
  const parsed = parseReviewerOpening(rawOutput);
  if (!parsed) return;

  const paths = resolveAsdPaths(projectRoot, homeDir);
  if (!fs.existsSync(paths.dbPath)) return;

  const realSessionId = sessionId.includes("::")
    ? sessionId.split("::")[0]!
    : sessionId;

  let db: SqliteDriver | undefined;
  try {
    db = openProjectDb(projectRoot, homeDir);
    const debates = db.getSessionDebates(realSessionId);
    const debMatch = subSessionId.match(/-deb-(D-[A-Za-z0-9-]+)-/);
    const debateId = debMatch?.[1] || taskId;
    const debateRow = debates.find(
      (d) => d.debate_id === debateId || (d.task_id && d.task_id === taskId)
    );
    if (!debateRow) return;

    let r1: { openings?: Array<Record<string, unknown>>; failedReviewers?: unknown[] } = {
      openings: [],
      failedReviewers: [],
    };
    try {
      if (debateRow.round1_bundle_json) {
        r1 = JSON.parse(debateRow.round1_bundle_json);
      }
    } catch {}

    const openings = Array.isArray(r1.openings) ? r1.openings : [];
    const newOpening = {
      reviewerId: subSessionId,
      role,
      harness,
      model,
      modelFamily: inferModelFamily(model, harness as import("./types.ts").HarnessId),
      verdict: parsed.verdict,
      hard_constraints: parsed.hard_constraints,
      decisions: parsed.decisions,
      risks: parsed.risks,
      reasoning: parsed.reasoning,
      rawOutput,
    };

    const existingIdx = openings.findIndex(
      (o) => o.role === role && o.harness === harness
    );
    if (existingIdx >= 0) {
      openings[existingIdx] = newOpening;
    } else {
      openings.push(newOpening);
    }

    const insightVerdict = synthesizeInsightVerdict(openings);

    db.updateDebateVerdict(debateRow.debate_id, "done", {
      round1BundleJson: JSON.stringify({
        openings,
        failedReviewers: r1.failedReviewers ?? [],
      }),
      insightVerdictJson: JSON.stringify(insightVerdict),
    });
  } catch {
    // Ignore DB refresh error
  } finally {
    db?.close();
  }
}

export function saveSessionMemo(options: {
  projectRoot: string;
  homeDir?: string;
  sessionId: string;
  memo: string;
}): { ok: boolean; sessionId: string; memo: string } {
  const projectRoot = path.resolve(options.projectRoot);
  const sessionId = options.sessionId.trim();
  const memo = options.memo.trim().slice(0, 80);

  if (!sessionId || /[\\/]|\.\./.test(sessionId)) {
    throw new Error("Invalid sessionId");
  }

  // Handle virtual standalone debate session IDs (`<realSessionId>::<debateId>`)
  const virtualSplitIdx = sessionId.indexOf("::");
  const realSessionId =
    virtualSplitIdx !== -1 ? sessionId.slice(0, virtualSplitIdx) : sessionId;

  let db: SqliteDriver | undefined;
  try {
    db = openProjectDb(projectRoot, options.homeDir);
    const existing = db.getSession(realSessionId);
    if (!existing) {
      db.createOrGetSession({
        sessionId: realSessionId,
        projectRoot,
        mainHarness: "claude-code",
        memo,
      });
    } else if (virtualSplitIdx === -1) {
      db.updateSessionMemo(realSessionId, memo);
    }
  } finally {
    db?.close();
  }

  // Persist memo inside .asd/sessions/<realSessionId>/main.json (including per-debate memos map)
  try {
    const sessionDir = path.join(projectRoot, ".asd", "sessions", realSessionId);
    fs.mkdirSync(sessionDir, { recursive: true });
    const mainJsonPath = path.join(sessionDir, "main.json");
    const current = readMainJsonMeta(projectRoot, realSessionId) ?? {
      sessionId: realSessionId,
      roleType: "main",
      harness: "claude-code",
      role: "director",
      phase: "planning",
      pid: process.pid,
      startedAt: new Date().toISOString(),
    };
    if (virtualSplitIdx !== -1) {
      const debateId = sessionId.slice(virtualSplitIdx + 2);
      const debateMemos =
        current.debateMemos && typeof current.debateMemos === "object"
          ? (current.debateMemos as Record<string, string>)
          : {};
      debateMemos[debateId] = memo;
      current.debateMemos = debateMemos;
    } else {
      current.memo = memo;
    }
    atomicWriteFileSync(mainJsonPath, JSON.stringify(current, null, 2) + "\n");
  } catch {
    // Ignore file sync error if SQLite succeeded
  }

  return { ok: true, sessionId, memo };
}

export async function collectDashboardSnapshot(options?: {
  projectRoot?: string;
  homeDir?: string;
  skipCliSpawn?: boolean;
  syncLocalTranscripts?: boolean;
  transcriptSyncThrottleMs?: number;
}): Promise<DashboardSnapshot> {
  const projectRoot = path.resolve(options?.projectRoot || process.cwd());
  const homeDir = options?.homeDir;
  const paths = resolveAsdPaths(projectRoot, homeDir);

  let rawSessions: SessionRow[] = [];
  let allTasks: TaskRow[] = [];
  let rawDebates: DebateRow[] = [];
  const drivers: Record<string, DriverRow[]> = {};

  if (fs.existsSync(paths.dbPath)) {
    let db: SqliteDriver | undefined;
    try {
      db = openProjectDb(projectRoot, homeDir);
      rawSessions = db.listSessions();
      allTasks = db.getAllTasks();
      rawDebates = db.getAllDebates();
      for (const s of rawSessions) {
        drivers[s.session_id] = db.listDrivers(s.session_id);
      }
    } catch {
      // Ignore transient read issues
    } finally {
      db?.close();
    }
  }

  const rawSubagentLogs = scanSubagentLogs(projectRoot);

  // Backfill missing taskId on legacy debate subagent logs (`...-deb-<debateId>-r1-1`)
  const subagentLogs: SubagentLogRecord[] = rawSubagentLogs.map((l) => {
    const debMatch = l.subSessionId.match(/-deb-(D-[A-Za-z0-9-]+)-/);
    const inferredTaskId = l.taskId || debMatch?.[1] || "";
    return {
      ...l,
      taskId: inferredTaskId,
    };
  });

  // Split sessions that have multiple standalone (task_id === null) debates into
  // separate virtual session rows (`<sessionId>::<debateId>`) so historical debates
  // that were accidentally grouped under one session appear as individual entries.
  const sessionMap = new Map<string, SessionRow>();
  const allDebates: DebateRow[] = [];

  for (const s of rawSessions) {
    const mainMeta = readMainJsonMeta(projectRoot, s.session_id);
    const diskMemo = typeof mainMeta?.memo === "string" ? mainMeta.memo : "";
    const debateMemos =
      mainMeta?.debateMemos && typeof mainMeta.debateMemos === "object"
        ? (mainMeta.debateMemos as Record<string, string>)
        : {};

    const sTasks = allTasks.filter((t) => t.session_id === s.session_id);
    const sDebates = rawDebates.filter((d) => d.session_id === s.session_id);
    const standaloneDebates = sDebates.filter((d) => !d.task_id);

    if (sTasks.length === 0 && standaloneDebates.length > 1) {
      // Split each standalone debate into its own selectable session entry
      for (const d of standaloneDebates) {
        const virtualId = `${s.session_id}::${d.debate_id}`;
        const relatedLogs = subagentLogs.filter(
          (l) =>
            l.sessionId === s.session_id &&
            (l.taskId === d.debate_id || l.subSessionId.includes(`-deb-${d.debate_id}-`))
        );
        for (const rl of relatedLogs) {
          rl.sessionId = virtualId;
        }
        const startedTime =
          relatedLogs.length > 0
            ? Math.min(...relatedLogs.map((r) => r.startedAt || s.created_at))
            : s.created_at;
        const customDebateMemo = debateMemos[d.debate_id]?.trim();
        sessionMap.set(virtualId, {
          ...s,
          session_id: virtualId,
          memo: customDebateMemo || d.topic.slice(0, 40),
          created_at: startedTime,
          updated_at: startedTime,
        });
        allDebates.push({
          ...d,
          session_id: virtualId,
        });
      }
    } else {
      const autoDebateTopic = sDebates[0]?.topic ?? "";
      const autoTaskTitle = sTasks[0]?.title ?? "";
      const effectiveMemo =
        (s.memo && s.memo.trim()) ||
        diskMemo.trim() ||
        autoDebateTopic.slice(0, 40) ||
        autoTaskTitle.slice(0, 40) ||
        "";
      sessionMap.set(s.session_id, {
        ...s,
        memo: effectiveMemo,
        main_model:
          s.main_model ??
          (typeof mainMeta?.model === "string" ? mainMeta.model : null),
        harness_session_id:
          s.harness_session_id ??
          (typeof mainMeta?.harnessSessionId === "string"
            ? mainMeta.harnessSessionId
            : null),
      });
      allDebates.push(...sDebates);
    }
  }

  for (const log of subagentLogs) {
    if (!log.sessionId) continue;
    if (!sessionMap.has(log.sessionId)) {
      const mainMeta = readMainJsonMeta(projectRoot, log.sessionId);
      const diskMemo = typeof mainMeta?.memo === "string" ? mainMeta.memo : "";
      sessionMap.set(log.sessionId, {
        session_id: log.sessionId,
        project_root: projectRoot,
        main_harness: log.harness || "claude-code",
        main_pid: null,
        phase: "done",
        state_version: 1,
        base_sha: null,
        stashed_work_sha: null,
        no_progress_count: 0,
        memo: diskMemo || log.taskId || log.role || "",
        created_at: log.startedAt || Date.now(),
        updated_at: log.finishedAt || log.startedAt || Date.now(),
      });
    }
  }

  const sessions = [...sessionMap.values()].sort((a, b) => b.created_at - a.created_at);
  const session = sessions[0] ?? null;
  const tasks = session
    ? allTasks.filter((t) => t.session_id === session.session_id)
    : [];
  const debates = session
    ? allDebates.filter((d) => d.session_id === session.session_id)
    : [];

  const cacheKey = `${projectRoot}::${homeDir ?? ""}`;
  let harnesses = doctorCache.get(cacheKey);
  if (!harnesses) {
    const doctor = await runAsdDoctor({ projectRoot, homeDir });
    harnesses = doctor.harnesses;
    doctorCache.set(cacheKey, harnesses);
  }

  const routingConfig = loadRoutingConfig(projectRoot, homeDir);
  const hasLocalRouting = fs.existsSync(paths.localRoutingPath);
  const availableModels = await discoverHarnessModels({
    projectRoot,
    homeDir,
    skipCliSpawn: options?.skipCliSpawn ?? false,
  });

  const worktreeStatuses: Record<string, string[]> = {};
  const nowMs = Date.now();
  for (const t of allTasks) {
    if (t.worktree_path && fs.existsSync(t.worktree_path)) {
      const wtKey = path.resolve(t.worktree_path);
      const cachedWt = worktreeStatusCache.get(wtKey);
      if (cachedWt && cachedWt.expiresAt > nowMs) {
        if (cachedWt.lines.length > 0) {
          worktreeStatuses[`${t.session_id}::${t.task_id}`] = cachedWt.lines;
        }
        continue;
      }
      try {
        const res = child_process.spawnSync("git", ["status", "--short"], {
          cwd: t.worktree_path,
          encoding: "utf8",
          timeout: 1500,
          windowsHide: true,
        });
        if (res.status === 0 && typeof res.stdout === "string") {
          const lines = res.stdout
            .split(/\r?\n/)
            .map((l) => l.trimEnd())
            .filter((l) => l.length > 0 && !l.includes("node_modules"));
          worktreeStatusCache.set(wtKey, {
            lines,
            expiresAt: nowMs + WORKTREE_STATUS_CACHE_TTL_MS,
          });
          if (lines.length > 0) {
            worktreeStatuses[`${t.session_id}::${t.task_id}`] = lines;
          }
        }
      } catch {
        // ignore worktree status errors
      }
    }
  }

  return {
    version: ASD_VERSION,
    projectRoot,
    systemLocale: detectSystemLocale(),
    timestamp: Date.now(),
    session,
    sessions,
    tasks,
    allTasks,
    debates,
    allDebates,
    drivers,
    subagentLogs,
    cliRecentSessions: (() => {
      const throttleMs = options?.transcriptSyncThrottleMs ?? TRANSCRIPT_SYNC_THROTTLE_MS;
      const lastSyncAt = transcriptSyncThrottleCache.get(cacheKey) ?? 0;
      const shouldSync =
        options?.syncLocalTranscripts !== undefined
          ? options.syncLocalTranscripts
          : nowMs - lastSyncAt >= throttleMs;
      if (shouldSync) {
        transcriptSyncThrottleCache.set(cacheKey, nowMs);
      }
      return readCliRecentSessions(projectRoot, {
        syncLocalTranscripts: shouldSync,
        homeDir,
      });
    })(),
    routingConfig,
    hasLocalRouting,
    localRoutingPath: paths.localRoutingPath,
    availableModels,
    worktreeStatuses,
    harnesses,
  };
}

function detectSystemLocale(): string {
  try {
    const resolved = Intl.DateTimeFormat().resolvedOptions().locale;
    if (resolved) return resolved;
  } catch {
    // Ignore
  }
  return process.env.LC_ALL || process.env.LANG || "en-US";
}