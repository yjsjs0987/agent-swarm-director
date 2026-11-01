/**
 * ASD Session Drivers Management API (CR-01)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  type DriverDetachReason,
  type DriverRow,
  type DriverSource,
  generateDriverId,
  type SqliteDriver,
} from "./db.ts";
import { resolveAsdPaths } from "./config.ts";
import { redactSecrets } from "./redact.ts";
import { atomicWriteFileSync, renderProgressBoard } from "./render.ts";
import { getAdapter } from "../adapters/registry.ts";
import {
  buildResumeHarnessCommand,
  isValidAsdSessionId,
  recordCliRecentSession,
} from "./session-tracker.ts";
import { type CommandRunner, executeHarnessProcess } from "./spawner.ts";
import type {
  HarnessId,
  MainSessionDriverMeta,
  MainSessionMeta,
  SessionPhase,
} from "./types.ts";

export type { DriverDetachReason, DriverRow, DriverSource };

function formatDriverForMainJson(row: DriverRow): MainSessionDriverMeta {
  return {
    driverId: row.driver_id,
    harness: row.harness,
    model: row.model ?? null,
    harnessSessionId: row.harness_session_id ?? null,
    source: row.source,
    attachedAt: row.attached_at,
    detachedAt: row.detached_at ?? null,
    detachReason: row.detach_reason ?? null,
  };
}

export function syncSessionDriversToMainJson(
  db: SqliteDriver,
  projectRoot: string,
  sessionId: string
): void {
  const sessionRow = db.getSession(sessionId);
  if (!sessionRow) return;

  const drivers = db.listDrivers(sessionId);
  const active = db.getActiveDriver(sessionId) ?? null;

  const sessionDir = path.join(path.resolve(projectRoot), ".asd", "sessions", sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  const mainJsonPath = path.join(sessionDir, "main.json");

  let existing: Record<string, unknown> = {};
  if (fs.existsSync(mainJsonPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(mainJsonPath, "utf8")) as Record<string, unknown>;
    } catch {
      existing = {};
    }
  }

  const effectiveHarness =
    active?.harness ?? ((sessionRow.main_harness as HarnessId) || "claude-code");
  const effectiveModel = active ? active.model : (sessionRow.main_model ?? null);
  const effectiveSid = active
    ? active.harness_session_id
    : (sessionRow.harness_session_id ?? null);

  const nextMeta: MainSessionMeta & Record<string, unknown> = {
    ...existing,
    sessionId,
    roleType: "main",
    harness: effectiveHarness,
    ...(effectiveModel ? { model: effectiveModel } : {}),
    harnessSessionId: effectiveSid ?? null,
    autoApprove: sessionRow.auto_approve !== 0,
    activeDriverId: active ? active.driver_id : null,
    drivers: drivers.map(formatDriverForMainJson),
    role: "director",
    phase: (sessionRow.phase as SessionPhase) || "planning",
    pid: sessionRow.main_pid ?? process.pid,
    startedAt:
      typeof existing.startedAt === "string"
        ? existing.startedAt
        : new Date(sessionRow.created_at).toISOString(),
    ...(sessionRow.memo ? { memo: sessionRow.memo } : {}),
  };

  if (!effectiveModel && "model" in nextMeta) {
    delete nextMeta.model;
  }

  atomicWriteFileSync(mainJsonPath, JSON.stringify(nextMeta, null, 2) + "\n");
}

export function attachDriver(
  db: SqliteDriver,
  input: {
    projectRoot: string;
    sessionId: string;
    harness: HarnessId;
    model?: string | null;
    harnessSessionId?: string | null;
    source: DriverSource;
    now?: number;
  }
): { driver: DriverRow; previousDriverId: string | null; changed: boolean } {
  const now = input.now ?? Date.now();
  const nextSid = input.harnessSessionId ?? null;
  const hasModelInput = input.model !== undefined;
  const nextModel = input.model ?? null;

  const txResult = db.withImmediateTx(() => {
    const session = db.getSession(input.sessionId);
    if (!session) {
      throw new Error(`Session not found: ${input.sessionId}`);
    }

    const active = db.getActiveDriver(input.sessionId);
    if (
      active &&
      active.harness === input.harness &&
      (active.harness_session_id ?? null) === nextSid
    ) {
      if (hasModelInput && nextModel !== (active.model ?? null)) {
        db["db"]
          .prepare("UPDATE session_drivers SET model = ? WHERE driver_id = ?")
          .run(nextModel, active.driver_id);
        db.updateSessionHarnessInfo(input.sessionId, {
          mainModel: nextModel,
        });
        db.incrementStateVersion(input.sessionId);
      }
      const refreshed = db.getDriver(active.driver_id) ?? active;
      return {
        driver: refreshed,
        previousDriverId: active.driver_id,
        changed: false,
      };
    }

    const previousDriverId = active ? active.driver_id : null;
    if (active) {
      db.detachDriverRow(active.driver_id, "switched", now);
    }

    const newDriver = db.insertDriver({
      driver_id: generateDriverId(now),
      session_id: input.sessionId,
      harness: input.harness,
      model: nextModel,
      harness_session_id: nextSid,
      source: input.source,
      attached_at: now,
      briefing_injected: 0,
    });

    db.updateSessionHarnessInfo(input.sessionId, {
      mainHarness: input.harness,
      mainModel: nextModel,
      harnessSessionId: nextSid,
    });
    db.incrementStateVersion(input.sessionId);

    return {
      driver: newDriver,
      previousDriverId,
      changed: true,
    };
  });

  syncSessionDriversToMainJson(db, input.projectRoot, input.sessionId);

  if (nextSid) {
    recordCliRecentSession(input.projectRoot, {
      harnessSessionId: nextSid,
      harness: input.harness,
      model: txResult.driver.model ?? null,
      asdSessionId: input.sessionId,
    });
  }

  return txResult;
}

export function setDriverHarnessSessionId(
  db: SqliteDriver,
  input: {
    projectRoot: string;
    driverId: string;
    harnessSessionId: string;
  }
): DriverRow {
  const sid = input.harnessSessionId.trim();
  if (!sid) {
    throw new Error("harnessSessionId must be a non-empty string");
  }

  const updated = db.withImmediateTx(() => {
    const existing = db.getDriver(input.driverId);
    if (!existing) {
      throw new Error(`Driver not found: ${input.driverId}`);
    }
    if (
      existing.harness_session_id !== null &&
      existing.harness_session_id !== undefined
    ) {
      if (existing.harness_session_id === sid) {
        return existing;
      }
      throw new Error(
        `Driver ${input.driverId} already has harness_session_id '${existing.harness_session_id}'`
      );
    }

    db.setDriverHarnessSessionId(input.driverId, sid);
    if (existing.detached_at === null) {
      db.updateSessionHarnessInfo(existing.session_id, {
        harnessSessionId: sid,
      });
    }
    db.incrementStateVersion(existing.session_id);
    return db.getDriver(input.driverId)!;
  });

  syncSessionDriversToMainJson(db, input.projectRoot, updated.session_id);
  recordCliRecentSession(input.projectRoot, {
    harnessSessionId: sid,
    harness: updated.harness,
    model: updated.model ?? null,
    asdSessionId: updated.session_id,
  });

  return updated;
}

export function detachDriver(
  db: SqliteDriver,
  input: {
    projectRoot: string;
    driverId: string;
    reason: DriverDetachReason;
  }
): void {
  const sessionId = db.withImmediateTx(() => {
    const existing = db.getDriver(input.driverId);
    if (!existing) {
      throw new Error(`Driver not found: ${input.driverId}`);
    }
    if (existing.detached_at === null) {
      db.detachDriverRow(input.driverId, input.reason, Date.now());
      db.incrementStateVersion(existing.session_id);
    }
    return existing.session_id;
  });

  syncSessionDriversToMainJson(db, input.projectRoot, sessionId);
}

export function getActiveDriver(
  db: SqliteDriver,
  sessionId: string
): DriverRow | null {
  return db.getActiveDriver(sessionId) ?? null;
}

export function listDrivers(db: SqliteDriver, sessionId: string): DriverRow[] {
  return db.listDrivers(sessionId);
}

// ============================================================================
// CR-02: 0-Token Driver Briefing (buildDriverBriefing)
// ============================================================================

export function buildDriverBriefing(input: {
  db: SqliteDriver;
  projectRoot: string;
  sessionId: string;
  maxChars?: number;
  locale?: "ko" | "en";
}): string {
  const maxChars = input.maxChars ?? 6000;
  const sysLang = (
    input.locale ??
    (Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase().startsWith("ko")
      ? "ko"
      : "ko")
  ) as "ko" | "en";

  const session = input.db.getSession(input.sessionId);
  const paths = resolveAsdPaths(input.projectRoot);
  const tasks = session ? input.db.getSessionTasks(input.sessionId) : [];
  const drivers = session ? input.db.listDrivers(input.sessionId) : [];
  const activeDriver = session ? input.db.getActiveDriver(input.sessionId) : undefined;

  // 1. Header
  const headerLines = [
    "# ASD Session Briefing",
    `- Session ID: ${input.sessionId}`,
    `- Memo: ${session?.memo ?? "(none)"}`,
    `- Phase: ${session?.phase ?? "planning"}`,
    `- Auto Approve: ${session ? session.auto_approve !== 0 : true}`,
    `- Project Root: ${path.resolve(input.projectRoot)}`,
    `- PLAN.md: ${paths.planMdPath}`,
  ];
  const sec1 = headerLines.join("\n");

  // 2. Previous drivers (excluding current active driver)
  const prevDrivers = drivers.filter(
    (d) => !activeDriver || d.driver_id !== activeDriver.driver_id
  );
  let sec2 = "";
  if (prevDrivers.length > 0) {
    const lines = ["## Previous Drivers"];
    for (const d of prevDrivers) {
      const startIso = new Date(d.attached_at).toISOString();
      const endIso = d.detached_at ? new Date(d.detached_at).toISOString() : "active";
      const modelStr = d.model ? `/${d.model}` : "";
      const sidStr = d.harness_session_id ? ` (sid: ${d.harness_session_id})` : "";
      lines.push(`- ${d.harness}${modelStr}${sidStr} [${startIso} ~ ${endIso}]`);
    }
    sec2 = lines.join("\n");
  }

  // 3. Progress board (only if tasks exist)
  let sec3 = "";
  if (session && tasks.length > 0) {
    sec3 = renderProgressBoard(session, tasks).trim();
  }

  // 4. Attention needed tasks (verifying, merge_conflict, failed, escalated)
  const attentionStatuses = new Set(["verifying", "merge_conflict", "failed", "escalated"]);
  const attentionTasks = tasks.filter((t) => attentionStatuses.has(t.status));
  let sec4 = "";
  if (attentionTasks.length > 0) {
    const lines = ["## Attention Needed Tasks"];
    for (const t of attentionTasks) {
      const wtInfo = t.worktree_path ? ` | worktree: ${t.worktree_path}` : "";
      lines.push(`- **${t.task_id}** [${t.status}]: ${t.title}${wtInfo}`);
    }
    sec4 = lines.join("\n");
  }

  // 5. Recently completed task summaries (done_claim_json.summary & key_decisions, newest first)
  const doneTasks = tasks
    .filter((t) => t.status === "done" && t.done_claim_json)
    .slice()
    .sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0));
  let sec5 = "";
  if (doneTasks.length > 0) {
    const lines = ["## Recently Completed Tasks"];
    for (const t of doneTasks) {
      try {
        const claim = JSON.parse(t.done_claim_json!) as {
          summary?: string;
          key_decisions?: string[];
        };
        const summary = claim.summary ?? "";
        const decisions =
          Array.isArray(claim.key_decisions) && claim.key_decisions.length > 0
            ? ` (Decisions: ${claim.key_decisions.join("; ")})`
            : "";
        lines.push(`- **${t.task_id}** (${t.title}): ${summary}${decisions}`);
      } catch {
        lines.push(`- **${t.task_id}** (${t.title})`);
      }
    }
    sec5 = lines.join("\n");
  }

  // 6. summary.md first 1,500 chars if present
  let sec6 = "";
  const sessionSummaryPath = path.join(
    path.resolve(input.projectRoot),
    ".asd",
    "sessions",
    input.sessionId,
    "summary.md"
  );
  const fallbackSummaryPath = paths.summaryMdPath;
  const summaryPath = fs.existsSync(sessionSummaryPath)
    ? sessionSummaryPath
    : fs.existsSync(fallbackSummaryPath)
      ? fallbackSummaryPath
      : null;
  if (summaryPath) {
    try {
      const rawSummary = fs.readFileSync(summaryPath, "utf8").trim();
      if (rawSummary.length > 0) {
        sec6 = `## Session Summary\n${rawSummary.slice(0, 1500)}`;
      }
    } catch {
      // ignore
    }
  }

  // 7. Guidance footer
  const sec7 =
    sysLang === "en"
      ? "## Guidance\nUse ASD MCP tools (asd_plan, asd_dispatch, asd_verify, asd_debate) for task planning, dispatching, and verification. Merge conflict tasks are resolved and re-merged or rejected by the user in the GUI."
      : "## 안내\n태스크 계획/디스패치/검증은 ASD MCP 도구(asd_plan, asd_dispatch, asd_verify, asd_debate)를 사용하라. 병합 충돌 태스크는 사용자가 GUI에서 해결·재병합하거나 반려한다.";

  const assemble = (s3: string, s5: string, s6: string): string =>
    [sec1, sec2, s3, sec4, s5, s6, sec7].filter((s) => s.length > 0).join("\n\n");

  const suffix = "…(truncated)";
  let cur3 = sec3;
  let cur5 = sec5;
  let cur6 = sec6;

  let full = assemble(cur3, cur5, cur6);
  let truncated = false;

  // Truncate in exact order: 5 -> 6 -> 3
  const shrinkSection = (
    current: string,
    buildWith: (val: string) => string
  ): string => {
    if (!current) return current;
    const without = buildWith("");
    if (without.length >= maxChars) {
      truncated = true;
      return "";
    }
    const budget = Math.max(0, maxChars - without.length - 2);
    truncated = true;
    return budget > 0 ? current.slice(0, budget) : "";
  };

  if (full.length > maxChars && cur5.length > 0) {
    cur5 = shrinkSection(cur5, (v) => assemble(cur3, v, cur6));
    full = assemble(cur3, cur5, cur6);
  }
  if (full.length > maxChars && cur6.length > 0) {
    cur6 = shrinkSection(cur6, (v) => assemble(cur3, cur5, v));
    full = assemble(cur3, cur5, cur6);
  }
  if (full.length > maxChars && cur3.length > 0) {
    cur3 = shrinkSection(cur3, (v) => assemble(v, cur5, cur6));
    full = assemble(cur3, cur5, cur6);
  }
  if (full.length > maxChars) {
    full = full.slice(0, maxChars);
    truncated = true;
  }

  if (truncated) {
    if (full.length > maxChars) {
      full = full.slice(0, maxChars);
    }
    full = `${full}${suffix}`;
  }

  return redactSecrets(full);
}


// ============================================================================
// CR-03: GUI Headless Driver Turn Runner (runDriverTurn)
// ============================================================================

export interface DriverRunResult {
  runId: string;
  driverId: string;
  exitCode: number;
  timedOut: boolean;
  harnessSessionId: string | null;
  durationMs: number;
  metaPath: string;
}

const activeDriverRuns = new Set<string>();

function isProcessAliveForDriver(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    return code === "EPERM";
  }
}

function getDefaultModelForHarness(harness: HarnessId): string {
  switch (harness) {
    case "claude-code":
      return "claude-sonnet-4-6";
    case "codex":
      return "gpt-5.4";
    case "opencode":
      return "glm-5";
    case "antigravity":
      return "gemini-3.1-pro-high";
    case "cursor":
      return "claude-4.5-sonnet";
    default:
      return "claude-sonnet-4-6";
  }
}

function generateDriverRunId(now = Date.now()): string {
  const ts = Math.max(0, Math.floor(now)).toString(36);
  const rand = Math.random().toString(36).slice(2, 6).padEnd(4, "0");
  return `run-${ts}-${rand}`;
}

function pruneDriverRuns(runsDir: string, maxRuns = 50): void {
  if (!fs.existsSync(runsDir)) return;
  try {
    const entries = fs
      .readdirSync(runsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory());
    if (entries.length <= maxRuns) return;

    const withTimes = entries.map((e) => {
      const dirPath = path.join(runsDir, e.name);
      const metaPath = path.join(dirPath, "meta.json");
      let startedAt = 0;
      try {
        if (fs.existsSync(metaPath)) {
          const parsed = JSON.parse(fs.readFileSync(metaPath, "utf8")) as {
            startedAt?: number;
          };
          if (typeof parsed.startedAt === "number") {
            startedAt = parsed.startedAt;
          }
        }
        if (!startedAt) {
          startedAt = fs.statSync(dirPath).mtimeMs;
        }
      } catch {
        startedAt = 0;
      }
      return { name: e.name, dirPath, startedAt };
    });

    withTimes.sort((a, b) => b.startedAt - a.startedAt);
    for (const old of withTimes.slice(maxRuns)) {
      try {
        fs.rmSync(old.dirPath, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
  } catch {
    // best-effort
  }
}

export async function runDriverTurn(input: {
  projectRoot: string;
  homeDir?: string;
  db: SqliteDriver;
  sessionId: string;
  prompt: string;
  driverId?: string;
  injectBriefing?: "auto" | "always" | "never";
  timeoutMs?: number;
  idleTimeoutMs?: number;
  signal?: AbortSignal;
  onOutput?: (chunk: string) => void;
  commandRunner?: CommandRunner;
}): Promise<DriverRunResult> {
  if (!isValidAsdSessionId(input.sessionId)) {
    throw new Error("INVALID_SESSION_ID");
  }

  const projectRoot = path.resolve(input.projectRoot);
  const driver = input.driverId
    ? input.db.getDriver(input.driverId)
    : input.db.getActiveDriver(input.sessionId);

  if (
    !driver ||
    driver.session_id !== input.sessionId ||
    driver.detached_at !== null
  ) {
    throw new Error("NO_ACTIVE_DRIVER");
  }

  const busyKey = `${projectRoot.toLowerCase()}::${driver.driver_id}`;
  if (activeDriverRuns.has(busyKey)) {
    throw new Error("DRIVER_BUSY");
  }

  const runsBaseDir = path.join(
    projectRoot,
    ".asd",
    "sessions",
    input.sessionId,
    "drivers",
    driver.driver_id,
    "runs"
  );
  if (fs.existsSync(runsBaseDir)) {
    try {
      for (const entry of fs.readdirSync(runsBaseDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const mPath = path.join(runsBaseDir, entry.name, "meta.json");
        if (!fs.existsSync(mPath)) continue;
        const parsed = JSON.parse(fs.readFileSync(mPath, "utf8")) as {
          status?: string;
          pid?: number;
        };
        if (
          parsed.status === "running" &&
          typeof parsed.pid === "number" &&
          parsed.pid > 0 &&
          isProcessAliveForDriver(parsed.pid)
        ) {
          throw new Error("DRIVER_BUSY");
        }
      }
    } catch (err) {
      if (err instanceof Error && err.message === "DRIVER_BUSY") {
        throw err;
      }
    }
  }

  activeDriverRuns.add(busyKey);
  try {
    const injectMode = input.injectBriefing ?? "auto";
    let shouldInject = false;
    if (injectMode === "always") {
      shouldInject = true;
    } else if (injectMode === "auto" && driver.briefing_injected === 0) {
      const allDrivers = input.db.listDrivers(input.sessionId);
      const hasPrevDriver = allDrivers.some(
        (d) => d.driver_id !== driver.driver_id
      );
      const hasTasks = input.db.getSessionTasks(input.sessionId).length >= 1;
      if (hasPrevDriver || hasTasks) {
        shouldInject = true;
      }
    }

    let effectivePrompt = input.prompt;
    if (shouldInject) {
      const briefing = buildDriverBriefing({
        db: input.db,
        projectRoot,
        sessionId: input.sessionId,
      });
      effectivePrompt = `${briefing}\n\n---\n\n${input.prompt}`;
    }

    const effectiveModel =
      driver.model && driver.model.trim().length > 0
        ? driver.model.trim()
        : getDefaultModelForHarness(driver.harness);

    let command: string;
    let args: string[];
    if (!driver.harness_session_id) {
      const built = getAdapter(driver.harness).buildHeadlessCommand(
        effectivePrompt,
        effectiveModel
      );
      command = built.cmd;
      args = built.args;
    } else {
      const built = buildResumeHarnessCommand({
        harness: driver.harness,
        harnessSessionId: driver.harness_session_id,
        prompt: effectivePrompt,
        model: driver.model ?? effectiveModel,
      });
      command = built.command;
      args = built.args;
    }

    const runId = generateDriverRunId();
    const runDir = path.join(runsBaseDir, runId);
    fs.mkdirSync(runDir, { recursive: true });
    const metaPath = path.join(runDir, "meta.json");
    const logPath = path.join(runDir, "output.log");

    const startedAt = Date.now();
    let currentSid: string | null = driver.harness_session_id ?? null;
    let meta: Record<string, unknown> = {
      runId,
      sessionId: input.sessionId,
      driverId: driver.driver_id,
      harness: driver.harness,
      model: effectiveModel,
      harnessSessionId: currentSid,
      pid: 0,
      status: "running",
      startedAt,
    };
    const writeMeta = (): void => {
      atomicWriteFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n");
    };
    writeMeta();

    if (shouldInject) {
      input.db.markDriverBriefingInjected(driver.driver_id);
    }

    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ASD_SESSION_ROLE: "driver",
      ASD_MAIN_SESSION_ID: input.sessionId,
      ASD_DRIVER_ID: driver.driver_id,
      NODE_NO_WARNINGS: "1",
    };

    const recordDetectedSid = (extracted: string): void => {
      if (!extracted) return;
      if (!currentSid) {
        try {
          const updated = setDriverHarnessSessionId(input.db, {
            projectRoot,
            driverId: driver.driver_id,
            harnessSessionId: extracted,
          });
          currentSid = updated.harness_session_id ?? extracted;
        } catch {
          const fresh = input.db.getDriver(driver.driver_id);
          currentSid = fresh?.harness_session_id ?? extracted;
        }
      }
      meta = { ...meta, harnessSessionId: currentSid };
      writeMeta();
    };

    const execRes = await executeHarnessProcess({
      command,
      args,
      cwd: projectRoot,
      env,
      harness: driver.harness,
      initialHarnessSessionId: currentSid,
      logPath,
      signal: input.signal,
      timeoutMs: input.timeoutMs,
      idleTimeoutMs: input.idleTimeoutMs,
      commandRunner: input.commandRunner,
      onOutput: input.onOutput,
      onSpawn: (pid) => {
        meta = { ...meta, pid };
        writeMeta();
      },
      onSessionIdDetected: (extracted) => {
        recordDetectedSid(extracted);
      },
      onBeforeStreamEnd: (res) => {
        if (res.harnessSessionId && !currentSid) {
          recordDetectedSid(res.harnessSessionId);
        }
        meta = {
          ...meta,
          pid: res.pid,
          exitCode: res.exitCode,
          timedOut: res.timedOut,
          harnessSessionId: currentSid ?? res.harnessSessionId ?? null,
          status: res.status,
          startedAt: res.startedAt,
          finishedAt: res.finishedAt,
          durationMs: res.durationMs,
        };
        writeMeta();
      },
    });

    try {
      if (fs.existsSync(logPath)) {
        fs.unlinkSync(logPath);
      }
    } catch {
      // best-effort
    }

    pruneDriverRuns(runsBaseDir, 50);

    return {
      runId,
      driverId: driver.driver_id,
      exitCode: execRes.exitCode,
      timedOut: execRes.timedOut,
      harnessSessionId: currentSid ?? execRes.harnessSessionId ?? null,
      durationMs: execRes.durationMs,
      metaPath,
    };
  } finally {
    activeDriverRuns.delete(busyKey);
  }
}
