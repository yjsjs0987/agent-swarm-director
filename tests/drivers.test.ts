/**
 * CR-01: session_drivers Table & Driver Management API Tests
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SqliteDriver } from "../src/core/db.ts";
import {
  attachDriver,
  detachDriver,
  getActiveDriver,
  listDrivers,
  setDriverHarnessSessionId,
} from "../src/core/drivers.ts";
import { readCliRecentSessions, recordCliRecentSession } from "../src/core/session-tracker.ts";

function makeTempDir(prefix = "asd-drivers-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("CR-01: session_drivers & Driver API", () => {
  it("1. creating a session in an empty DB automatically creates 1 active driver", () => {
    const tmp = makeTempDir();
    try {
      const db = new SqliteDriver(path.join(tmp, "core.db"));
      try {
        db.createOrGetSession({
          sessionId: "asd-20261101-130000-aa01",
          projectRoot: tmp,
          mainHarness: "claude-code",
          mainModel: "claude-sonnet-4",
          harnessSessionId: "cc-sid-1",
          driverSource: "cli-asd",
        });

        const drivers = listDrivers(db, "asd-20261101-130000-aa01");
        assert.equal(drivers.length, 1);
        const active = getActiveDriver(db, "asd-20261101-130000-aa01");
        assert.ok(active);
        assert.equal(active.harness, "claude-code");
        assert.equal(active.model, "claude-sonnet-4");
        assert.equal(active.harness_session_id, "cc-sid-1");
        assert.equal(active.source, "cli-asd");
        assert.equal(active.detached_at, null);
        assert.equal(active.detach_reason, null);
        assert.equal(active.briefing_injected, 0);
        assert.match(active.driver_id, /^drv-[0-9a-z]+-[0-9a-z]{4}$/);
      } finally {
        db.close();
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("2. attachDriver with a different harness detaches previous driver, inserts new active driver, and mirrors to sessions & main.json & cli-recent.json", () => {
    const tmp = makeTempDir();
    try {
      fs.mkdirSync(path.join(tmp, ".asd"), { recursive: true });
      const db = new SqliteDriver(path.join(tmp, ".asd", "core.db"));
      try {
        const sid = "asd-20261101-130000-aa02";
        db.createOrGetSession({
          sessionId: sid,
          projectRoot: tmp,
          mainHarness: "claude-code",
          mainModel: "claude-sonnet-4",
          harnessSessionId: "cc-100",
        });

        // Pre-populate cli-recent with summary & transcriptPath to verify preservation
        recordCliRecentSession(
          tmp,
          {
            harnessSessionId: "oc-200",
            harness: "opencode",
            summary: "Original user prompt summary",
            transcriptPath: "/tmp/oc-200.db",
          },
          { forceCreateDir: true }
        );

        const firstDriver = getActiveDriver(db, sid)!;
        const res = attachDriver(db, {
          projectRoot: tmp,
          sessionId: sid,
          harness: "opencode",
          model: "glm-5",
          harnessSessionId: "oc-200",
          source: "gui-headless",
          now: firstDriver.attached_at + 5000,
        });

        assert.equal(res.changed, true);
        assert.equal(res.previousDriverId, firstDriver.driver_id);
        assert.equal(res.driver.harness, "opencode");
        assert.equal(res.driver.model, "glm-5");
        assert.equal(res.driver.harness_session_id, "oc-200");
        assert.equal(res.driver.source, "gui-headless");

        const all = listDrivers(db, sid);
        assert.equal(all.length, 2);
        assert.equal(all[0]!.driver_id, firstDriver.driver_id);
        assert.equal(all[0]!.detached_at, firstDriver.attached_at + 5000);
        assert.equal(all[0]!.detach_reason, "switched");
        assert.equal(all[1]!.driver_id, res.driver.driver_id);
        assert.equal(all[1]!.detached_at, null);

        // Verify sessions mirror
        const sRow = db.getSession(sid)!;
        assert.equal(sRow.main_harness, "opencode");
        assert.equal(sRow.main_model, "glm-5");
        assert.equal(sRow.harness_session_id, "oc-200");
        assert.ok(sRow.state_version >= 2);

        // Verify main.json mirror
        const mainJsonPath = path.join(tmp, ".asd", "sessions", sid, "main.json");
        assert.equal(fs.existsSync(mainJsonPath), true);
        const mainJson = JSON.parse(fs.readFileSync(mainJsonPath, "utf8"));
        assert.equal(mainJson.activeDriverId, res.driver.driver_id);
        assert.equal(Array.isArray(mainJson.drivers), true);
        assert.equal(mainJson.drivers.length, 2);
        assert.equal(mainJson.harness, "opencode");
        assert.equal(mainJson.model, "glm-5");
        assert.equal(mainJson.harnessSessionId, "oc-200");

        // Verify cli-recent.json preserved summary/transcriptPath and linked asdSessionId
        const recents = readCliRecentSessions(tmp);
        const ocEntry = recents.find((r) => r.harnessSessionId === "oc-200");
        assert.ok(ocEntry);
        assert.equal(ocEntry.asdSessionId, sid);
        assert.equal(ocEntry.summary, "Original user prompt summary");
        assert.equal(ocEntry.transcriptPath, "/tmp/oc-200.db");
      } finally {
        db.close();
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("3. calling attachDriver with same harness and same harnessSessionId is a no-op (changed=false)", () => {
    const tmp = makeTempDir();
    try {
      const db = new SqliteDriver(path.join(tmp, "core.db"));
      try {
        const sid = "asd-20261101-130000-aa03";
        db.createOrGetSession({
          sessionId: sid,
          projectRoot: tmp,
          mainHarness: "antigravity",
          mainModel: "gemini-3.8-flash",
          harnessSessionId: null,
        });

        const res1 = attachDriver(db, {
          projectRoot: tmp,
          sessionId: sid,
          harness: "antigravity",
          model: "gemini-4-argon",
          harnessSessionId: null,
          source: "gui-headless",
        });

        assert.equal(res1.changed, false);
        assert.equal(listDrivers(db, sid).length, 1);
        assert.equal(res1.driver.model, "gemini-4-argon");
        assert.equal(db.getSession(sid)!.main_model, "gemini-4-argon");
      } finally {
        db.close();
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("4. directly inserting a second active driver for the same session violates ux_session_active_driver UNIQUE index", () => {
    const tmp = makeTempDir();
    try {
      const db = new SqliteDriver(path.join(tmp, "core.db"));
      try {
        const sid = "asd-20261101-130000-aa04";
        db.createOrGetSession({
          sessionId: sid,
          projectRoot: tmp,
          mainHarness: "claude-code",
        });

        assert.throws(() => {
          db.insertDriver({
            driver_id: "drv-manual-0002",
            session_id: sid,
            harness: "codex",
            model: null,
            harness_session_id: null,
            source: "cli-asd",
            attached_at: Date.now(),
            briefing_injected: 0,
          });
        }, /UNIQUE constraint failed/i);
      } finally {
        db.close();
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("5. opening a v1 DB (without session_drivers rows, 3 sessions) migrates 3 rows idempotently", () => {
    const tmp = makeTempDir();
    const dbFile = path.join(tmp, "legacy.db");
    try {
      // Create legacy v1 schema with 3 sessions and no session_drivers table
      const raw = new DatabaseSync(dbFile);
      raw.exec(`
        CREATE TABLE sessions (
          session_id TEXT PRIMARY KEY,
          project_root TEXT NOT NULL,
          main_harness TEXT NOT NULL,
          main_model TEXT DEFAULT NULL,
          harness_session_id TEXT DEFAULT NULL,
          auto_approve INTEGER NOT NULL DEFAULT 1,
          main_pid INTEGER,
          phase TEXT NOT NULL DEFAULT 'planning',
          state_version INTEGER NOT NULL DEFAULT 1,
          base_sha TEXT,
          stashed_work_sha TEXT,
          no_progress_count INTEGER NOT NULL DEFAULT 0,
          memo TEXT DEFAULT '',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);
      const ins = raw.prepare(
        "INSERT INTO sessions (session_id, project_root, main_harness, main_model, harness_session_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      );
      ins.run("s-leg-1", tmp, "claude-code", "sonnet", "sid-1", 1000, 1000);
      ins.run("s-leg-2", tmp, "opencode", "glm-5", "sid-2", 2000, 2000);
      ins.run("s-leg-3", tmp, "antigravity", null, null, 3000, 3000);
      raw.close();

      // First open: migrates 3 rows
      const db1 = new SqliteDriver(dbFile);
      const d1 = listDrivers(db1, "s-leg-1");
      const d2 = listDrivers(db1, "s-leg-2");
      const d3 = listDrivers(db1, "s-leg-3");
      assert.equal(d1.length, 1);
      assert.equal(d2.length, 1);
      assert.equal(d3.length, 1);
      assert.equal(d1[0]!.source, "migrated");
      assert.equal(d1[0]!.attached_at, 1000);
      assert.equal(d1[0]!.harness_session_id, "sid-1");
      db1.close();

      // Second open: idempotent, still 1 row per session
      const db2 = new SqliteDriver(dbFile);
      assert.equal(listDrivers(db2, "s-leg-1").length, 1);
      assert.equal(listDrivers(db2, "s-leg-2").length, 1);
      assert.equal(listDrivers(db2, "s-leg-3").length, 1);
      db2.close();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("6. deleting a session cascades to session_drivers, and setDriverHarnessSessionId / detachDriver enforce invariants", () => {
    const tmp = makeTempDir();
    try {
      const db = new SqliteDriver(path.join(tmp, "core.db"));
      try {
        const sid = "asd-20261101-130000-aa06";
        db.createOrGetSession({
          sessionId: sid,
          projectRoot: tmp,
          mainHarness: "codex",
          harnessSessionId: null,
        });

        const active = getActiveDriver(db, sid)!;
        assert.equal(active.harness_session_id, null);

        const updated = setDriverHarnessSessionId(db, {
          projectRoot: tmp,
          driverId: active.driver_id,
          harnessSessionId: "cx-thread-1",
        });
        assert.equal(updated.harness_session_id, "cx-thread-1");
        assert.equal(db.getSession(sid)!.harness_session_id, "cx-thread-1");

        // Setting a different harnessSessionId on the same driver must throw
        assert.throws(() => {
          setDriverHarnessSessionId(db, {
            projectRoot: tmp,
            driverId: active.driver_id,
            harnessSessionId: "cx-thread-2",
          });
        });

        // Detach driver
        detachDriver(db, {
          projectRoot: tmp,
          driverId: active.driver_id,
          reason: "user",
        });
        assert.equal(getActiveDriver(db, sid), null);

        // Delete session -> CASCADE deletes driver rows
        db["db"].prepare("DELETE FROM sessions WHERE session_id = ?").run(sid);
        assert.equal(listDrivers(db, sid).length, 0);
      } finally {
        db.close();
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});