/**
 * One-shot migration: per-project DBs (~/.asd/state/<hash>/core.db) -> single
 * shared DB (~/.asd/state/core.db).
 *
 * Migrates sessions (and their tasks/debates/drivers) whose project_root still
 * exists on disk. Test-polluted rows pointing into %TEMP% are dropped by that
 * rule. Idempotent: sessions already present in the target DB are skipped.
 *
 * Usage:
 *   node --experimental-strip-types scripts/migrate-single-db.ts            # migrate
 *   node --experimental-strip-types scripts/migrate-single-db.ts --prune    # + delete migrated per-project DB dirs
 *   node --experimental-strip-types scripts/migrate-single-db.ts --prune-all # + delete every leftover <hash> dir (empty or not)
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveAsdPaths } from "../src/core/config.ts";

const args = process.argv.slice(2);
const prune = args.includes("--prune");
const pruneAll = args.includes("--prune-all");

const home = process.env.ASD_HOME_DIR ?? os.homedir();
const stateRoot = path.join(home, ".asd", "state");
const targetDbPath = path.join(stateRoot, "core.db");

if (!fs.existsSync(stateRoot)) {
  console.log(`No state dir at ${stateRoot} — nothing to migrate.`);
  process.exit(0);
}

fs.mkdirSync(stateRoot, { recursive: true });
const target = new DatabaseSync(targetDbPath);
target.exec("PRAGMA journal_mode = WAL;");
target.exec("PRAGMA busy_timeout = 5000;");

// Ensure target schema matches src/core/db.ts DDL (create if fresh).
const existingTables = target
  .prepare("SELECT name FROM sqlite_master WHERE type='table'")
  .all() as Array<{ name: string }>;
if (existingTables.length === 0) {
  // Let SqliteDriver create schema via a throwaway open.
  const { SqliteDriver } = await import("../src/core/db.ts");
  const probe = new SqliteDriver(targetDbPath);
  probe.close();
}

const TABLES = ["sessions", "tasks", "debates", "session_drivers"] as const;
const hasTable = (db: DatabaseSync, t: string): boolean =>
  (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
      .get(t) as { name?: string } | undefined
  )?.name === t;

let migratedSessions = 0;
let skippedSessions = 0;
let totalSessions = 0;
const migratedDirs: string[] = [];
const emptyDirs: string[] = [];

const entries = fs
  .readdirSync(stateRoot, { withFileTypes: true })
  .filter((e) => e.isDirectory() && /^[0-9a-f]{12}$/.test(e.name));

for (const entry of entries) {
  const dir = path.join(stateRoot, entry.name);
  const srcDbPath = path.join(dir, "core.db");
  if (!fs.existsSync(srcDbPath)) {
    emptyDirs.push(dir);
    continue;
  }

  let src: DatabaseSync;
  try {
    src = new DatabaseSync(srcDbPath, { readOnly: true });
  } catch (err) {
    console.warn(`SKIP (unreadable): ${dir}`);
    continue;
  }

  try {
    if (!hasTable(src, "sessions")) {
      emptyDirs.push(dir);
      continue;
    }
    const sessions = src
      .prepare("SELECT * FROM sessions ORDER BY created_at ASC")
      .all() as Array<Record<string, unknown>>;
    totalSessions += sessions.length;

    for (const s of sessions) {
      const projectRoot = String(s.project_root ?? "");
      const sessionId = String(s.session_id ?? "");
      if (!projectRoot || !sessionId) continue;
      // Only migrate sessions whose project still exists on disk.
      if (!fs.existsSync(projectRoot)) {
        skippedSessions++;
        continue;
      }
      const dupe = target
        .prepare("SELECT 1 FROM sessions WHERE session_id = ?")
        .get(sessionId);
      if (dupe) {
        skippedSessions++;
        continue;
      }

      target.exec("BEGIN IMMEDIATE");
      try {
        target
          .prepare(
            `INSERT INTO sessions (session_id, project_root, main_harness, main_model, harness_session_id, auto_approve, main_pid, phase, state_version, base_sha, stashed_work_sha, no_progress_count, memo, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            s.session_id,
            s.project_root,
            s.main_harness,
            s.main_model ?? null,
            s.harness_session_id ?? null,
            s.auto_approve ?? 1,
            s.main_pid ?? null,
            s.phase,
            s.state_version ?? 1,
            s.base_sha ?? null,
            s.stashed_work_sha ?? null,
            s.no_progress_count ?? 0,
            s.memo ?? "",
            s.created_at,
            s.updated_at
          );

        if (hasTable(src, "tasks")) {
          const tasks = src
            .prepare("SELECT * FROM tasks WHERE session_id = ?")
            .all(sessionId) as Array<Record<string, unknown>>;
          for (const t of tasks) {
            target
              .prepare(
                `INSERT INTO tasks (task_id, session_id, turn, title, track, role, category, difficulty, status, attempts, assigned_harness, assigned_model, depends_on_json, target_files_json, context_hint, acceptance, verify_cmd, done_claim_json, worktree_path, sub_session_id, commit_sha, duration_ms, is_cross_scope, follow_up_of, thinking_effort)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
              )
              .run(
                t.task_id,
                t.session_id,
                t.turn,
                t.title,
                t.track,
                t.role,
                t.category,
                t.difficulty,
                t.status,
                t.attempts,
                t.assigned_harness ?? null,
                t.assigned_model ?? null,
                t.depends_on_json,
                t.target_files_json,
                t.context_hint ?? null,
                t.acceptance ?? null,
                t.verify_cmd ?? null,
                t.done_claim_json ?? null,
                t.worktree_path ?? null,
                t.sub_session_id ?? null,
                t.commit_sha ?? null,
                t.duration_ms ?? null,
                t.is_cross_scope ?? 0,
                t.follow_up_of ?? null,
                t.thinking_effort ?? null
              );
          }
        }

        if (hasTable(src, "debates")) {
          const debates = src
            .prepare("SELECT * FROM debates WHERE session_id = ?")
            .all(sessionId) as Array<Record<string, unknown>>;
          for (const d of debates) {
            target
              .prepare(
                `INSERT INTO debates (debate_id, session_id, task_id, topic, status, round1_bundle_json, round2_bundle_json, insight_verdict_json)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
              )
              .run(
                d.debate_id,
                d.session_id,
                d.task_id ?? null,
                d.topic,
                d.status,
                d.round1_bundle_json ?? null,
                d.round2_bundle_json ?? null,
                d.insight_verdict_json ?? null
              );
          }
        }

        if (hasTable(src, "session_drivers")) {
          const drivers = src
            .prepare("SELECT * FROM session_drivers WHERE session_id = ?")
            .all(sessionId) as Array<Record<string, unknown>>;
          for (const dr of drivers) {
            target
              .prepare(
                `INSERT INTO session_drivers (driver_id, session_id, harness, model, harness_session_id, source, attached_at, detached_at, detach_reason, briefing_injected)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
              )
              .run(
                dr.driver_id,
                dr.session_id,
                dr.harness,
                dr.model ?? null,
                dr.harness_session_id ?? null,
                dr.source,
                dr.attached_at,
                dr.detached_at ?? null,
                dr.detach_reason ?? null,
                dr.briefing_injected ?? 0
              );
          }
        }
        target.exec("COMMIT");
        migratedSessions++;
      } catch (err) {
        target.exec("ROLLBACK");
        console.warn(`FAIL session ${sessionId}: ${err}`);
      }
    }
    migratedDirs.push(dir);
  } finally {
    src.close();
  }
}

target.close();

console.log(`Source dirs scanned : ${entries.length}`);
console.log(`Sessions total      : ${totalSessions}`);
console.log(`Sessions migrated   : ${migratedSessions}`);
console.log(`Sessions skipped    : ${skippedSessions} (project gone, duplicate, or temp/test project)`);
console.log(`Target DB           : ${targetDbPath}`);

// Prune: only dirs whose every session was migrated or skipped-by-rule.
if (prune || pruneAll) {
  let removed = 0;
  const targetDb = new DatabaseSync(targetDbPath, { readOnly: true });
  for (const dir of migratedDirs) {
    if (pruneAll) {
      fs.rmSync(dir, { recursive: true, force: true });
      removed++;
      continue;
    }
    // --prune: only delete if no live session from this dir remains unmigrated.
    // A dir is fully handled when we migrated it AND it has no session rows left
    // that we skipped due to an existing project (those were dupes/temp).
    const srcPath = path.join(dir, "core.db");
    if (!fs.existsSync(srcPath)) continue;
    let src: DatabaseSync;
    try {
      src = new DatabaseSync(srcPath, { readOnly: true });
    } catch {
      continue;
    }
    try {
      const rows = src
        .prepare("SELECT session_id, project_root FROM sessions")
        .all() as Array<{ session_id: string; project_root: string }>;
      const allHandled = rows.every(
        (r) =>
          !fs.existsSync(r.project_root) ||
          targetDb.prepare("SELECT 1 FROM sessions WHERE session_id = ?").get(r.session_id)
      );
      if (allHandled) {
        fs.rmSync(dir, { recursive: true, force: true });
        removed++;
      }
    } catch {
      // keep dir on any error
    } finally {
      src.close();
    }
  }
  // Empty dirs (no core.db at all) are always safe to remove.
  for (const dir of emptyDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      removed++;
    } catch {
      // ignore
    }
  }
  console.log(`Pruned dirs         : ${removed}`);
}
