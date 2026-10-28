/**
 * Tests for src/core/policy.ts — security boundary enforcement,
 * case-normalized protected paths, 1ms zero-DB PreToolUse guard,
 * Subagent Shield, and main session 3-strike circuit breaker.
 */

import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  resolveSafeTargetPath,
  checkProtectedPath,
  isProtectedPath,
  matchGlobOrPrefix,
  isPathAllowed,
  evaluatePreToolUse,
  evaluateStopHook,
  verifyChangedFilesBoundary,
  DEFAULT_HARNESS_TOOL_MANIFEST,
} from "../src/core/policy.ts";
import { SqliteDriver } from "../src/core/db.ts";
import type { SubagentSessionMeta } from "../src/core/types.ts";

const tmpDirs: string[] = [];

function makeTmpDir(prefix = "asd-policy-test-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tmpDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  }
});

// ============================================================================
// 1. Ancestor-Safe Path Resolution Tests
// ============================================================================

describe("resolveSafeTargetPath", () => {
  test("allows nested non-existent directory (a/b/c.ts) inside rootDir", () => {
    const rootDir = makeTmpDir();
    const result = resolveSafeTargetPath("a/b/c.ts", rootDir);
    assert.equal(result.safe, true);
    assert.ok(result.resolvedPath.endsWith(path.join("a", "b", "c.ts")));
  });

  test("allows deep non-existent path (src/components/button/button.tsx)", () => {
    const rootDir = makeTmpDir();
    const result = resolveSafeTargetPath("src/components/button/button.tsx", rootDir);
    assert.equal(result.safe, true);
  });

  test("blocks relative path escaping rootDir (../outside.ts)", () => {
    const rootDir = makeTmpDir();
    const result = resolveSafeTargetPath("../outside.ts", rootDir);
    assert.equal(result.safe, false);
    assert.match(result.reason ?? "", /escapes root directory/);
  });

  test("blocks multiple parent traversal (a/../../outside.ts)", () => {
    const rootDir = makeTmpDir();
    const result = resolveSafeTargetPath("a/../../outside.ts", rootDir);
    assert.equal(result.safe, false);
  });

  test("blocks absolute path outside rootDir", () => {
    const rootDir = makeTmpDir();
    const outside = makeTmpDir("asd-outside-");
    const result = resolveSafeTargetPath(path.join(outside, "leak.ts"), rootDir);
    assert.equal(result.safe, false);
  });

  test("blocks null bytes in target path", () => {
    const rootDir = makeTmpDir();
    const result = resolveSafeTargetPath("a/b\0/c.ts", rootDir);
    assert.equal(result.safe, false);
    assert.match(result.reason ?? "", /null byte/);
  });

  test("does not false-positive on sibling directories with prefix overlap", () => {
    const base = makeTmpDir("asd-base-");
    const rootDir = path.join(base, "project");
    fs.mkdirSync(rootDir);
    const siblingDir = path.join(base, "project-fake");
    fs.mkdirSync(siblingDir);

    const outsidePath = path.join(siblingDir, "exploit.ts");
    const result = resolveSafeTargetPath(outsidePath, rootDir);
    assert.equal(result.safe, false);
  });
});

// ============================================================================
// 2. Case-Normalized Protected Paths & Secret Checks
// ============================================================================

