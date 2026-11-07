import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { openProjectDb } from "../src/core/db.ts";
import { finalizeSubagentArtifacts, type CommandRunner } from "../src/core/spawner.ts";
import { ensureGitUserIdentity, prepareBaseline, rejectPendingTask, runGit } from "../src/core/workspace.ts";
import { AsdMcpServer } from "../src/mcp/server.ts";
import { scanSubagentLogs } from "../src/core/subagent-logs.ts";
import { runSubagentControlAction } from "../src/core/subagent-control.ts";

function makeTempGitProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asd-cr09-test-"));
  runGit(["init"], { cwd: dir });
  ensureGitUserIdentity(dir);
  prepareBaseline(dir);
  return dir;
}

describe("CR-09: Subagent Artifact Lifecycle (finalizeSubagentArtifacts & Prompt Reconstruction)", () => {
  test("1. finalizeSubagentArtifacts deletes prompt.md and output.log (or keeps last 8KB on keep:'tail') while preserving meta.json", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "asd-cr09-unit-"));
    try {
      const sid = "asd-20261101-133500-a001";
      const subId1 = "sub-1-T1.1-worker-claude-code";
      const subDir1 = path.join(root, ".asd", "sessions", sid, "subagents", subId1);
      fs.mkdirSync(subDir1, { recursive: true });
      fs.writeFileSync(path.join(subDir1, "meta.json"), JSON.stringify({ subSessionId: subId1, status: "done" }), "utf8");
      fs.writeFileSync(path.join(subDir1, "prompt.md"), "Prompt text", "utf8");
      fs.writeFileSync(path.join(subDir1, "output.log"), "Log text", "utf8");

      finalizeSubagentArtifacts({ projectRoot: root, sessionId: sid, subSessionId: subId1 });
      assert.ok(fs.existsSync(path.join(subDir1, "meta.json")));
      assert.ok(!fs.existsSync(path.join(subDir1, "prompt.md")));
      assert.ok(!fs.existsSync(path.join(subDir1, "output.log")));

      const logs = scanSubagentLogs(root);
      assert.equal(logs.length, 1);
      assert.equal(logs[0]!.artifactsPurged, true);
      assert.equal(logs[0]!.prompt, "");
      assert.equal(logs[0]!.outputLog, "");

      // keep: "tail" keeps last 8KB of output.log
      const subId2 = "sub-1-T1.2-worker-claude-code";
      const subDir2 = path.join(root, ".asd", "sessions", sid, "subagents", subId2);
      fs.mkdirSync(subDir2, { recursive: true });
      fs.writeFileSync(path.join(subDir2, "meta.json"), JSON.stringify({ subSessionId: subId2, status: "done" }), "utf8");
      fs.writeFileSync(path.join(subDir2, "prompt.md"), "Prompt 2", "utf8");
      fs.writeFileSync(path.join(subDir2, "output.log"), "X".repeat(12000), "utf8");

      finalizeSubagentArtifacts({ projectRoot: root, sessionId: sid, subSessionId: subId2, keep: "tail" });
      assert.ok(!fs.existsSync(path.join(subDir2, "prompt.md")));
      assert.ok(fs.existsSync(path.join(subDir2, "output.log")));
      assert.equal(fs.statSync(path.join(subDir2, "output.log")).size, 8192);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("2. parallel_spawn done deletes prompt.md/output.log; verifying keeps them until approve/reject; retry reconstructs prompt from DB", async () => {
    const root = makeTempGitProject();
    let capturedRetryArgs: string[] = [];
    const runner: CommandRunner = {
      async run(_cmd, args, opts) {
        capturedRetryArgs = args;
        fs.writeFileSync(path.join(opts.cwd, "hello.ts"), `export const t = ${Date.now()};\n`, "utf8");
        opts.onStdout('{"session_id":"sid-cr09"}\n');
        return { exitCode: 0, pid: 1234 };
      },
    };

    const db = openProjectDb(root);
    const server = new AsdMcpServer({ projectRoot: root, db, commandRunner: runner });
    try {
      const sid = "asd-20261101-133501-a002";
      await server.handlePlan({
        action: "create",
        sessionId: sid,
        autoApprove: true,
        tasks: [
          {
            taskId: "T1.1",
            turn: 1,
            title: "Auto approved task",
            track: "LIGHT",
            targetFiles: ["hello.ts"],
            verifyCmd: 'node -e "process.exit(0)"',
          },
        ],
      });

      const disp1 = await server.handleDispatch({
        sessionId: sid,
        turn: 1,
        mode: "parallel_spawn",
      });
      assert.equal(disp1.results[0]!.status, "done");

      const recsAfterDone = scanSubagentLogs(root);
      assert.equal(recsAfterDone.length, 1);
      assert.equal(recsAfterDone[0]!.artifactsPurged, true);

      // Retry after prompt.md was purged reconstructs prompt from DB task T1.1!
      const retryRes = await runSubagentControlAction({
        projectRoot: root,
        sessionId: sid,
        subSessionId: recsAfterDone[0]!.subSessionId,
        action: "retry",
        commandRunner: runner,
        waitForCompletion: true,
      });
      assert.equal(retryRes.ok, true);
      assert.ok(
        capturedRetryArgs.some((a) => a.includes("# ASD Subagent Task: T1.1") && a.includes("Auto approved task")),
        "Retry must reconstruct prompt from DB task when prompt.md is purged"
      );

      // Now test autoApprove=false ('verifying'): artifacts stay until rejectPendingTask / approvePendingTask
      const sid2 = "asd-20261101-133502-a003";
      await server.handlePlan({
        action: "create",
        sessionId: sid2,
        autoApprove: false,
        tasks: [
          {
            taskId: "T1.1",
            turn: 1,
            title: "Manual approval task",
            track: "HEAVY",
            targetFiles: ["hello.ts"],
            verifyCmd: 'node -e "process.exit(0)"',
          },
        ],
      });

      const disp2 = await server.handleDispatch({
        sessionId: sid2,
        turn: 1,
        mode: "parallel_spawn",
      });
      assert.equal(disp2.results[0]!.status, "verifying");

      const verifyingRec = scanSubagentLogs(root).find((r) => r.sessionId === sid2)!;
      assert.ok(verifyingRec);
      assert.equal(verifyingRec.artifactsPurged, false, "verifying task must preserve prompt.md and output.log");

      // Rejecting pending task purges artifacts
      rejectPendingTask({ projectRoot: root, sessionId: sid2, taskId: "T1.1", db });
      const rejectedRec = scanSubagentLogs(root).find((r) => r.sessionId === sid2)!;
      assert.equal(rejectedRec.artifactsPurged, true, "rejectPendingTask must purge artifacts");
    } finally {
      server.close();
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});