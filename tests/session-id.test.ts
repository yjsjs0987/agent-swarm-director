/**
 * Tests for CR-15 & CR-17.4 (T1.1):
 * - generateAsdSessionId / isValidAsdSessionId (session-tracker.ts surface)
 * - INVALID_SESSION_ID guards in createOrGetSession / handlePlan / spawnSubagent
 * - getAdapter moved to src/adapters/registry.ts and re-exported by src/cli/index.ts
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  generateAsdSessionId,
  isValidAsdSessionId,
} from "../src/core/session-tracker.ts";
import { SqliteDriver } from "../src/core/db.ts";
import { spawnSubagent } from "../src/core/spawner.ts";
import { AsdMcpServer } from "../src/mcp/server.ts";
import { getAdapter as getAdapterFromRegistry } from "../src/adapters/registry.ts";
import { getAdapter as getAdapterFromCli } from "../src/cli/index.ts";
import {
  antigravityAdapter,
  claudeCodeAdapter,
  codexAdapter,
  cursorAdapter,
  opencodeAdapter,
} from "../src/index.ts";

const tmpDirs: string[] = [];
const openServers: AsdMcpServer[] = [];
const openDrivers: SqliteDriver[] = [];

after(() => {
  for (const drv of openDrivers) {
    try {
      drv.close();
    } catch {
      // already closed
    }
  }
  openDrivers.length = 0;
  for (const srv of openServers) {
    try {
      srv.close();
    } catch {
      // already closed
    }
  }
  openServers.length = 0;
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs.length = 0;
});

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function makeDriver(): SqliteDriver {
  const dir = tempDir("asd-sessid-db-");
  const drv = new SqliteDriver(path.join(dir, "core.db"));
  openDrivers.push(drv);
  return drv;
}

// ============================================================================
// isValidAsdSessionId
// ============================================================================

test("isValidAsdSessionId rejects path-unsafe and malformed IDs", () => {
  assert.equal(isValidAsdSessionId("../x"), false);
  assert.equal(isValidAsdSessionId("a/b"), false);
  assert.equal(isValidAsdSessionId(".."), false);
  assert.equal(isValidAsdSessionId("."), false);
  assert.equal(isValidAsdSessionId(""), false);
  assert.equal(isValidAsdSessionId("a".repeat(65)), false);
  assert.equal(isValidAsdSessionId("a b"), false);
  assert.equal(isValidAsdSessionId("a\nb"), false);
});

test("isValidAsdSessionId accepts safe IDs including boundary lengths", () => {
  assert.equal(isValidAsdSessionId("a"), true);
  assert.equal(isValidAsdSessionId("main-1"), true);
  assert.equal(isValidAsdSessionId("20261101-asd-main"), true);
  assert.equal(isValidAsdSessionId("a.b-c_d"), true);
  assert.equal(isValidAsdSessionId("Z9"), true);
  assert.equal(isValidAsdSessionId("a".repeat(64)), true);
});

// ============================================================================
// generateAsdSessionId
// ============================================================================

test("generateAsdSessionId produces asd-YYYYMMDD-HHmmss-<4 [a-z0-9]> in local time", () => {
  // Local-time constructor: Nov 1 2026, 14:30:05 local
  const id = generateAsdSessionId(new Date(2026, 10, 1, 14, 30, 5));
  assert.match(id, /^asd-\d{8}-\d{6}-[a-z0-9]{4}$/);
  assert.ok(id.startsWith("asd-20261101-143005-"));
  assert.equal(isValidAsdSessionId(id), true);
});

test("generateAsdSessionId: 1000 same-second calls produce 0 collisions", () => {
  const fixedNow = new Date(2026, 10, 1, 9, 0, 0);
  const seen = new Set<string>();
  for (let i = 0; i < 1000; i++) {
    seen.add(generateAsdSessionId(fixedNow));
  }
  assert.equal(seen.size, 1000);
});

// ============================================================================
// INVALID_SESSION_ID guards
// ============================================================================

test("createOrGetSession throws INVALID_SESSION_ID on invalid sessionId and still reads valid rows", () => {
  const drv = makeDriver();
  for (const bad of ["../x", "a/b", "..", "", "a".repeat(65)]) {
    assert.throws(
      () =>
        drv.createOrGetSession({
          sessionId: bad,
          projectRoot: "C:\\Proj",
          mainHarness: "opencode",
        }),
      (err: Error) => err.message === "INVALID_SESSION_ID"
    );
  }

  const row = drv.createOrGetSession({
    sessionId: "valid-sess-1",
    projectRoot: "C:\\Proj",
    mainHarness: "opencode",
  });
  assert.equal(row.session_id, "valid-sess-1");
  // Existing valid DB row remains readable
  assert.equal(drv.getSession("valid-sess-1")?.session_id, "valid-sess-1");
});

test("handlePlan throws INVALID_SESSION_ID on invalid explicit sessionId", async () => {
  const projectRoot = tempDir("asd-sessid-plan-");
  const server = new AsdMcpServer({ projectRoot, autoSync: false });
  openServers.push(server);

  await assert.rejects(
    async () => {
      await server.handlePlan({
        action: "create",
        sessionId: "../escape",
        tasks: [],
      });
    },
    (err: Error) => err.message === "INVALID_SESSION_ID"
  );
  // No session directory escaped into .asd/sessions
  const sessionsDir = path.join(projectRoot, ".asd", "sessions");
  const entries = fs.existsSync(sessionsDir) ? fs.readdirSync(sessionsDir) : [];
  assert.equal(entries.length, 0, "invalid sessionId must not create directories");
});

test("handlePlan accepts a valid explicit sessionId", async () => {
  const projectRoot = tempDir("asd-sessid-plan-ok-");
  const server = new AsdMcpServer({ projectRoot, autoSync: false });
  openServers.push(server);

  const out = await server.handlePlan({
    action: "create",
    sessionId: "plan-ok-1",
    tasks: [],
  });
  assert.equal(out.sessionId, "plan-ok-1");
  assert.ok(fs.existsSync(path.join(projectRoot, ".asd", "sessions", "plan-ok-1", "main.json")));
});

test("spawnSubagent rejects INVALID_SESSION_ID without creating session directories", async () => {
  const projectRoot = tempDir("asd-sessid-spawn-");
  await assert.rejects(
    async () =>
      spawnSubagent({
        projectRoot,
        cwd: projectRoot,
        worktreePath: null,
        mainSessionId: "../escape",
        subSessionId: "sub-1",
        role: "worker",
        harness: "claude-code",
        model: "test-model",
        taskId: "T0.0",
        prompt: "noop",
        allowedFiles: [],
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
      }),
    (err: Error) => err.message === "INVALID_SESSION_ID"
  );
  const sessionsDir = path.join(projectRoot, ".asd", "sessions");
  const entries = fs.existsSync(sessionsDir) ? fs.readdirSync(sessionsDir) : [];
  assert.equal(entries.length, 0);
});

// ============================================================================
// getAdapter registry move (CR-17.4)
// ============================================================================

test("getAdapter is exported from adapters/registry.ts and re-exported by cli/index.ts", () => {
  assert.equal(typeof getAdapterFromRegistry, "function");
  assert.equal(typeof getAdapterFromCli, "function");
  assert.equal(getAdapterFromCli, getAdapterFromRegistry);
});

test("getAdapter maps each harness id to its adapter singleton", () => {
  assert.equal(getAdapterFromRegistry("claude-code"), claudeCodeAdapter);
  assert.equal(getAdapterFromRegistry("opencode"), opencodeAdapter);
  assert.equal(getAdapterFromRegistry("codex"), codexAdapter);
  assert.equal(getAdapterFromRegistry("antigravity"), antigravityAdapter);
  assert.equal(getAdapterFromRegistry("cursor"), cursorAdapter);
  assert.equal(getAdapterFromRegistry(undefined), claudeCodeAdapter);
  assert.equal(getAdapterFromRegistry("unknown"), claudeCodeAdapter);
});
