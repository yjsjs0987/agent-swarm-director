import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openProjectDb } from "../src/core/db.ts";
import {
  buildSessionDemotion,
  linkHarnessSessionToAsdSession,
  promoteCliSessionToAsd,
  readCliRecentSessions,
  recordCliRecentSession,
  syncLocalHarnessTranscripts,
} from "../src/core/session-tracker.ts";

function makeTempDir(prefix = "asd-session-tracker-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("T1.1: syncLocalHarnessTranscripts discovers Claude Code, Codex, OpenCode, and Antigravity sessions for projectRoot", () => {
  const homeDir = makeTempDir("asd-t11-home-");
  const projectRoot = makeTempDir("asd-t11-proj-");
  const otherProjectRoot = makeTempDir("asd-t11-other-");
  try {
    fs.mkdirSync(path.join(projectRoot, ".asd"), { recursive: true });

    // 1. Claude Code transcript under ~/.claude/projects/<encoded>/cc-sess-1.jsonl
    const encodedDir = projectRoot.replace(/[:\\/]/g, "-");
    const claudeDir = path.join(homeDir, ".claude", "projects", encodedDir);
    fs.mkdirSync(claudeDir, { recursive: true });
    const claudeTranscript = path.join(claudeDir, "cc-sess-101.jsonl");
    fs.writeFileSync(
      claudeTranscript,
      [
        JSON.stringify({
          type: "user",
          cwd: projectRoot,
          message: { role: "user", content: "Fix authentication bug in login flow" },
        }),
        JSON.stringify({
          type: "assistant",
          message: { role: "assistant", model: "claude-sonnet-4-6", content: [{ type: "text", text: "On it." }] },
        }),
      ].join("\n") + "\n",
      "utf8"
    );

    // 2. Codex rollout transcript under ~/.codex/sessions/2026/11/03/rollout-...-codex-thread-202.jsonl
    const codexDir = path.join(homeDir, ".codex", "sessions", "2026", "11", "03");
    fs.mkdirSync(codexDir, { recursive: true });
    const codexTranscript = path.join(
      codexDir,
      "rollout-2026-11-03T10-00-00-codex-thread-202.jsonl"
    );
    fs.writeFileSync(
      codexTranscript,
      [
        JSON.stringify({
          type: "session_meta",
          payload: { id: "codex-thread-202", cwd: projectRoot, model: "gpt-5.4" },
        }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "<environment_context>skip me</environment_context>" }],
          },
        }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Optimize database queries for Codex" }],
          },
        }),
      ].join("\n") + "\n",
      "utf8"
    );

    // Unrelated Codex session for otherProjectRoot (must be ignored)
    fs.writeFileSync(
      path.join(codexDir, "rollout-2026-11-03T10-00-00-codex-other-999.jsonl"),
      JSON.stringify({
        type: "session_meta",
        payload: { id: "codex-other-999", cwd: otherProjectRoot },
      }) + "\n",
      "utf8"
    );

    // 3. OpenCode SQLite session in ~/.local/share/opencode/opencode.db
    const ocDir = path.join(homeDir, ".local", "share", "opencode");
    fs.mkdirSync(ocDir, { recursive: true });
    const ocDbPath = path.join(ocDir, "opencode.db");
    const ocDb = new DatabaseSync(ocDbPath);
    ocDb.exec(`
      CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT);
      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        directory TEXT,
        title TEXT,
        parent_id TEXT,
        time_created INTEGER,
        time_updated INTEGER
      );
    `);
    const nowMs = Date.now();
    ocDb
      .prepare("INSERT INTO project (id, worktree) VALUES (?, ?)")
      .run("proj-1", projectRoot);
    ocDb
      .prepare(
        "INSERT INTO session (id, project_id, directory, title, parent_id, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)"
      )
      .run("oc-sess-303", "proj-1", projectRoot, "Refactor OpenCode router", null, nowMs - 1000, nowMs);
    ocDb.close();

    // 4. Antigravity transcript under ~/.gemini/antigravity-cli/brain/agy-conv-404/.system_generated/logs/transcript.jsonl
    const agyLogDir = path.join(
      homeDir,
      ".gemini",
      "antigravity-cli",
      "brain",
      "agy-conv-404",
      ".system_generated",
      "logs"
    );
    fs.mkdirSync(agyLogDir, { recursive: true });
    fs.writeFileSync(
      path.join(agyLogDir, "transcript.jsonl"),
      JSON.stringify({
        type: "USER_INPUT",
        content: `<CONTEXT_SUMMARY>old context</CONTEXT_SUMMARY><USER_REQUEST>Build Antigravity session sync</USER_REQUEST><ADDITIONAL_METADATA>workspace: ${projectRoot}</ADDITIONAL_METADATA>`,
      }) + "\n",
      "utf8"
    );

    const synced = syncLocalHarnessTranscripts(projectRoot, { homeDir });
    const byHarness = new Map(synced.map((s) => [s.harness, s]));

    assert.equal(byHarness.get("claude-code")?.harnessSessionId, "cc-sess-101");
    assert.equal(byHarness.get("claude-code")?.model, "claude-sonnet-4-6");
    assert.equal(byHarness.get("claude-code")?.summary, "Fix authentication bug in login flow");

    assert.equal(byHarness.get("codex")?.harnessSessionId, "codex-thread-202");
    assert.equal(byHarness.get("codex")?.model, "gpt-5.4");
    assert.equal(byHarness.get("codex")?.summary, "Optimize database queries for Codex");

    assert.equal(byHarness.get("opencode")?.harnessSessionId, "oc-sess-303");
    assert.equal(byHarness.get("opencode")?.summary, "Refactor OpenCode router");

    assert.equal(byHarness.get("antigravity")?.harnessSessionId, "agy-conv-404");
    assert.equal(byHarness.get("antigravity")?.summary, "Build Antigravity session sync");
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(otherProjectRoot, { recursive: true, force: true });
  }
});