describe("checkProtectedPath (case-normalized)", () => {
  test("100% blocks case-variant .git paths (.GIT/config, .Git/HEAD, .git\\config)", () => {
    assert.equal(checkProtectedPath(".git/config").protected, true);
    assert.equal(checkProtectedPath(".GIT/config").protected, true);
    assert.equal(checkProtectedPath(".Git/HEAD").protected, true);
    assert.equal(checkProtectedPath(".git\\config").protected, true);
    assert.equal(checkProtectedPath("sub/.git/hooks/pre-commit").protected, true);
    assert.equal(checkProtectedPath("sub/.GIT/HEAD").protected, true);
  });

  test("100% blocks case-variant .asd paths (.Asd/meta.json, .ASD/PLAN.md)", () => {
    assert.equal(checkProtectedPath(".asd/meta.json").protected, true);
    assert.equal(checkProtectedPath(".Asd/meta.json").protected, true);
    assert.equal(checkProtectedPath(".ASD/PLAN.md").protected, true);
    assert.equal(checkProtectedPath(".asd\\wt\\task1\\code.ts").protected, true);
  });

  test("100% blocks case-variant .env files (.ENV, .env.local, .Env.production)", () => {
    assert.equal(checkProtectedPath(".env").protected, true);
    assert.equal(checkProtectedPath(".ENV").protected, true);
    assert.equal(checkProtectedPath(".env.local").protected, true);
    assert.equal(checkProtectedPath(".Env.production").protected, true);
    assert.equal(checkProtectedPath("config/.env.test").protected, true);
    assert.equal(checkProtectedPath("sub/.ENV").protected, true);
  });

  test("100% blocks secret key & certificate files (*.pem, *.key, id_rsa)", () => {
    assert.equal(checkProtectedPath("server.pem").protected, true);
    assert.equal(checkProtectedPath("certs/server.PEM").protected, true);
    assert.equal(checkProtectedPath("client.key").protected, true);
    assert.equal(checkProtectedPath("ssl/APP.KEY").protected, true);
    assert.equal(checkProtectedPath("id_rsa").protected, true);
    assert.equal(checkProtectedPath("id_rsa.pub").protected, true);
    assert.equal(checkProtectedPath(".ssh/ID_RSA").protected, true);
    assert.equal(checkProtectedPath(".ssh/id_ed25519").protected, true);
  });

  test("allows normal safe source files", () => {
    assert.equal(checkProtectedPath("src/index.ts").protected, false);
    assert.equal(checkProtectedPath("src/a/b/c.ts").protected, false);
    assert.equal(checkProtectedPath("package.json").protected, false);
    assert.equal(checkProtectedPath("README.md").protected, false);
    assert.equal(checkProtectedPath("src/components/Environments.tsx").protected, false);
  });
});

// ============================================================================
// 3. Glob & Prefix Matcher (allowedFiles)
// ============================================================================

describe("matchGlobOrPrefix & isPathAllowed", () => {
  test("matches directory prefix with trailing slash (src/)", () => {
    assert.equal(matchGlobOrPrefix("src/a/b/c.ts", "src/"), true);
    assert.equal(matchGlobOrPrefix("tests/a.test.ts", "src/"), false);
  });

  test("matches directory without trailing slash (src)", () => {
    assert.equal(matchGlobOrPrefix("src/a/b/c.ts", "src"), true);
    assert.equal(matchGlobOrPrefix("src", "src"), true);
  });

  test("matches exact file pattern", () => {
    assert.equal(matchGlobOrPrefix("src/widget.ts", "src/widget.ts"), true);
    assert.equal(matchGlobOrPrefix("src/other.ts", "src/widget.ts"), false);
  });

  test("matches wildcards (* and **)", () => {
    assert.equal(matchGlobOrPrefix("src/a/b/c.ts", "src/**"), true);
    assert.equal(matchGlobOrPrefix("src/widget.ts", "src/*.ts"), true);
    assert.equal(matchGlobOrPrefix("src/nested/widget.ts", "src/*.ts"), false);
    assert.equal(matchGlobOrPrefix("src/nested/widget.ts", "**/*.ts"), true);
    assert.equal(matchGlobOrPrefix("root.ts", "**/*.ts"), true);
  });

  test("is case-normalized across patterns and targets", () => {
    assert.equal(matchGlobOrPrefix("SRC/a/b/c.ts", "src/"), true);
    assert.equal(matchGlobOrPrefix("src/a/b/c.ts", "SRC/"), true);
  });

  test("isPathAllowed tests multiple patterns", () => {
    const allowed = ["src/", "tests/*.test.ts"];
    assert.equal(isPathAllowed("src/app.ts", allowed), true);
    assert.equal(isPathAllowed("tests/app.test.ts", allowed), true);
    assert.equal(isPathAllowed("docs/readme.md", allowed), false);
    assert.equal(isPathAllowed("src/app.ts", []), false);
  });
});

// ============================================================================
// 4. evaluatePreToolUse Guard Tests
// ============================================================================

