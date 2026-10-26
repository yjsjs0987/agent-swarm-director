/**
 * Tests for src/core/db.ts (3-table SQLite SSOT driver) and the
 * config helpers it depends on (resolveAsdPaths, loadRoutingConfig).
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SqliteDriver } from "../src/core/db.ts";
import type { TaskInput } from "../src/core/db.ts";
import { loadRoutingConfig, resolveAsdPaths } from "../src/core/config.ts";

// LIFO cleanup registry: DBs close before their temp dirs are removed.
const cleanups: Array<() => void> = [];
after(() => {
  for (const fn of cleanups.reverse()) fn();
  cleanups.length = 0;
});

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeDriver(): SqliteDriver {
  const dir = tempDir("asd-db-");
  const drv = new SqliteDriver(path.join(dir, "core.db"));
  cleanups.push(() => drv.close());
  return drv;
}

function makeSession(drv: SqliteDriver, sessionId = "s1") {
  return drv.createOrGetSession({
    sessionId,
    projectRoot: "C:\\Proj",
    mainHarness: "opencode",
    mainPid: 1234,
    baseSha: "abc000",
  });
}

// 1. Case-insensitive project hash (win32/darwin case-swap guard).
test("resolveAsdPaths: case-differing roots share dbPath", () => {
  const home = tempDir("asd-home-");
  const a = resolveAsdPaths("C:\\Proj", home);
  const b = resolveAsdPaths("c:\\proj", home);
  assert.equal(a.projectHash, b.projectHash);
  assert.equal(a.dbPath, b.dbPath);
});

// 2. Local routing override beats the global file.
test("loadRoutingConfig: local .asd/routing.jsonc wins over global", () => {
  const home = tempDir("asd-home-");
  const project = tempDir("asd-proj-");
  fs.mkdirSync(path.join(project, ".asd"), { recursive: true });
  fs.writeFileSync(
    path.join(project, ".asd", "routing.jsonc"),
    JSON.stringify({
      _asdVersion: "2.2.0",
      agents: {},
      categories: {
        design: { harness: "codex", model: "LOCAL-MARKER", modelFamily: "gpt", fallbacks: [] },
      },
      _local: true,
    })
  );
  fs.mkdirSync(path.join(home, ".asd"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".asd", "routing.jsonc"),
    JSON.stringify({
      _asdVersion: "2.2.0",
      agents: {},
      categories: {
        design: { harness: "opencode", model: "GLOBAL-MARKER", modelFamily: "glm", fallbacks: [] },
      },
    })
  );
  const cfg = loadRoutingConfig(project, home);
  assert.equal(cfg.categories.design!.model, "LOCAL-MARKER");
});

// 3. Session + task CRUD: upsert, wave claim, status update with extras.
test("CRUD: createOrGetSession -> upsertTasks -> claimWaveTasks -> updateTaskStatus", () => {
  const drv = makeDriver();
  const s = makeSession(drv);
  assert.equal(s.session_id, "s1");
  assert.equal(s.phase, "planning");
  assert.equal(s.main_harness, "opencode");
  // Idempotent: second call returns the stored row unchanged.
  const again = drv.createOrGetSession({
    sessionId: "s1",
    projectRoot: "C:\\Proj",
    mainHarness: "opencode",
  });
  assert.equal(again.created_at, s.created_at);

  const tasks: TaskInput[] = [
    { taskId: "T1.1", turn: 1, title: "first task" },
    { taskId: "T1.2", turn: 1, title: "second task", dependsOn: ["T1.1"], acceptance: "base" },
  ];
  drv.upsertTasks("s1", tasks);
  assert.equal(drv.getSessionTasks("s1").length, 2);
  assert.equal(drv.getTask("s1", "T1.2")!.depends_on_json, JSON.stringify(["T1.1"]));
  assert.equal(drv.getTask("s1", "T1.1")!.status, "pending");

  const claimed = drv.claimWaveTasks("s1", 1);
  assert.equal(claimed.length, 2);
  for (const row of claimed) assert.equal(row.status, "running");
  assert.equal(drv.getTask("s1", "T1.1")!.status, "running");

  drv.updateTaskStatus("s1", "T1.1", "done", { commitSha: "deadbeef" });
  const done = drv.getTask("s1", "T1.1")!;
  assert.equal(done.status, "done");
  assert.equal(done.commit_sha, "deadbeef");
});

// 4. Foreign keys: tasks cannot exist without a parent session.
test("foreign key: upsertTasks for unknown session throws", () => {
  const drv = makeDriver();
  assert.throws(() =>
    drv.upsertTasks("ghost-session", [{ taskId: "T1.1", turn: 1, title: "orphan" }])
  );
});

// 5. withImmediateTx rolls back on error (nested calls join the outer tx).
test("withImmediateTx: rollback discards writes when fn throws", () => {
  const drv = makeDriver();
  makeSession(drv);
  assert.throws(
    () =>
      drv.withImmediateTx(() => {
        drv.updateSessionPhase("s1", "paused");
        throw new Error("boom");
      }),
    /boom/
  );
  assert.equal(drv.getSession("s1")!.phase, "planning");
});

// 6. no_progress_count increment/reset.
test("no_progress_count: increments then resets", () => {
  const drv = makeDriver();
  makeSession(drv);
  drv.incrementNoProgress("s1");
  drv.incrementNoProgress("s1");
  assert.equal(drv.getSession("s1")!.no_progress_count, 2);
  drv.resetNoProgress("s1");
  assert.equal(drv.getSession("s1")!.no_progress_count, 0);
});

// 7. Attempt escalation ladder: 1 unchanged, 2 escalated, 3 failed.
test("recordTaskAttemptFailure: 1=unchanged, 2=escalated, 3=failed", () => {
  const drv = makeDriver();
  makeSession(drv);
  drv.upsertTasks("s1", [{ taskId: "T1.1", turn: 1, title: "flaky" }]);

  const r1 = drv.recordTaskAttemptFailure("s1", "T1.1");
  assert.equal(r1.attempts, 1);
  assert.equal(r1.status, "pending");

  const r2 = drv.recordTaskAttemptFailure("s1", "T1.1");
  assert.equal(r2.attempts, 2);
  assert.equal(r2.status, "escalated");

  const r3 = drv.recordTaskAttemptFailure("s1", "T1.1");
  assert.equal(r3.attempts, 3);
  assert.equal(r3.status, "failed");
});

// 8. recordTaskVerified marks done, stores commit/claim/duration, resets counter.
test("recordTaskVerified: done + commit_sha + no_progress reset", () => {
  const drv = makeDriver();
  makeSession(drv);
  drv.upsertTasks("s1", [{ taskId: "T1.1", turn: 1, title: "work" }]);
  drv.incrementNoProgress("s1");
  assert.equal(drv.getSession("s1")!.no_progress_count, 1);

  const claim = { summary: "did it", changed_files: ["a.ts"], key_decisions: [], risks: [] };
  drv.recordTaskVerified("s1", "T1.1", "cafe123", claim, 5000);

  const t = drv.getTask("s1", "T1.1")!;
  assert.equal(t.status, "done");
  assert.equal(t.commit_sha, "cafe123");
  assert.equal(t.duration_ms, 5000);
  assert.deepEqual(JSON.parse(t.done_claim_json!), claim);
  assert.equal(drv.getSession("s1")!.no_progress_count, 0);
});

// 9. Debate lifecycle + acceptance injection.
test("debates: create -> verdict -> injectDebateAcceptance appends", () => {
  const drv = makeDriver();
  makeSession(drv);
  drv.upsertTasks("s1", [{ taskId: "T1.1", turn: 1, title: "task", acceptance: "base" }]);

  drv.createDebate({ debateId: "D1", sessionId: "s1", taskId: "T1.1", topic: "design tradeoff" });
  assert.equal(drv.getDebate("D1")!.status, "round1");

  drv.updateDebateVerdict("D1", "done", { insightVerdictJson: '{"verdict":"APPROVE"}' });
  const d = drv.getDebate("D1")!;
  assert.equal(d.status, "done");
  assert.equal(d.insight_verdict_json, '{"verdict":"APPROVE"}');

  drv.injectDebateAcceptance("s1", "T1.1", "must not break X");
  assert.equal(drv.getTask("s1", "T1.1")!.acceptance, "base\n\nmust not break X");
});
