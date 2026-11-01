import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import * as asd from "../src/index.ts";
import { getAdapter } from "../src/adapters/registry.ts";
import { buildInteractiveResumeHarnessCommand } from "../src/core/session-tracker.ts";
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
  assert.equal(asd.ASD_VERSION, "2.3.2");
});