describe("evaluatePreToolUse", () => {
  test("happy: allows nested src/a/b/c.ts when src/ is in allowedFiles", () => {
    const rootDir = makeTmpDir();
    const metaPath = path.join(rootDir, "meta.json");
    const meta: SubagentSessionMeta = {
      subSessionId: "sub-1-T1.1-worker-oc",
      parentSessionId: "main-session",
      roleType: "subagent",
      role: "worker",
      harness: "opencode",
      model: "glm-5",
      taskId: "T1.1",
      pid: process.pid,
      worktreePath: rootDir,
      allowedFiles: ["src/"],
      status: "running",
    };
    fs.writeFileSync(metaPath, JSON.stringify(meta));

    const payload = {
      harness: "opencode",
      tool: "write",
      filePath: "src/a/b/c.ts",
    };

    const env = {
      ASD_SESSION_ROLE: "subagent",
      ASD_SUBAGENT_META: metaPath,
    };

    const result = evaluatePreToolUse(payload, DEFAULT_HARNESS_TOOL_MANIFEST, env);
    assert.equal(result.allowed, true);
  });

  test("fail-closed: blocks when ASD_SESSION_ROLE is subagent but meta.json is missing or unreadable", () => {
    const payload = {
      harness: "opencode",
      tool: "write",
      filePath: "src/a/b/c.ts",
    };

    // Missing ASD_SUBAGENT_META env
    const result1 = evaluatePreToolUse(payload, DEFAULT_HARNESS_TOOL_MANIFEST, {
      ASD_SESSION_ROLE: "subagent",
    });
    assert.equal(result1.allowed, false);
    assert.match(result1.reason ?? "", /Fail-closed/);

    // Unreadable / non-existent ASD_SUBAGENT_META file
    const result2 = evaluatePreToolUse(payload, DEFAULT_HARNESS_TOOL_MANIFEST, {
      ASD_SESSION_ROLE: "subagent",
      ASD_SUBAGENT_META: "C:/non/existent/meta.json",
    });
    assert.equal(result2.allowed, false);
    assert.match(result2.reason ?? "", /Fail-closed/);
  });

  test("failure: 100% blocks .GIT/config, .Asd/meta.json, .ENV, and ../outside.ts via evaluatePreToolUse", () => {
    const rootDir = makeTmpDir();
    const metaPath = path.join(rootDir, "meta.json");
    const meta: SubagentSessionMeta = {
      subSessionId: "sub-1-T1.1-worker-oc",
      parentSessionId: "main-session",
      roleType: "subagent",
      role: "worker",
      harness: "opencode",
      model: "glm-5",
      taskId: "T1.1",
      pid: process.pid,
      worktreePath: rootDir,
      allowedFiles: ["*"],
      status: "running",
    };
    fs.writeFileSync(metaPath, JSON.stringify(meta));

    const env = {
      ASD_SESSION_ROLE: "subagent",
      ASD_SUBAGENT_META: metaPath,
    };

    // 1. .GIT/config
    const resGit = evaluatePreToolUse(
      { tool: "write", filePath: ".GIT/config" },
      DEFAULT_HARNESS_TOOL_MANIFEST,
      env
    );
    assert.equal(resGit.allowed, false);
    assert.match(resGit.reason ?? "", /protected/i);

    // 2. .Asd/meta.json
    const resAsd = evaluatePreToolUse(
      { tool: "write", filePath: ".Asd/meta.json" },
      DEFAULT_HARNESS_TOOL_MANIFEST,
      env
    );
    assert.equal(resAsd.allowed, false);
    assert.match(resAsd.reason ?? "", /protected/i);

    // 3. .ENV
    const resEnv = evaluatePreToolUse(
      { tool: "write", filePath: ".ENV" },
      DEFAULT_HARNESS_TOOL_MANIFEST,
      env
    );
    assert.equal(resEnv.allowed, false);
    assert.match(resEnv.reason ?? "", /protected/i);

    // 4. ../outside.ts
    const resOutside = evaluatePreToolUse(
      { tool: "write", filePath: "../outside.ts" },
      DEFAULT_HARNESS_TOOL_MANIFEST,
      env
    );
    assert.equal(resOutside.allowed, false);
    assert.match(resOutside.reason ?? "", /escapes root/i);
  });

  test("blocks writes outside subagent allowedFiles boundary", () => {
    const rootDir = makeTmpDir();
    const metaPath = path.join(rootDir, "meta.json");
    const meta: SubagentSessionMeta = {
      subSessionId: "sub-1",
      parentSessionId: "main",
      roleType: "subagent",
      role: "worker",
      harness: "claude-code",
      model: "sonnet",
      taskId: "T1",
      pid: process.pid,
      worktreePath: rootDir,
      allowedFiles: ["src/allowed.ts"],
      status: "running",
    };
    fs.writeFileSync(metaPath, JSON.stringify(meta));

    const env = {
      ASD_SESSION_ROLE: "subagent",
      ASD_SUBAGENT_META: metaPath,
    };

    const res = evaluatePreToolUse(
      {
        harness: "claude-code",
        tool_name: "Write",
        tool_input: { file_path: "src/forbidden.ts" },
      },
      DEFAULT_HARNESS_TOOL_MANIFEST,
      env
    );
    assert.equal(res.allowed, false);
    assert.match(res.reason ?? "", /outside allowedFiles boundary/);
  });

  test("extracts file paths across all 4 harnesses", () => {
    const rootDir = makeTmpDir();
    const metaPath = path.join(rootDir, "meta.json");
    const meta: SubagentSessionMeta = {
      subSessionId: "sub-1",
      parentSessionId: "main",
      roleType: "subagent",
      role: "worker",
      harness: "antigravity",
      model: "gemini",
      taskId: "T1",
      pid: process.pid,
      worktreePath: rootDir,
      allowedFiles: ["src/"],
      status: "running",
    };
    fs.writeFileSync(metaPath, JSON.stringify(meta));
    const env = { ASD_SESSION_ROLE: "subagent", ASD_SUBAGENT_META: metaPath };

    // Claude Code
    const rCc = evaluatePreToolUse(
      { tool_name: "Edit", tool_input: { file_path: "src/a.ts" } },
      DEFAULT_HARNESS_TOOL_MANIFEST,
      env
    );
    assert.equal(rCc.allowed, true);

    // OpenCode
    const rOc = evaluatePreToolUse(
      { tool: "edit", filePath: "src/b.ts" },
      DEFAULT_HARNESS_TOOL_MANIFEST,
      env
    );
    assert.equal(rOc.allowed, true);

    // Codex
    const rCx = evaluatePreToolUse(
      { tool: "apply_patch", path: "src/c.ts" },
      DEFAULT_HARNESS_TOOL_MANIFEST,
      env
    );
    assert.equal(rCx.allowed, true);

    // Antigravity
    const rAg = evaluatePreToolUse(
      { tool_name: "write_file", tool_input: { TargetFile: "src/d.ts" } },
      DEFAULT_HARNESS_TOOL_MANIFEST,
      env
    );
    assert.equal(rAg.allowed, true);
  });

  test("main session allows normal file modifications while protecting .git", () => {
    const rootDir = makeTmpDir();
    const env = { ASD_PROJECT_ROOT: rootDir };

    // Normal file write: allowed
    const r1 = evaluatePreToolUse(
      { tool_name: "Write", tool_input: { file_path: "src/index.ts" }, projectRoot: rootDir },
      DEFAULT_HARNESS_TOOL_MANIFEST,
      env
    );
    assert.equal(r1.allowed, true);

    // .git write: blocked even for main session
    const r2 = evaluatePreToolUse(
      { tool_name: "Write", tool_input: { file_path: ".git/config" }, projectRoot: rootDir },
      DEFAULT_HARNESS_TOOL_MANIFEST,
      env
    );
    assert.equal(r2.allowed, false);
  });

  test("inspects BashTools: blocks destructive and redirection writes for subagent", () => {
    const rootDir = makeTmpDir();
    const metaPath = path.join(rootDir, "meta.json");
    const meta: SubagentSessionMeta = {
      subSessionId: "sub-1",
      parentSessionId: "main",
      roleType: "subagent",
      role: "worker",
      harness: "opencode",
      model: "glm-5",
      taskId: "T1",
      pid: process.pid,
      worktreePath: rootDir,
      allowedFiles: ["src/"],
      status: "running",
    };
    fs.writeFileSync(metaPath, JSON.stringify(meta));
    const env = { ASD_SESSION_ROLE: "subagent", ASD_SUBAGENT_META: metaPath };

    // Harmless bash command: allowed
    const rSafe = evaluatePreToolUse(
      { tool: "bash", command: "git status" },
      DEFAULT_HARNESS_TOOL_MANIFEST,
      env
    );
    assert.equal(rSafe.allowed, true);

    // Redirection write (>): blocked
    const rRedir = evaluatePreToolUse(
      { tool: "bash", command: "echo hacked > evil.txt" },
      DEFAULT_HARNESS_TOOL_MANIFEST,
      env
    );
    assert.equal(rRedir.allowed, false);
    assert.match(rRedir.reason ?? "", /redirection/i);

    // Append redirection (>>): blocked
    const rAppend = evaluatePreToolUse(
      { tool: "bash", command: "cat file >> evil.txt" },
      DEFAULT_HARNESS_TOOL_MANIFEST,
      env
    );
    assert.equal(rAppend.allowed, false);

    // Destructive command (rm): blocked
    const rRm = evaluatePreToolUse(
      { tool: "bash", command: "rm -rf src/old" },
      DEFAULT_HARNESS_TOOL_MANIFEST,
      env
    );
    assert.equal(rRm.allowed, false);
    assert.match(rRm.reason ?? "", /destructive/i);

    // Bash touching .git/: blocked
    const rGit = evaluatePreToolUse(
      { tool: "bash", command: "cat .git/config" },
      DEFAULT_HARNESS_TOOL_MANIFEST,
      env
    );
    assert.equal(rGit.allowed, false);

    // Bash touching .asd/: blocked
    const rAsd = evaluatePreToolUse(
      { tool: "bash", command: "cat .asd/meta.json" },
      DEFAULT_HARNESS_TOOL_MANIFEST,
      env
    );
    assert.equal(rAsd.allowed, false);

    // Bash touching .env: blocked
    const rEnv = evaluatePreToolUse(
      { tool: "bash", command: "cat .env" },
      DEFAULT_HARNESS_TOOL_MANIFEST,
      env
    );
    assert.equal(rEnv.allowed, false);
  });
});

