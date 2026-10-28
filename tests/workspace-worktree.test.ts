/**
 * Tests for src/core/workspace.ts:
 *
 * 1. Unborn HEAD safeguard & baseline prep (prepareBaseline)
 * 2. Dirty working tree auto-stash with SQLite session recording
 * 3. Changed files listing (Korean / non-ASCII paths, renames, .asd/ & node_modules exclusion)
 * 4. Verification command resolution (resolveVerifyCmd)
 * 5. Sequential LIGHT tasks:
 *    - T1.1 passes -> checkpoint commit created
 *    - T1.2 fails (out-of-scope boundary violation / failed verifyCmd) -> atomic rollback
 *    - Proves T1.1 committed files remain 100% intact!
 * 6. Concurrent HEAVY worktrees:
 *    - T1.1 and T1.2 run in parallel via Promise.all
 *    - node_modules junction connected & intact during tests
 *    - junction unlinked before git add -A
 *    - withMergeLock serializes merge into main without .git/index.lock collision
 *    - .asd/wt/* directories completely removed and no untracked pollution
 * 7. HEAVY track merge conflict:
 *    - Aborts merge, marks merge_conflict, preserves worktree for inspection
 * 8. HEAVY track smoke check failure:
 *    - Resets main branch to pre_merge_sha
 */

import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  prepareBaseline,
  getChangedFiles,
  resolveVerifyCmd,
  verifyAndCommitLightTask,
  rollbackLightChanges,
  createTaskWorktree,
  verifyAndMergeHeavyTask,
  cleanupWorktree,
  withMergeLock,
  AsyncMutex,
  runGit,
  ensureGitUserIdentity,
} from "../src/core/workspace.ts";
import { SqliteDriver } from "../src/core/db.ts";

const tmpDirs: string[] = [];
const openDbs: SqliteDriver[] = [];

function makeTmpDir(prefix = "asd-wt-test-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function initGitRepo(dir: string): void {
  runGit(["init"], { cwd: dir });
  ensureGitUserIdentity(dir);
}

after(() => {
  for (const db of openDbs) {
    try {
      db.close();
    } catch {
      // ignore
    }
  }

  for (const dir of tmpDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // Best-effort cleanup on Windows
    }
  }
});

// ============================================================================
// 1. Unborn HEAD & Baseline Prep
// ============================================================================

describe("prepareBaseline", () => {
  test("creates initial empty baseline commit on unborn HEAD and excludes .asd/", () => {
    const root = makeTmpDir("asd-unborn-");
    initGitRepo(root);

    // HEAD does not exist yet
    const headBefore = runGit(["rev-parse", "--verify", "HEAD"], { cwd: root });
    assert.notEqual(headBefore.exitCode, 0, "Repo should have no commits initially");

    const result = prepareBaseline(root);
    assert.ok(result.baseSha, "baseSha must be returned");
    assert.equal(result.stashedWorkSha, undefined, "Nothing should be stashed");

    // HEAD now exists with baseline commit
    const logRes = runGit(["log", "-1", "--format=%s"], { cwd: root });
    assert.equal(logRes.exitCode, 0);
    assert.equal(logRes.stdout.trim(), "asd(init): root baseline");

    // .git/info/exclude contains .asd/
    const excludeFile = path.join(root, ".git", "info", "exclude");
    assert.ok(fs.existsSync(excludeFile));
    const content = fs.readFileSync(excludeFile, "utf8");
    assert.ok(content.includes(".asd/"), "exclude must contain .asd/");
  });

  test("auto-stashes dirty working tree files and records stash SHA in SQLite", () => {
    const root = makeTmpDir("asd-stash-");
    initGitRepo(root);

    // Initial commit
    prepareBaseline(root);

    // Create user uncommitted files
    fs.writeFileSync(path.join(root, "dirty.txt"), "user work in progress", "utf8");
    assert.equal(getChangedFiles(root).length, 1);

    // Setup SQLite DB with a session
    const dbPath = path.join(root, ".asd", "state", "core.db");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new SqliteDriver(dbPath);
    openDbs.push(db);

    const sessionId = "test-session-stash-1";
    db.createOrGetSession({
      sessionId,
      projectRoot: root,
      mainHarness: "claude-code",
    });

    const result = prepareBaseline(root, { sessionId, db });

    // Working tree must now be clean
    const changedAfter = getChangedFiles(root);
    assert.equal(changedAfter.length, 0, "Working tree must be clean after auto-stash");

    // Stash SHA must be recorded in result and in DB
    assert.ok(result.stashedWorkSha, "stashedWorkSha must be returned");
    const sessionRow = db.getSession(sessionId);
    assert.ok(sessionRow);
    assert.equal(sessionRow.stashed_work_sha, result.stashedWorkSha);
  });
});

