import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { openProjectDb } from "../src/core/db.ts";
import { parsePlanMd, renderPlanMd, syncPlanFromMd } from "../src/core/render.ts";
import {
  createTaskWorktree,
  ensureGitUserIdentity,
  prepareBaseline,
  runGit,
} from "../src/core/workspace.ts";
import { runSubagentControlAction } from "../src/core/subagent-control.ts";

function makeTempGitRepo(prefix = "asd-sub-resume-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  runGit(["init"], { cwd: dir });
  runGit(["config", "core.autocrlf", "false"], { cwd: dir });
  ensureGitUserIdentity(dir);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src/feature.ts"), "export const v = 1;\n", "utf8");
  runGit(["add", "-A"], { cwd: dir });
  runGit(["commit", "-m", "initial", "--no-verify"], { cwd: dir });
  prepareBaseline(dir);
  return dir;
}

test("CR-13: resuming a done task creates follow-up task T1.3 with follow_up_of='T1.1', runs verification gate, and round-trips PLAN.md", async () => {
  const root = makeTempGitRepo();
  try {
    const db = openProjectDb(root);
    const sessionId = "asd-20261101-121300-res1";
    db.createOrGetSession({
      sessionId,
      projectRoot: root,
      mainHarness: "claude-code",
      autoApprove: true,
    });
    db.upsertTasks(sessionId, [
      {
        taskId: "T1.1",
        turn: 1,
        title: "Original feature task",
        track: "HEAVY",
        role: "worker",
        targetFiles: ["src/feature.ts"],
        verifyCmd: "node -e \"process.exit(0)\"",
      },
      {
        taskId: "T1.2",
        turn: 1,
        title: "Second task in turn 1",
        track: "HEAVY",
        role: "worker",
        targetFiles: ["src/other.ts"],
      },
    ]);
    db.updateTaskStatus(sessionId, "T1.1", "done", {
      subSessionId: "sub-1-T1.1-worker-codex",
    });

    const subDir = path.join(
      root,
      ".asd",
      "sessions",
      sessionId,
      "subagents",
      "sub-1-T1.1-worker-codex"
    );
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(
      path.join(subDir, "meta.json"),
      JSON.stringify(
        {
          subSessionId: "sub-1-T1.1-worker-codex",
          parentSessionId: sessionId,
          roleType: "subagent",
          role: "worker",
          harness: "codex",
          model: "gpt-5.4",
          harnessSessionId: "codex-thread-done-1",
          taskId: "T1.1",
          pid: 1001,
          worktreePath: null,
          allowedFiles: ["src/feature.ts"],
          status: "done",
          startedAt: Date.now() - 1000,
        },
        null,
        2
      ),
      "utf8"
    );
    db.close();

    // Resume T1.1 -> should create T1.3 with follow_up_of = 'T1.1'
    const res = await runSubagentControlAction({
      projectRoot: root,
      sessionId,
      subSessionId: "sub-1-T1.1-worker-codex",
      action: "resume",
      prompt: "Add extra export to src/feature.ts",
      commandRunner: {
        async run(_cmd, _args, opts) {
          fs.writeFileSync(
            path.join(opts.cwd!, "src/feature.ts"),
            "export const v = 2;\nexport const extra = true;\n",
            "utf8"
          );
          opts.onStdout(JSON.stringify({ thread_id: "codex-thread-done-1" }) + "\n");
          return { exitCode: 0, pid: 2002 };
        },
      },
    });

    assert.equal(res.ok, true);
    assert.equal(res.status, "done");
    assert.equal(res.taskId, "T1.3");
    assert.equal(res.followUpTaskId, "T1.3");

    // Verify merged into main working tree
    const mainContent = fs.readFileSync(path.join(root, "src/feature.ts"), "utf8");
    assert.ok(mainContent.includes("export const extra = true;"));

    const dbAfter = openProjectDb(root);
    const followTask = dbAfter.getTask(sessionId, "T1.3")!;
    assert.ok(followTask);
    assert.equal(followTask.status, "done");
    assert.equal(followTask.follow_up_of, "T1.1");
    assert.deepEqual(JSON.parse(followTask.depends_on_json), ["T1.1"]);

    // Verify PLAN.md round-trip preserves follow_up_of
    const planPath = path.join(root, ".asd", "PLAN.md");
    const mdText = renderPlanMd(
      dbAfter.getSession(sessionId)!,
      dbAfter.getSessionTasks(sessionId),
      planPath,
      { force: true }
    );
    const parsed = parsePlanMd(mdText);
    const parsedT13 = parsed.find((t) => t.taskId === "T1.3");
    assert.equal(parsedT13?.followUpOf, "T1.1");

    syncPlanFromMd(dbAfter, sessionId, planPath);
    assert.equal(dbAfter.getTask(sessionId, "T1.3")!.follow_up_of, "T1.1");
    dbAfter.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("CR-13: resuming a verifying task runs in the same worktree and respects session auto_approve, and rejects mismatched harness or missing session ID", async () => {
  const root = makeTempGitRepo();
  try {
    const db = openProjectDb(root);
    const sessionId = "asd-20261101-121301-res2";
    db.createOrGetSession({
      sessionId,
      projectRoot: root,
      mainHarness: "claude-code",
      autoApprove: false,
    });

    const wt = createTaskWorktree(root, 1, "T1.1");
    fs.writeFileSync(path.join(wt.wtPath, "src/feature.ts"), "export const v = 10;\n", "utf8");

    db.upsertTasks(sessionId, [
      {
        taskId: "T1.1",
        turn: 1,
        title: "Verifying task",
        track: "HEAVY",
        role: "worker",
        targetFiles: ["src/feature.ts"],
        verifyCmd: "node -e \"process.exit(0)\"",
      },
    ]);
    db.updateTaskStatus(sessionId, "T1.1", "verifying", {
      worktreePath: wt.wtPath,
      subSessionId: "sub-1-T1.1-worker-claude-code",
    });

    const subBase = path.join(root, ".asd", "sessions", sessionId, "subagents");
    const subDir = path.join(subBase, "sub-1-T1.1-worker-claude-code");
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(
      path.join(subDir, "meta.json"),
      JSON.stringify(
        {
          subSessionId: "sub-1-T1.1-worker-claude-code",
          parentSessionId: sessionId,
          roleType: "subagent",
          role: "worker",
          harness: "claude-code",
          model: "claude-sonnet-4-6",
          harnessSessionId: "cc-verifying-sid",
          taskId: "T1.1",
          pid: 3001,
          worktreePath: wt.wtPath,
          allowedFiles: ["src/feature.ts"],
          status: "done",
          startedAt: Date.now() - 1000,
        },
        null,
        2
      ),
      "utf8"
    );

    const noSidDir = path.join(subBase, "sub-nosid");
    fs.mkdirSync(noSidDir, { recursive: true });
    fs.writeFileSync(
      path.join(noSidDir, "meta.json"),
      JSON.stringify({
        subSessionId: "sub-nosid",
        parentSessionId: sessionId,
        roleType: "subagent",
        role: "worker",
        harness: "claude-code",
        model: "claude-sonnet-4-6",
        harnessSessionId: null,
        taskId: "T1.1",
        pid: 3002,
        worktreePath: wt.wtPath,
        allowedFiles: ["src/feature.ts"],
        status: "failed",
      }),
      "utf8"
    );
    db.close();

    // 1. Mismatched harness -> RESUME_HARNESS_MISMATCH
    await assert.rejects(
      () =>
        runSubagentControlAction({
          projectRoot: root,
          sessionId,
          subSessionId: "sub-1-T1.1-worker-claude-code",
          action: "resume",
          harness: "codex",
          prompt: "Try wrong harness",
        }),
      /RESUME_HARNESS_MISMATCH/
    );

    // 2. Missing harnessSessionId -> NO_HARNESS_SESSION
    await assert.rejects(
      () =>
        runSubagentControlAction({
          projectRoot: root,
          sessionId,
          subSessionId: "sub-nosid",
          action: "resume",
          prompt: "Try without sid",
        }),
      /NO_HARNESS_SESSION/
    );

    // 3. Resume verifying task with auto_approve = false -> runs in wt.wtPath and returns to 'verifying'
    let usedCwd = "";
    const res = await runSubagentControlAction({
      projectRoot: root,
      sessionId,
      subSessionId: "sub-1-T1.1-worker-claude-code",
      action: "resume",
      prompt: "Refine feature in worktree",
      commandRunner: {
        async run(_cmd, _args, opts) {
          usedCwd = opts.cwd!;
          fs.writeFileSync(path.join(opts.cwd!, "src/feature.ts"), "export const v = 20;\n", "utf8");
          return { exitCode: 0, pid: 3005 };
        },
      },
    });

    assert.equal(path.resolve(usedCwd), path.resolve(wt.wtPath));
    assert.equal(res.status, "verifying");
    assert.equal(res.taskId, "T1.1");
    assert.equal(res.followUpTaskId, undefined);

    const dbCheck = openProjectDb(root);
    assert.equal(dbCheck.getTask(sessionId, "T1.1")!.status, "verifying");
    dbCheck.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
