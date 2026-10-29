/**
 * ASD v2.2 Unified Terminal CLI & Hook Tests (tests/cli.test.ts)
 *
 * Verifies:
 * 1. CLI help and unknown command handling.
 * 2. `asd doctor` runs in < 150ms and exits 0.
 * 3. `asd sync` and `asd uninstall` round-trip in isolated temp homeDir.
 * 4. `asd status` with seeded SQLite session displays `### 📊 ASD TODO 진행 현황` and detects stashed work warning.
 * 5. `asd clean --pop` cleans worktrees and restores auto-stashed work.
 * 6. `asd hook pre-tool-use` denies `.GIT/config` and `.ENV` with exit code 2 on claude-code, and allows safe tool use.
 * 7. `asd hook stop` applies Subagent Shield and 3-strike breaker.
 */

import assert from "node:assert/strict";
import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";

import { openProjectDb } from "../src/core/db.ts";
import { buildDefaultHarnessCommand } from "../src/core/debate.ts";
import { resolveSpawnCommand } from "../src/core/spawner.ts";
import { startDashboardServer } from "../src/cli/dashboard.ts";
import { getLatestSession, runAsdLogs } from "../src/cli/index.ts";
import { runGit } from "../src/core/workspace.ts";

function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function removeTempDir(dirPath: string): void {
  try {
    fs.rmSync(dirPath, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // Ignore cleanup error
  }
}

const cliPath = path.resolve(import.meta.dirname, "../src/cli/index.ts");

function runCli(
  args: string[],
  options?: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    input?: string;
  }
): {
  exitCode: number;
  stdout: string;
  stderr: string;
} {
  const result = child_process.spawnSync(
    process.execPath,
    ["--no-warnings", cliPath, ...args],
    {
      cwd: options?.cwd,
      env: { ...process.env, ...options?.env },
      input: options?.input,
      encoding: "utf8",
      windowsHide: true,
    }
  );

  return {
    exitCode: result.status ?? (result.error ? 1 : 0),
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? (result.error ? String(result.error) : ""),
  };
}

function initGitRepo(dir: string): void {
  runGit(["init"], { cwd: dir });
  runGit(["config", "user.name", "ASD CLI Test"], { cwd: dir });
  runGit(["config", "user.email", "asd-cli-test@example.com"], { cwd: dir });
}