// ============================================================================
// 2. Changed Files Listing
// ============================================================================

describe("getChangedFiles", () => {
  test("handles non-ASCII/Korean names, renames, and ignores .asd/ and node_modules", () => {
    const root = makeTmpDir("asd-changed-");
    initGitRepo(root);
    prepareBaseline(root);

    // Create tracked and untracked files
    fs.writeFileSync(path.join(root, "normal.txt"), "hello", "utf8");
    fs.writeFileSync(path.join(root, "한글_파일.ts"), "const a = 1;", "utf8");

    // Create files inside .asd/ and node_modules (must be ignored)
    fs.mkdirSync(path.join(root, ".asd", "temp"), { recursive: true });
    fs.writeFileSync(path.join(root, ".asd", "temp", "ignored.txt"), "skip", "utf8");

    fs.mkdirSync(path.join(root, "node_modules", "some-pkg"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "node_modules", "some-pkg", "index.js"),
      "module.exports = {};",
      "utf8"
    );

    const changed = getChangedFiles(root);
    assert.ok(changed.includes("normal.txt"));
    assert.ok(
      changed.includes("한글_파일.ts"),
      "Korean filenames must not be octal-escaped"
    );
    assert.ok(!changed.some((f) => f.startsWith(".asd")));
    assert.ok(!changed.some((f) => f.startsWith("node_modules")));

    // Commit normal.txt, then test rename
    runGit(["add", "normal.txt"], { cwd: root });
    runGit(["commit", "-m", "add normal.txt", "--no-verify"], { cwd: root });
    runGit(["mv", "normal.txt", "renamed.txt"], { cwd: root });

    const changedAfterRename = getChangedFiles(root);
    assert.ok(
      changedAfterRename.includes("renamed.txt"),
      "Renamed file target must be listed"
    );
  });
});

// ============================================================================
// 3. Verification Command Resolution
// ============================================================================

describe("resolveVerifyCmd", () => {
  test("prioritizes explicit cmd -> package.json typecheck/test -> tsconfig.json -> null", () => {
    const root = makeTmpDir("asd-verifycmd-");

    // 1. Explicit override wins
    assert.equal(
      resolveVerifyCmd(root, "npm run custom-check"),
      "npm run custom-check"
    );

    // 2. package.json with typecheck
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ scripts: { typecheck: "tsc --noEmit", test: "node --test" } })
    );
    assert.equal(resolveVerifyCmd(root), "npm run typecheck");

    // 3. package.json with test only
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ scripts: { test: "node --test" } })
    );
    assert.equal(resolveVerifyCmd(root), "npm test");

    // 4. tsconfig.json only
    fs.unlinkSync(path.join(root, "package.json"));
    fs.writeFileSync(path.join(root, "tsconfig.json"), "{}");
    assert.equal(resolveVerifyCmd(root), "npx tsc --noEmit");

    // 5. neither exists -> null
    fs.unlinkSync(path.join(root, "tsconfig.json"));
    assert.equal(resolveVerifyCmd(root), null);
  });
});