// ============================================================================
// 5. evaluateStopHook & Subagent Shield Tests
// ============================================================================

describe("evaluateStopHook", () => {
  test("Subagent Shield: immediately returns allow without touching DB when ASD_SESSION_ROLE is subagent", () => {
    const res = evaluateStopHook(
      { sessionId: "sub-session" },
      { ASD_SESSION_ROLE: "subagent" }
    );
    assert.equal(res.decision, "allow");
  });

  test("Subagent Shield: immediately returns allow when roleType is subagent", () => {
    const res = evaluateStopHook({ sessionId: "sub-1", roleType: "subagent" });
    assert.equal(res.decision, "allow");
  });

  test("Subagent Shield: immediately returns allow when meta.json has roleType === 'subagent'", () => {
    const rootDir = makeTmpDir();
    const metaPath = path.join(rootDir, "meta.json");
    fs.writeFileSync(metaPath, JSON.stringify({ roleType: "subagent" }));

    const res = evaluateStopHook(
      { sessionId: "sub-1" },
      { ASD_SUBAGENT_META: metaPath }
    );
    assert.equal(res.decision, "allow");
  });

  test("main session: allows when all tasks completed or phase is done", () => {
    const tmpDir = makeTmpDir();
    const dbPath = path.join(tmpDir, "test.db");
    const driver = new SqliteDriver(dbPath);

    driver.createOrGetSession({
      sessionId: "main-done",
      projectRoot: tmpDir,
      mainHarness: "claude-code",
    });
    driver.updateSessionPhase("main-done", "done");

    const res = evaluateStopHook({ sessionId: "main-done" }, {}, driver);
    assert.equal(res.decision, "allow");
    driver.close();
  });

  test("main session: 3-strike circuit breaker blocks 3 times then allows on 4th", () => {
    const tmpDir = makeTmpDir();
    const dbPath = path.join(tmpDir, "test.db");
    const driver = new SqliteDriver(dbPath);

    driver.createOrGetSession({
      sessionId: "main-pending",
      projectRoot: tmpDir,
      mainHarness: "claude-code",
    });

    driver.upsertTasks("main-pending", [
      {
        taskId: "T1.1",
        turn: 1,
        title: "Work on feature",
        track: "LIGHT",
        role: "worker",
      },
    ]);

    // Strike 1 (count goes 0 -> 1): block
    const res1 = evaluateStopHook({ sessionId: "main-pending" }, {}, driver);
    assert.equal(res1.decision, "block");
    assert.match(res1.reason ?? "", /Attempt 1\/3/);

    // Strike 2 (count goes 1 -> 2): block
    const res2 = evaluateStopHook({ sessionId: "main-pending" }, {}, driver);
    assert.equal(res2.decision, "block");
    assert.match(res2.reason ?? "", /Attempt 2\/3/);

    // Strike 3 (count goes 2 -> 3): block
    const res3 = evaluateStopHook({ sessionId: "main-pending" }, {}, driver);
    assert.equal(res3.decision, "block");
    assert.match(res3.reason ?? "", /Attempt 3\/3/);

    // Strike 4 (count is 3 >= 3): circuit breaker trips -> allow
    const res4 = evaluateStopHook({ sessionId: "main-pending" }, {}, driver);
    assert.equal(res4.decision, "allow");
    assert.equal(res4.circuitBreakerTripped, true);
    assert.match(res4.reason ?? "", /Circuit breaker tripped/);

    driver.close();
  });
});