test("T1.1: recordCliRecentSession preserves meaningful summary and transcriptPath across tool/stop hooks", () => {
  const projectRoot = makeTempDir("asd-t11-record-");
  try {
    fs.mkdirSync(path.join(projectRoot, ".asd"), { recursive: true });

    recordCliRecentSession(projectRoot, {
      harnessSessionId: "sess-preserve-1",
      harness: "claude-code",
      model: "claude-sonnet-4-6",
      summary: "Initial user prompt for feature X",
      transcriptPath: "/tmp/transcript-1.jsonl",
    });

    // Subsequent pre-tool-use with generic "Tool: Bash" and no transcriptPath
    const afterTool = recordCliRecentSession(projectRoot, {
      harnessSessionId: "sess-preserve-1",
      harness: "claude-code",
      summary: "Tool: Bash",
      transcriptPath: null,
    });
    assert.equal(afterTool?.summary, "Initial user prompt for feature X");
    assert.equal(afterTool?.transcriptPath, "/tmp/transcript-1.jsonl");
    assert.equal(afterTool?.model, "claude-sonnet-4-6");

    // Subsequent stop hook with empty summary
    const afterStop = recordCliRecentSession(projectRoot, {
      harnessSessionId: "sess-preserve-1",
      harness: "claude-code",
      summary: "",
      transcriptPath: undefined,
    });
    assert.equal(afterStop?.summary, "Initial user prompt for feature X");
    assert.equal(afterStop?.transcriptPath, "/tmp/transcript-1.jsonl");
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("T1.1: linkHarnessSessionToAsdSession falls back to syncLocalHarnessTranscripts when cli-recent has no fresh entry for target harness", () => {
  const homeDir = makeTempDir("asd-t11-link-home-");
  const projectRoot = makeTempDir("asd-t11-link-proj-");
  try {
    const db = openProjectDb(projectRoot, homeDir);
    const asdSessionId = "asd-20261103-183000-t11a";
    db.createOrGetSession({
      sessionId: asdSessionId,
      projectRoot,
      mainHarness: "codex",
      mainModel: "gpt-5.4",
    });

    // Seed an old claude-code entry in cli-recent.json so the file is non-empty
    recordCliRecentSession(
      projectRoot,
      {
        harnessSessionId: "old-cc-1",
        harness: "claude-code",
        summary: "Old session",
      },
      { forceCreateDir: true }
    );

    // Create a fresh local Codex rollout transcript for projectRoot
    const codexDir = path.join(homeDir, ".codex", "sessions", "2026", "11", "03");
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(
      path.join(codexDir, "rollout-2026-11-03T18-30-00-codex-fresh-777.jsonl"),
      JSON.stringify({
        type: "session_meta",
        payload: { id: "codex-fresh-777", cwd: projectRoot, model: "gpt-5.4" },
      }) + "\n",
      "utf8"
    );

    const linked = linkHarnessSessionToAsdSession({
      projectRoot,
      homeDir,
      asdSessionId,
      harness: "codex",
      db,
    });

    assert.equal(linked.harnessSessionId, "codex-fresh-777");
    const activeDriver = db.getActiveDriver(asdSessionId);
    assert.equal(activeDriver?.harness, "codex");
    assert.equal(activeDriver?.harness_session_id, "codex-fresh-777");
    db.close();
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("T2.2: promoteCliSessionToAsd promotes a plain CLI session into an ASD session and round-trips with buildSessionDemotion", () => {
  const homeDir = makeTempDir("asd-t22-promo-home-");
  const projectRoot = makeTempDir("asd-t22-promo-proj-");
  try {
    const promoted = promoteCliSessionToAsd({
      projectRoot,
      homeDir,
      harness: "antigravity",
      harnessSessionId: "agy-conv-promo-888",
      model: "gemini-3.1-pro-high",
      title: "Promote CLI session test",
      autoApprove: true,
    });

    assert.ok(promoted.asdSessionId.startsWith("asd-"));
    assert.ok(promoted.driverId.startsWith("drv-"));
    assert.equal(promoted.harness, "antigravity");
    assert.equal(promoted.harnessSessionId, "agy-conv-promo-888");
    assert.ok(fs.existsSync(promoted.mainJsonPath));

    const recent = readCliRecentSessions(projectRoot);
    assert.equal(recent[0]?.harnessSessionId, "agy-conv-promo-888");
    assert.equal(recent[0]?.asdSessionId, promoted.asdSessionId);

    // Demoting back to CLI session must return `agy --resume agy-conv-promo-888`
    const demoted = buildSessionDemotion({
      projectRoot,
      homeDir,
      sessionId: promoted.asdSessionId,
    });
    assert.equal(demoted.command, "agy");
    assert.deepEqual(demoted.args, ["--resume", "agy-conv-promo-888", "--model", "gemini-3.1-pro-high"]);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});
