/**
 * ASD v2.2 SQLite SSOT driver (3 tables: sessions, tasks, debates).
 *
 * Every connection enables WAL + busy_timeout + foreign_keys, and every
 * write goes through `withImmediateTx` (BEGIN IMMEDIATE). Nested calls
 * join the outer transaction instead of issuing a nested BEGIN.
 */

import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { ensureProjectInitialized, resolveAsdPaths } from "./config.ts";
import type {
  AgentRole,
  DifficultyTier,
  DoneClaim,
  DriverDetachReason,
  DriverRow,
  DriverSource,
  HarnessId,
  SessionPhase,
  TaskStatus,
  TaskTrack,
} from "./types.ts";

export type { DriverDetachReason, DriverRow, DriverSource };

// ============================================================================
// ASD Session ID Generation & Validation (CR-15 / CR-17.4)
// Lives here (leaf module) so db/spawner/server share it without cycles;
// session-tracker.ts re-exports for the public surface.
// ============================================================================

const ASD_SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ASD_SESSION_ID_RANDOM_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";
// ponytail: in-memory per-second suffix set guarantees 0 collisions between
// same-second generations (spec requires 1000 rapid calls to never collide);
// add a DB-backed uniqueness check if multi-process generation is ever needed.
const usedSessionIdSuffixes = new Map<string, Set<string>>();

/**
 * True when `id` is a safe ASD session ID: path-segment safe (1-64 chars from
 * [A-Za-z0-9._-], starting alphanumeric) and never "." or "..".
 */
export function isValidAsdSessionId(id: string): boolean {
  if (typeof id !== "string") return false;
  if (id === "." || id === "..") return false;
  return ASD_SESSION_ID_PATTERN.test(id);
}

/**
 * Generates a unique ASD session ID in local time:
 * `asd-YYYYMMDD-HHmmss-<4 random [a-z0-9]>`, e.g. `asd-20261101-143005-9f2k`.
 */
export function generateAsdSessionId(now?: Date): string {
  const d = now ?? new Date();
  const pad = (n: number): string => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  if (!usedSessionIdSuffixes.has(stamp)) {
    usedSessionIdSuffixes.clear();
    usedSessionIdSuffixes.set(stamp, new Set());
  }
  const used = usedSessionIdSuffixes.get(stamp)!;
  let suffix = "";
  do {
    suffix = "";
    for (let i = 0; i < 4; i++) {
      suffix +=
        ASD_SESSION_ID_RANDOM_CHARS[
          Math.floor(Math.random() * ASD_SESSION_ID_RANDOM_CHARS.length)
        ];
    }
  } while (used.has(suffix));
  used.add(suffix);
  return `asd-${stamp}-${suffix}`;
}

// ============================================================================
// Row / input types (snake_case mirrors the DDL exactly)
// ============================================================================

export interface SessionRow {
  session_id: string;
  project_root: string;
  main_harness: string;
  main_model?: string | null;
  harness_session_id?: string | null;
  auto_approve?: number;
  main_pid: number | null;
  phase: string;
  state_version: number;
  base_sha: string | null;
  stashed_work_sha: string | null;
  no_progress_count: number;
  memo?: string | null;
  created_at: number;
  updated_at: number;
}

export interface SessionInput {
  sessionId: string;
  projectRoot: string;
  mainHarness: HarnessId;
  mainModel?: string | null;
  harnessSessionId?: string | null;
  autoApprove?: boolean;
  mainPid?: number | null;
  baseSha?: string | null;
  memo?: string | null;
  driverSource?: DriverSource;
}

export interface TaskRow {
  task_id: string;
  session_id: string;
  turn: number;
  title: string;
  track: string;
  role: string;
  category: string;
  difficulty: string;
  status: string;
  attempts: number;
  assigned_harness: string | null;
  assigned_model: string | null;
  depends_on_json: string;
  target_files_json: string;
  context_hint: string | null;
  acceptance: string | null;
  verify_cmd: string | null;
  done_claim_json: string | null;
  worktree_path: string | null;
  sub_session_id: string | null;
  commit_sha: string | null;
  duration_ms: number | null;
  is_cross_scope?: number;
  follow_up_of?: string | null;
  thinking_effort?: string | null;
}

export interface TaskInput {
  taskId: string;
  turn: number;
  title: string;
  track?: TaskTrack;
  role?: AgentRole;
  category?: string;
  difficulty?: DifficultyTier;
  dependsOn?: string[];
  targetFiles?: string[];
  contextHint?: string | null;
  acceptance?: string | null;
  verifyCmd?: string | null;
  isCrossScope?: boolean;
  followUpOf?: string | null;
  thinkingEffort?: string | null;
}