describe("ASD CLI (src/cli/index.ts)", () => {
  let tmpHome: string;
  let tmpProject: string;

  before(() => {
    tmpHome = createTempDir("asd-cli-test-home-");
    tmpProject = createTempDir("asd-cli-test-project-");
    initGitRepo(tmpProject);
  });

  after(() => {
    removeTempDir(tmpHome);
    removeTempDir(tmpProject);
  });

  // ==========================================================================
  // 1. CLI Help and Unknown Command Handling
  // ==========================================================================
  describe("1. Help & Unknown Command Handling", () => {
    test("asd --help prints usage and all 5 user commands + hook & mcp", () => {
      const res = runCli(["--help"]);
      assert.equal(res.exitCode, 0);
      assert.ok(res.stdout.includes("Usage:"));
      assert.ok(res.stdout.includes("sync"));
      assert.ok(res.stdout.includes("status"));
      assert.ok(res.stdout.includes("doctor"));
      assert.ok(res.stdout.includes("clean"));
      assert.ok(res.stdout.includes("uninstall"));
      assert.ok(res.stdout.includes("hook"));
      assert.ok(res.stdout.includes("mcp"));
    });

    test("asd -h flag displays help menu", () => {
      const res = runCli(["-h"]);
      assert.equal(res.exitCode, 0);
      assert.ok(res.stdout.includes("Usage:"));
    });

    test("asd --version displays 2.3.0", () => {
      const res = runCli(["--version"]);
      assert.equal(res.exitCode, 0);
      assert.ok(res.stdout.includes("2.3.0"));
    });

    test("asd -v flag displays version", () => {
      const res = runCli(["-v"]);
      assert.equal(res.exitCode, 0);
      assert.ok(res.stdout.includes("2.3.0"));
    });

    test("unknown command exits with code 1 and error message", () => {
      const res = runCli(["nonexistent-command"]);
      assert.equal(res.exitCode, 1);
      assert.ok(res.stderr.includes("Unknown command: nonexistent-command"));
      assert.ok(res.stderr.includes("Run 'asd --help' for usage."));
    });
  });

  // ==========================================================================
  // 2. asd doctor Performance (< 150ms) and Diagnostics
  // ==========================================================================
  describe("2. asd doctor Diagnostic Probe", () => {
    test("asd doctor runs in < 150ms and exits 0", () => {
      const res = runCli(["doctor", "--json"], { cwd: tmpProject });
      assert.equal(res.exitCode, 0, `doctor stderr: ${res.stderr}`);

      const data = JSON.parse(res.stdout);
      assert.equal(data.ok, true);
      assert.equal(typeof data.durationMs, "number");
      assert.ok(
        data.durationMs < 150,
        `asd doctor took ${data.durationMs.toFixed(1)}ms, expected < 150ms`
      );
      assert.equal(data.nodeVersion.ok, true);
      assert.equal(data.sqliteWal.ok, true);
      assert.equal(data.policyProbe.ok, true);
      assert.ok(Array.isArray(data.checks));

      // Also verify plain text output
      const resText = runCli(["doctor"], { cwd: tmpProject });
      assert.equal(resText.exitCode, 0);
      assert.ok(resText.stdout.includes("ASD Doctor Diagnostic Probe"));
      assert.ok(resText.stdout.includes("Node.js Version:"));
      assert.ok(resText.stdout.includes("SQLite WAL Mode:"));
      assert.ok(resText.stdout.includes("Policy Probe:"));
    });

    test("asd doctor --json returns complete probe payload", () => {
      const res = runCli(["doctor", "--json"], { cwd: tmpProject });
      assert.equal(res.exitCode, 0);

      const data = JSON.parse(res.stdout);
      assert.equal(data.ok, true);
      assert.ok(data.durationMs < 100);
      assert.equal(data.gitRepo.isRepo, true);
      assert.ok(data.harnesses);
    });
  });

  // ==========================================================================
  // 3. asd sync and asd uninstall Round-Trip
  // ==========================================================================
  describe("3. asd sync & asd uninstall Round-Trip", () => {
    test("sync installs all harnesses, idempotent skip on 2nd run, uninstall cleanly restores", () => {
      const isolatedHome = createTempDir("asd-cli-sync-roundtrip-");
      try {
        // 1. Initial sync
        const syncRes1 = runCli(["sync", "--home", isolatedHome], {
          cwd: tmpProject,
        });
        assert.equal(syncRes1.exitCode, 0, `sync1 failed: ${syncRes1.stderr}`);
        assert.ok(syncRes1.stdout.includes("Status: updated"));
        assert.ok(syncRes1.stdout.includes("claude-code: updated"));
        assert.ok(syncRes1.stdout.includes("opencode: updated"));
        assert.ok(syncRes1.stdout.includes("codex: updated"));
        assert.ok(syncRes1.stdout.includes("antigravity: updated"));

        // Verify target files exist in isolatedHome
        assert.ok(fs.existsSync(path.join(isolatedHome, ".claude", "settings.json")));
        assert.ok(
          fs.existsSync(
            path.join(isolatedHome, ".config", "opencode", "opencode.json")
          )
        );
        assert.ok(fs.existsSync(path.join(isolatedHome, ".codex", "config.toml")));
        assert.ok(fs.existsSync(path.join(isolatedHome, ".gemini", "hooks.json")));

        // 2. Idempotent sync (skipped)
        const syncRes2 = runCli(["sync", "--home", isolatedHome], {
          cwd: tmpProject,
        });
        assert.equal(syncRes2.exitCode, 0);
        assert.ok(syncRes2.stdout.includes("Status: skipped"));
        assert.ok(syncRes2.stdout.includes("claude-code: skipped"));

        // 3. Uninstall
        const uninstRes = runCli(["uninstall", "--home", isolatedHome], {
          cwd: tmpProject,
        });
        assert.equal(uninstRes.exitCode, 0, `uninstall failed: ${uninstRes.stderr}`);
        assert.ok(uninstRes.stdout.includes("Uninstalled successfully"));

        // Verify ASD managed files removed
        assert.equal(fs.existsSync(path.join(isolatedHome, ".claude", "settings.json")), false);
        assert.equal(fs.existsSync(path.join(isolatedHome, ".gemini", "hooks.json")), false);
      } finally {
        removeTempDir(isolatedHome);
      }
    });
  });

  // ==========================================================================
  // 4. asd status with Seeded SQLite Session & Warning Detection
  // ==========================================================================
  describe("4. asd status with Seeded SQLite Session", () => {
    test("displays progress board and unapplied auto-stash warning", () => {
      const statusHome = createTempDir("asd-cli-status-home-");
      const statusProject = createTempDir("asd-cli-status-proj-");
      initGitRepo(statusProject);

      try {
        const db = openProjectDb(statusProject, statusHome);
        db.createOrGetSession({
          sessionId: "sess-cli-status-test",
          projectRoot: statusProject,
          mainHarness: "claude-code",
        });
        db.recordStashedWork("sess-cli-status-test", "stashed-sha-12345");
        db.upsertTasks("sess-cli-status-test", [
          {
            taskId: "T1.1",
            turn: 1,
            title: "Database schema verification",
            track: "LIGHT",
          },
          {
            taskId: "T1.2",
            turn: 1,
            title: "CLI commands verification",
            track: "HEAVY",
          },
        ]);
        db.updateTaskStatus("sess-cli-status-test", "T1.1", "done", {
          commitSha: "abc001",
        });
        db.close();

        // 1. Text output
        const res = runCli(["status", "--home", statusHome], {
          cwd: statusProject,
        });
        assert.equal(res.exitCode, 0, `status failed: ${res.stderr}`);
        assert.ok(res.stdout.includes("### 📊 ASD TODO 진행 현황"));
        assert.ok(res.stdout.includes("T1.1"));
        assert.ok(res.stdout.includes("T1.2"));
        assert.ok(
          res.stdout.includes(
            "Warning: Unapplied auto-stash detected. Run 'asd clean --pop' to restore auto-stashed work."
          )
        );

        // 2. JSON output
        const resJson = runCli(["status", "--json", "--home", statusHome], {
          cwd: statusProject,
        });
        assert.equal(resJson.exitCode, 0);
        const data = JSON.parse(resJson.stdout);
        assert.equal(data.hasStashedWork, true);
        assert.equal(data.session.session_id, "sess-cli-status-test");
        assert.equal(data.tasks.length, 2);

        // 3. Status in empty project without session
        const emptyProject = createTempDir("asd-cli-empty-proj-");
        try {
          const resEmpty = runCli(["status", "--home", statusHome], {
            cwd: emptyProject,
          });
          assert.equal(resEmpty.exitCode, 0);
          assert.ok(resEmpty.stdout.includes("No active ASD session found"));
        } finally {
          removeTempDir(emptyProject);
        }
      } finally {
        removeTempDir(statusHome);
        removeTempDir(statusProject);
      }
    });
  });

  // ==========================================================================
  // 5. asd clean --pop Worktrees and Auto-Stash Restoration
  // ==========================================================================
  describe("5. asd clean --pop", () => {
    test("cleans leftover worktrees and restores auto-stashed work cleanly", () => {
      const cleanHome = createTempDir("asd-cli-clean-home-");
      const cleanProject = createTempDir("asd-cli-clean-proj-");
      initGitRepo(cleanProject);

      try {
        // Initial baseline commit
        fs.writeFileSync(path.join(cleanProject, "base.txt"), "baseline\n");
        runGit(["add", "base.txt"], { cwd: cleanProject });
        runGit(["commit", "-m", "init"], { cwd: cleanProject });

        // Create dummy leftover worktree
        const wtDir = path.join(cleanProject, ".asd", "wt", "1-T1.2");
        fs.mkdirSync(path.dirname(wtDir), { recursive: true });
        runGit(["worktree", "add", "-b", "asd/wt-1-T1.2", wtDir], {
          cwd: cleanProject,
        });
        assert.ok(fs.existsSync(wtDir));

        // Create dirty user file and auto-stash it
        const dirtyFile = path.join(cleanProject, "user-dirty-file.txt");
        fs.writeFileSync(dirtyFile, "important user work\n");
        runGit(["stash", "push", "-u", "-m", "asd-auto-stash"], {
          cwd: cleanProject,
        });
        const stashSha = runGit(["rev-parse", "refs/stash"], {
          cwd: cleanProject,
        }).stdout.trim();
        assert.ok(stashSha.length > 0);
        assert.equal(fs.existsSync(dirtyFile), false);

        // Record in SQLite session
        const db = openProjectDb(cleanProject, cleanHome);
        db.createOrGetSession({
          sessionId: "sess-clean-test",
          projectRoot: cleanProject,
          mainHarness: "claude-code",
        });
        db.recordStashedWork("sess-clean-test", stashSha);
        db.close();

        // Run asd clean --pop
        const res = runCli(["clean", "--pop", "--home", cleanHome], {
          cwd: cleanProject,
        });
        assert.equal(res.exitCode, 0, `clean failed: ${res.stderr}`);
        assert.ok(res.stdout.includes("Clean completed"));

        // Worktree directory removed
        assert.equal(fs.existsSync(wtDir), false);

        // Branch asd/wt-1-T1.2 deleted
        const branches = runGit(["branch", "--list", "asd/wt-1-T1.2"], {
          cwd: cleanProject,
        }).stdout;
        assert.equal(branches.includes("asd/wt-1-T1.2"), false);

        // Auto-stashed file is restored!
        assert.ok(fs.existsSync(dirtyFile));
        assert.equal(
          fs.readFileSync(dirtyFile, "utf8").trim(),
          "important user work"
        );

        // SQLite stashed_work_sha cleared
        const dbAfter = openProjectDb(cleanProject, cleanHome);
        const sessionAfter = getLatestSession(dbAfter);
        assert.equal(sessionAfter?.stashed_work_sha, null);
        dbAfter.close();
      } finally {
        removeTempDir(cleanHome);
        removeTempDir(cleanProject);
      }
    });
  });

  // ==========================================================================
  // 6. asd hook pre-tool-use Policy Guard
  // ==========================================================================
  describe("6. asd hook pre-tool-use", () => {
    test("denies .GIT/config with exit code 2 on claude-code", () => {
      const res = runCli(
        ["hook", "pre-tool-use", "--harness", "claude-code"],
        {
          input: JSON.stringify({ tool: "Write", filePath: ".GIT/config" }),
        }
      );
      assert.equal(res.exitCode, 2);
      assert.match(res.stderr, /protected/i);
    });

    test("denies .ENV with exit code 2 on claude-code", () => {
      const res = runCli(
        ["hook", "pre-tool-use", "--harness", "claude-code"],
        {
          input: JSON.stringify({ tool: "Write", filePath: ".ENV" }),
        }
      );
      assert.equal(res.exitCode, 2);
      assert.match(res.stderr, /protected/i);
    });

    test("allows safe tool use on regular files with exit code 0", () => {
      const res = runCli(
        ["hook", "pre-tool-use", "--harness", "claude-code"],
        {
          input: JSON.stringify({ tool: "Write", filePath: "src/safe.ts" }),
        }
      );
      assert.equal(res.exitCode, 0);
    });

    test("antigravity harness outputs JSON deny format with exit code 0", () => {
      const res = runCli(
        ["hook", "pre-tool-use", "--harness", "antigravity"],
        {
          input: JSON.stringify({
            tool_name: "write_file",
            tool_input: { TargetFile: ".GIT/config" },
          }),
        }
      );
      assert.equal(res.exitCode, 0);
      assert.ok(res.stdout.includes('"decision":"deny"'));
    });
  });

  // ==========================================================================
  // 7. asd hook stop: Subagent Shield & 3-strike Breaker
  // ==========================================================================
  describe("7. asd hook stop (Subagent Shield & 3-strike breaker)", () => {
    test("Subagent Shield allows immediately without blocking", () => {
      const res = runCli(["hook", "stop", "--harness", "claude-code"], {
        env: { ASD_SESSION_ROLE: "subagent" },
        input: JSON.stringify({ sessionId: "subagent-session" }),
      });
      assert.equal(res.exitCode, 0);
      assert.equal(res.stdout.includes('"decision":"block"'), false);
    });

    test("main session applies 3-strike circuit breaker", () => {
      const breakerHome = createTempDir("asd-cli-breaker-home-");
      const breakerProject = createTempDir("asd-cli-breaker-proj-");
      initGitRepo(breakerProject);

      try {
        const db = openProjectDb(breakerProject, breakerHome);
        db.createOrGetSession({
          sessionId: "sess-breaker",
          projectRoot: breakerProject,
          mainHarness: "claude-code",
        });
        db.upsertTasks("sess-breaker", [
          { taskId: "T1.1", turn: 1, title: "Unfinished task" },
        ]);
        db.close();

        const inputPayload = JSON.stringify({
          sessionId: "sess-breaker",
          projectRoot: breakerProject,
        });

        const runBreaker = () =>
          runCli(
            ["hook", "stop", "--harness", "claude-code", "--home", breakerHome],
            {
              cwd: breakerProject,
              env: { ASD_HOME_DIR: breakerHome },
              input: inputPayload,
            }
          );

        // Strike 1
        const res1 = runBreaker();
        assert.equal(res1.exitCode, 0);
        assert.ok(res1.stdout.includes('"decision":"block"'));
        assert.ok(res1.stdout.includes("Attempt 1/3"));

        // Strike 2
        const res2 = runBreaker();
        assert.equal(res2.exitCode, 0);
        assert.ok(res2.stdout.includes('"decision":"block"'));
        assert.ok(res2.stdout.includes("Attempt 2/3"));

        // Strike 3
        const res3 = runBreaker();
        assert.equal(res3.exitCode, 0);
        assert.ok(res3.stdout.includes('"decision":"block"'));
        assert.ok(res3.stdout.includes("Attempt 3/3"));

        // Strike 4: Circuit breaker tripped! Allows stop.
        const res4 = runBreaker();
        assert.equal(res4.exitCode, 0);
        assert.equal(res4.stdout.includes('"decision":"block"'), false);
      } finally {
        removeTempDir(breakerHome);
        removeTempDir(breakerProject);
      }
    });
  });

  // ==========================================================================
  // 8. asd logs, thinkingEffort command flags, and Windows .cmd resolver
  // ==========================================================================
  describe("8. asd logs, thinkingEffort, and Windows .cmd shim resolver", () => {
    test("runAsdLogs retrieves latest subagent log and case-insensitive taskId log", () => {
      const logProj = createTempDir("asd-cli-logs-proj-");
      try {
        const sub1Dir = path.join(logProj, ".asd", "sessions", "sess-1", "subagents", "sub-1-T1.1");
        const sub2Dir = path.join(logProj, ".asd", "sessions", "sess-1", "subagents", "sub-1-T1.2");
        fs.mkdirSync(sub1Dir, { recursive: true });
        fs.mkdirSync(sub2Dir, { recursive: true });

        fs.writeFileSync(
          path.join(sub1Dir, "meta.json"),
          JSON.stringify({
            mainSessionId: "sess-1",
            subSessionId: "sub-1-T1.1",
            taskId: "T1.1",
            role: "builder",
            harness: "claude-code",
            model: "claude-sonnet-4-6",
            status: "done",
            startedAt: 1000,
          }),
          "utf8"
        );
        fs.writeFileSync(path.join(sub1Dir, "output.log"), "Task 1.1 completed.\n", "utf8");

        fs.writeFileSync(
          path.join(sub2Dir, "meta.json"),
          JSON.stringify({
            mainSessionId: "sess-1",
            subSessionId: "sub-1-T1.2",
            taskId: "T1.2",
            role: "reviewer",
            harness: "codex",
            model: "gpt-5.4",
            status: "failed",
            startedAt: 2000,
          }),
          "utf8"
        );
        fs.writeFileSync(path.join(sub2Dir, "output.log"), "Task 1.2 failed check.\n", "utf8");

        // No taskId -> returns latest (T1.2)
        const latest = runAsdLogs({ projectRoot: logProj });
        assert.equal(latest.found, true);
        assert.equal(latest.record?.taskId, "T1.2");
        assert.match(latest.record?.outputLog ?? "", /Task 1\.2 failed check/);

        // Specific taskId (case-insensitive t1.1) -> returns T1.1
        const specific = runAsdLogs({ projectRoot: logProj, taskId: "t1.1" });
        assert.equal(specific.found, true);
        assert.equal(specific.record?.taskId, "T1.1");
        assert.match(specific.record?.outputLog ?? "", /Task 1\.1 completed/);
      } finally {
        removeTempDir(logProj);
      }
    });

    test("buildDefaultHarnessCommand includes thinkingEffort flags for codex and antigravity", () => {
      const codexCmd = buildDefaultHarnessCommand("codex", "do work", "gpt-5.4", "xhigh");
      assert.deepEqual(codexCmd.args, [
        "exec",
        "do work",
        "--json",
        "-m",
        "gpt-5.4",
        "-c",
        "model_reasoning_effort=xhigh",
      ]);

      const agyCmd = buildDefaultHarnessCommand("antigravity", "do work", "gemini-3.1-pro", "high");
      assert.deepEqual(agyCmd.args, [
        "-p",
        "do work",
        "--output-format",
        "json",
        "--model",
        "gemini-3.1-pro",
        "--effort",
        "high",
      ]);
    });

    test("resolveSpawnCommand unwraps npm .cmd shim on Windows to node execPath", () => {
      const binDir = createTempDir("asd-shim-bin-");
      try {
        const pkgDir = path.join(binDir, "node_modules", "dummy-cli");
        fs.mkdirSync(pkgDir, { recursive: true });
        const entryJs = path.join(pkgDir, "cli.js");
        fs.writeFileSync(entryJs, "console.log('ok');\n", "utf8");

        const shimCmd = path.join(binDir, "dummy-cli.cmd");
        fs.writeFileSync(
          shimCmd,
          `@ECHO off\r\n"%dp0%\\node_modules\\dummy-cli\\cli.js" %*\r\n`,
          "utf8"
        );

        const resolved = resolveSpawnCommand("dummy-cli", ["-p", "hello\nworld"], {
          PATH: binDir,
        });
        if (process.platform === "win32") {
          assert.equal(resolved.command, process.execPath);
          assert.equal(resolved.args[0], entryJs);
          assert.equal(resolved.shell, false);
        } else {
          assert.equal(resolved.command, "dummy-cli");
          assert.equal(resolved.shell, false);
        }
      } finally {
        removeTempDir(binDir);
      }
    });

    test("startDashboardServer serves HTML on / and live JSON snapshot on /api/state", async () => {
      const uiHome = createTempDir("asd-ui-home-");
      const uiProj = createTempDir("asd-ui-proj-");
      try {
        const db = openProjectDb(uiProj, uiHome);
        db.createOrGetSession({
          sessionId: "sess-ui-1",
          projectRoot: uiProj,
          mainHarness: "claude-code",
        });
        db.upsertTasks("sess-ui-1", [
          { taskId: "T1.1", turn: 1, title: "Web UI Test Task" },
        ]);
        db.close();

        const subSeedDir = path.join(
          uiProj,
          ".asd",
          "sessions",
          "sess-ui-1",
          "subagents",
          "sub-1-T1.1"
        );
        fs.mkdirSync(subSeedDir, { recursive: true });
        fs.writeFileSync(
          path.join(subSeedDir, "meta.json"),
          JSON.stringify({
            subSessionId: "sub-1-T1.1",
            parentSessionId: "sess-ui-1",
            roleType: "subagent",
            role: "critic",
            harness: "claude-code",
            model: "claude-opus-4-6",
            taskId: "T1.1",
            pid: 0,
            status: "running",
            startedAt: Date.now(),
          }),
          "utf8"
        );
        fs.writeFileSync(path.join(subSeedDir, "prompt.md"), "Audit T1.1\n", "utf8");
        fs.writeFileSync(path.join(subSeedDir, "output.log"), "Running...\n", "utf8");

        const handle = await startDashboardServer({
          port: 0,
          projectRoot: uiProj,
          homeDir: uiHome,
          commandRunner: {
            async run(_cmd, _args, opts) {
              opts.onSpawn?.(4321);
              opts.onStdout(
                JSON.stringify({
                  verdict: "APPROVE",
                  hard_constraints: [],
                  decisions: ["Web retry succeeded"],
                  risks: [],
                })
              );
              return { exitCode: 0, pid: 4321 };
            },
          },
        });
        try {
          const htmlRes = await fetch(`${handle.url}/`);
          assert.equal(htmlRes.status, 200);
          const htmlText = await htmlRes.text();
          assert.ok(htmlText.includes("ASD Multi-Agent Control Plane"));
          assert.ok(htmlText.includes("ASD 멀티 에이전트 컨트롤 플레인"));
          assert.ok(htmlText.includes("setLang('ko')"));
          assert.ok(htmlText.includes("setLang('en')"));

          const stateRes = await fetch(`${handle.url}/api/state`);
          assert.equal(stateRes.status, 200);
          const stateJson = (await stateRes.json()) as {
            session: { session_id: string };
            sessions: Array<{ session_id: string; memo?: string }>;
            tasks: Array<{ task_id: string; title: string }>;
          };
          assert.equal(stateJson.session.session_id, "sess-ui-1");
          assert.equal(stateJson.sessions.length, 1);
          assert.equal(stateJson.tasks.length, 1);
          assert.equal(stateJson.tasks[0]?.task_id, "T1.1");

          // Update session memo via POST /api/session-memo and verify persistence in .asd
          const memoRes = await fetch(`${handle.url}/api/session-memo`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              sessionId: "sess-ui-1",
              memo: "P0 보안 감사 토론",
            }),
          });
          assert.equal(memoRes.status, 200);
          const memoJson = (await memoRes.json()) as {
            ok: boolean;
            sessionId: string;
            memo: string;
          };
          assert.equal(memoJson.ok, true);
          assert.equal(memoJson.memo, "P0 보안 감사 토론");

          const mainJsonFile = path.join(
            uiProj,
            ".asd",
            "sessions",
            "sess-ui-1",
            "main.json"
          );
          assert.equal(fs.existsSync(mainJsonFile), true);
          const mainMeta = JSON.parse(fs.readFileSync(mainJsonFile, "utf8")) as {
            memo?: string;
          };
          assert.equal(mainMeta.memo, "P0 보안 감사 토론");

          const stateAfter = (await (
            await fetch(`${handle.url}/api/state`)
          ).json()) as {
            sessions: Array<{ session_id: string; memo?: string }>;
            hasLocalRouting: boolean;
            routingConfig: Record<string, unknown>;
          };
          assert.equal(stateAfter.sessions[0]?.memo, "P0 보안 감사 토론");
          assert.equal(stateAfter.hasLocalRouting, false);

          // 2. Test project-scoped routing editor (POST /api/routing save & reset)
          const customRouting = structuredClone(stateAfter.routingConfig) as {
            _asdVersion: string;
            agents: Record<string, { harness: string; model: string; fallbacks: unknown[] }>;
            categories: Record<string, unknown>;
          };
          customRouting.agents.critic = {
            harness: "codex",
            model: "gpt-5.4",
            fallbacks: [{ harness: "opencode", model: "glm-5" }],
          };
          const saveRtRes = await fetch(`${handle.url}/api/routing`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "save", routingConfig: customRouting }),
          });
          assert.equal(saveRtRes.status, 200);
          const localRtFile = path.join(uiProj, ".asd", "routing.jsonc");
          assert.equal(fs.existsSync(localRtFile), true);

          // 3. Test 4 subagent control options (kill, retry, fallback, custom)
          const killRes = await fetch(`${handle.url}/api/subagent-action`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              sessionId: "sess-ui-1",
              subSessionId: "sub-1-T1.1",
              action: "kill",
            }),
          });
          assert.equal(killRes.status, 200);
          const killJson = (await killRes.json()) as { status: string };
          assert.equal(killJson.status, "failed");

          const fbRes = await fetch(`${handle.url}/api/subagent-action`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              sessionId: "sess-ui-1",
              subSessionId: "sub-1-T1.1",
              action: "fallback",
              waitForCompletion: true,
            }),
          });
          assert.equal(fbRes.status, 200);
          const fbJson = (await fbRes.json()) as {
            ok: boolean;
            harness: string;
            model: string;
            newSubSessionId: string;
          };
          assert.equal(fbJson.ok, true);
          assert.equal(fbJson.harness, "codex");
          assert.equal(fbJson.model, "gpt-5.4");
          assert.ok(fbJson.newSubSessionId.startsWith("sub-1-T1.1-fb-"));

          const customRunRes = await fetch(`${handle.url}/api/subagent-action`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              sessionId: "sess-ui-1",
              subSessionId: "sub-1-T1.1",
              action: "custom",
              harness: "antigravity",
              model: "gemini-3.1-pro",
              waitForCompletion: true,
            }),
          });
          assert.equal(customRunRes.status, 200);
          const customRunJson = (await customRunRes.json()) as {
            ok: boolean;
            harness: string;
            model: string;
          };
          assert.equal(customRunJson.ok, true);
          assert.equal(customRunJson.harness, "antigravity");
          assert.equal(customRunJson.model, "gemini-3.1-pro");

          const resetRtRes = await fetch(`${handle.url}/api/routing`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "reset" }),
          });
          assert.equal(resetRtRes.status, 200);
          assert.equal(fs.existsSync(localRtFile), false);

          // 4. Test dynamic model catalog endpoints (GET /api/models & POST /api/models/refresh)
          const codexDir = path.join(uiHome, ".codex");
          fs.mkdirSync(codexDir, { recursive: true });
          fs.writeFileSync(
            path.join(codexDir, "models_cache.json"),
            JSON.stringify({ models: [{ slug: "gpt-6-luna" }] }),
            "utf8"
          );

          const modelsRes = await fetch(`${handle.url}/api/models`);
          assert.equal(modelsRes.status, 200);
          const modelsJson = (await modelsRes.json()) as {
            ok: boolean;
            availableModels: Record<string, string[]>;
          };
          assert.equal(modelsJson.ok, true);
          assert.ok(Array.isArray(modelsJson.availableModels.antigravity));
          assert.ok(Array.isArray(modelsJson.availableModels["claude-code"]));
          assert.ok(Array.isArray(modelsJson.availableModels.codex));
          assert.ok(Array.isArray(modelsJson.availableModels.opencode));
          assert.ok(Array.isArray(modelsJson.availableModels.cursor));

          const refreshRes = await fetch(`${handle.url}/api/models/refresh`, {
            method: "POST",
          });
          assert.equal(refreshRes.status, 200);
          const refreshJson = (await refreshRes.json()) as {
            ok: boolean;
            availableModels: Record<string, string[]>;
          };
          assert.equal(refreshJson.ok, true);
          assert.ok(refreshJson.availableModels.codex.includes("gpt-6-luna"));
          // Verify no hardcoded fake models are injected when unconfigured
          assert.equal(refreshJson.availableModels.codex.includes("gpt-5.4"), false);
          assert.ok(htmlText.includes("buildSearchableModelPickerHtml"));
          assert.ok(htmlText.includes("filterModelPicker"));
          assert.ok(htmlText.includes("renderSelectedItemMetaCard"));
          assert.ok(htmlText.includes("saveInlineMemo"));
          assert.ok(htmlText.includes("outputLogPre"));
          assert.ok(htmlText.includes("promptPre"));
        } finally {
          await handle.close();
        }
      } finally {
        removeTempDir(uiHome);
        removeTempDir(uiProj);
      }
    });

    test("asd sync installs CLI shims by default and skips them when --no-path is passed", () => {
      const noPathHome = createTempDir("asd-nopath-home-");
      const withPathHome = createTempDir("asd-withpath-home-");
      try {
        // 1. With --no-path: .asd/bin should NOT be created
        const resNoPath = runCli(["sync", "--no-path", "--home", noPathHome]);
        assert.equal(resNoPath.exitCode, 0);
        assert.equal(fs.existsSync(path.join(noPathHome, ".asd", "bin", "asd")), false);

        // 2. Default sync: .asd/bin/asd (and asd.cmd on win32) SHOULD be created, and removed on uninstall
        const resWithPath = runCli(["sync", "--home", withPathHome]);
        assert.equal(resWithPath.exitCode, 0);
        assert.equal(fs.existsSync(path.join(withPathHome, ".asd", "bin", "asd")), true);
        if (process.platform === "win32") {
          assert.equal(fs.existsSync(path.join(withPathHome, ".asd", "bin", "asd.cmd")), true);
        }

        const resUninstall = runCli(["uninstall", "--home", withPathHome]);
        assert.equal(resUninstall.exitCode, 0);
        assert.equal(fs.existsSync(path.join(withPathHome, ".asd", "bin", "asd")), false);
      } finally {
        removeTempDir(noPathHome);
        removeTempDir(withPathHome);
      }
    });

    test("CLI orchestration commands (plan, dispatch, verify, debate guard) work directly without MCP", async () => {
      const orchHome = createTempDir("asd-orch-home-");
      const orchProj = createTempDir("asd-orch-proj-");
      initGitRepo(orchProj);
      try {
        // 1. asd plan create
        const planPayload = JSON.stringify({
          sessionId: "sess-cli-orch-1",
          tasks: [
            {
              taskId: "T1.1",
              turn: 1,
              title: "CLI Orchestrated Task",
              track: "LIGHT",
              targetFiles: ["hello.txt"],
            },
          ],
        });
        const planRes = runCli(
          ["plan", "create", "--payload", planPayload, "--home", orchHome],
          { cwd: orchProj }
        );
        assert.equal(planRes.exitCode, 0, `plan stderr: ${planRes.stderr}`);
        assert.ok(planRes.stdout.includes("### 📊 ASD TODO 진행 현황"));
        assert.ok(planRes.stdout.includes("T1.1"));

        // 2. asd dispatch --mode claim_only (auto-resolving latest session without --session)
        const dispRes = runCli(
          ["dispatch", "--turn", "1", "--mode", "claim_only", "--home", orchHome],
          { cwd: orchProj }
        );
        assert.equal(dispRes.exitCode, 0, `dispatch stderr: ${dispRes.stderr}`);
        assert.ok(dispRes.stdout.includes("T1.1: running"));

        // 3. Write allowed file and run asd verify --task T1.1
        fs.writeFileSync(path.join(orchProj, "hello.txt"), "hello cli\n", "utf8");
        const verRes = runCli(
          [
            "verify",
            "--task",
            "T1.1",
            "--files",
            "hello.txt",
            "--summary",
            "Created hello.txt via CLI",
            "--home",
            orchHome,
          ],
          { cwd: orchProj }
        );
        assert.equal(verRes.exitCode, 0, `verify stderr: ${verRes.stderr}`);
        assert.ok(verRes.stdout.includes("Verify [T1.1]: PASS"));

        // 4. Subagent guard blocks asd debate from subagents
        const subDebate = runCli(
          ["debate", "--topic", "T", "--proposal", "P", "--home", orchHome],
          {
            cwd: orchProj,
            env: { ...process.env, ASD_SESSION_ROLE: "subagent" },
          }
        );
        assert.equal(subDebate.exitCode, 1);
        assert.ok(subDebate.stderr.includes("Subagents cannot invoke orchestration tools"));

        // 5. Open non-TTY stdin pipe must NOT cause 'asd plan' or 'asd debate' to block
        const openPipeCheck = await new Promise<{ exitCode: number; stdout: string }>((resolve, reject) => {
          const child = child_process.spawn(
            process.execPath,
            ["--no-warnings", cliPath, "plan", "get", "--home", orchHome],
            {
              cwd: orchProj,
              stdio: ["pipe", "pipe", "pipe"],
              windowsHide: true,
            }
          );
          // Deliberately keep child.stdin open (do NOT call child.stdin.end())
          let out = "";
          child.stdout?.on("data", (c) => {
            out += String(c);
          });
          const t = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error("CLI hung waiting for open non-TTY stdin pipe"));
          }, 4000);
          child.on("close", (code) => {
            clearTimeout(t);
            child.stdin?.destroy();
            resolve({ exitCode: code ?? -1, stdout: out });
          });
        });
        assert.equal(openPipeCheck.exitCode, 0);
        assert.ok(openPipeCheck.stdout.includes("sess-cli-orch-1"));

        // 6. asd plan --title --tasks with alias fields (id: "T-2", agent, allowedFiles, verificationCmd)
        //    and asd plan --from-markdown preserving verify_cmd
        const aliasTasks = JSON.stringify([
          {
            id: "T-2",
            title: "Alias Schema Task",
            agent: "builder",
            turn: 2,
            track: "LIGHT",
            allowedFiles: ["alias.txt"],
            verificationCmd: "npm test",
          },
        ]);
        const aliasPlanRes = runCli(
          ["plan", "--title", "Alias Goal", "--tasks", aliasTasks, "--home", orchHome],
          { cwd: orchProj }
        );
        assert.equal(aliasPlanRes.exitCode, 0, `aliasPlan stderr: ${aliasPlanRes.stderr}`);
        assert.ok(aliasPlanRes.stdout.includes("T2.2"));

        const syncMdRes = runCli(
          ["plan", "--from-markdown", "--json", "--home", orchHome],
          { cwd: orchProj }
        );
        assert.equal(syncMdRes.exitCode, 0, `syncMd stderr: ${syncMdRes.stderr}`);
        const syncMdJson = JSON.parse(syncMdRes.stdout) as {
          tasks: Array<{ taskId: string; role: string; verifyCmd?: string; targetFiles: string[] }>;
        };
        const t2 = syncMdJson.tasks.find((t) => t.taskId === "T2.2");
        assert.ok(t2, "T2.2 should exist after --from-markdown sync");
        assert.equal(t2.role, "builder");
        assert.equal(t2.verifyCmd, "npm test", "verifyCmd must be preserved across syncPlanFromMd");
        assert.deepEqual(t2.targetFiles, ["alias.txt"]);
      } finally {
        removeTempDir(orchHome);
        removeTempDir(orchProj);
      }
    });
  });
});
