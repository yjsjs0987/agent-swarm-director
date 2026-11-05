import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { openProjectDb } from "../src/core/db.ts";
import {
  attachDriver,
  getActiveDriver,
  parseDriverStreamLine,
  runDriverTurn,
  type DriverStreamEvent,
} from "../src/core/drivers.ts";

function makeTempDir(prefix = "asd-driver-runner-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("CR-03: runDriverTurn first run uses headless command, records session_id, deletes output.log, and second run uses resume", async () => {
  const root = makeTempDir();
  try {
    const db = openProjectDb(root, root);
    const sessionId = "asd-20261101-120300-drv1";
    db.createOrGetSession({
      sessionId,
      projectRoot: root,
      mainHarness: "claude-code",
      mainModel: "claude-sonnet-4-6",
    });

    const calls: Array<{ cmd: string; args: string[]; env: Record<string, string> }> = [];
    const chunks: string[] = [];

    const firstRes = await runDriverTurn({
      projectRoot: root,
      db,
      sessionId,
      prompt: "Hello first turn",
      onOutput: (c) => chunks.push(c),
      commandRunner: {
        async run(cmd, args, opts) {
          calls.push({ cmd, args, env: opts.env });
          opts.onSpawn?.(42424);
          opts.onStdout(
            JSON.stringify({ session_id: "cc-sess-001", text: "secret sk-1234567890abcdefghijklmnop" }) + "\n"
          );
          return { exitCode: 0, pid: 42424 };
        },
      },
    });

    assert.equal(firstRes.exitCode, 0);
    assert.equal(firstRes.harnessSessionId, "cc-sess-001");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cmd, "claude");
    assert.ok(!calls[0].args.includes("--resume"), "First run should not use --resume");
    assert.equal(calls[0].env.ASD_SESSION_ROLE, "driver");
    assert.equal(calls[0].env.ASD_MAIN_SESSION_ID, sessionId);
    assert.equal(calls[0].env.ASD_DRIVER_ID, firstRes.driverId);

    // Check output.log deleted and meta.json exists with status=done
    assert.ok(fs.existsSync(firstRes.metaPath));
    assert.equal(fs.existsSync(path.join(path.dirname(firstRes.metaPath), "output.log")), false);
    const meta = JSON.parse(fs.readFileSync(firstRes.metaPath, "utf8"));
    assert.equal(meta.status, "done");
    assert.equal(meta.exitCode, 0);
    assert.equal(meta.harnessSessionId, "cc-sess-001");

    // Check active driver in DB updated
    const active = getActiveDriver(db, sessionId);
    assert.equal(active?.harness_session_id, "cc-sess-001");

    // Check secret masking in onOutput
    assert.ok(!chunks.join("").includes("sk-1234567890abcdefghijklmnop"));

    // Second run: should use --resume cc-sess-001
    const secondRes = await runDriverTurn({
      projectRoot: root,
      db,
      sessionId,
      prompt: "Second turn follow up",
      commandRunner: {
        async run(cmd, args, opts) {
          calls.push({ cmd, args, env: opts.env });
          opts.onStdout(JSON.stringify({ session_id: "cc-sess-001" }) + "\n");
          return { exitCode: 0, pid: 42425 };
        },
      },
    });

    assert.equal(secondRes.exitCode, 0);
    assert.equal(calls.length, 2);
    assert.ok(calls[1].args.includes("--resume"), "Second run must use --resume");
    assert.ok(calls[1].args.includes("cc-sess-001"));

    db.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("CR-03: runDriverTurn injects briefing once when switching to a new driver and rejects concurrent execution with DRIVER_BUSY", async () => {
  const root = makeTempDir();
  try {
    const db = openProjectDb(root, root);
    const sessionId = "asd-20261101-120301-drv2";
    db.createOrGetSession({
      sessionId,
      projectRoot: root,
      mainHarness: "claude-code",
      mainModel: "claude-sonnet-4-6",
      memo: "Briefing test session",
    });

    // Switch to codex driver so there is a previous driver
    attachDriver(db, {
      projectRoot: root,
      sessionId,
      harness: "codex",
      model: "gpt-5.4",
      source: "gui-prompt",
    });

    const receivedArgs: string[][] = [];

    // First run on new driver: auto briefing should be injected
    await runDriverTurn({
      projectRoot: root,
      db,
      sessionId,
      prompt: "Continue work in codex",
      commandRunner: {
        async run(_cmd, args, opts) {
          receivedArgs.push(args);
          opts.onStdout(JSON.stringify({ thread_id: "codex-thread-99" }) + "\n");
          return { exitCode: 0, pid: 50001 };
        },
      },
    });

    assert.equal(receivedArgs.length, 1);
    const firstJoined = receivedArgs[0].join(" ");
    assert.ok(firstJoined.includes("# ASD Session Briefing"), "First turn of switched driver must include briefing");
    assert.ok(firstJoined.includes("Continue work in codex"));

    // Second run on same driver: briefing_injected is now 1, so briefing should NOT be injected
    await runDriverTurn({
      projectRoot: root,
      db,
      sessionId,
      prompt: "Next prompt without briefing",
      commandRunner: {
        async run(_cmd, args) {
          receivedArgs.push(args);
          return { exitCode: 0, pid: 50002 };
        },
      },
    });

    assert.equal(receivedArgs.length, 2);
    const secondJoined = receivedArgs[1].join(" ");
    assert.ok(!secondJoined.includes("# ASD Session Briefing"), "Second turn must not re-inject briefing");
    assert.ok(secondJoined.includes("Next prompt without briefing"));

    // Concurrent execution on same driver -> DRIVER_BUSY
    let releaseSlow!: () => void;
    const slowGate = new Promise<void>((r) => {
      releaseSlow = r;
    });

    const runningPromise = runDriverTurn({
      projectRoot: root,
      db,
      sessionId,
      prompt: "Slow turn",
      commandRunner: {
        async run() {
          await slowGate;
          return { exitCode: 0, pid: 50003 };
        },
      },
    });

    await assert.rejects(
      () =>
        runDriverTurn({
          projectRoot: root,
          db,
          sessionId,
          prompt: "Concurrent turn",
          commandRunner: {
            async run() {
              return { exitCode: 0, pid: 50004 };
            },
          },
        }),
      /DRIVER_BUSY/
    );

    releaseSlow();
    await runningPromise;

    db.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("T2.2: runDriverTurn emits structured onEvent callbacks for thinking, tool_use, tool_result, and text across harnesses", async () => {
  const root = makeTempDir("asd-driver-events-");
  try {
    const db = openProjectDb(root, root);
    const sessionId = "asd-20261103-184500-evnt";
    db.createOrGetSession({
      sessionId,
      projectRoot: root,
      mainHarness: "claude-code",
      mainModel: "claude-sonnet-4-6",
    });

    const events: DriverStreamEvent[] = [];
    const res = await runDriverTurn({
      projectRoot: root,
      db,
      sessionId,
      prompt: "Stream everything",
      streamJson: true,
      onEvent: (ev) => events.push(ev),
      commandRunner: {
        async run(_cmd, args, opts) {
          assert.ok(args.includes("stream-json"), "streamJson should switch claude output format to stream-json");
          opts.onStdout(
            JSON.stringify({
              type: "assistant",
              session_id: "cc-stream-1",
              message: {
                role: "assistant",
                content: [
                  { type: "thinking", thinking: "Step 1: inspect files" },
                  { type: "tool_use", id: "tu_1", name: "Bash", input: { command: "ls" } },
                ],
              },
            }) + "\n"
          );
          opts.onStdout(
            JSON.stringify({
              type: "user",
              message: {
                role: "user",
                content: [
                  { type: "tool_result", tool_use_id: "tu_1", content: "file1.ts\nfile2.ts" },
                ],
              },
            }) + "\n"
          );
          opts.onStdout(
            JSON.stringify({
              type: "result",
              session_id: "cc-stream-1",
              result: "Completed inspection.",
            }) + "\n"
          );
          return { exitCode: 0, pid: 60001 };
        },
      },
    });

    assert.equal(res.exitCode, 0);
    assert.equal(res.harnessSessionId, "cc-stream-1");
    assert.equal(events.length, 4);
    assert.equal(events[0]?.type, "thinking");
    assert.equal(events[0]?.thinking, "Step 1: inspect files");
    assert.equal(events[1]?.type, "tool_use");
    assert.equal(events[1]?.toolName, "Bash");
    assert.equal(events[2]?.type, "tool_result");
    assert.equal(events[2]?.toolOutput, "file1.ts\nfile2.ts");
    assert.equal(events[3]?.type, "text");
    assert.equal(events[3]?.text, "Completed inspection.");

    // Verify parseDriverStreamLine for Codex & OpenCode & Antigravity
    const codexEvents = parseDriverStreamLine(
      JSON.stringify({
        type: "item.completed",
        item: { type: "command_execution", id: "cmd_1", command: "npm test", aggregated_output: "PASS", exit_code: 0 },
      }),
      "codex"
    );
    assert.equal(codexEvents[0]?.type, "tool_result");
    assert.equal(codexEvents[0]?.toolOutput, "PASS");

    const ocEvents = parseDriverStreamLine(
      JSON.stringify({
        type: "tool",
        part: { type: "tool", tool: "read", callID: "c1", state: { status: "completed", input: { path: "a.ts" }, output: "content" } },
      }),
      "opencode"
    );
    assert.equal(ocEvents.length, 2);
    assert.equal(ocEvents[0]?.type, "tool_use");
    assert.equal(ocEvents[1]?.type, "tool_result");

    db.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("F16: runDriverTurn recovers full session_id when JSON line is split across stdout chunks", async () => {
  const root = makeTempDir("asd-driver-split-sid-");
  try {
    const db = openProjectDb(root, root);
    const sessionId = "asd-20261105-090000-f16a";
    db.createOrGetSession({
      sessionId,
      projectRoot: root,
      mainHarness: "claude-code",
      mainModel: "claude-sonnet-4-6",
    });

    const fullUuid = "550e8400-e29b-41d4-a716-446655440000";
    const jsonLine = JSON.stringify({ type: "system", session_id: fullUuid, text: "hello" }) + "\n";
    // Split right in the middle of the UUID
    const splitIdx = jsonLine.indexOf("41d4");
    const chunk1 = jsonLine.slice(0, splitIdx);
    const chunk2 = jsonLine.slice(splitIdx);

    const firstRes = await runDriverTurn({
      projectRoot: root,
      homeDir: root,
      db,
      sessionId,
      prompt: "First turn with split chunks",
      commandRunner: {
        async run(_cmd, _args, opts) {
          opts.onSpawn?.(70001);
          opts.onStdout(chunk1);
          opts.onStdout(chunk2);
          return { exitCode: 0, pid: 70001 };
        },
      },
    });

    assert.equal(firstRes.exitCode, 0);
    assert.equal(firstRes.harnessSessionId, fullUuid);
    const active = getActiveDriver(db, sessionId);
    assert.equal(active?.harness_session_id, fullUuid);

    const resumeArgs: string[][] = [];
    await runDriverTurn({
      projectRoot: root,
      homeDir: root,
      db,
      sessionId,
      prompt: "Second turn resume check",
      commandRunner: {
        async run(_cmd, args) {
          resumeArgs.push(args);
          return { exitCode: 0, pid: 70002 };
        },
      },
    });

    assert.equal(resumeArgs.length, 1);
    assert.ok(resumeArgs[0].includes("--resume"));
    assert.ok(resumeArgs[0].includes(fullUuid));

    db.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
