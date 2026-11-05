import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import * as asd from "../src/index.ts";
import { getAdapter } from "../src/adapters/registry.ts";
import {
  buildInteractiveResumeHarnessCommand,
  buildSessionDemotion,
} from "../src/core/session-tracker.ts";
import { openProjectDb } from "../src/core/db.ts";
import type { HarnessId } from "../src/core/types.ts";

test("CR-17.1: adapter buildInteractiveResumeCommand matches buildInteractiveResumeHarnessCommand across all 5 harnesses", () => {
  const harnesses: HarnessId[] = [
    "claude-code",
    "opencode",
    "codex",
    "antigravity",
    "cursor",
  ];

  for (const h of harnesses) {
    const adapter = getAdapter(h);
    assert.ok(adapter.buildInteractiveResumeCommand, `Adapter ${h} must define buildInteractiveResumeCommand`);
    const fromAdapter = adapter.buildInteractiveResumeCommand!("sess-123", "model-x");
    const fromTracker = buildInteractiveResumeHarnessCommand({
      harness: h,
      harnessSessionId: "sess-123",
      model: "model-x",
    });

    assert.equal(fromAdapter.cmd, fromTracker.command, `Command mismatch for ${h}`);
    assert.deepEqual(fromAdapter.args, fromTracker.args, `Args mismatch for ${h}`);
  }

  // Verify new session (no harnessSessionId) commands
  const agyNew = buildInteractiveResumeHarnessCommand({ harness: "antigravity" });
  assert.equal(agyNew.command, "agy");
  assert.deepEqual(agyNew.args, ["chat"]);

  const ocNew = buildInteractiveResumeHarnessCommand({ harness: "opencode", harnessSessionId: "oc-1" });
  assert.equal(ocNew.command, "opencode");
  assert.deepEqual(ocNew.args, ["--session", "oc-1"]);
});

test("CR-17.2 & Appendix B: tasks.thinking_effort column persists in SQLite and all Appendix B symbols are exported from src/index.ts", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "asd-cr17-"));
  try {
    const db = openProjectDb(tmpDir);
    const sessionId = asd.generateAsdSessionId();
    db.createOrGetSession({
      sessionId,
      projectRoot: tmpDir,
      mainHarness: "codex",
    });
    db.upsertTasks(sessionId, [
      {
        taskId: "T1.1",
        turn: 1,
        title: "Task with thinkingEffort",
        targetFiles: ["a.ts"],
        thinkingEffort: "high",
      },
    ]);
    const task = db.getTask(sessionId, "T1.1")!;
    assert.equal(task.thinking_effort, "high");
    db.close();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // Verify Appendix B runtime exports on src/index.ts
  const requiredExports = [
    "attachDriver",
    "setDriverHarnessSessionId",
    "detachDriver",
    "getActiveDriver",
    "listDrivers",
    "buildDriverBriefing",
    "runDriverTurn",
    "readHarnessTranscript",
    "locateHarnessTranscript",
    "finalizeSubagentArtifacts",
    "recoverOrphanedTasks",
    "getForegroundSessionId",
    "setForegroundSession",
    "generateAsdSessionId",
    "isValidAsdSessionId",
    "withMergeLock",
    "getWorktreeDiff",
    "rollbackLightChanges",
    "linkHarnessSessionToAsdSession",
    "runSubagentControlAction",
  ];
  for (const sym of requiredExports) {
    assert.equal(typeof (asd as Record<string, unknown>)[sym], "function", `Missing export in src/index.ts: ${sym}`);
  }
  assert.equal(typeof asd.buildSessionDemotion, "function", "buildSessionDemotion must be exported from src/index.ts");
  assert.equal(asd.ASD_VERSION, "2.4.2");
});

