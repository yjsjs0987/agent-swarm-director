import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { openProjectDb } from "../src/core/db.ts";
import {
  ensureGitUserIdentity,
  prepareBaseline,
  rejectPendingTask,
  rollbackLightChanges,
  runGit,
  verifyAndCommitLightTask,
} from "../src/core/workspace.ts";

function makeTempRepo(prefix = "asd-light-rollback-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  runGit(["init"], { cwd: dir });
  runGit(["config", "core.autocrlf", "false"], { cwd: dir });
  ensureGitUserIdentity(dir);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src/a.ts"), "export const a = 1;\n", "utf8");
  fs.writeFileSync(path.join(dir, "notes.txt"), "committed note\n", "utf8");
  runGit(["add", "-A"], { cwd: dir });
  runGit(["commit", "-m", "init", "--no-verify"], { cwd: dir });
  prepareBaseline(dir);
  return dir;
}

test("CR-07: rejectPendingTask on LIGHT task restores only allowedFiles (tracked and untracked) while preserving user uncommitted files", () => {
  const root = makeTempRepo();
  try {
    const db = openProjectDb(root);
    const sessionId = "asd-20261101-120700-lrb1";
    db.createOrGetSession({
      sessionId,
      projectRoot: root,
      mainHarness: "claude-code",
    });
    db.upsertTasks(sessionId, [
      {
        taskId: "T1.1",
        turn: 1,
        title: "Light task",
        track: "LIGHT",
        role: "worker",
        targetFiles: ["src/**"],
      },
    ]);
    db.updateTaskStatus(sessionId, "T1.1", "verifying");

    // User uncommitted edit outside task scope
    fs.writeFileSync(path.join(root, "notes.txt"), "user dirty note\n", "utf8");
    fs.writeFileSync(path.join(root, "user-draft.md"), "user untracked draft\n", "utf8");

    // Task edits inside src/** (allowed)
    fs.writeFileSync(path.join(root, "src/a.ts"), "export const a = 999;\n", "utf8");
    fs.writeFileSync(path.join(root, "src/new.ts"), "export const created = true;\n", "utf8");

    const res = rejectPendingTask({
      projectRoot: root,
      sessionId,
      taskId: "T1.1",
      db,
    });

    assert.equal(res.ok, true);
    assert.equal(res.status, "failed");
    assert.ok(res.untouchedFiles?.includes("notes.txt"));
    assert.ok(res.untouchedFiles?.includes("user-draft.md"));

    // Allowed task changes rolled back:
    assert.equal(fs.readFileSync(path.join(root, "src/a.ts"), "utf8"), "export const a = 1;\n");
    assert.equal(fs.existsSync(path.join(root, "src/new.ts")), false);

    // User uncommitted changes preserved:
    assert.equal(fs.readFileSync(path.join(root, "notes.txt"), "utf8"), "user dirty note\n");
    assert.equal(fs.readFileSync(path.join(root, "user-draft.md"), "utf8"), "user untracked draft\n");

    db.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("CR-07: verifyAndCommitLightTask failure rolls back only scoped files and preserves out-of-scope user changes", () => {
  const root = makeTempRepo();
  try {
    // Modify both allowed src/a.ts, new allowed src/new.ts, and out-of-scope notes.txt
    fs.writeFileSync(path.join(root, "src/a.ts"), "export const a = 2;\n", "utf8");
    fs.writeFileSync(path.join(root, "src/new.ts"), "export const n = 1;\n", "utf8");
    fs.writeFileSync(path.join(root, "notes.txt"), "important user work\n", "utf8");

    const res = verifyAndCommitLightTask({
      projectRoot: root,
      taskId: "T1.1",
      title: "Light task boundary failure",
      allowedFiles: ["src/**"],
      verifyCmd: "node -e \"process.exit(0)\"",
    });

    assert.equal(res.verified, false);
    assert.equal(res.rollbackPerformed, true);
    assert.ok(res.untouchedFiles?.includes("notes.txt"));

    // Scoped task files restored/removed
    assert.equal(fs.readFileSync(path.join(root, "src/a.ts"), "utf8"), "export const a = 1;\n");
    assert.equal(fs.existsSync(path.join(root, "src/new.ts")), false);

    // User file preserved
    assert.equal(fs.readFileSync(path.join(root, "notes.txt"), "utf8"), "important user work\n");

    // Direct rollbackLightChanges with explicit files option
    rollbackLightChanges(root, { files: ["notes.txt"] });
    assert.equal(fs.readFileSync(path.join(root, "notes.txt"), "utf8"), "committed note\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
