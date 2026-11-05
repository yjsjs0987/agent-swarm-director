import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SqliteDriver } from "../src/core/db.ts";
import { attachDriver, buildDriverBriefing } from "../src/core/drivers.ts";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "asd-cr02-test-"));
}

describe("CR-02: 0-Token Driver Briefing (buildDriverBriefing)", () => {
  test("1. 0-task session returns header and guidance without error", () => {
    const root = makeTempDir();
    const db = new SqliteDriver(path.join(root, ".asd", "core.db"));
    try {
      const sid = "asd-20261101-133000-b001";
      db.createOrGetSession({
        sessionId: sid,
        projectRoot: root,
        mainHarness: "claude-code",
        memo: "Zero task briefing",
      });

      const briefing = buildDriverBriefing({
        db,
        projectRoot: root,
        sessionId: sid,
      });

      assert.ok(briefing.startsWith("# ASD Session Briefing"));
      assert.ok(briefing.includes(`Session ID: ${sid}`));
      assert.ok(briefing.includes("Zero task briefing"));
      assert.ok(briefing.includes("asd_plan, asd_dispatch, asd_verify, asd_debate"));
      assert.ok(!briefing.includes("## Attention Needed Tasks"));
      assert.ok(!briefing.includes("## Recently Completed Tasks"));
    } finally {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("2. includes previous drivers, progress board, attention tasks (verifying/merge_conflict/failed/escalated), done summaries, and summary.md", () => {
    const root = makeTempDir();
    const db = new SqliteDriver(path.join(root, ".asd", "core.db"));
    try {
      const sid = "asd-20261101-133001-b002";
      db.createOrGetSession({
        sessionId: sid,
        projectRoot: root,
        mainHarness: "claude-code",
        mainModel: "claude-sonnet-4",
        harnessSessionId: "cc-1",
      });

      // Switch driver so previous driver appears
      attachDriver(db, {
        projectRoot: root,
        sessionId: sid,
        harness: "codex",
        model: "gpt-5.3-codex",
        harnessSessionId: "cx-2",
        source: "gui",
      });

      db.upsertTasks(sid, [
        { taskId: "T1.1", turn: 1, title: "Completed task", targetFiles: ["src/a.ts"] },
        { taskId: "T1.2", turn: 1, title: "Verifying task", track: "HEAVY", targetFiles: ["src/b.ts"] },
        { taskId: "T1.3", turn: 1, title: "Conflict task", track: "HEAVY", targetFiles: ["src/c.ts"] },
      ]);

      db.updateTaskStatus(sid, "T1.1", "done", {
        doneClaimJson: JSON.stringify({
          summary: "Implemented module A",
          changed_files: ["src/a.ts"],
          key_decisions: ["Used pure functions"],
          risks: [],
        }),
      });
      db.updateTaskStatus(sid, "T1.2", "verifying", {
        worktreePath: path.join(root, ".asd", "wt", "1-T1.2"),
      });
      db.updateTaskStatus(sid, "T1.3", "merge_conflict", {
        worktreePath: path.join(root, ".asd", "wt", "1-T1.3"),
      });

      const summaryDir = path.join(root, ".asd", "sessions", sid);
      fs.mkdirSync(summaryDir, { recursive: true });
      fs.writeFileSync(path.join(summaryDir, "summary.md"), "Custom session summary note.", "utf8");

      const briefing = buildDriverBriefing({
        db,
        projectRoot: root,
        sessionId: sid,
      });

      assert.ok(briefing.includes("## Previous Drivers"));
      assert.ok(briefing.includes("claude-code/claude-sonnet-4"));
      assert.ok(briefing.includes("### 📊 ASD TODO 진행 현황"));
      assert.ok(briefing.includes("## Attention Needed Tasks"));
      assert.ok(briefing.includes("**T1.2** [verifying]: Verifying task"));
      assert.ok(briefing.includes("**T1.3** [merge_conflict]: Conflict task"));
      assert.ok(briefing.includes("## Recently Completed Tasks"));
      assert.ok(briefing.includes("Implemented module A"));
      assert.ok(briefing.includes("Used pure functions"));
      assert.ok(briefing.includes("## Session Summary"));
      assert.ok(briefing.includes("Custom session summary note."));
    } finally {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("3. maxChars=500 truncates in order (5 -> 6 -> 3) and stays <= 500 + suffix length", () => {
    const root = makeTempDir();
    const db = new SqliteDriver(path.join(root, ".asd", "core.db"));
    try {
      const sid = "asd-20261101-133002-b003";
      db.createOrGetSession({
        sessionId: sid,
        projectRoot: root,
        mainHarness: "claude-code",
      });

      for (let i = 1; i <= 10; i++) {
        const tid = `T1.${i}`;
        db.upsertTasks(sid, [
          { taskId: tid, turn: 1, title: `Task number ${i} with description`, targetFiles: [`src/f${i}.ts`] },
        ]);
        db.updateTaskStatus(sid, tid, "done", {
          doneClaimJson: JSON.stringify({
            summary: `Detailed completion summary for task ${i} `.repeat(5),
            changed_files: [`src/f${i}.ts`],
            key_decisions: [`Decision ${i}A`, `Decision ${i}B`],
            risks: [],
          }),
        });
      }

      const suffix = "…(truncated)";
      const briefing = buildDriverBriefing({
        db,
        projectRoot: root,
        sessionId: sid,
        maxChars: 500,
      });

      assert.ok(briefing.endsWith(suffix));
      assert.ok(
        briefing.length <= 500 + suffix.length,
        `Expected length <= ${500 + suffix.length}, got ${briefing.length}`
      );
    } finally {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("4. masks secret patterns (sk-...) in done_claim via redactSecrets", () => {
    const root = makeTempDir();
    const db = new SqliteDriver(path.join(root, ".asd", "core.db"));
    try {
      const sid = "asd-20261101-133003-b004";
      db.createOrGetSession({
        sessionId: sid,
        projectRoot: root,
        mainHarness: "claude-code",
      });
      db.upsertTasks(sid, [
        { taskId: "T1.1", turn: 1, title: "Secret task", targetFiles: ["src/s.ts"] },
      ]);
      const fakeSecret = "sk-proj-1234567890abcdefghijklmnopqrstuvwxyzABCD";
      db.updateTaskStatus(sid, "T1.1", "done", {
        doneClaimJson: JSON.stringify({
          summary: `Used token ${fakeSecret} during test`,
          changed_files: ["src/s.ts"],
          key_decisions: [],
          risks: [],
        }),
      });

      const briefing = buildDriverBriefing({
        db,
        projectRoot: root,
        sessionId: sid,
      });

      assert.ok(!briefing.includes(fakeSecret), "Secret must be redacted from briefing");
      assert.ok(briefing.includes("[REDACTED"));
    } finally {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  test("5. F18: Recently Completed Tasks are ordered newest-first by completion time (updated_at DESC)", () => {
    const root = makeTempDir();
    const db = new SqliteDriver(path.join(root, ".asd", "core.db"));
    try {
      const sid = "asd-20261105-090500-b005";
      db.createOrGetSession({
        sessionId: sid,
        projectRoot: root,
        mainHarness: "claude-code",
      });

      db.upsertTasks(sid, [
        { taskId: "T1.1", turn: 1, title: "First completed", targetFiles: ["src/1.ts"] },
        { taskId: "T1.2", turn: 1, title: "Third completed", targetFiles: ["src/2.ts"] },
        { taskId: "T2.1", turn: 2, title: "Second completed", targetFiles: ["src/3.ts"] },
      ]);

      // Complete in order: T1.1 -> T2.1 -> T1.2
      db.recordTaskVerified(
        sid,
        "T1.1",
        "sha1",
        { summary: "Done first", changed_files: ["src/1.ts"], key_decisions: [], risks: [] },
        100
      );
      db.recordTaskVerified(
        sid,
        "T2.1",
        "sha2",
        { summary: "Done second", changed_files: ["src/3.ts"], key_decisions: [], risks: [] },
        100
      );
      db.recordTaskVerified(
        sid,
        "T1.2",
        "sha3",
        { summary: "Done third", changed_files: ["src/2.ts"], key_decisions: [], risks: [] },
        100
      );

      const briefing = buildDriverBriefing({
        db,
        projectRoot: root,
        sessionId: sid,
      });

      const idxT12 = briefing.indexOf("- **T1.2** (Third completed)");
      const idxT21 = briefing.indexOf("- **T2.1** (Second completed)");
      const idxT11 = briefing.indexOf("- **T1.1** (First completed)");

      assert.ok(idxT12 !== -1 && idxT21 !== -1 && idxT11 !== -1, "All completed tasks must appear");
      assert.ok(idxT12 < idxT21, "T1.2 (completed last) must appear before T2.1");
      assert.ok(idxT21 < idxT11, "T2.1 (completed second) must appear before T1.1");
    } finally {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