// ============================================================================
// 4. Sequential LIGHT Tasks (Checkpoint Commit vs Rollback)
// ============================================================================

describe("LIGHT Track Lifecycle", () => {
  test("sequential T1.1 (pass -> checkpoint commit) followed by T1.2 (fail -> rollback) preserves T1.1", () => {
    const root = makeTmpDir("asd-light-");
    initGitRepo(root);
    prepareBaseline(root);

    // --- Task T1.1: Passes verification ---
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    const t1Path = path.join(root, "src", "t1.ts");
    fs.writeFileSync(t1Path, "export const t1 = 'checkpoint 1';", "utf8");

    const t1Result = verifyAndCommitLightTask({
      projectRoot: root,
      taskId: "T1.1",
      title: "create t1 module",
      allowedFiles: ["src/t1.ts"],
      verifyCmd: null,
    });

    assert.equal(t1Result.verified, true, "T1.1 must verify successfully");
    assert.ok(t1Result.commitSha, "T1.1 must return commitSha");
    assert.equal(t1Result.rollbackPerformed, false);

    // Verify commit in Git log
    const t1Log = runGit(["log", "-1", "--format=%s"], { cwd: root });
    assert.equal(t1Log.stdout.trim(), "asd(T1.1): create t1 module");
    assert.ok(fs.existsSync(t1Path), "t1.ts must exist on disk");

    // --- Task T1.2: Fails verification (out-of-scope boundary violation) ---
    // Modify an out-of-scope file
    const t2Path = path.join(root, "src", "t2.ts");
    const illegalPath = path.join(root, "outside.ts");
    fs.writeFileSync(t2Path, "export const t2 = 'uncommitted';", "utf8");
    fs.writeFileSync(illegalPath, "export const hack = true;", "utf8");

    const t2Result = verifyAndCommitLightTask({
      projectRoot: root,
      taskId: "T1.2",
      title: "illegal edit",
      allowedFiles: ["src/t2.ts"], // illegalPath not allowed!
    });

    assert.equal(t2Result.verified, false, "T1.2 must fail verification");
    assert.equal(t2Result.rollbackPerformed, true, "T1.2 must perform rollback");
    assert.ok(t2Result.violations && t2Result.violations.length > 0);

    // CRITICAL ASSERTION: T1.1 files remain 100% intact!
    assert.ok(fs.existsSync(t1Path), "T1.1 file must remain intact after T1.2 rollback");
    const t1Content = fs.readFileSync(t1Path, "utf8");
    assert.equal(t1Content, "export const t1 = 'checkpoint 1';");

    // T1.2 uncommitted edits must be completely rolled back
    assert.ok(!fs.existsSync(illegalPath), "Illegal file must be removed by rollback");
    assert.ok(!fs.existsSync(t2Path), "Failed task file must be removed by rollback");

    // Git HEAD still points to T1.1 checkpoint commit
    const headLog = runGit(["log", "-1", "--format=%s"], { cwd: root });
    assert.equal(headLog.stdout.trim(), "asd(T1.1): create t1 module");
  });

  test("LIGHT rollback catches leaked secret patterns and preserves prior commit", () => {
    const root = makeTmpDir("asd-secret-");
    initGitRepo(root);
    prepareBaseline(root);

    // Base commit
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "base.ts"), "export const ok = 1;", "utf8");
    verifyAndCommitLightTask({
      projectRoot: root,
      taskId: "T1.0",
      title: "base",
      allowedFiles: ["src/base.ts"],
    });

    // Write file with leaked AWS credential
    fs.writeFileSync(
      path.join(root, "src", "leak.ts"),
      "const awsKey = 'AKIAIOSFODNN7EXAMPLE';",
      "utf8"
    );

    const leakResult = verifyAndCommitLightTask({
      projectRoot: root,
      taskId: "T1.1",
      title: "leaky task",
      allowedFiles: ["src/leak.ts"],
    });

    assert.equal(leakResult.verified, false);
    assert.equal(leakResult.rollbackPerformed, true);
    assert.ok(!fs.existsSync(path.join(root, "src", "leak.ts")));
    assert.ok(fs.existsSync(path.join(root, "src", "base.ts")));
  });
});

