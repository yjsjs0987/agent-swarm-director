/**
 * Tests for the 5-harness original transcript reader (CR-10).
 *
 * Fixture-based verification for:
 * 1. claude-code ~/.claude/projects/<encoded>/<sessionId>.jsonl
 * 2. codex ~/.codex/sessions/** /rollout-*<threadId>*.jsonl
 * 3. opencode ~/.local/share/opencode/opencode.db (readOnly DatabaseSync) + storage/ fallback
 * 4. antigravity ~/.gemini/antigravity-cli/brain/<id>/... + legacy ~/.gemini/antigravity/brain
 * 5. cursor -> found:false / "unsupported"
 *
 * Plus: missing sessions never throw, malformed JSONL lines are skipped,
 * secrets are redacted, limit/before pagination works, 20MB cap truncation.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, test } from "node:test";

import {
  locateHarnessTranscript,
  readHarnessTranscript,
} from "../src/core/transcripts.ts";

const tmpDirs: string[] = [];

function makeHome(prefix = "asd-transcripts-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function writeJsonl(filePath: string, lines: string[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf8");
}

describe("Harness Transcripts (CR-10)", () => {
  describe("1. claude-code (~/.claude/projects/<encoded>/<sessionId>.jsonl)", () => {
    const home = makeHome();
    const sessionId = "sess-cc-1234";
    const transcript = path.join(home, ".claude", "projects", "C--Users-x-proj", `${sessionId}.jsonl`);
    writeJsonl(transcript, [
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "hello sk-1234567890abcdefghij" },
        timestamp: "2025-01-01T00:00:00Z",
      }),
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "hi there" }] },
        timestamp: "2025-01-01T00:00:01Z",
      }),
      "{this is not valid json", // malformed line: skipped, index preserved
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "third question" },
        timestamp: "2025-01-01T00:00:02Z",
      }),
    ]);

    test("locate finds the transcript under the encoded project dir", () => {
      const loc = locateHarnessTranscript("claude-code", sessionId, { homeDir: home });
      assert.equal(loc.found, true);
      assert.ok(loc.transcriptPath && loc.transcriptPath.endsWith(`${sessionId}.jsonl`));
    });

    test("read returns redacted messages with malformed lines skipped", () => {
      const result = readHarnessTranscript("claude-code", sessionId, { homeDir: home });
      assert.equal(result.found, true);
      assert.equal(result.messages.length, 3);
      assert.deepEqual(
        result.messages.map((m) => m.index),
        [0, 1, 3]
      );
      assert.equal(result.messages[0]?.role, "user");
      assert.ok(result.messages[0]?.text.includes("[REDACTED]"));
      assert.ok(!result.messages[0]?.text.includes("sk-1234567890abcdefghij"));
      assert.equal(result.messages[1]?.text, "hi there");
      assert.equal(result.truncated, false);
    });

    test("missing session returns found:false without throwing", () => {
      const loc = locateHarnessTranscript("claude-code", "nope-missing", { homeDir: home });
      assert.equal(loc.found, false);
      const result = readHarnessTranscript("claude-code", "nope-missing", { homeDir: home });
      assert.equal(result.found, false);
      assert.deepEqual(result.messages, []);
      assert.ok(result.error);
    });
  });

  describe("2. codex (~/.codex/sessions/**/rollout-*<threadId>*.jsonl)", () => {
    const home = makeHome();
    const threadId = "0199abcd-thread";
    const transcript = path.join(
      home,
      ".codex",
      "sessions",
      "2025",
      "11",
      "01",
      `rollout-2025-11-01T10-00-00-${threadId}.jsonl`
    );
    writeJsonl(transcript, [
      JSON.stringify({ timestamp: "2025-11-01T10:00:00Z", type: "session_meta", payload: { id: threadId } }),
      JSON.stringify({
        timestamp: "2025-11-01T10:00:01Z",
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "what is 2+2?" }] },
      }),
      JSON.stringify({
        timestamp: "2025-11-01T10:00:02Z",
        type: "response_item",
        payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "4" }] },
      }),
      JSON.stringify({
        timestamp: "2025-11-01T10:00:03Z",
        type: "response_item",
        payload: { type: "function_call", name: "shell", arguments: "{}" },
      }),
      "not-json-at-all",
    ]);

    test("locate finds rollout file by threadId substring", () => {
      const loc = locateHarnessTranscript("codex", threadId, { homeDir: home });
      assert.equal(loc.found, true);
      assert.ok(loc.transcriptPath && loc.transcriptPath.includes("rollout-"));
    });

    test("read extracts response_item messages and skips meta/events", () => {
      const result = readHarnessTranscript("codex", threadId, { homeDir: home });
      assert.equal(result.found, true);
      assert.equal(result.messages.length, 2);
      assert.equal(result.messages[0]?.role, "user");
      assert.equal(result.messages[0]?.text, "what is 2+2?");
      assert.equal(result.messages[1]?.role, "assistant");
      assert.equal(result.messages[1]?.text, "4");
    });
  });

  describe("3. opencode (opencode.db readOnly + storage/ fallback)", () => {
    const home = makeHome();
    const sessionId = "ses_oc_42";

    test("reads messages from the SQLite database (readOnly)", () => {
      const dbPath = path.join(home, ".local", "share", "opencode", "opencode.db");
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      const db = new DatabaseSync(dbPath);
      try {
        db.exec(
          "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, data TEXT NOT NULL);" +
            "CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, data TEXT NOT NULL);"
        );
        db.prepare("INSERT INTO message (id, session_id, data) VALUES (?, ?, ?)").run(
          "msg_1",
          sessionId,
          JSON.stringify({ id: "msg_1", sessionID: sessionId, role: "user" })
        );
        db.prepare("INSERT INTO message (id, session_id, data) VALUES (?, ?, ?)").run(
          "msg_2",
          sessionId,
          JSON.stringify({
            id: "msg_2",
            sessionID: sessionId,
            role: "assistant",
            time: { created: 1761955200000 },
          })
        );
        db.prepare("INSERT INTO message (id, session_id, data) VALUES (?, ?, ?)").run(
          "msg_other",
          "ses_other",
          JSON.stringify({ id: "msg_other", sessionID: "ses_other", role: "user" })
        );
        db.prepare("INSERT INTO part (id, message_id, session_id, data) VALUES (?, ?, ?, ?)").run(
          "prt_001",
          "msg_1",
          sessionId,
          JSON.stringify({ id: "prt_001", messageID: "msg_1", sessionID: sessionId, type: "text", text: "fix password = hunter2 please" })
        );
        db.prepare("INSERT INTO part (id, message_id, session_id, data) VALUES (?, ?, ?, ?)").run(
          "prt_002",
          "msg_2",
          sessionId,
          JSON.stringify({ id: "prt_002", messageID: "msg_2", sessionID: sessionId, type: "text", text: "done" })
        );
      } finally {
        db.close();
      }

      const result = readHarnessTranscript("opencode", sessionId, { homeDir: home });
      assert.equal(result.found, true);
      assert.ok(result.transcriptPath && result.transcriptPath.endsWith("opencode.db"));
      assert.equal(result.messages.length, 2);
      assert.equal(result.messages[0]?.role, "user");
      assert.ok(result.messages[0]?.text.includes("[REDACTED]"));
      assert.ok(!result.messages[0]?.text.includes("hunter2"));
      assert.equal(result.messages[1]?.timestamp, new Date(1761955200000).toISOString());
    });

    test("falls back to storage/ JSON layout when the db is absent", () => {
      const home2 = makeHome();
      const storage = path.join(home2, ".local", "share", "opencode", "storage");
      const writeJson = (rel: string, data: unknown): void => {
        const p = path.join(storage, rel);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, JSON.stringify(data), "utf8");
      };
      writeJson(`message/${sessionId}/msg_a.json`, {
        id: "msg_a",
        sessionID: sessionId,
        role: "user",
        time: { created: 1000 },
      });
      writeJson(`message/${sessionId}/msg_b.json`, {
        id: "msg_b",
        sessionID: sessionId,
        role: "assistant",
        time: { created: 2000 },
      });
      writeJson(`part/${sessionId}/msg_b/prt_001.json`, {
        id: "prt_001",
        messageID: "msg_b",
        sessionID: sessionId,
        type: "text",
        text: "second question",
      });
      writeJson(`part/${sessionId}/msg_a/prt_000.json`, {
        id: "prt_000",
        messageID: "msg_a",
        sessionID: sessionId,
        type: "text",
        text: "part one with sk-abcdefghijklmnopqrst",
      });

      const loc = locateHarnessTranscript("opencode", sessionId, { homeDir: home2 });
      assert.equal(loc.found, true);
      assert.ok(loc.storageDir && loc.storageDir.endsWith("storage"));

      const result = readHarnessTranscript("opencode", sessionId, { homeDir: home2 });
      assert.equal(result.found, true);
      assert.equal(result.messages.length, 2);
      assert.equal(result.messages[0]?.index, 0);
      assert.ok(result.messages[0]?.text.includes("[REDACTED]"));
      assert.ok(!result.messages[0]?.text.includes("sk-abcdefghijklmnopqrst"));
      assert.equal(result.messages[1]?.text, "second question");
    });
  });

  describe("4. antigravity (antigravity-cli/brain + legacy root)", () => {
    const home = makeHome();
    const sessionId = "conv-abc-999";
    const transcript = path.join(
      home,
      ".gemini",
      "antigravity-cli",
      "brain",
      sessionId,
      ".system_generated",
      "logs",
      "transcript.jsonl"
    );
    writeJsonl(transcript, [
      JSON.stringify({ role: "user", content: "fix the bug" }),
      JSON.stringify({ role: "assistant", content: [{ type: "text", text: "done ghp_Abcdefghij0123456789" }] }),
    ]);

    test("locate + read from antigravity-cli brain root with redaction", () => {
      const loc = locateHarnessTranscript("antigravity", sessionId, { homeDir: home });
      assert.equal(loc.found, true);
      assert.ok(loc.transcriptPath && loc.transcriptPath.includes("antigravity-cli"));

      const result = readHarnessTranscript("antigravity", sessionId, { homeDir: home });
      assert.equal(result.found, true);
      assert.equal(result.messages.length, 2);
      assert.equal(result.messages[0]?.role, "user");
      assert.ok(result.messages[1]?.text.includes("[REDACTED]"));
      assert.ok(!result.messages[1]?.text.includes("ghp_Abcdefghij0123456789"));
    });

    test("legacy ~/.gemini/antigravity/brain root is discovered as fallback", () => {
      const home2 = makeHome();
      const legacy = path.join(home2, ".gemini", "antigravity", "brain", "conv-legacy-1");
      writeJsonl(path.join(legacy, ".system_generated", "logs", "transcript.jsonl"), [
        JSON.stringify({ role: "user", content: "legacy question" }),
      ]);
      const result = readHarnessTranscript("antigravity", "conv-legacy-1", { homeDir: home2 });
      assert.equal(result.found, true);
      assert.ok(result.transcriptPath && result.transcriptPath.includes("antigravity"));
      assert.equal(result.messages.length, 1);
      assert.equal(result.messages[0]?.text, "legacy question");
    });
  });

  describe("5. cursor (unsupported)", () => {
    test("returns found:false with error 'unsupported' without throwing", () => {
      const home = makeHome();
      const loc = locateHarnessTranscript("cursor", "any-session", { homeDir: home });
      assert.equal(loc.found, false);
      assert.equal(loc.error, "unsupported");

      const result = readHarnessTranscript("cursor", "any-session", { homeDir: home });
      assert.equal(result.found, false);
      assert.equal(result.error, "unsupported");
      assert.deepEqual(result.messages, []);
    });
  });

  describe("6. pagination, priority override and 20MB cap", () => {
    const home = makeHome();
    const sessionId = "sess-page-1";
    const transcript = path.join(home, ".claude", "projects", "proj", `${sessionId}.jsonl`);
    const lines: string[] = [];
    for (let i = 0; i < 10; i++) {
      lines.push(
        JSON.stringify({
          type: "user",
          message: { role: "user", content: `message-${i}` },
          timestamp: `2025-01-01T00:00:${String(i).padStart(2, "0")}Z`,
        })
      );
    }
    writeJsonl(transcript, lines);

    test("latest window: default limit returns tail messages", () => {
      const result = readHarnessTranscript("claude-code", sessionId, { homeDir: home, limit: 4 });
      assert.equal(result.found, true);
      assert.deepEqual(
        result.messages.map((m) => m.text),
        ["message-6", "message-7", "message-8", "message-9"]
      );
      assert.equal(result.hasMore, true);
    });

    test("before pagination walks backward via message indexes", () => {
      const page1 = readHarnessTranscript("claude-code", sessionId, { homeDir: home, limit: 4 });
      const page2 = readHarnessTranscript("claude-code", sessionId, {
        homeDir: home,
        limit: 4,
        before: page1.messages[0]?.index,
      });
      assert.deepEqual(
        page2.messages.map((m) => m.text),
        ["message-2", "message-3", "message-4", "message-5"]
      );
      assert.equal(page2.hasMore, true);
      const page3 = readHarnessTranscript("claude-code", sessionId, {
        homeDir: home,
        limit: 4,
        before: page2.messages[0]?.index,
      });
      assert.deepEqual(
        page3.messages.map((m) => m.text),
        ["message-0", "message-1"]
      );
      assert.equal(page3.hasMore, false);
    });

    test("transcriptPath option bypasses locator entirely", () => {
      const codexThread = "0199xyz-priority";
      const codexFile = path.join(
        home,
        ".codex",
        "sessions",
        "rollout-override",
        `rollout-x-${codexThread}.jsonl`
      );
      writeJsonl(codexFile, [
        JSON.stringify({
          type: "response_item",
          payload: { type: "message", role: "user", content: [{ type: "input_text", text: "priority read" }] },
        }),
      ]);
      const result = readHarnessTranscript("claude-code", sessionId, {
        homeDir: home,
        transcriptPath: codexFile,
      });
      assert.equal(result.found, true);
      assert.equal(result.messages.length, 1);
      assert.equal(result.messages[0]?.text, "priority read");
    });

    test("maxReadBytes cap truncates huge files while keeping stable indexes", () => {
      const bigSid = "sess-big-file";
      const bigFile = path.join(home, ".claude", "projects", "proj", `${bigSid}.jsonl`);
      const bigLines: string[] = [];
      for (let i = 0; i < 200; i++) {
        bigLines.push(
          JSON.stringify({ type: "user", message: { role: "user", content: `big-${i}` } })
        );
      }
      writeJsonl(bigFile, bigLines);

      const result = readHarnessTranscript("claude-code", bigSid, {
        homeDir: home,
        limit: 3,
        maxReadBytes: 512,
      });
      assert.equal(result.found, true);
      assert.equal(result.truncated, true);
      // Tail window: last complete lines inside the cap, correct absolute indexes.
      assert.equal(result.messages.length, 3);
      assert.deepEqual(
        result.messages.map((m) => m.index),
        [197, 198, 199]
      );
      assert.equal(result.messages[2]?.text, "big-199");
    });

    test("empty home and corrupt db never throw", () => {
      const emptyHome = makeHome();
      const result = readHarnessTranscript("opencode", "ghost", { homeDir: emptyHome });
      assert.equal(result.found, false);
      assert.ok(result.error);

      const dbPath = path.join(emptyHome, ".local", "share", "opencode", "opencode.db");
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      fs.writeFileSync(dbPath, "this is not a sqlite database at all", "utf8");
      const corrupt = readHarnessTranscript("opencode", "ghost", { homeDir: emptyHome });
      assert.equal(corrupt.found, false);
      assert.ok(corrupt.error);
    });
  });
});