test("T1.1: buildSessionDemotion resolves active driver across harnesses and errors cleanly on missing driver or harness_session_id", () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "asd-demotion-home-"));
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "asd-demotion-proj-"));
  try {
    const db = openProjectDb(tmpDir, tmpHome);

    // 1. No session at all -> NO_SESSION
    assert.throws(
      () => buildSessionDemotion({ projectRoot: tmpDir, homeDir: tmpHome, db }),
      (err: unknown) => (err as { code?: string })?.code === "NO_SESSION"
    );

    // 2. Session with active driver but no harness_session_id -> NO_HARNESS_SESSION
    const noSidSession = "asd-20261103-100000-nsid";
    db.createOrGetSession({
      sessionId: noSidSession,
      projectRoot: tmpDir,
      mainHarness: "claude-code",
      mainModel: "claude-sonnet-4-6",
      harnessSessionId: null,
    });
    assert.throws(
      () =>
        buildSessionDemotion({
          projectRoot: tmpDir,
          homeDir: tmpHome,
          sessionId: noSidSession,
          db,
        }),
      (err: unknown) =>
        (err as { code?: string })?.code === "NO_HARNESS_SESSION" &&
        err instanceof Error &&
        err.message.includes("NO_HARNESS_SESSION")
    );

    // 3. Session with detached driver (no active driver) -> NO_ACTIVE_DRIVER
    const activeDrv = db.getActiveDriver(noSidSession)!;
    db.detachDriverRow(activeDrv.driver_id, "user", Date.now());
    assert.throws(
      () =>
        buildSessionDemotion({
          projectRoot: tmpDir,
          homeDir: tmpHome,
          sessionId: noSidSession,
          db,
        }),
      (err: unknown) =>
        (err as { code?: string })?.code === "NO_ACTIVE_DRIVER" &&
        err instanceof Error &&
        err.message.includes("NO_ACTIVE_DRIVER")
    );

    // 4. Normal cases across harnesses (latest session + explicit sessionId)
    const cases: Array<{
      sessionId: string;
      harness: HarnessId;
      sid: string;
      model: string;
      expectedCli: string;
    }> = [
      {
        sessionId: "asd-20261103-100001-cc01",
        harness: "claude-code",
        sid: "cc-uuid-1",
        model: "claude-sonnet-4-6",
        expectedCli: "claude --resume cc-uuid-1 --model claude-sonnet-4-6",
      },
      {
        sessionId: "asd-20261103-100002-oc01",
        harness: "opencode",
        sid: "oc-sid-2",
        model: "glm-5",
        expectedCli: "opencode --session oc-sid-2 --model glm-5",
      },
      {
        sessionId: "asd-20261103-100003-cx01",
        harness: "codex",
        sid: "cx-thread-3",
        model: "gpt-5.4",
        expectedCli: "codex resume cx-thread-3 -m gpt-5.4",
      },
      {
        sessionId: "asd-20261103-100004-ag01",
        harness: "antigravity",
        sid: "ag-conv-4",
        model: "gemini-3-pro",
        expectedCli: "agy --resume ag-conv-4 --model gemini-3-pro",
      },
      {
        sessionId: "asd-20261103-100005-cr01",
        harness: "cursor",
        sid: "cr-chat-5",
        model: "claude-3.7-sonnet",
        expectedCli: "agent --resume cr-chat-5 --model claude-3.7-sonnet",
      },
    ];

    for (const c of cases) {
      db.createOrGetSession({
        sessionId: c.sessionId,
        projectRoot: tmpDir,
        mainHarness: c.harness,
        mainModel: c.model,
        harnessSessionId: c.sid,
      });

      const res = buildSessionDemotion({
        projectRoot: tmpDir,
        homeDir: tmpHome,
        sessionId: c.sessionId,
        db,
      });
      assert.equal(res.sessionId, c.sessionId);
      assert.equal(res.harness, c.harness);
      assert.equal(res.harnessSessionId, c.sid);
      assert.equal(res.model, c.model);
      assert.equal(res.cliString, c.expectedCli);
      assert.ok(res.driverId.startsWith("drv-"));
    }

    db.close();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});