// ============================================================================
// 5. AsyncMutex Concurrency Tests
// ============================================================================

describe("AsyncMutex", () => {
  test("serializes execution order and handles rejection cleanly", async () => {
    const mutex = new AsyncMutex();
    const order: number[] = [];

    const p1 = mutex.runExclusive(async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push(1);
      return 1;
    });

    const p2 = mutex.runExclusive(async () => {
      order.push(2);
      return 2;
    });

    const p3 = mutex.runExclusive(async () => {
      throw new Error("task 3 failed");
    });

    const p4 = mutex.runExclusive(async () => {
      order.push(4);
      return 4;
    });

    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(r1, 1);
    assert.equal(r2, 2);

    await assert.rejects(p3, /task 3 failed/);

    const r4 = await p4;
    assert.equal(r4, 4);

    assert.deepEqual(order, [1, 2, 4]);
  });
});

// ============================================================================
// 6. Concurrent HEAVY Worktrees (Parallel Promise.all)
// ============================================================================

describe("HEAVY Track Worktree Lifecycle", () => {
  test("2 concurrent HEAVY worktrees run in parallel via Promise.all with node_modules junction, unlinked before commit, merge cleanly into main", async () => {
    const root = makeTmpDir("asd-heavy-");
    initGitRepo(root);
    prepareBaseline(root);

    // Create a mock node_modules in projectRoot with a package
    const pkgDir = path.join(root, "node_modules", "mock-calc");
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, "index.js"),
      "module.exports = { multiply: (a, b) => a * b };\n",
      "utf8"
    );

    // Initial tracked source directory
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "index.ts"), "// main entry\n", "utf8");
    runGit(["add", "src/index.ts"], { cwd: root });
    runGit(["commit", "-m", "init src", "--no-verify"], { cwd: root });

    // 1. Create worktree 1 (T1.1)
    const wt1 = createTaskWorktree(root, 1, "T1.1");
    assert.ok(fs.existsSync(wt1.wtPath));
    assert.equal(wt1.hasNodeModulesJunction, true);
    // Verify junction can access mock-calc inside worktree 1
    const wt1Pkg = path.join(wt1.wtPath, "node_modules", "mock-calc", "index.js");
    assert.ok(fs.existsSync(wt1Pkg), "node_modules junction must be readable in wt1");

    // 2. Create worktree 2 (T1.2)
    const wt2 = createTaskWorktree(root, 1, "T1.2");
    assert.ok(fs.existsSync(wt2.wtPath));
    assert.equal(wt2.hasNodeModulesJunction, true);
    // Verify junction can access mock-calc inside worktree 2
    const wt2Pkg = path.join(wt2.wtPath, "node_modules", "mock-calc", "index.js");
    assert.ok(fs.existsSync(wt2Pkg), "node_modules junction must be readable in wt2");

    // Edit files in worktree 1 (requires mock-calc)
    fs.writeFileSync(
      path.join(wt1.wtPath, "src", "feature1.ts"),
      "const calc = require('mock-calc');\nconsole.log(calc.multiply(3, 4));\n",
      "utf8"
    );

    // Edit files in worktree 2 (independent feature, also requires mock-calc)
    fs.writeFileSync(
      path.join(wt2.wtPath, "src", "feature2.ts"),
      "const calc = require('mock-calc');\nconsole.log(calc.multiply(10, 5));\n",
      "utf8"
    );

    // Verify command that executes Node and requires mock-calc via node_modules
    const testCmd1 = `node -e "const calc = require('./node_modules/mock-calc'); if (calc.multiply(3,4) !== 12) process.exit(1);"`;
    const testCmd2 = `node -e "const calc = require('./node_modules/mock-calc'); if (calc.multiply(10,5) !== 50) process.exit(1);"`;

    // 3. Execute verifyAndMergeHeavyTask concurrently via Promise.all
    const [res1, res2] = await Promise.all([
      verifyAndMergeHeavyTask({
        projectRoot: root,
        turn: 1,
        taskId: "T1.1",
        title: "implement feature 1",
        wtPath: wt1.wtPath,
        branchName: wt1.branchName,
        allowedFiles: ["src/feature1.ts"],
        verifyCmd: testCmd1,
      }),
      verifyAndMergeHeavyTask({
        projectRoot: root,
        turn: 1,
        taskId: "T1.2",
        title: "implement feature 2",
        wtPath: wt2.wtPath,
        branchName: wt2.branchName,
        allowedFiles: ["src/feature2.ts"],
        verifyCmd: testCmd2,
      }),
    ]);

    // Both parallel tasks must pass and merge
    assert.equal(res1.verified, true, `T1.1 failed: ${res1.error}`);
    assert.equal(res1.status, "done");
    assert.ok(res1.commitSha);

    assert.equal(res2.verified, true, `T1.2 failed: ${res2.error}`);
    assert.equal(res2.status, "done");
    assert.ok(res2.commitSha);

    // 4. Verify main branch state
    // Both features exist in main branch
    assert.ok(
      fs.existsSync(path.join(root, "src", "feature1.ts")),
      "feature1.ts must exist in main"
    );
    assert.ok(
      fs.existsSync(path.join(root, "src", "feature2.ts")),
      "feature2.ts must exist in main"
    );

    // Untracked pollution: working tree must have no untracked files
    const changedInMain = getChangedFiles(root);
    assert.equal(
      changedInMain.length,
      0,
      `Main branch has unexpected untracked pollution: ${changedInMain.join(", ")}`
    );

    // node_modules was NOT committed into Git
    const gitLs = runGit(["ls-files", "node_modules"], { cwd: root });
    assert.equal(gitLs.stdout.trim(), "", "node_modules must not be tracked in git");

    // Root node_modules must remain intact
    assert.ok(fs.existsSync(pkgDir), "Root node_modules must not be damaged");

    // 5. Worktrees and temporary branches are completely removed
    assert.ok(
      !fs.existsSync(wt1.wtPath),
      `Worktree dir 1 must be removed: ${wt1.wtPath}`
    );
    assert.ok(
      !fs.existsSync(wt2.wtPath),
      `Worktree dir 2 must be removed: ${wt2.wtPath}`
    );

    // Check .asd/wt directory is clean
    const wtDir = path.join(root, ".asd", "wt");
    if (fs.existsSync(wtDir)) {
      const remainingWts = fs.readdirSync(wtDir);
      assert.equal(
        remainingWts.length,
        0,
        `.asd/wt must be empty, but found: ${remainingWts.join(", ")}`
      );
    }
  });

  test("HEAVY track handles merge conflicts: aborts merge, marks merge_conflict, preserves worktree", async () => {
    const root = makeTmpDir("asd-conflict-");
    initGitRepo(root);
    prepareBaseline(root);

    // Base file
    fs.writeFileSync(path.join(root, "conflict.txt"), "line original\n", "utf8");
    runGit(["add", "conflict.txt"], { cwd: root });
    runGit(["commit", "-m", "add conflict.txt", "--no-verify"], { cwd: root });

    // Worktree 1
    const wt1 = createTaskWorktree(root, 1, "T1.1");
    fs.writeFileSync(path.join(wt1.wtPath, "conflict.txt"), "line from T1.1\n", "utf8");

    // Worktree 2 (modifies same line differently)
    const wt2 = createTaskWorktree(root, 1, "T1.2");
    fs.writeFileSync(path.join(wt2.wtPath, "conflict.txt"), "line from T1.2\n", "utf8");

    // Merge wt1 first
    const res1 = await verifyAndMergeHeavyTask({
      projectRoot: root,
      turn: 1,
      taskId: "T1.1",
      title: "t1 edit",
      wtPath: wt1.wtPath,
      branchName: wt1.branchName,
      allowedFiles: ["conflict.txt"],
    });
    assert.equal(res1.verified, true);

    // Merge wt2 second -> Conflict!
    const res2 = await verifyAndMergeHeavyTask({
      projectRoot: root,
      turn: 1,
      taskId: "T1.2",
      title: "t2 edit",
      wtPath: wt2.wtPath,
      branchName: wt2.branchName,
      allowedFiles: ["conflict.txt"],
    });

    assert.equal(res2.verified, false);
    assert.equal(res2.status, "merge_conflict");
    assert.ok(res2.error?.includes("Merge conflict"));

    // Main working tree was aborted and clean
    const changed = getChangedFiles(root);
    assert.equal(changed.length, 0);

    // CRITICAL: Worktree 2 is PRESERVED for developer inspection
    assert.ok(
      fs.existsSync(wt2.wtPath),
      "Worktree 2 must be preserved when merge conflict occurs"
    );

    // Clean up preserved worktree manually for test hygiene
    cleanupWorktree(root, wt2.wtPath, wt2.branchName, { forceBranchDelete: true });
  });

  test("HEAVY track rolls back main branch if post-merge smoke check fails", async () => {
    const root = makeTmpDir("asd-smoke-");
    initGitRepo(root);
    prepareBaseline(root);

    const baseSha = runGit(["rev-parse", "HEAD"], { cwd: root }).stdout.trim();

    const wt = createTaskWorktree(root, 1, "T1.1");
    fs.writeFileSync(path.join(wt.wtPath, "good.txt"), "all good", "utf8");

    // Smoke check command exits with 1
    const smokeCmd = `node -e "process.exit(1)"`;

    const res = await verifyAndMergeHeavyTask({
      projectRoot: root,
      turn: 1,
      taskId: "T1.1",
      title: "good code but bad smoke",
      wtPath: wt.wtPath,
      branchName: wt.branchName,
      allowedFiles: ["good.txt"],
      smokeCmd,
    });

    assert.equal(res.verified, false);
    assert.equal(res.status, "failed");
    assert.ok(res.error?.includes("Smoke check failed"));
    assert.equal(res.rolledBackTo, baseSha);

    // Main branch was rolled back to baseSha
    const currentHead = runGit(["rev-parse", "HEAD"], { cwd: root }).stdout.trim();
    assert.equal(currentHead, baseSha, "Main branch must be reset to pre_merge_sha");
    assert.ok(!fs.existsSync(path.join(root, "good.txt")));
  });
});


describe("Secret Scan False-Positive Guard (P0 Issue 6a)", () => {
  test("does NOT falsely flag TypeScript type annotations or property accesses as leaked secrets", () => {
    const root = makeTmpDir("asd-no-fp-secret-");
    initGitRepo(root);
    prepareBaseline(root);

    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "src", "auth.ts"),
      [
        "export interface AuthHeader {",
        "  token: string;",
        "  password: boolean;",
        "  secret: number;",
        "  api_key: string;",
        "}",
        "export function extractAuth(req: { token: string; password: string }) {",
        "  const token = req.token;",
        "  const password = req.password;",
        "  return { token, password };",
        "}",
      ].join("\n"),
      "utf8"
    );

    const res = verifyAndCommitLightTask({
      projectRoot: root,
      taskId: "T1.9",
      title: "auth types without false-positive rollback",
      allowedFiles: ["src/auth.ts"],
      verifyCmd: null,
    });

    assert.equal(res.verified, true, `Should pass without false-positive secret rollback: ${res.error}`);
    assert.equal(res.rollbackPerformed, false);
    assert.ok(fs.existsSync(path.join(root, "src", "auth.ts")));
  });
});
