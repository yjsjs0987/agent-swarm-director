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
import { ensureGitUserIdentity, prepareBaseline, runGit } from "../src/core/workspace.ts";

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

  test("5. F05: when foreground Session A is active and newer Session B exists, implicit sync_from_md, get, dispatch, and verify target Session A", async () => {
    const root = makeTempProject();
    runGit(["init"], { cwd: root });
    ensureGitUserIdentity(root);
    prepareBaseline(root);

    const db = new SqliteDriver(path.join(root, ".asd", "core.db"));
    const server = new AsdMcpServer({ projectRoot: root, db });
    const planPath = path.join(root, ".asd", "PLAN.md");
    try {
      const sidA = "asd-20261101-110000-s00a";
      const sidB = "asd-20261101-110005-s00b";

      // Create foreground Session A
      await server.handlePlan({
        action: "create",
        sessionId: sidA,
        tasks: [
          {
            taskId: "T1.1",
            turn: 1,
            title: "Original A1",
            track: "LIGHT",
            targetFiles: ["src/a.ts"],
          },
        ],
      });
      assert.equal(getForegroundSessionId(root, planPath), sidA);

      // Create newer background Session B while Session A is still active
      await server.handlePlan({
        action: "create",
        sessionId: sidB,
        tasks: [
          {
            taskId: "T1.1",
            turn: 1,
            title: "Original B1",
            track: "LIGHT",
            targetFiles: ["src/b.ts"],
          },
        ],
      });
      assert.equal(getForegroundSessionId(root, planPath), sidA);
      assert.equal(db.getLatestSession()?.session_id, sidB);

      // Manually edit PLAN.md (which belongs to Session A)
      const editedMd = fs
        .readFileSync(planPath, "utf8")
        .replace("Original A1", "Synced A1 from PLAN.md");
      fs.writeFileSync(planPath, editedMd, "utf8");

      // 1) Implicit get (without sessionId) targets foreground Session A AND preserves manual PLAN.md edit
      const getOut = await server.handlePlan({ action: "get" });
      assert.equal(getOut.sessionId, sidA);
      assert.equal(getOut.foreground, true);
      assert.equal(fs.readFileSync(planPath, "utf8"), editedMd);

      // 2) Implicit sync_from_md (without sessionId) targets Session A without PLAN_SESSION_MISMATCH
      const syncOut = await server.handlePlan({ action: "sync_from_md" });
      assert.equal(syncOut.sessionId, sidA);
      assert.equal(syncOut.tasks[0]?.title, "Synced A1 from PLAN.md");
      assert.equal(db.getTask(sidB, "T1.1")?.title, "Original B1");

      // 3) Implicit dispatch (without sessionId) claims task in Session A, not Session B
      const dispOut = await server.handleDispatch({
        sessionId: "",
        turn: 1,
        mode: "claim_only",
      });
      assert.equal(dispOut.sessionId, sidA);
      assert.equal(db.getTask(sidA, "T1.1")?.status, "running");
      assert.equal(db.getTask(sidB, "T1.1")?.status, "pending");

      // 4) Implicit verify (without sessionId) verifies task in Session A
      fs.mkdirSync(path.join(root, "src"), { recursive: true });
      fs.writeFileSync(path.join(root, "src", "a.ts"), "export const a = 1;\n", "utf8");
      const verifyOut = await server.handleVerify({
        sessionId: "",
        taskId: "T1.1",
        doneClaim: {
          summary: "Done A1",
          changed_files: ["src/a.ts"],
          key_decisions: [],
          risks: [],
        },
      });
      assert.equal(verifyOut.verified, true);
      assert.equal(db.getTask(sidA, "T1.1")?.status, "done");
      assert.equal(db.getTask(sidB, "T1.1")?.status, "pending");
    } finally {
      server.close();
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("6. F04: handlePlan({ action: 'get' }) is strictly read-only (does not overwrite PLAN.md, main.json, or DB state)", async () => {
    const root = makeTempProject();
    const db = new SqliteDriver(path.join(root, ".asd", "core.db"));
    const server = new AsdMcpServer({ projectRoot: root, db });
    const planPath = path.join(root, ".asd", "PLAN.md");
    try {
      // 1) Calling 'get' on an empty project creates zero DB sessions and zero files on disk
      const emptyGet = await server.handlePlan({ action: "get" });
      assert.equal(emptyGet.stateVersion, 0);
      assert.deepEqual(emptyGet.tasks, []);
      assert.equal(emptyGet.foreground, false);
      assert.equal(db.getLatestSession(), undefined);
      assert.equal(fs.existsSync(planPath), false);
      assert.equal(fs.existsSync(path.join(root, ".asd", "sessions")), false);

      // 2) Create a session, then manually edit PLAN.md and remove main.json
      const sid = "asd-20261101-120000-r001";
      await server.handlePlan({
        action: "create",
        sessionId: sid,
        tasks: [
          {
            taskId: "T1.1",
            turn: 1,
            title: "Initial Task Title",
            targetFiles: ["src/x.ts"],
          },
        ],
      });

      const beforeSession = db.getSession(sid)!;
      const beforeTasks = db.getSessionTasks(sid);
      const mainJsonPath = path.join(root, ".asd", "sessions", sid, "main.json");
      fs.unlinkSync(mainJsonPath);

      const customPlanBytes =
        fs.readFileSync(planPath, "utf8").replace("Initial Task Title", "Manual User Edit Before Sync") +
        "\n<!-- custom user note -->\n";
      fs.writeFileSync(planPath, customPlanBytes, "utf8");

      // Call handlePlan({ action: 'get' })
      const getRes = await server.handlePlan({ action: "get" });
      assert.equal(getRes.sessionId, sid);
      assert.equal(getRes.stateVersion, beforeSession.state_version);
      assert.equal(getRes.tasks[0]?.title, "Initial Task Title");

      // Verify PLAN.md bytes, DB state_version, DB tasks, and main.json were NOT touched
      assert.equal(fs.readFileSync(planPath, "utf8"), customPlanBytes);
      assert.equal(db.getSession(sid)?.state_version, beforeSession.state_version);
      assert.deepEqual(db.getSessionTasks(sid), beforeTasks);
      assert.equal(fs.existsSync(mainJsonPath), false);
    } finally {
      server.close();
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});