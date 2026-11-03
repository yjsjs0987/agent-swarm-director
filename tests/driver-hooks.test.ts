import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as child_process from "node:child_process";
import { openProjectDb } from "../src/core/db.ts";
import { getActiveDriver, listDrivers } from "../src/core/drivers.ts";
import {
  extractHookSessionInfo,
  linkHarnessSessionToAsdSession,
  readCliRecentSessions,
} from "../src/core/session-tracker.ts";
import { AsdMcpServer } from "../src/mcp/server.ts";
import { ensureGitUserIdentity, prepareBaseline, runGit } from "../src/core/workspace.ts";

function makeTempProject(prefix = "asd-driver-hooks-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  runGit(["init"], { cwd: dir });
  ensureGitUserIdentity(dir);
  prepareBaseline(dir);
  return dir;
}

const cliEntry = path.resolve(import.meta.dirname, "../src/cli/index.ts");

test("CR-04: normal conversation hook without ASD_DRIVER_ID records cli-recent.json ONLY and does NOT hijack active ASD session", () => {
  const root = makeTempProject();
  try {
    const db = openProjectDb(root);
    const sessionId = "asd-20261101-120400-hk01";
    db.createOrGetSession({
      sessionId,
      projectRoot: root,
      mainHarness: "claude-code",
      mainModel: "claude-sonnet-4-6",
      harnessSessionId: "orig-cc-sid",
    });
    db.close();

    // Run session-start hook for an unrelated codex conversation (no ASD_DRIVER_ID)
    const env = { ...process.env };
    delete env.ASD_DRIVER_ID;
    delete env.ASD_MAIN_SESSION_ID;
    delete env.ASD_SESSION_ROLE;

    const payload = JSON.stringify({
      session_id: "unrelated-codex-sid",
      model: "gpt-5.4",
      prompt: "Unrelated chat prompt",
      cwd: root,
    });

    const res = child_process.spawnSync(
      process.execPath,
      ["--no-warnings", cliEntry, "hook", "session-start", "--harness", "codex", "--project", root],
      { input: payload, encoding: "utf8", env, cwd: root }
    );
    assert.equal(res.status, 0);

    const dbAfter = openProjectDb(root);
    const sess = dbAfter.getSession(sessionId)!;
    assert.equal(sess.harness_session_id, "orig-cc-sid", "Session harness_session_id must remain unchanged");
    assert.equal(sess.main_harness, "claude-code", "Session main_harness must remain unchanged");

    const drivers = listDrivers(dbAfter, sessionId);
    assert.equal(drivers.length, 1);
    assert.equal(drivers[0].harness, "claude-code");
    assert.equal(drivers[0].harness_session_id, "orig-cc-sid");
    dbAfter.close();

    const recent = readCliRecentSessions(root);
    const recorded = recent.find((r) => r.harnessSessionId === "unrelated-codex-sid");
    assert.ok(recorded, "Unrelated CLI session must still be recorded in cli-recent.json");
    assert.equal(recorded?.asdSessionId, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("CR-04: hook with ASD_DRIVER_ID binds harness_session_id to that driver when null", () => {
  const root = makeTempProject();
  try {
    const db = openProjectDb(root);
    const sessionId = "asd-20261101-120401-hk02";
    db.createOrGetSession({
      sessionId,
      projectRoot: root,
      mainHarness: "claude-code",
      mainModel: "claude-sonnet-4-6",
      harnessSessionId: null,
    });
    const active = getActiveDriver(db, sessionId)!;
    assert.equal(active.harness_session_id, null);
    db.close();

    const env = {
      ...process.env,
      ASD_SESSION_ROLE: "driver",
      ASD_MAIN_SESSION_ID: sessionId,
      ASD_DRIVER_ID: active.driver_id,
    };

    const payload = JSON.stringify({
      session_id: "driver-bound-sid-777",
      model: "claude-sonnet-4-6",
      prompt: "GUI driver prompt",
      cwd: root,
    });

    const res = child_process.spawnSync(
      process.execPath,
      ["--no-warnings", cliEntry, "hook", "session-start", "--harness", "claude-code", "--project", root],
      { input: payload, encoding: "utf8", env, cwd: root }
    );
    assert.equal(res.status, 0);

    const dbAfter = openProjectDb(root);
    const updatedDriver = getActiveDriver(dbAfter, sessionId)!;
    assert.equal(updatedDriver.harness_session_id, "driver-bound-sid-777");
    assert.equal(dbAfter.getSession(sessionId)!.harness_session_id, "driver-bound-sid-777");
    dbAfter.close();

    const recent = readCliRecentSessions(root);
    const rec = recent.find((r) => r.harnessSessionId === "driver-bound-sid-777");
    assert.equal(rec?.asdSessionId, sessionId);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("CR-04: MCP handlePlan create/update switches driver when called from another CLI harness, and 11-min old cli-recent entry attaches with null sid", async () => {
  const root = makeTempProject();
  try {
    const db = openProjectDb(root);
    const sessionId = "asd-20261101-120402-hk03";
    const server = new AsdMcpServer({ db, projectRoot: root, autoSync: false });

    await server.handlePlan({
      action: "create",
      sessionId,
      mainHarness: "claude-code",
      mainModel: "claude-sonnet-4-6",
      harnessSessionId: "cc-initial-sid",
      tasks: [
        {
          taskId: "T1.1",
          turn: 1,
          title: "Task 1",
          targetFiles: ["a.ts"],
        },
      ],
    });

    let drivers = listDrivers(db, sessionId);
    assert.equal(drivers.length, 1);
    assert.equal(drivers[0].harness, "claude-code");
    assert.equal(drivers[0].harness_session_id, "cc-initial-sid");

    // Write an 11-minute-old cli-recent entry for opencode
    const now = Date.now();
    const recentPath = path.join(root, ".asd", "sessions", "cli-recent.json");
    fs.mkdirSync(path.dirname(recentPath), { recursive: true });
    fs.writeFileSync(
      recentPath,
      JSON.stringify(
        {
          sessions: [
            {
              harnessSessionId: "stale-oc-sid",
              harness: "opencode",
              model: "glm-5",
              summary: "Old session",
              transcriptPath: null,
              asdSessionId: null,
              projectRoot: root,
              startedAt: now - 15 * 60 * 1000,
              updatedAt: now - 11 * 60 * 1000,
            },
          ],
        },
        null,
        2
      ),
      "utf8"
    );

    // Call linkHarnessSessionToAsdSession for opencode without explicit sid -> stale entry (>10m) must be ignored (sid = null)
    const linked = linkHarnessSessionToAsdSession({
      projectRoot: root,
      asdSessionId: sessionId,
      harness: "opencode",
      mainModel: "glm-5",
      now,
      db,
    });
    assert.equal(linked.harnessSessionId, null);

    drivers = listDrivers(db, sessionId);
    assert.equal(drivers.length, 2);
    const prev = drivers.find((d) => d.harness === "claude-code")!;
    const curr = drivers.find((d) => d.harness === "opencode")!;
    assert.equal(prev.detach_reason, "switched");
    assert.notEqual(prev.detached_at, null);
    assert.equal(curr.detached_at, null);
    assert.equal(curr.harness_session_id, null);

    db.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("T1.3: Codex notify (thread-id / thread_id via argv and stdin) and Cursor hooks (conversation_id / chat_id / composer_id) fixture tests record cli-recent.json", () => {
  const root = makeTempProject("asd-codex-cursor-fixtures-");
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "asd-fixture-home-"));
  try {
    const env = {
      ...process.env,
      ASD_HOME_DIR: tmpHome,
    };
    delete env.ASD_DRIVER_ID;
    delete env.ASD_MAIN_SESSION_ID;
    delete env.ASD_SESSION_ROLE;

    // 1. Unit-test extractHookSessionInfo on Codex & Cursor payload variants
    const codexNotifyFixture = {
      type: "agent-turn-complete",
      "thread-id": "codex-thread-kebab-001",
      "turn-id": "turn-01",
      cwd: root,
      "input-messages": ["Implement session demotion CLI"],
      "last-assistant-message": "Done implementing asd resume.",
    };
    const codexExtracted = extractHookSessionInfo(codexNotifyFixture, "codex");
    assert.equal(codexExtracted.harness, "codex");
    assert.equal(codexExtracted.harnessSessionId, "codex-thread-kebab-001");
    assert.equal(codexExtracted.projectRoot, path.resolve(root));
    assert.equal(codexExtracted.summary, "Implement session demotion CLI");

    const cursorShellFixture = {
      conversation_id: "cursor-conv-uuid-101",
      hook_event_name: "beforeShellExecution",
      workspace_roots: [root],
      model: "claude-3.7-sonnet",
      command: "npm test",
    };
    const cursorExtracted = extractHookSessionInfo(cursorShellFixture, "cursor");
    assert.equal(cursorExtracted.harness, "cursor");
    assert.equal(cursorExtracted.harnessSessionId, "cursor-conv-uuid-101");
    assert.equal(cursorExtracted.model, "claude-3.7-sonnet");
    assert.equal(cursorExtracted.projectRoot, path.resolve(root));
    assert.equal(cursorExtracted.summary, "Shell: npm test");

    const cursorComposerFixture = {
      composer_id: "cursor-composer-202",
      workspace_roots: [root],
      prompt: "Fix hooks schema",
    };
    const composerExtracted = extractHookSessionInfo(cursorComposerFixture, "cursor");
    assert.equal(composerExtracted.harnessSessionId, "cursor-composer-202");
    assert.equal(composerExtracted.summary, "Fix hooks schema");

    // 2. End-to-end CLI hook execution: Codex notify passes JSON payload as final argv (no stdin)
    const codexArgvRes = child_process.spawnSync(
      process.execPath,
      [
        "--no-warnings",
        cliEntry,
        "hook",
        "stop",
        "--harness",
        "codex",
        JSON.stringify(codexNotifyFixture),
      ],
      { encoding: "utf8", env, cwd: root }
    );
    assert.equal(codexArgvRes.status, 0, `codex argv hook stderr: ${codexArgvRes.stderr}`);

    // 3. End-to-end CLI hook execution: Cursor stop hook passes chat_id payload via stdin
    const cursorStopFixture = {
      chat_id: "cursor-chat-stdin-303",
      hook_event_name: "stop",
      workspace_roots: [root],
      model: "gpt-5.4",
      prompt: "Verify cursor hook session tracking",
    };
    const cursorStdinRes = child_process.spawnSync(
      process.execPath,
      ["--no-warnings", cliEntry, "hook", "stop", "--harness", "cursor"],
      { input: JSON.stringify(cursorStopFixture), encoding: "utf8", env, cwd: root }
    );
    assert.equal(cursorStdinRes.status, 0, `cursor stdin hook stderr: ${cursorStdinRes.stderr}`);

    // 4. Assert cli-recent.json contains both Codex and Cursor sessions
    const recent = readCliRecentSessions(root);
    const codexRec = recent.find((r) => r.harnessSessionId === "codex-thread-kebab-001");
    assert.ok(codexRec, "Codex notify argv session must be recorded in cli-recent.json");
    assert.equal(codexRec.harness, "codex");
    assert.equal(codexRec.summary, "Implement session demotion CLI");

    const cursorRec = recent.find((r) => r.harnessSessionId === "cursor-chat-stdin-303");
    assert.ok(cursorRec, "Cursor stop hook session must be recorded in cli-recent.json");
    assert.equal(cursorRec.harness, "cursor");
    assert.equal(cursorRec.model, "gpt-5.4");
    assert.equal(cursorRec.summary, "Verify cursor hook session tracking");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});