export interface TaskStatusExtra {
  assignedHarness?: string;
  assignedModel?: string;
  commitSha?: string;
  subSessionId?: string;
  worktreePath?: string;
  doneClaimJson?: string;
  durationMs?: number;
}

export interface DebateRow {
  debate_id: string;
  session_id: string;
  task_id: string | null;
  topic: string;
  status: string;
  round1_bundle_json: string | null;
  round2_bundle_json: string | null;
  insight_verdict_json: string | null;
}

export interface DebateInput {
  debateId: string;
  sessionId: string;
  taskId?: string | null;
  topic: string;
  status?: string;
  round1BundleJson?: string | null;
  round2BundleJson?: string | null;
  insightVerdictJson?: string | null;
}

export interface DebateBundles {
  round1BundleJson?: string;
  round2BundleJson?: string;
  insightVerdictJson?: string;
}

// ============================================================================
// DDL (verbatim from IMPLEMENTATION_PLAN.md section 2)
// ============================================================================

const DDL = `
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,            -- 예: '20261026-0300-main'
  project_root TEXT NOT NULL,
  main_harness TEXT NOT NULL,             -- 'claude-code' | 'opencode' | 'codex' | 'antigravity' | 'cursor'
  main_model TEXT DEFAULT NULL,           -- 메인 하네스 사용 모델 ID
  harness_session_id TEXT DEFAULT NULL,   -- 하네스 자체 고유 세션 ID (CLI <-> GUI 양방향 Resume용)
  auto_approve INTEGER NOT NULL DEFAULT 1,-- 태스크 검증 통과 시 자동 승인/병합 여부 (1: 자동, 0: 수동 승인 대기)
  main_pid INTEGER,
  phase TEXT NOT NULL DEFAULT 'planning', -- 'planning' | 'running' | 'paused' | 'done'
  state_version INTEGER NOT NULL DEFAULT 1,
  base_sha TEXT,                          -- 세션 시작 시점의 Git HEAD SHA
  stashed_work_sha TEXT,                  -- Dirty tree auto-stash 수행 시 보관된 stash SHA
  no_progress_count INTEGER NOT NULL DEFAULT 0, -- Stop 훅 3회 무진전 서킷 브레이커 카운터
  memo TEXT DEFAULT '',                   -- 세션 한 줄 메모 (.asd 내부 관리용)
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  task_id TEXT NOT NULL,                  -- 예: 'T1.1', 'T1.2'
  session_id TEXT NOT NULL,
  turn INTEGER NOT NULL DEFAULT 1,        -- 병렬 실행 웨이브(Turn) 번호
  title TEXT NOT NULL,
  track TEXT NOT NULL DEFAULT 'LIGHT',    -- 'LIGHT' | 'HEAVY'
  role TEXT NOT NULL DEFAULT 'worker',    -- 'worker' | 'planner' | 'architect' | 'scout' | 'critic'
  category TEXT NOT NULL DEFAULT 'general', -- 'visual-ui' | 'design' | 'research' | 'writing' | 'general'
  difficulty TEXT NOT NULL DEFAULT 'medium',-- 'low' | 'medium' | 'high'
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending'|'running'|'verifying'|'done'|'escalated'|'failed'|'merge_conflict'
  attempts INTEGER NOT NULL DEFAULT 0,    -- 검증 실패 횟수 (최대 maxAttemptsPerTask = 3)
  assigned_harness TEXT,                  -- 라우터가 배정한 하네스 ID
  assigned_model TEXT,                    -- 라우터가 배정한 모델 ID
  depends_on_json TEXT NOT NULL DEFAULT '[]',   -- 선행 task_id 배열 JSON (예: '["T1.1"]')
  target_files_json TEXT NOT NULL DEFAULT '[]', -- 수정 허용된 파일/디렉토리 글로브 배열 JSON
  context_hint TEXT,                      -- 'src/auth.ts:10-50 (주의사항 1줄)'
  acceptance TEXT,                        -- 수용 기준 (토론 Insight Bundle 자동 주입 대상)
  verify_cmd TEXT,                        -- 태스크 전용 검증/테스트 명령어 (선택)
  done_claim_json TEXT,                   -- 완료 시 기록: { summary, changed_files, key_decisions, risks }
  worktree_path TEXT,                     -- HEAVY 실행 시 '.asd/wt/<turn>-<taskId>'
  sub_session_id TEXT,                    -- 'sub-<turn>-<taskId>-<role>-<harness>'
  commit_sha TEXT,                        -- 완료 후 생성된 체크포인트/병합 커밋 SHA
  duration_ms INTEGER,
  is_cross_scope INTEGER NOT NULL DEFAULT 0, -- Cross-Scope 자동 생성 태스크 여부 (0 | 1)
  PRIMARY KEY (session_id, task_id),
  FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS debates (
  debate_id TEXT PRIMARY KEY,             -- 예: 'D1'
  session_id TEXT NOT NULL,
  task_id TEXT,
  topic TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'round1',  -- 'round1' | 'round2' | 'done'
  round1_bundle_json TEXT,
  round2_bundle_json TEXT,
  insight_verdict_json TEXT,              -- JSON: { verdict, hard_constraints, decisions, risks, diversity_degraded? }
  FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS session_drivers (
  driver_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  harness TEXT NOT NULL,
  model TEXT DEFAULT NULL,
  harness_session_id TEXT DEFAULT NULL,
  source TEXT NOT NULL,
  attached_at INTEGER NOT NULL,
  detached_at INTEGER DEFAULT NULL,
  detach_reason TEXT DEFAULT NULL,
  briefing_injected INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_session_active_driver
  ON session_drivers(session_id) WHERE detached_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_session_drivers_sid
  ON session_drivers(session_id, harness_session_id);
`;