// ============================================================================
// 6. verifyChangedFilesBoundary Tests
// ============================================================================

describe("verifyChangedFilesBoundary", () => {
  test("returns valid: true when all changed files are within allowedFiles and safe", () => {
    const rootDir = makeTmpDir();
    const changed = ["src/a/b/c.ts", "src/components/button.tsx"];
    const allowed = ["src/"];

    const res = verifyChangedFilesBoundary(changed, allowed, rootDir);
    assert.equal(res.valid, true);
    assert.equal(res.violations.length, 0);
  });

  test("captures violations for case-variant protected files (.GIT/config, .Asd/meta.json, .ENV)", () => {
    const rootDir = makeTmpDir();
    const changed = [
      "src/safe.ts",
      ".GIT/config",
      ".Asd/meta.json",
      ".ENV",
      "certs/key.pem",
    ];
    const allowed = ["*"];

    const res = verifyChangedFilesBoundary(changed, allowed, rootDir);
    assert.equal(res.valid, false);
    assert.equal(res.violations.length, 4);
    assert.ok(res.violations.some((v) => v.includes(".GIT/config")));
    assert.ok(res.violations.some((v) => v.includes(".Asd/meta.json")));
    assert.ok(res.violations.some((v) => v.includes(".ENV")));
    assert.ok(res.violations.some((v) => v.includes("certs/key.pem")));
  });

  test("captures violations for escaping rootDir and outside allowedFiles", () => {
    const rootDir = makeTmpDir();
    const changed = ["../outside.ts", "other/file.ts"];
    const allowed = ["src/"];

    const res = verifyChangedFilesBoundary(changed, allowed, rootDir);
    assert.equal(res.valid, false);
    assert.equal(res.violations.length, 2);
    assert.ok(res.violations.some((v) => v.includes("escapes rootDir")));
    assert.ok(res.violations.some((v) => v.includes("outside allowedFiles")));
  });
});


