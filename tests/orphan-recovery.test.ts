import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { openProjectDb } from "../src/core/db.ts";
import {
  recoverOrphanedTasks,
  createTaskWorktree,
  runGit,
  ensureGitUserIdentity,
  prepareBaseline,
} from "../src/core/workspace.ts";
import { AsdMcpServer } from "../src/mcp/server.ts";

function makeTempGitRepo(prefix = "asd-orphan-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  runGit(["init"], { cwd: dir });
  ensureGitUserIdentity(dir);
  prepareBaseline(dir);
  return dir;
}

test("CR-12: recoverOrphanedTasks transitions dead parallel_spawn tasks to failed while preserving worktree", () => {
  const root = makeTempGitRepo("asd-orphan-ps-");
  try {
    const db = openProjectDb(root);
    const sessionId = "asd-20261101-120000-orps";
    db.createOrGetSession({
      sessionId,
      projectRoot: root,
      mainHarness: "claude-code",
      track: "HEAVY",
      goal: "Test orphan recovery",
    });

    const wt = createTaskWorktree(root, 1, "T1.1");
    fs.writeFileSync(path.join(wt.wtPath, "partial.txt"), "work in progress\n", "utf8");

    db.upsertTasks(sessionId, [
      {
        taskId: "T1.1",
        turn: 1,
        title: "Orphaned parallel task",
        role: "worker",
        track: "HEAVY",
        targetFiles: ["partial.txt"],
        dependsOn: [],
        verifyCmd: "node -e \"process.exit(0)\"",
      },
    ]);
    db.updateTaskStatus(sessionId, "T1.1", "running", {
      worktreePath: wt.wtPath,
      subSessionId: "sub-1-T1_1-1000",
    });

    const subDir = path.join(root, ".asd", "sessions", sessionId, "subagents", "sub-1-T1_1-1000");
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(
      path.join(subDir, "meta.json"),
      JSON.stringify(
        {
          subSessionId: "sub-1-T1_1-1000",
          sessionId,
          taskId: "T1.1",
          turn: 1,
          role: "worker",
          harness: "codex",
          model: "gpt-5.4",
          cwd: wt.wtPath,
          pid: 999991,
          ownerPid: 999992,
          dispatchMode: "parallel_spawn",
          startedAt: Date.now() - 5000,
          status: "running",
        },
        null,
        2
      ),
      "utf8"
    );
    fs.writeFileSync(path.join(subDir, "prompt.md"), "Prompt text", "utf8");
    fs.writeFileSync(path.join(subDir, "output.log"), "Some log", "utf8");

    const verBefore = db.getSession(sessionId)!.state_version;
    const recovered = recoverOrphanedTasks({ db, projectRoot: root, sessionId });

    assert.equal(recovered.length, 1);
    assert.deepEqual(recovered[0], {
      sessionId,
      taskId: "T1.1",
      from: "running",
      to: "failed",
      reason: "orphaned",
    });

    const taskAfter = db.getTask(sessionId, "T1.1")!;
    assert.equal(taskAfter.status, "failed");
    assert.equal(taskAfter.worktree_path, wt.wtPath);
    assert.ok(fs.existsSync(path.join(wt.wtPath, "partial.txt")));

    const verAfter = db.getSession(sessionId)!.state_version;
    assert.ok(verAfter > verBefore);

    const metaAfter = JSON.parse(fs.readFileSync(path.join(subDir, "meta.json"), "utf8"));
    assert.equal(metaAfter.status, "failed");
    assert.equal(fs.existsSync(path.join(subDir, "prompt.md")), false);
    assert.equal(fs.existsSync(path.join(subDir, "output.log")), false);

    // Retrying createTaskWorktree for T1.1 cleans up preserved worktree/branch cleanly without collision
    const wtRetry = createTaskWorktree(root, 1, "T1.1");
    assert.equal(wtRetry.wtPath, wt.wtPath);
    assert.equal(fs.existsSync(path.join(wtRetry.wtPath, "partial.txt")), false);

    db.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("CR-12: recoverOrphanedTasks ignores claim_only tasks and applies 24h TTL to legacy tasks", () => {
  const root = makeTempGitRepo("asd-orphan-co-");
  try {
    const db = openProjectDb(root);
    const sessionId = "asd-20261101-120001-orco";
    db.createOrGetSession({
      sessionId,
      projectRoot: root,
      mainHarness: "claude-code",
      track: "LIGHT",
      goal: "Test claim_only and legacy TTL",
    });

    const now = Date.now();
    db.upsertTasks(sessionId, [
      {
        taskId: "T1.1",
        turn: 1,
        title: "Claim only task",
        role: "worker",
        track: "LIGHT",
        targetFiles: ["a.ts"],
        dependsOn: [],
      },
      {
        taskId: "T1.2",
        turn: 1,
        title: "Legacy recent task",
        role: "worker",
        track: "LIGHT",
        targetFiles: ["b.ts"],
        dependsOn: [],
      },
      {
        taskId: "T1.3",
        turn: 1,
        title: "Legacy expired task",
        role: "worker",
        track: "LIGHT",
        targetFiles: ["c.ts"],
        dependsOn: [],
      },
    ]);
    db.updateTaskStatus(sessionId, "T1.1", "running", { subSessionId: "claim-1-T1_1-1000" });
    db.updateTaskStatus(sessionId, "T1.2", "running", { subSessionId: "legacy-recent" });
    db.updateTaskStatus(sessionId, "T1.3", "running", { subSessionId: "legacy-expired" });

    const subBase = path.join(root, ".asd", "sessions", sessionId, "subagents");
    fs.mkdirSync(path.join(subBase, "claim-1-T1_1-1000"), { recursive: true });
    fs.writeFileSync(
      path.join(subBase, "claim-1-T1_1-1000", "meta.json"),
      JSON.stringify({
        subSessionId: "claim-1-T1_1-1000",
        sessionId,
        taskId: "T1.1",
        turn: 1,
        dispatchMode: "claim_only",
        pid: 999993,
        ownerPid: 999994,
        startedAt: now - 48 * 60 * 60 * 1000,
        status: "running",
      }),
      "utf8"
    );

    fs.mkdirSync(path.join(subBase, "legacy-recent"), { recursive: true });
    fs.writeFileSync(
      path.join(subBase, "legacy-recent", "meta.json"),
      JSON.stringify({
        subSessionId: "legacy-recent",
        sessionId,
        taskId: "T1.2",
        turn: 1,
        pid: 999995,
        startedAt: now - 60 * 1000,
        status: "running",
      }),
      "utf8"
    );

    fs.mkdirSync(path.join(subBase, "legacy-expired"), { recursive: true });
    fs.writeFileSync(
      path.join(subBase, "legacy-expired", "meta.json"),
      JSON.stringify({
        subSessionId: "legacy-expired",
        sessionId,
        taskId: "T1.3",
        turn: 1,
        pid: 999996,
        startedAt: now - 25 * 60 * 60 * 1000,
        status: "running",
      }),
      "utf8"
    );

    const recovered = recoverOrphanedTasks({ db, projectRoot: root, sessionId, now });
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].taskId, "T1.3");
    assert.equal(db.getTask(sessionId, "T1.1")!.status, "running");
    assert.equal(db.getTask(sessionId, "T1.2")!.status, "running");
    assert.equal(db.getTask(sessionId, "T1.3")!.status, "failed");

    db.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("CR-12: concurrent handleDispatch calls claim and execute each task at most once via tryClaimTask", async () => {
  const root = makeTempGitRepo("asd-orphan-atomic-");
  try {
    const db = openProjectDb(root);
    const sessionId = "asd-20261101-120002-atom";
    let spawnCount = 0;

    const server = new AsdMcpServer({
      db,
      projectRoot: root,
      autoSync: false,
      commandRunner: {
        async run(_cmd, _args, opts) {
          spawnCount++;
          await new Promise((r) => setTimeout(r, 25));
          const baseName = path.basename(opts.cwd);
          const taskId = baseName.includes("-") ? baseName.split("-").slice(1).join("-") : "T1.1";
          fs.writeFileSync(path.join(opts.cwd, `${taskId}.txt`), "done\n", "utf8");
          opts.onStdout?.("ok\n");
          return { exitCode: 0 };
        },
      },
    });

    await server.handlePlan({
      action: "create",
      sessionId,
      projectRoot: root,
      mainHarness: "claude-code",
      track: "HEAVY",
      goal: "Concurrent dispatch test",
      tasks: [
        {
          taskId: "T1.1",
          turn: 1,
          title: "Task 1",
          role: "worker",
          track: "HEAVY",
          targetFiles: ["T1.1.txt"],
          verifyCmd: "",
        },
        {
          taskId: "T1.2",
          turn: 1,
          title: "Task 2",
          role: "worker",
          track: "HEAVY",
          targetFiles: ["T1.2.txt"],
          verifyCmd: "",
        },
      ],
    });

    const [resA, resB] = await Promise.all([
      server.handleDispatch({ sessionId, turn: 1, mode: "parallel_spawn" }),
      server.handleDispatch({ sessionId, turn: 1, mode: "parallel_spawn" }),
    ]);

    assert.equal(spawnCount, 2, "Each of the 2 tasks must be spawned at most once across concurrent handleDispatch calls");
    const totalDispatched = resA.results.length + resB.results.length;
    assert.equal(totalDispatched, 2);

    db.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("F07: handleDispatch automatically recovers dead parallel_spawn tasks and re-dispatches them without manual recoverOrphanedTasks call", async () => {
  const root = makeTempGitRepo("asd-orphan-f07-");
  try {
    const db = openProjectDb(root);
    const sessionId = "asd-20261105-095000-f07a";
    let spawnCount = 0;

    const server = new AsdMcpServer({
      db,
      projectRoot: root,
      autoSync: false,
      commandRunner: {
        async run(_cmd, _args, opts) {
          spawnCount++;
          fs.writeFileSync(path.join(opts.cwd, "recovered.txt"), "recovered work\n", "utf8");
          opts.onStdout?.("ok\n");
          return { exitCode: 0, pid: 77777 };
        },
      },
    });

    await server.handlePlan({
      action: "create",
      sessionId,
      projectRoot: root,
      mainHarness: "claude-code",
      tasks: [
        {
          taskId: "T1.1",
          turn: 1,
          title: "Crashed parallel task to recover on next dispatch",
          role: "worker",
          track: "HEAVY",
          targetFiles: ["recovered.txt"],
          verifyCmd: "",
        },
      ],
    });

    // Simulate a previous crash: task is stuck in 'running' with dead pid and dead ownerPid
    const wt = createTaskWorktree(root, 1, "T1.1");
    const deadSubId = "sub-1-T1.1-worker-codex";
    db.updateTaskStatus(sessionId, "T1.1", "running", {
      worktreePath: wt.wtPath,
      subSessionId: deadSubId,
    });
    const subDir = path.join(root, ".asd", "sessions", sessionId, "subagents", deadSubId);
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(
      path.join(subDir, "meta.json"),
      JSON.stringify({
        subSessionId: deadSubId,
        parentSessionId: sessionId,
        taskId: "T1.1",
        turn: 1,
        role: "worker",
        harness: "codex",
        model: "gpt-5.4",
        pid: 999981,
        ownerPid: 999982,
        dispatchMode: "parallel_spawn",
        startedAt: Date.now() - 10_000,
        status: "running",
      }),
      "utf8"
    );

    // Calling handleDispatch directly (without manual recoverOrphanedTasks) must recover T1.1 -> failed -> re-claim -> done
    const dispRes = await server.handleDispatch({
      sessionId,
      turn: 1,
      mode: "parallel_spawn",
    });

    assert.equal(spawnCount, 1);
    assert.equal(dispRes.results.length, 1);
    assert.equal(dispRes.results[0]?.taskId, "T1.1");
    assert.equal(dispRes.results[0]?.status, "done");
    assert.equal(db.getTask(sessionId, "T1.1")?.status, "done");

    db.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
