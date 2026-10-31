/**
 * GUI Prerequisites & Unified Session Management Tests (tests/gui-prerequisites.test.ts)
 *
 * Verifies all core/CLI enhancements required for external `asd-gui` integration:
 * 1. Barrel exports (`src/index.ts`) and 5-adapter resume command builders.
 * 2. Two-tier session storage:
 *    - All native CLI sessions recorded in `.asd/sessions/cli-recent.json` with 0-token summary.
 *    - Only `/asd` orchestration sessions create `.asd/sessions/<asd-id>/` folders and auto-link `harnessSessionId`.
 * 3. Subagent `harnessSessionId` auto-extraction into `meta.json` and `resume` control action.
 * 4. Manual approval gate (`autoApprove: false` -> `'verifying'`), `getWorktreeDiff`, `approvePendingTask`, and `rejectPendingTask`.
 * 5. Multi-project discovery (`listKnownProjects`) from `~/.asd/state/<hash>/core.db`.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, test } from "node:test";

import * as asdPublicApi from "../src/index.ts";
import {
  approvePendingTask,
  AsdMcpServer,
  antigravityAdapter,
  buildInteractiveResumeHarnessCommand,
  buildResumeHarnessCommand,
  claudeCodeAdapter,
  codexAdapter,
  collectDashboardSnapshot,
  createTaskWorktree,
  cursorAdapter,
  extractHarnessSessionIdFromOutput,
  extractHookSessionInfo,
  getWorktreeDiff,
  listKnownProjects,
  openProjectDb,
  opencodeAdapter,
  prepareBaseline,
  readCliRecentSessions,
  recordCliRecentSession,
  rejectPendingTask,
  runSubagentControlAction,
  spawnSubagent,
  verifyAndMergeHeavyTask,
} from "../src/index.ts";

function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function removeTempDir(dirPath: string): void {
  try {
    fs.rmSync(dirPath, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // Ignore cleanup errors
  }
}

describe("GUI Prerequisites & Session Architecture", () => {
  test("1. Public barrel export exposes core, adapters, session tracker, diff gate, and dashboard services", () => {
    assert.equal(typeof asdPublicApi.openProjectDb, "function");
    assert.equal(typeof asdPublicApi.spawnSubagent, "function");
    assert.equal(typeof asdPublicApi.collectDashboardSnapshot, "function");
    assert.equal(typeof asdPublicApi.runSubagentControlAction, "function");
    assert.equal(typeof asdPublicApi.extractHarnessSessionIdFromOutput, "function");
    assert.equal(typeof asdPublicApi.readCliRecentSessions, "function");
    assert.equal(typeof asdPublicApi.listKnownProjects, "function");
    assert.equal(typeof asdPublicApi.getWorktreeDiff, "function");
    assert.equal(typeof asdPublicApi.approvePendingTask, "function");
    assert.equal(typeof asdPublicApi.rejectPendingTask, "function");
    assert.equal(typeof asdPublicApi.handlePlan, "function");
    assert.equal(typeof asdPublicApi.handleDispatch, "function");
    assert.equal(typeof asdPublicApi.handleVerify, "function");
    assert.equal(typeof asdPublicApi.handleDebate, "function");
  });

  test("2. All 5 adapters implement buildResumeCommand and buildInteractiveResumeCommand", () => {
    const ccResume = claudeCodeAdapter.buildResumeCommand!(
      "cc-uuid-123",
      "Fix edge case",
      "claude-sonnet-4-6"
    );
    assert.equal(ccResume.cmd, "claude");
    assert.deepEqual(ccResume.args, [
      "-p",
      "Fix edge case",
      "--resume",
      "cc-uuid-123",
      "--output-format",
      "json",
      "--model",
      "claude-sonnet-4-6",
    ]);

    const cxResume = codexAdapter.buildResumeCommand!(
      "thread-cx-99",
      "Add unit test",
      "gpt-5.4",
      { reasoningEffort: "high" }
    );
    assert.equal(cxResume.cmd, "codex");
    assert.deepEqual(cxResume.args, [
      "exec",
      "resume",
      "thread-cx-99",
      "Add unit test",
      "--json",
      "-m",
      "gpt-5.4",
      "-c",
      "model_reasoning_effort=high",
    ]);

    const ocResume = opencodeAdapter.buildResumeCommand!(
      "ses_oc_777",
      "Continue refactor",
      "glm-5"
    );
    assert.equal(ocResume.cmd, "opencode");
    assert.deepEqual(ocResume.args, [
      "run",
      "Continue refactor",
      "--session",
      "ses_oc_777",
      "--format",
      "json",
      "--model",
      "glm-5",
    ]);

    const agResume = antigravityAdapter.buildResumeCommand!(
      "agy-conv-42",
      "Check UI",
      "gemini-3-pro"
    );
    assert.equal(agResume.cmd, "agy");
    assert.ok(agResume.args.includes("--resume"));
    assert.ok(agResume.args.includes("agy-conv-42"));

    const crResume = cursorAdapter.buildResumeCommand!(
      "cursor-chat-11",
      "Update styles",
      "composer-2"
    );
    assert.ok(crResume.args.includes("--resume"));
    assert.ok(crResume.args.includes("cursor-chat-11"));

    const interactive = buildInteractiveResumeHarnessCommand(
      "claude-code",
      "cc-uuid-123",
      "claude-opus-4-6"
    );
    assert.equal(interactive.cliString, "claude --resume cc-uuid-123 --model claude-opus-4-6");

    const helperResume = buildResumeHarnessCommand(
      "codex",
      "thread-cx-99",
      "Follow up",
      "gpt-5.4"
    );
    assert.equal(helperResume.command, "codex");
    assert.deepEqual(helperResume.args.slice(0, 4), [
      "exec",
      "resume",
      "thread-cx-99",
      "Follow up",
    ]);

    const helperResumeObj = buildResumeHarnessCommand({
      harness: "codex",
      harnessSessionId: "thread-cx-99",
      prompt: "Follow up",
      model: "gpt-5.4",
    });
    assert.deepEqual(helperResumeObj, helperResume);

    const interactiveObj = buildInteractiveResumeHarnessCommand({
      harness: "claude-code",
      harnessSessionId: "cc-uuid-123",
      model: "claude-opus-4-6",
    });
    assert.equal(interactiveObj.cliString, "claude --resume cc-uuid-123 --model claude-opus-4-6");
  });

  test("3. Two-tier session tracking: cli-recent.json stores all CLI sessions with 0-token summary, and /asd plan links harnessSessionId into <asd-id>/main.json & core.db", async () => {
    const tmpHome = createTempDir("asd-gui-tier-home-");
    const tmpProj = createTempDir("asd-gui-tier-proj-");

    try {
      // Simulate a local transcript file passed by a harness hook
      const transcriptFile = path.join(tmpHome, "sample-transcript.jsonl");
      fs.writeFileSync(
        transcriptFile,
        JSON.stringify({
          role: "user",
          content: "로그인 JWT 만료 시간을 1시간에서 24시간으로 늘려줘",
        }) + "\n",
        "utf8"
      );

      const hookInfo = extractHookSessionInfo(
        {
          session_id: "native-cc-sess-001",
          transcript_path: transcriptFile,
          model: "claude-sonnet-4-6",
        },
        "claude-code"
      );
      assert.equal(hookInfo.harnessSessionId, "native-cc-sess-001");
      assert.equal(
        hookInfo.summary,
        "로그인 JWT 만료 시간을 1시간에서 24시간으로 늘려줘"
      );

      // Verify Antigravity hook payload extraction (workspacePaths, lastUserInput, modelName, toolCall)
      const agyHookInfo = extractHookSessionInfo(
        {
          conversationId: "agy-conv-999",
          workspacePaths: [tmpProj],
          modelName: "gemini-3-pro",
          lastUserInput: "asd-gui 프론트엔드 초기 세팅 진행해줘",
          toolCall: {
            name: "write_file",
            args: { Path: "src/web/App.tsx" },
          },
        },
        "antigravity"
      );
      assert.equal(agyHookInfo.harnessSessionId, "agy-conv-999");
      assert.equal(agyHookInfo.projectRoot, path.resolve(tmpProj));
      assert.equal(agyHookInfo.model, "gemini-3-pro");
      assert.equal(agyHookInfo.summary, "asd-gui 프론트엔드 초기 세팅 진행해줘");

      // Record casual CLI session in .asd/sessions/cli-recent.json
      recordCliRecentSession(
        tmpProj,
        {
          harnessSessionId: hookInfo.harnessSessionId!,
          harness: hookInfo.harness,
          model: hookInfo.model,
          summary: hookInfo.summary,
          transcriptPath: hookInfo.transcriptPath,
        },
        { forceCreateDir: true }
      );

      const recentBeforePlan = readCliRecentSessions(tmpProj);
      assert.equal(recentBeforePlan.length, 1);
      assert.equal(recentBeforePlan[0]!.harnessSessionId, "native-cc-sess-001");
      assert.equal(recentBeforePlan[0]!.asdSessionId, null);

      // Ensure no <asd-id>/ subdirectories exist yet for casual chat
      const sessionEntriesBefore = fs
        .readdirSync(path.join(tmpProj, ".asd", "sessions"), { withFileTypes: true })
        .filter((d) => d.isDirectory());
      assert.equal(sessionEntriesBefore.length, 0);

      // Now run `asd_plan` (simulating `/asd` invocation in that same harness session)
      const server = new AsdMcpServer({
        projectRoot: tmpProj,
        homeDir: tmpHome,
        autoSync: false,
      });
      try {
        const planOut = await server.handlePlan({
          action: "create",
          sessionId: "20261101-asd-main",
          mainHarness: "claude-code",
          tasks: [
            {
              taskId: "T1.1",
              turn: 1,
              title: "Update JWT expiry",
              targetFiles: ["src/auth.ts"],
            },
          ],
        });
        assert.equal(planOut.sessionId, "20261101-asd-main");
      } finally {
        server.close();
      }

      // Verify <asd-id>/main.json has linked `harnessSessionId` and `model`
      const mainJsonPath = path.join(
        tmpProj,
        ".asd",
        "sessions",
        "20261101-asd-main",
        "main.json"
      );
      assert.ok(fs.existsSync(mainJsonPath));
      const mainMeta = JSON.parse(fs.readFileSync(mainJsonPath, "utf8"));
      assert.equal(mainMeta.harnessSessionId, "native-cc-sess-001");
      assert.equal(mainMeta.model, "claude-sonnet-4-6");

      // Verify core.db session row has `harness_session_id` and `main_model`
      const db = openProjectDb(tmpProj, tmpHome);
      const sRow = db.getSession("20261101-asd-main");
      db.close();
      assert.equal(sRow?.harness_session_id, "native-cc-sess-001");
      assert.equal(sRow?.main_model, "claude-sonnet-4-6");

      // Verify cli-recent.json entry is now linked back to `20261101-asd-main`
      const recentAfterPlan = readCliRecentSessions(tmpProj);
      assert.equal(recentAfterPlan[0]!.asdSessionId, "20261101-asd-main");
    } finally {
      removeTempDir(tmpHome);
      removeTempDir(tmpProj);
    }
  });

  test("4. Subagent spawner auto-extracts harnessSessionId into meta.json and supports 'resume' action", async () => {
    const tmpHome = createTempDir("asd-gui-sub-home-");
    const tmpProj = createTempDir("asd-gui-sub-proj-");

    try {
      assert.equal(
        extractHarnessSessionIdFromOutput(
          '{"type":"thread.started","thread_id":"codex-thread-555"}\n{"type":"item.completed"}'
        ),
        "codex-thread-555"
      );
      assert.equal(
        extractHarnessSessionIdFromOutput(
          '{"type":"step_start","sessionID":"ses_opencode_888"}'
        ),
        "ses_opencode_888"
      );

      const spawnRes = await spawnSubagent({
        projectRoot: tmpProj,
        homeDir: tmpHome,
        mainSessionId: "sess-sub-test",
        subSessionId: "sub-1-T1.1-worker-claude-code",
        role: "worker",
        harness: "claude-code",
        model: "claude-sonnet-4-6",
        taskId: "T1.1",
        prompt: "Initial subagent task",
        allowedFiles: ["src/**"],
        command: "claude",
        args: ["-p", "Initial subagent task"],
        commandRunner: {
          async run(_cmd, _args, opts) {
            opts.onSpawn?.(4321);
            opts.onStdout(
              JSON.stringify({
                type: "result",
                session_id: "sub-cc-native-999",
                result: "Done initial task",
              }) + "\n"
            );
            return { exitCode: 0, pid: 4321 };
          },
        },
      });

      assert.equal(spawnRes.exitCode, 0);
      assert.equal(spawnRes.harnessSessionId, "sub-cc-native-999");

      const meta = JSON.parse(fs.readFileSync(spawnRes.metaPath, "utf8"));
      assert.equal(meta.harnessSessionId, "sub-cc-native-999");

      // Verify runSubagentControlAction with action: "resume" passes --resume sub-cc-native-999
      let capturedCmd = "";
      let capturedArgs: string[] = [];
      const resumeRes = await runSubagentControlAction({
        projectRoot: tmpProj,
        homeDir: tmpHome,
        sessionId: "sess-sub-test",
        subSessionId: "sub-1-T1.1-worker-claude-code",
        action: "resume",
        prompt: "Also handle null input",
        waitForCompletion: true,
        commandRunner: {
          async run(cmd, args, opts) {
            capturedCmd = cmd;
            capturedArgs = args;
            opts.onStdout(
              JSON.stringify({
                session_id: "sub-cc-native-999",
                result: "Handled null input",
              }) + "\n"
            );
            return { exitCode: 0, pid: 4322 };
          },
        },
      });

      assert.equal(resumeRes.ok, true);
      assert.equal(capturedCmd, "claude");
      assert.ok(capturedArgs.includes("--resume"));
      assert.ok(capturedArgs.includes("sub-cc-native-999"));
      assert.ok(capturedArgs.includes("Also handle null input"));
    } finally {
      removeTempDir(tmpHome);
      removeTempDir(tmpProj);
    }
  });

  test("5. Manual approval gate (autoApprove: false) pauses at 'verifying', inspects worktree diff, and approves/rejects cleanly", async () => {
    const tmpHome = createTempDir("asd-gui-gate-home-");
    const tmpProj = createTempDir("asd-gui-gate-proj-");

    try {
      prepareBaseline(tmpProj);

      const db = openProjectDb(tmpProj, tmpHome);
      db.createOrGetSession({
        sessionId: "sess-gate",
        projectRoot: tmpProj,
        mainHarness: "claude-code",
        autoApprove: false,
      });
      db.upsertTasks("sess-gate", [
        {
          taskId: "T1.1",
          turn: 1,
          title: "Upgrade feature v2",
          track: "HEAVY",
          targetFiles: ["src/feature.ts"],
        },
      ]);

      const wt = createTaskWorktree(tmpProj, 1, "T1.1");
      db.updateTaskStatus("sess-gate", "T1.1", "running", {
        worktreePath: wt.wtPath,
      });

      // Modify file inside worktree
      fs.mkdirSync(path.join(wt.wtPath, "src"), { recursive: true });
      fs.writeFileSync(
        path.join(wt.wtPath, "src", "feature.ts"),
        "export const v = 2;\n"
      );

      // Run verifyAndMergeHeavyTask with autoApprove: false
      const gateRes = await verifyAndMergeHeavyTask({
        projectRoot: tmpProj,
        turn: 1,
        taskId: "T1.1",
        title: "Upgrade feature v2",
        wtPath: wt.wtPath,
        branchName: wt.branchName,
        allowedFiles: ["src/feature.ts"],
        sessionId: "sess-gate",
        db,
        autoApprove: false,
      });

      assert.equal(gateRes.verified, true);
      assert.equal(gateRes.status, "verifying");
      assert.equal(gateRes.pendingApproval, true);
      assert.equal(db.getTask("sess-gate", "T1.1")?.status, "verifying");
      assert.ok(fs.existsSync(wt.wtPath), "Worktree must remain intact while verifying");

      // Inspect worktree diff via getWorktreeDiff
      const diffSnap = getWorktreeDiff(tmpProj, { wtPath: wt.wtPath });
      assert.equal(diffSnap.exists, true);
      assert.deepEqual(diffSnap.changedFiles, ["src/feature.ts"]);
      assert.ok(diffSnap.diff.includes("+export const v = 2;"));

      // Approve pending task -> merges into main branch and cleans up worktree
      const approved = await approvePendingTask({
        projectRoot: tmpProj,
        sessionId: "sess-gate",
        taskId: "T1.1",
        db,
      });
      assert.equal(approved.ok, true);
      assert.equal(approved.status, "done");
      assert.equal(db.getTask("sess-gate", "T1.1")?.status, "done");
      assert.equal(
        fs.readFileSync(path.join(tmpProj, "src", "feature.ts"), "utf8").trim(),
        "export const v = 2;"
      );
      assert.equal(fs.existsSync(wt.wtPath), false);

      // Also test rejectPendingTask on a second task T1.2
      db.upsertTasks("sess-gate", [
        {
          taskId: "T1.2",
          turn: 1,
          title: "Experimental task to reject",
          track: "HEAVY",
          targetFiles: ["src/feature.ts"],
        },
      ]);
      const wt2 = createTaskWorktree(tmpProj, 1, "T1.2");
      db.updateTaskStatus("sess-gate", "T1.2", "verifying", {
        worktreePath: wt2.wtPath,
      });
      fs.writeFileSync(
        path.join(wt2.wtPath, "src", "feature.ts"),
        "export const v = 999;\n"
      );

      const rejected = rejectPendingTask({
        projectRoot: tmpProj,
        sessionId: "sess-gate",
        taskId: "T1.2",
        db,
      });
      assert.equal(rejected.ok, true);
      assert.equal(rejected.status, "failed");
      assert.equal(db.getTask("sess-gate", "T1.2")?.status, "failed");
      assert.equal(fs.existsSync(wt2.wtPath), false);

      // Verify listKnownProjects discovers tmpProj from tmpHome
      const projects = listKnownProjects({ homeDir: tmpHome });
      assert.equal(projects.length, 1);
      assert.equal(projects[0]!.projectRoot, path.resolve(tmpProj));
      assert.equal(projects[0]!.latestSessionId, "sess-gate");

      // Verify collectDashboardSnapshot includes cliRecentSessions
      const snap = await collectDashboardSnapshot({
        projectRoot: tmpProj,
        homeDir: tmpHome,
      });
      assert.ok(Array.isArray(snap.cliRecentSessions));

      db.close();
    } finally {
      removeTempDir(tmpHome);
      removeTempDir(tmpProj);
    }
  });
});