export function generateDriverId(nowMs = Date.now()): string {
  const rand = Math.random().toString(36).slice(2, 6).padEnd(4, "0").slice(0, 4);
  return `drv-${nowMs.toString(36)}-${rand}`;
}

const TASK_COLUMNS = `task_id, session_id, turn, title, track, role, category, difficulty, status, attempts, assigned_harness, assigned_model, depends_on_json, target_files_json, context_hint, acceptance, verify_cmd, done_claim_json, worktree_path, sub_session_id, commit_sha, duration_ms, is_cross_scope, follow_up_of, thinking_effort`;

// ============================================================================
// SqliteDriver
// ============================================================================

export class SqliteDriver {
  private db: DatabaseSync;
  private txDepth = 0;
  /**
   * When set, all multi-row reads (list/get-latest/all-tasks/all-debates) are
   * scoped to this project root — required now that every project shares one
   * DB file. Direct construction without projectRoot stays unscoped (tests,
   * custom DBs); openProjectDb always sets it.
   */
  private scopeProjectRoot: string | null;

  constructor(dbPath: string, projectRoot?: string) {
    this.scopeProjectRoot = projectRoot ?? null;
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath, { timeout: 5000 });
    // Set busy_timeout FIRST so concurrent connections on the shared DB wait instead of failing with SQLITE_BUSY on journal_mode/DDL.
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec(DDL);
    try {
      const cols = this.db
        .prepare("PRAGMA table_info(sessions)")
        .all() as Array<{ name?: string }>;
      if (!cols.some((c) => c.name === "memo")) {
        this.db.exec("ALTER TABLE sessions ADD COLUMN memo TEXT DEFAULT ''");
      }
      if (!cols.some((c) => c.name === "main_model")) {
        this.db.exec("ALTER TABLE sessions ADD COLUMN main_model TEXT DEFAULT NULL");
      }
      if (!cols.some((c) => c.name === "harness_session_id")) {
        this.db.exec(
          "ALTER TABLE sessions ADD COLUMN harness_session_id TEXT DEFAULT NULL"
        );
      }
      if (!cols.some((c) => c.name === "auto_approve")) {
        this.db.exec(
          "ALTER TABLE sessions ADD COLUMN auto_approve INTEGER NOT NULL DEFAULT 1"
        );
      }
      const taskCols = this.db
        .prepare("PRAGMA table_info(tasks)")
        .all() as Array<{ name?: string }>;
      if (!taskCols.some((c) => c.name === "is_cross_scope")) {
        this.db.exec(
          "ALTER TABLE tasks ADD COLUMN is_cross_scope INTEGER NOT NULL DEFAULT 0"
        );
      }
      if (!taskCols.some((c) => c.name === "follow_up_of")) {
        this.db.exec(
          "ALTER TABLE tasks ADD COLUMN follow_up_of TEXT DEFAULT NULL"
        );
      }
      if (!taskCols.some((c) => c.name === "thinking_effort")) {
        this.db.exec(
          "ALTER TABLE tasks ADD COLUMN thinking_effort TEXT DEFAULT NULL"
        );
      }
      // CR-01: Idempotent migration for existing sessions without any session_drivers rows
      this.withImmediateTx(() => {
        const orphanSessions = this.db
          .prepare(
            `SELECT s.session_id, s.main_harness, s.main_model, s.harness_session_id, s.created_at
             FROM sessions s
             WHERE NOT EXISTS (
               SELECT 1 FROM session_drivers d WHERE d.session_id = s.session_id
             )`
          )
          .all() as Array<{
          session_id: string;
          main_harness: string;
          main_model: string | null;
          harness_session_id: string | null;
          created_at: number;
        }>;
        if (orphanSessions.length > 0) {
          const insertStmt = this.db.prepare(
            `INSERT INTO session_drivers (driver_id, session_id, harness, model, harness_session_id, source, attached_at, detached_at, detach_reason, briefing_injected)
             VALUES (?, ?, ?, ?, ?, 'migrated', ?, NULL, NULL, 0)`
          );
          for (const s of orphanSessions) {
            insertStmt.run(
              generateDriverId(s.created_at || Date.now()),
              s.session_id,
              s.main_harness || "claude-code",
              s.main_model ?? null,
              s.harness_session_id ?? null,
              s.created_at || Date.now()
            );
          }
        }
      });
    } catch {
      // Ignore migration check error if table already matches
    }
  }

  /**
   * Run fn inside BEGIN IMMEDIATE ... COMMIT. On error: ROLLBACK + rethrow.
   * Nested calls join the outer transaction (depth tracking).
   */
  withImmediateTx<T>(fn: () => T): T {
    if (this.txDepth > 0) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    this.txDepth++;
    try {
      const result = fn();
      this.db.exec("COMMIT");
      this.txDepth--;
      return result;
    } catch (err) {
      this.txDepth--;
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // connection already broken; original error matters more
      }
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }

  // --------------------------------------------------------------------------
  // sessions
  // --------------------------------------------------------------------------

  getSession(sessionId: string): SessionRow | undefined {
    return this.db
      .prepare("SELECT * FROM sessions WHERE session_id = ?")
      .get(sessionId) as unknown as SessionRow | undefined;
  }

  /** Return the most recently created session for this project, or undefined. */
  getLatestSession(): SessionRow | undefined {
    if (this.scopeProjectRoot !== null) {
      return this.db
        .prepare(
          "SELECT * FROM sessions WHERE project_root = ? ORDER BY created_at DESC LIMIT 1"
        )
        .get(this.scopeProjectRoot) as unknown as SessionRow | undefined;
    }
    return this.db
      .prepare("SELECT * FROM sessions ORDER BY created_at DESC LIMIT 1")
      .get() as unknown as SessionRow | undefined;
  }

  /** Return all sessions of this project ordered by created_at DESC (newest first). */
  listSessions(): SessionRow[] {
    if (this.scopeProjectRoot !== null) {
      return this.db
        .prepare(
          "SELECT * FROM sessions WHERE project_root = ? ORDER BY created_at DESC"
        )
        .all(this.scopeProjectRoot) as unknown as SessionRow[];
    }
    return this.db
      .prepare("SELECT * FROM sessions ORDER BY created_at DESC")
      .all() as unknown as SessionRow[];
  }

  /** Distinct project roots present in this DB (single-DB discovery source). */
  listProjectRoots(): string[] {
    return (
      this.db
        .prepare("SELECT DISTINCT project_root FROM sessions ORDER BY project_root")
        .all() as unknown as Array<{ project_root: string }>
    ).map((r) => r.project_root);
  }

  /** Update the short memo attached to a session. */
  updateSessionMemo(sessionId: string, memo: string): void {
    this.withImmediateTx(() => {
      this.db
        .prepare(
          "UPDATE sessions SET memo = ?, updated_at = ? WHERE session_id = ?"
        )
        .run(memo, Date.now(), sessionId);
    });
  }

  /** Update main harness metadata (native harnessSessionId, mainModel, mainHarness, autoApprove). */
  updateSessionHarnessInfo(
    sessionId: string,
    info: {
      harnessSessionId?: string | null;
      mainModel?: string | null;
      mainHarness?: HarnessId;
      autoApprove?: boolean;
    }
  ): void {
    this.withImmediateTx(() => {
      const sets: string[] = [];
      const vals: Array<string | number | null> = [];
      if (info.harnessSessionId !== undefined) {
        sets.push("harness_session_id = ?");
        vals.push(info.harnessSessionId);
      }
      if (info.mainModel !== undefined) {
        sets.push("main_model = ?");
        vals.push(info.mainModel);
      }
      if (info.mainHarness !== undefined) {
        sets.push("main_harness = ?");
        vals.push(info.mainHarness);
      }
      if (info.autoApprove !== undefined) {
        sets.push("auto_approve = ?");
        vals.push(info.autoApprove ? 1 : 0);
      }
      if (sets.length === 0) return;
      sets.push("updated_at = ?");
      vals.push(Date.now());
      this.db
        .prepare(`UPDATE sessions SET ${sets.join(", ")} WHERE session_id = ?`)
        .run(...vals, sessionId);
    });
  }

  /** Insert the session if absent; return the stored row either way. */
  createOrGetSession(session: SessionInput): SessionRow {
    if (!isValidAsdSessionId(session.sessionId)) {
      throw new Error("INVALID_SESSION_ID");
    }
    return this.withImmediateTx(() => {
      const existing = this.getSession(session.sessionId);
      if (existing) {
        if (session.memo !== undefined && session.memo !== null && !existing.memo) {
          this.updateSessionMemo(session.sessionId, session.memo);
        }
        if (
          session.harnessSessionId !== undefined ||
          session.mainModel !== undefined ||
          session.autoApprove !== undefined
        ) {
          this.updateSessionHarnessInfo(session.sessionId, {
            harnessSessionId: session.harnessSessionId,
            mainModel: session.mainModel,
            autoApprove: session.autoApprove,
          });
        }
        return this.getSession(session.sessionId) ?? existing;
      }
      const now = Date.now();
      this.db
        .prepare(
          `INSERT INTO sessions (session_id, project_root, main_harness, main_model, harness_session_id, auto_approve, main_pid, phase, state_version, base_sha, no_progress_count, memo, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'planning', 1, ?, 0, ?, ?, ?)`
        )
        .run(
          session.sessionId,
          session.projectRoot,
          session.mainHarness,
          session.mainModel ?? null,
          session.harnessSessionId ?? null,
          session.autoApprove === false ? 0 : 1,
          session.mainPid ?? null,
          session.baseSha ?? null,
          session.memo ?? "",
          now,
          now
        );
      if (session.mainHarness) {
        this.insertDriver({
          driver_id: generateDriverId(now),
          session_id: session.sessionId,
          harness: session.mainHarness,
          model: session.mainModel ?? null,
          harness_session_id: session.harnessSessionId ?? null,
          source: session.driverSource ?? "cli-asd",
          attached_at: now,
          briefing_injected: 0,
        });
      }
      const row = this.getSession(session.sessionId);
      if (!row) throw new Error(`session insert failed: ${session.sessionId}`);
      return row;
    });
  }

  updateSessionPhase(sessionId: string, phase: SessionPhase): void {
    this.withImmediateTx(() => {
      this.db
        .prepare(
          "UPDATE sessions SET phase = ?, updated_at = ? WHERE session_id = ?"
        )
        .run(phase, Date.now(), sessionId);
    });
  }

  incrementNoProgress(sessionId: string): void {
    this.withImmediateTx(() => {
      this.db
        .prepare(
          "UPDATE sessions SET no_progress_count = no_progress_count + 1, updated_at = ? WHERE session_id = ?"
        )
        .run(Date.now(), sessionId);
    });
  }

  resetNoProgress(sessionId: string): void {
    this.withImmediateTx(() => {
      this.db
        .prepare(
          "UPDATE sessions SET no_progress_count = 0, updated_at = ? WHERE session_id = ?"
        )
        .run(Date.now(), sessionId);
    });
  }

  recordStashedWork(sessionId: string, stashSha: string): void {
    this.withImmediateTx(() => {
      this.db
        .prepare(
          "UPDATE sessions SET stashed_work_sha = ?, updated_at = ? WHERE session_id = ?"
        )
        .run(stashSha, Date.now(), sessionId);
    });
  }

  clearStashedWork(sessionId: string): void {
    this.withImmediateTx(() => {
      this.db
        .prepare(
          "UPDATE sessions SET stashed_work_sha = NULL, updated_at = ? WHERE session_id = ?"
        )
        .run(Date.now(), sessionId);
    });
  }

  incrementStateVersion(sessionId: string): void {
    this.withImmediateTx(() => {
      this.db
        .prepare(
          "UPDATE sessions SET state_version = state_version + 1, updated_at = ? WHERE session_id = ?"
        )
        .run(Date.now(), sessionId);
    });
  }

  // --------------------------------------------------------------------------
  // tasks
  // --------------------------------------------------------------------------

  getTask(sessionId: string, taskId: string): TaskRow | undefined {
    return this.db
      .prepare("SELECT * FROM tasks WHERE session_id = ? AND task_id = ?")
      .get(sessionId, taskId) as unknown as TaskRow | undefined;
  }

  getSessionTasks(sessionId: string): TaskRow[] {
    return this.db
      .prepare("SELECT * FROM tasks WHERE session_id = ? ORDER BY turn, task_id")
      .all(sessionId) as unknown as TaskRow[];
  }

  deleteTask(sessionId: string, taskId: string): void {
    this.withImmediateTx(() => {
      this.db
        .prepare("DELETE FROM tasks WHERE session_id = ? AND task_id = ?")
        .run(sessionId, taskId);
    });
  }

  /** Insert or refresh task definitions; runtime fields (status/attempts/...) are preserved. */
  upsertTasks(sessionId: string, tasks: TaskInput[]): void {
    this.withImmediateTx(() => {
      const stmt = this.db.prepare(
        `INSERT INTO tasks (task_id, session_id, turn, title, track, role, category, difficulty, status, attempts, depends_on_json, target_files_json, context_hint, acceptance, verify_cmd, is_cross_scope, follow_up_of, thinking_effort)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id, task_id) DO UPDATE SET
           turn = excluded.turn,
           title = excluded.title,
           track = excluded.track,
           role = excluded.role,
           category = excluded.category,
           difficulty = excluded.difficulty,
           depends_on_json = excluded.depends_on_json,
           target_files_json = excluded.target_files_json,
           context_hint = excluded.context_hint,
           acceptance = excluded.acceptance,
           verify_cmd = excluded.verify_cmd,
           is_cross_scope = MAX(tasks.is_cross_scope, excluded.is_cross_scope),
           follow_up_of = COALESCE(excluded.follow_up_of, tasks.follow_up_of),
           thinking_effort = COALESCE(excluded.thinking_effort, tasks.thinking_effort)`
      );
      for (const t of tasks) {
        stmt.run(
          t.taskId,
          sessionId,
          t.turn,
          t.title,
          t.track ?? "LIGHT",
          t.role ?? "worker",
          t.category ?? "general",
          t.difficulty ?? "medium",
          JSON.stringify(t.dependsOn ?? []),
          JSON.stringify(t.targetFiles ?? []),
          t.contextHint ?? null,
          t.acceptance ?? null,
          t.verifyCmd ?? null,
          t.isCrossScope ? 1 : 0,
          t.followUpOf ?? null,
          t.thinkingEffort ?? null
        );
      }
    });
  }

  updateTaskStatus(
    sessionId: string,
    taskId: string,
    status: TaskStatus,
    extra?: TaskStatusExtra
  ): void {
    this.withImmediateTx(() => {
      this.db
        .prepare("UPDATE tasks SET status = ? WHERE session_id = ? AND task_id = ?")
        .run(status, sessionId, taskId);
      if (!extra) return;
      const sets: string[] = [];
      const vals: Array<string | number | null> = [];
      if (extra.assignedHarness !== undefined) {
        sets.push("assigned_harness = ?");
        vals.push(extra.assignedHarness);
      }
      if (extra.assignedModel !== undefined) {
        sets.push("assigned_model = ?");
        vals.push(extra.assignedModel);
      }
      if (extra.commitSha !== undefined) {
        sets.push("commit_sha = ?");
        vals.push(extra.commitSha);
      }
      if (extra.subSessionId !== undefined) {
        sets.push("sub_session_id = ?");
        vals.push(extra.subSessionId);
      }
      if (extra.worktreePath !== undefined) {
        sets.push("worktree_path = ?");
        vals.push(extra.worktreePath);
      }
      if (extra.doneClaimJson !== undefined) {
        sets.push("done_claim_json = ?");
        vals.push(extra.doneClaimJson);
      }
      if (extra.durationMs !== undefined) {
        sets.push("duration_ms = ?");
        vals.push(extra.durationMs);
      }
      if (sets.length === 0) return;
      this.db
        .prepare(
          `UPDATE tasks SET ${sets.join(", ")} WHERE session_id = ? AND task_id = ?`
        )
        .run(...vals, sessionId, taskId);
    });
  }

  /**
   * Atomically claims a single task if its status is 'pending', 'escalated', or 'failed'.
   * Returns true if claimed by this caller, false if already running/done/verifying/etc.
   */
  tryClaimTask(sessionId: string, taskId: string): boolean {
    return this.withImmediateTx(() => {
      const res = this.db
        .prepare(
          "UPDATE tasks SET status = 'running' WHERE session_id = ? AND task_id = ? AND status IN ('pending', 'escalated', 'failed')"
        )
        .run(sessionId, taskId);
      return Number(res.changes ?? 0) > 0;
    });
  }

  /** Claim all pending tasks of a wave: status -> 'running'; returns the claimed rows. */
  claimWaveTasks(sessionId: string, turn: number): TaskRow[] {
    return this.withImmediateTx(() => {
      this.db
        .prepare(
          "UPDATE tasks SET status = 'running' WHERE session_id = ? AND turn = ? AND status = 'pending'"
        )
        .run(sessionId, turn);
      return this.db
        .prepare(
          "SELECT * FROM tasks WHERE session_id = ? AND turn = ? AND status = 'running' ORDER BY task_id"
        )
        .all(sessionId, turn) as unknown as TaskRow[];
    });
  }

  /** Mark done, record commit/claim/duration, and reset the session's no_progress_count. */
  recordTaskVerified(
    sessionId: string,
    taskId: string,
    commitSha: string,
    doneClaim: DoneClaim,
    durationMs: number
  ): void {
    this.withImmediateTx(() => {
      this.db
        .prepare(
          `UPDATE tasks SET status = 'done', commit_sha = ?, done_claim_json = ?, duration_ms = ? WHERE session_id = ? AND task_id = ?`
        )
        .run(commitSha, JSON.stringify(doneClaim), durationMs, sessionId, taskId);
      this.db
        .prepare(
          "UPDATE sessions SET no_progress_count = 0, updated_at = ? WHERE session_id = ?"
        )
        .run(Date.now(), sessionId);
    });
  }

  /**
   * Attempt escalation: attempts += 1.
   * attempts >= 3 -> 'failed'; attempts == 2 -> 'escalated'; otherwise status unchanged.
   */
  recordTaskAttemptFailure(sessionId: string, taskId: string): TaskRow {
    return this.withImmediateTx(() => {
      this.db
        .prepare(
          "UPDATE tasks SET attempts = attempts + 1 WHERE session_id = ? AND task_id = ?"
        )
        .run(sessionId, taskId);
      const bumped = this.getTask(sessionId, taskId);
      if (!bumped) throw new Error(`task not found: ${sessionId}/${taskId}`);
      if (bumped.attempts >= 3) {
        this.updateTaskStatus(sessionId, taskId, "failed");
      } else if (bumped.attempts === 2) {
        this.updateTaskStatus(sessionId, taskId, "escalated");
      }
      const row = this.getTask(sessionId, taskId);
      if (!row) throw new Error(`task vanished: ${sessionId}/${taskId}`);
      return row;
    });
  }


  // --------------------------------------------------------------------------
  // session_drivers (CR-01)
  // --------------------------------------------------------------------------

  insertDriver(row: Omit<DriverRow, "detached_at" | "detach_reason">): DriverRow {
    return this.withImmediateTx(() => {
      this.db
        .prepare(
          `INSERT INTO session_drivers (driver_id, session_id, harness, model, harness_session_id, source, attached_at, detached_at, detach_reason, briefing_injected)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`
        )
        .run(
          row.driver_id,
          row.session_id,
          row.harness,
          row.model ?? null,
          row.harness_session_id ?? null,
          row.source,
          row.attached_at,
          row.briefing_injected ?? 0
        );
      return this.getDriver(row.driver_id)!;
    });
  }

  getDriver(driverId: string): DriverRow | undefined {
    return this.withImmediateTx(() => {
      return this.db
        .prepare("SELECT * FROM session_drivers WHERE driver_id = ?")
        .get(driverId) as unknown as DriverRow | undefined;
    });
  }

  getActiveDriver(sessionId: string): DriverRow | undefined {
    return this.withImmediateTx(() => {
      return this.db
        .prepare(
          "SELECT * FROM session_drivers WHERE session_id = ? AND detached_at IS NULL LIMIT 1"
        )
        .get(sessionId) as unknown as DriverRow | undefined;
    });
  }

  listDrivers(sessionId: string): DriverRow[] {
    return this.withImmediateTx(() => {
      return this.db
        .prepare(
          "SELECT * FROM session_drivers WHERE session_id = ? ORDER BY attached_at ASC, rowid ASC"
        )
        .all(sessionId) as unknown as DriverRow[];
    });
  }

  detachDriverRow(driverId: string, reason: DriverDetachReason, at: number): void {
    this.withImmediateTx(() => {
      this.db
        .prepare(
          "UPDATE session_drivers SET detached_at = ?, detach_reason = ? WHERE driver_id = ?"
        )
        .run(at, reason, driverId);
    });
  }

  setDriverHarnessSessionId(driverId: string, harnessSessionId: string): void {
    this.withImmediateTx(() => {
      this.db
        .prepare(
          "UPDATE session_drivers SET harness_session_id = ? WHERE driver_id = ?"
        )
        .run(harnessSessionId, driverId);
    });
  }

  markDriverBriefingInjected(driverId: string): void {
    this.withImmediateTx(() => {
      this.db
        .prepare(
          "UPDATE session_drivers SET briefing_injected = 1 WHERE driver_id = ?"
        )
        .run(driverId);
    });
  }

  // --------------------------------------------------------------------------
  // debates
  // --------------------------------------------------------------------------

  getDebate(debateId: string): DebateRow | undefined {
    return this.db
      .prepare("SELECT * FROM debates WHERE debate_id = ?")
      .get(debateId) as unknown as DebateRow | undefined;
  }

  getSessionDebates(sessionId: string): DebateRow[] {
    return this.db
      .prepare("SELECT * FROM debates WHERE session_id = ? ORDER BY rowid DESC")
      .all(sessionId) as unknown as DebateRow[];
  }

  getAllDebates(): DebateRow[] {
    if (this.scopeProjectRoot !== null) {
      return this.db
        .prepare(
          `SELECT d.* FROM debates d JOIN sessions s ON d.session_id = s.session_id
           WHERE s.project_root = ? ORDER BY d.rowid DESC`
        )
        .all(this.scopeProjectRoot) as unknown as DebateRow[];
    }
    return this.db
      .prepare("SELECT * FROM debates ORDER BY rowid DESC")
      .all() as unknown as DebateRow[];
  }

  getAllTasks(): TaskRow[] {
    if (this.scopeProjectRoot !== null) {
      return this.db
        .prepare(
          `SELECT t.* FROM tasks t JOIN sessions s ON t.session_id = s.session_id
           WHERE s.project_root = ? ORDER BY t.turn, t.task_id`
        )
        .all(this.scopeProjectRoot) as unknown as TaskRow[];
    }
    return this.db
      .prepare("SELECT * FROM tasks ORDER BY turn, task_id")
      .all() as unknown as TaskRow[];
  }

  createDebate(debate: DebateInput): void {
    this.withImmediateTx(() => {
      this.db
        .prepare(
          `INSERT INTO debates (debate_id, session_id, task_id, topic, status, round1_bundle_json, round2_bundle_json, insight_verdict_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(debate_id) DO NOTHING`
        )
        .run(
          debate.debateId,
          debate.sessionId,
          debate.taskId ?? null,
          debate.topic,
          debate.status ?? "round1",
          debate.round1BundleJson ?? null,
          debate.round2BundleJson ?? null,
          debate.insightVerdictJson ?? null
        );
    });
  }

  updateDebateVerdict(
    debateId: string,
    status: string,
    bundles: DebateBundles
  ): void {
    this.withImmediateTx(() => {
      const sets: string[] = ["status = ?"];
      const vals: Array<string | null> = [status];
      if (bundles.round1BundleJson !== undefined) {
        sets.push("round1_bundle_json = ?");
        vals.push(bundles.round1BundleJson);
      }
      if (bundles.round2BundleJson !== undefined) {
        sets.push("round2_bundle_json = ?");
        vals.push(bundles.round2BundleJson);
      }
      if (bundles.insightVerdictJson !== undefined) {
        sets.push("insight_verdict_json = ?");
        vals.push(bundles.insightVerdictJson);
      }
      this.db
        .prepare(`UPDATE debates SET ${sets.join(", ")} WHERE debate_id = ?`)
        .run(...vals, debateId);
    });
  }

  /** Append a debate Insight Bundle constraint to the target task's acceptance. */
  injectDebateAcceptance(
    sessionId: string,
    taskId: string,
    acceptanceText: string
  ): void {
    this.withImmediateTx(() => {
      const row = this.getTask(sessionId, taskId);
      if (!row) throw new Error(`task not found: ${sessionId}/${taskId}`);
      const current = row.acceptance ?? "";
      const merged =
        current === "" ? acceptanceText : `${current}\n\n${acceptanceText}`;
      this.db
        .prepare(
          "UPDATE tasks SET acceptance = ? WHERE session_id = ? AND task_id = ?"
        )
        .run(merged, sessionId, taskId);
    });
  }
}

// ============================================================================
// Project DB helper
// ============================================================================

/**
 * Ensure the 2-path layout exists, then open the project's scoped view of the
 * shared state DB. Every project reads/writes the same state/core.db file; the
 * driver scopes multi-row queries to this project via sessions.project_root.
 */
export function openProjectDb(
  projectRoot: string,
  homeDir?: string
): SqliteDriver {
  ensureProjectInitialized(projectRoot, homeDir);
  const paths = resolveAsdPaths(projectRoot, homeDir);
  return new SqliteDriver(paths.dbPath, projectRoot);
}