describe("Bash .git and .asd boundary regex (P0 Issue 6b)", () => {
  test("blocks bare 'rm -rf .git' and 'rm -rf .asd' while allowing 'git clone https://.../repo.git'", () => {
    const rootDir = makeTmpDir();
    const metaPath = path.join(rootDir, "meta.json");
    fs.writeFileSync(
      metaPath,
      JSON.stringify({
        roleType: "subagent",
        allowedFiles: ["src/"],
        worktreePath: rootDir,
      })
    );
    const env = {
      ASD_SESSION_ROLE: "subagent",
      ASD_SUBAGENT_META: metaPath,
      ASD_PROJECT_ROOT: rootDir,
    };

    const bareGit = evaluatePreToolUse(
      { tool: "bash", command: "ls .git" },
      DEFAULT_HARNESS_TOOL_MANIFEST,
      env
    );
    assert.equal(bareGit.allowed, false);
    assert.match(bareGit.reason ?? "", /protected \.git/i);

    const bareAsd = evaluatePreToolUse(
      { tool: "bash", command: "ls .asd" },
      DEFAULT_HARNESS_TOOL_MANIFEST,
      env
    );
    assert.equal(bareAsd.allowed, false);
    assert.match(bareAsd.reason ?? "", /protected \.asd/i);

    const gitCloneUrl = evaluatePreToolUse(
      { tool: "bash", command: "git clone https://github.com/example/repo.git" },
      DEFAULT_HARNESS_TOOL_MANIFEST,
      {}
    );
    assert.equal(gitCloneUrl.allowed, true);
  });
});
