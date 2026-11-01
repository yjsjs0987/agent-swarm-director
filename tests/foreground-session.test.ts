import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SqliteDriver } from "../src/core/db.ts";
import {
  getForegroundSessionId,
  renderPlanMd,
  setForegroundSession,
  syncPlanFromMd,
} from "../src/core/render.ts";
import { AsdMcpServer } from "../src/mcp/server.ts";

function makeTempProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "asd-cr14-test-"));
}

describe("CR-14: PLAN.md Foreground Session & Overwrite/Sync Guards", () => {
  test("1. getForegroundSessionId returns null when missing or headerless, and returns sessionId when present", () => {
    const root = makeTempProject();
    const planPath = path.join(root, ".asd", "PLAN.md");
    try {
      assert.equal(getForegroundSessionId(root, planPath), null);
      fs.mkdirSync(path.dirname(planPath), { recursive: true });
      fs.writeFileSync(planPath, "# ASD PLAN\n\n## Turn 1\n", "utf8");
      assert.equal(getForegroundSessionId(root, planPath), null);

      fs.writeFileSync(planPath, "# ASD PLAN\n\nSession: asd-20261101-100000-aaaa\n\n## Turn 1\n", "utf8");
      assert.equal(getForegroundSessionId(root, planPath), "asd-20261101-100000-aaaa");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("2. when Session A is foreground, rendering or creating Session B preserves Session A in PLAN.md unless Session A is done", async () => {
    const root = makeTempProject();
    const db = new SqliteDriver(path.join(root, ".asd", "core.db"));
    const server = new AsdMcpServer({ projectRoot: root, db });
    try {
      const sidA = "asd-20261101-100000-s00a";
      const sidB = "asd-20261101-100001-s00b";

      const outA = await server.handlePlan({
        action: "create",
        sessionId: sidA,
        tasks: [
          {
            taskId: "T1.1",
            turn: 1,
            title: "Task in Session A",
            targetFiles: ["src/a.ts"],
          },
        ],
      });
      assert.equal((outA as { foreground?: boolean }).foreground, true);
      assert.equal(getForegroundSessionId(root), sidA);

      // Creating Session B while Session A is still active ('planning') keeps Session A in PLAN.md
      const outB = await server.handlePlan({
        action: "create",
        sessionId: sidB,
        tasks: [
          {
            taskId: "T1.1",
            turn: 1,
            title: "Task in Session B",
            targetFiles: ["src/b.ts"],
          },
        ],
      });
      assert.equal((outB as { foreground?: boolean }).foreground, false);
      assert.equal(getForegroundSessionId(root), sidA);

      // Session B tasks exist in DB
      const bTasks = db.getSessionTasks(sidB);
      assert.equal(bTasks.length, 1);
      assert.equal(bTasks[0]!.title, "Task in Session B");

      // PLAN.md on disk still has Session A
      const diskPlan = fs.readFileSync(path.join(root, ".asd", "PLAN.md"), "utf8");
      assert.ok(diskPlan.includes(`Session: ${sidA}`));
      assert.ok(diskPlan.includes("Task in Session A"));
      assert.ok(!diskPlan.includes("Task in Session B"));

      // Direct renderPlanMd for Session B without force also skips overwriting disk
      const renderedB = renderPlanMd(db.getSession(sidB)!, bTasks);
      assert.ok(renderedB.includes(`Session: ${sidB}`));
      assert.equal(getForegroundSessionId(root), sidA);

      // Once Session A is 'done', creating Session C takes foreground automatically
      db.updateSessionPhase(sidA, "done");
      const sidC = "asd-20261101-100002-s00c";
      const outC = await server.handlePlan({
        action: "create",
        sessionId: sidC,
        tasks: [
          {
            taskId: "T1.1",
            turn: 1,
            title: "Task in Session C",
            targetFiles: ["src/c.ts"],
          },
        ],
      });
      assert.equal((outC as { foreground?: boolean }).foreground, true);
      assert.equal(getForegroundSessionId(root), sidC);
    } finally {
      server.close();
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("3. syncPlanFromMd throws PLAN_SESSION_MISMATCH when Session header differs, and warns when header is absent", () => {
    const root = makeTempProject();
    const db = new SqliteDriver(path.join(root, ".asd", "core.db"));
    const planPath = path.join(root, ".asd", "PLAN.md");
    try {
      const sidA = "asd-20261101-100010-s00a";
      const sidB = "asd-20261101-100011-s00b";

      const sessA = db.createOrGetSession({ sessionId: sidA, projectRoot: root, mainHarness: "claude-code" });
      db.createOrGetSession({ sessionId: sidB, projectRoot: root, mainHarness: "claude-code" });
      db.upsertTasks(sidA, [{ taskId: "T1.1", turn: 1, title: "A1", targetFiles: ["src/a.ts"] }]);
      db.upsertTasks(sidB, [{ taskId: "T1.1", turn: 1, title: "B1", targetFiles: ["src/b.ts"] }]);

      renderPlanMd(sessA, db.getSessionTasks(sidA), planPath, { force: true });

      assert.throws(
        () => syncPlanFromMd(db, sidB, planPath),
        /PLAN_SESSION_MISMATCH/
      );
      // Session B's task in DB is untouched
      assert.equal(db.getSessionTasks(sidB)[0]!.title, "B1");

      // Headerless PLAN.md logs a warning and syncs
      const headerless = fs.readFileSync(planPath, "utf8").replace(/^Session:.*$/m, "");
      fs.writeFileSync(planPath, headerless, "utf8");
      const synced = syncPlanFromMd(db, sidB, planPath);
      assert.equal(synced.length, 1);
      assert.equal(db.getSessionTasks(sidB)[0]!.title, "A1");
    } finally {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("4. setForegroundSession syncs manual edits from PLAN.md into previous session then writes new session with force:true", () => {
    const root = makeTempProject();
    const db = new SqliteDriver(path.join(root, ".asd", "core.db"));
    const planPath = path.join(root, ".asd", "PLAN.md");
    try {
      const sidA = "asd-20261101-100020-s00a";
      const sidB = "asd-20261101-100021-s00b";

      const sessA = db.createOrGetSession({ sessionId: sidA, projectRoot: root, mainHarness: "claude-code" });
      db.createOrGetSession({ sessionId: sidB, projectRoot: root, mainHarness: "claude-code" });
      db.upsertTasks(sidA, [{ taskId: "T1.1", turn: 1, title: "Original A", targetFiles: ["src/a.ts"] }]);
      db.upsertTasks(sidB, [{ taskId: "T1.1", turn: 1, title: "Original B", targetFiles: ["src/b.ts"] }]);

      renderPlanMd(sessA, db.getSessionTasks(sidA), planPath, { force: true });

      // Simulate user manually editing PLAN.md while Session A is foreground
      const editedMd = fs.readFileSync(planPath, "utf8").replace("Original A", "Edited A in Markdown");
      fs.writeFileSync(planPath, editedMd, "utf8");

      // Switch foreground to Session B
      const res = setForegroundSession({ db, projectRoot: root, sessionId: sidB, planMdPath: planPath });
      assert.equal(res.previous, sidA);

      // Session A in DB received the manual edit from PLAN.md before switch!
      assert.equal(db.getSessionTasks(sidA)[0]!.title, "Edited A in Markdown");

      // PLAN.md on disk now shows Session B
      assert.equal(getForegroundSessionId(root, planPath), sidB);
      const newDisk = fs.readFileSync(planPath, "utf8");
      assert.ok(newDisk.includes("Original B"));
    } finally {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});