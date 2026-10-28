/**
 * Tests for src/core/spawner.ts — subagent spawning, artifact logging,
 * secret redaction, env injection, abort tree-kill, and mock CommandRunner.
 * Uses node:test and node:assert/strict. All children are killed in after().
 */

import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  spawnSubagent,
  killProcessTree,
} from "../src/core/spawner.ts";
import type { CommandRunner } from "../src/core/spawner.ts";
import type { SubagentSessionMeta } from "../src/core/types.ts";

const tmpRoots: string[] = [];
const livePids: number[] = [];

function makeProjectRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asd-spawner-test-"));
  tmpRoots.push(dir);
  return dir;
}

function readMeta(metaPath: string): SubagentSessionMeta {
  return JSON.parse(fs.readFileSync(metaPath, "utf8")) as SubagentSessionMeta;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPid(metaPath: string, timeoutMs = 5000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const meta = readMeta(metaPath);
    if (meta.pid > 0) return meta.pid;
    if (Date.now() > deadline) {
      throw new Error("pid never appeared in meta.json");
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function waitForExit(pid: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (processAlive(pid)) {
    if (Date.now() > deadline) {
      throw new Error(`process ${pid} still alive after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

after(() => {
  // Defensive: no orphan children, no leftover temp dirs.
  for (const pid of livePids) {
    try {
      killProcessTree(pid);
    } catch {
      // Already gone.
    }
  }
  for (const dir of tmpRoots) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("spawner.ts", () => {
  test("happy path: artifacts created, secrets redacted, env injected", async () => {
    const projectRoot = makeProjectRoot();
    const result = await spawnSubagent({
      projectRoot,
      mainSessionId: "main-1",
      subSessionId: "sub-happy",
      role: "worker",
      harness: "opencode",
      model: "glm-5",
      taskId: "T1.1",
      prompt: "Build the widget. Prior decision: use stdlib.",
      allowedFiles: ["src/widget.ts"],
      command: process.execPath,
      args: [
        "-e",
        "console.log('hello'); " +
          "console.log('ROLE=' + process.env.ASD_SESSION_ROLE); " +
          "console.log('MAIN=' + process.env.ASD_MAIN_SESSION_ID); " +
          "console.error('token=abc123secretvalue')",
      ],
    });

    assert.equal(result.exitCode, 0);
    assert.ok(typeof result.durationMs === "number");
    assert.ok(result.durationMs >= 0);

    const dir = path.join(
      projectRoot,
      ".asd",
      "sessions",
      "main-1",
      "subagents",
      "sub-happy"
    );

    // meta.json
    const meta = readMeta(path.join(dir, "meta.json"));
    assert.equal(meta.status, "done");
    assert.ok(meta.pid > 0);
    assert.equal(meta.roleType, "subagent");
    assert.equal(meta.subSessionId, "sub-happy");
    assert.equal(meta.parentSessionId, "main-1");
    assert.equal(meta.role, "worker");
    assert.equal(meta.harness, "opencode");
    assert.equal(meta.model, "glm-5");
    assert.equal(meta.taskId, "T1.1");
    assert.deepEqual(meta.allowedFiles, ["src/widget.ts"]);
    assert.equal(meta.worktreePath, null);
    assert.ok(typeof meta.durationMs === "number");
    livePids.push(meta.pid); // safety net for after()

    // prompt.md
    const prompt = fs.readFileSync(path.join(dir, "prompt.md"), "utf8");
    assert.ok(prompt.includes("Build the widget."));

    // output.log: content present, secret redacted, env visible to child
    const log = fs.readFileSync(path.join(dir, "output.log"), "utf8");
    assert.ok(log.includes("hello"), "log should contain stdout");
    assert.ok(log.includes("ROLE=subagent"), "child should see ASD_SESSION_ROLE");
    assert.ok(log.includes("MAIN=main-1"), "child should see ASD_MAIN_SESSION_ID");
    assert.ok(log.includes("[REDACTED]"), "token must be redacted");
    assert.ok(!log.includes("abc123secretvalue"), "raw secret must not appear");
  });

  test("abort mid-run tree-kills the child and marks meta failed", async () => {
    const projectRoot = makeProjectRoot();
    const ac = new AbortController();
    const metaPath = path.join(
      projectRoot,
      ".asd",
      "sessions",
      "main-abort",
      "subagents",
      "sub-abort",
      "meta.json"
    );

    const spawnPromise = spawnSubagent({
      projectRoot,
      mainSessionId: "main-abort",
      subSessionId: "sub-abort",
      role: "builder",
      harness: "claude-code",
      model: "opus",
      taskId: "T2",
      prompt: "sleep forever",
      allowedFiles: [],
      command: process.execPath,
      args: ["-e", "setTimeout(()=>{},60000)"],
      signal: ac.signal,
    });

    const pid = await waitForPid(metaPath);
    livePids.push(pid);
    assert.ok(processAlive(pid), "child should be running before abort");

    ac.abort();
    const result = await spawnPromise;
    assert.equal(result.exitCode, -1);

    const meta = readMeta(metaPath);
    assert.equal(meta.status, "failed");
    assert.equal(meta.pid, pid);
    assert.ok(typeof meta.durationMs === "number");

    // Zero zombies: the tree-kill must have actually terminated the child.
    await waitForExit(pid);
  });

  test("idleTimeoutMs resets while tokens stream and aborts when output stalls", async () => {
    const projectRoot = makeProjectRoot();
    const result = await spawnSubagent({
      projectRoot,
      mainSessionId: "main-idle",
      subSessionId: "sub-idle",
      role: "worker",
      harness: "opencode",
      model: "glm-5",
      taskId: "T-IDLE",
      prompt: "emit once then stall",
      allowedFiles: [],
      command: process.execPath,
      args: ["-e", "console.log('token-1'); setTimeout(()=>{}, 10000)"],
      timeoutMs: 5000,
      idleTimeoutMs: 250,
    });

    assert.equal(result.timedOut, true);
    assert.equal(result.exitCode, -1);
    const meta = readMeta(result.metaPath);
    assert.equal(meta.status, "failed");
    if (meta.pid > 0) {
      livePids.push(meta.pid);
    }
  });

  test("mock runner: env injection recorded, meta transitions running→done", async () => {
    const projectRoot = makeProjectRoot();
    let capturedCmd = "";
    let capturedArgs: string[] = [];
    let capturedEnv: Record<string, string> | undefined;
    let metaDuringRun: SubagentSessionMeta | undefined;

    const mockRunner: CommandRunner = {
      async run(cmd, args, opts) {
        capturedCmd = cmd;
        capturedArgs = args;
        capturedEnv = opts.env;
        const metaPath = opts.env["ASD_SUBAGENT_META"] ?? "";
        metaDuringRun = JSON.parse(fs.readFileSync(metaPath, "utf8"));
        opts.onSpawn?.(4242);
        opts.onStdout("mock-out\n");
        opts.onStderr("mock-err\n");
        return { exitCode: 0, pid: 4242 };
      },
    };

    const result = await spawnSubagent({
      projectRoot,
      mainSessionId: "main-mock",
      subSessionId: "sub-mock",
      role: "scout",
      harness: "antigravity",
      model: "flash-lite",
      taskId: "T3",
      prompt: "mock prompt",
      allowedFiles: [],
      command: "fake-cmd",
      args: ["--flag", "value"],
      commandRunner: mockRunner,
    });

    assert.equal(result.exitCode, 0);
    assert.equal(capturedCmd, "fake-cmd");
    assert.deepEqual(capturedArgs, ["--flag", "value"]);

    const env = capturedEnv ?? {};
    assert.equal(env["ASD_SESSION_ROLE"], "subagent");
    assert.equal(env["NODE_NO_WARNINGS"], "1");
    assert.equal(env["ASD_MAIN_SESSION_ID"], "main-mock");
    const metaEnvPath = env["ASD_SUBAGENT_META"] ?? "";
    assert.ok(metaEnvPath.endsWith("meta.json"), "ASD_SUBAGENT_META must be a meta.json path");
    assert.ok(fs.existsSync(metaEnvPath), "ASD_SUBAGENT_META must point at a real file");
    assert.equal(result.metaPath, metaEnvPath);

    // Status transition observed inside the run: running (pid 0 pre-spawn).
    assert.equal(metaDuringRun?.status, "running");

    // Final meta: done, with the pid reported by the mock runner.
    const meta = readMeta(result.metaPath);
    assert.equal(meta.status, "done");
    assert.equal(meta.pid, 4242);
    assert.ok(typeof meta.durationMs === "number");

    // Piped output landed in output.log.
    const log = fs.readFileSync(
      path.join(path.dirname(result.metaPath), "output.log"),
      "utf8"
    );
    assert.ok(log.includes("mock-out"));
    assert.ok(log.includes("mock-err"));
  });
});
