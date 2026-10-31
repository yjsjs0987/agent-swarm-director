/**
 * ASD v2.2 Workspace & Worktree Lifecycle Engine (src/core/workspace.ts)
 *
 * Implements:
 * 1. Unborn HEAD Safeguard & Baseline Prep (`prepareBaseline`):
 *    - Ensures .git/info/exclude contains `.asd/`.
 *    - If repo has no commits yet, creates root baseline empty commit.
 *    - If working tree has uncommitted user files, stashes with asd-auto-stash and records stash SHA.
 * 2. Changed Files Listing (`getChangedFiles`):
 *    - Uses `git -c core.quotePath=false status --porcelain -uall` (ignoring `.asd/` and `node_modules`).
 * 3. LIGHT Track Lifecycle (`verifyAndCommitLightTask`, `rollbackLightChanges`):
 *    - In-place boundary check (`policy.ts`) & secret scan (`redact.ts`).
 *    - verifyCmd priority resolution (explicit -> package.json typecheck/test -> tsconfig.json -> skip).
 *    - On pass: local checkpoint commit `asd(<taskId>): <title>` with --no-verify.
 *    - On failure: atomic rollback preserving prior checkpoint commits.
 * 4. HEAVY Track Worktree Lifecycle (`createTaskWorktree`, `verifyAndMergeHeavyTask`, `cleanupWorktree`):
 *    - Isolated worktree with node_modules junction.
 *    - Strict ordering: boundary check -> test with junction intact -> unlink junction -> commit in wt -> merge with mutex.
 * 5. Process-Internal Async Merge Mutex (`withMergeLock`, `AsyncMutex`):
 *    - Serializes main branch merges preventing .git/index.lock contention across concurrent tasks.
 *
 * Must NOT import anything from src/adapters/*.
 */

import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { ensureGitExclude, ensureProjectInitialized, getGitExcludePath } from "./config.ts";
import type { SqliteDriver } from "./db.ts";
import { verifyChangedFilesBoundary } from "./policy.ts";
import { hasLeakedSecrets } from "./redact.ts";
import type { TaskStatus } from "./types.ts";

export { ensureGitExclude, getGitExcludePath };

// ============================================================================
// Types & Interfaces
// ============================================================================

export interface GitExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface PrepareBaselineOptions {
  sessionId?: string;
  db?: SqliteDriver;
}

export interface PrepareBaselineResult {
  baseSha: string;
  stashedWorkSha?: string;
}

export interface TaskWorktreeInfo {
  wtPath: string;
  branchName: string;
  turn: number;
  taskId: string;
  hasNodeModulesJunction: boolean;
}

export interface VerifyLightTaskOptions {
  projectRoot: string;
  taskId: string;
  title: string;
  allowedFiles?: string[];
  verifyCmd?: string | null;
  sessionId?: string;
  db?: SqliteDriver;
  autoApprove?: boolean;
}

export interface VerifyTaskResult {
  verified: boolean;
  status?: TaskStatus;
  pendingApproval?: boolean;
  commitSha?: string;
  rollbackPerformed?: boolean;
  violations?: string[];
  testOutput?: string;
  error?: string;
  changedFiles?: string[];
}

export interface VerifyHeavyTaskOptions {
  projectRoot: string;
  turn: number;
  taskId: string;
  title: string;
  wtPath?: string;
  branchName?: string;
  allowedFiles?: string[];
  verifyCmd?: string | null;
  smokeCmd?: string | null;
  sessionId?: string;
  db?: SqliteDriver;
  autoApprove?: boolean;
}

export interface VerifyHeavyTaskResult {
  verified: boolean;
  status: TaskStatus;
  pendingApproval?: boolean;
  commitSha?: string;
  violations?: string[];
  testOutput?: string;
  error?: string;
  rolledBackTo?: string;
  changedFiles?: string[];
}

export interface BoundaryAndSecretCheckResult {
  valid: boolean;
  violations: string[];
}

// ============================================================================
// 1. Process-Internal Async Merge Mutex
// ============================================================================

export class AsyncMutex {
  private queue: Promise<void> = Promise.resolve();

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    let release: () => void = () => {};
    const lockPromise = new Promise<void>((resolve) => {
      release = resolve;
    });

    const currentQueue = this.queue;
    this.queue = currentQueue.then(() => lockPromise, () => lockPromise);

    await currentQueue;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

export const mergeMutex = new AsyncMutex();

export async function withMergeLock<T>(fn: () => Promise<T>): Promise<T> {
  return mergeMutex.runExclusive(fn);
}

// ============================================================================
// 2. Git Helper Functions
// ============================================================================

export function runGit(
  args: string[],
  opts?: { cwd?: string; env?: Record<string, string> }
): GitExecResult {
  const finalArgs = ["-c", "core.quotePath=false", ...args];
  const res = child_process.spawnSync("git", finalArgs, {
    cwd: opts?.cwd,
    env: { ...process.env, ...opts?.env },
    encoding: "utf8",
    windowsHide: true,
  });
  return {
    exitCode: res.status ?? (res.error ? 1 : 0),
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? (res.error ? String(res.error) : ""),
  };
}

/**
 * Ensures git local config has user.name and user.email set so automated
 * commits and merges never fail with "Author identity unknown" in headless
 * CI or fresh test directories. Does not overwrite existing identities.
 */
export function ensureGitUserIdentity(cwd: string): void {
  const nameRes = runGit(["config", "user.name"], { cwd });
  if (!nameRes.stdout.trim()) {
    runGit(["config", "user.name", "ASD Agent"], { cwd });
  }
  const emailRes = runGit(["config", "user.email"], { cwd });
  if (!emailRes.stdout.trim()) {
    runGit(["config", "user.email", "asd@local"], { cwd });
  }
}

// ============================================================================
// 3. Changed Files Listing
// ============================================================================

/**
 * Lists uncommitted / changed files in cwd using git status --porcelain -uall.
 * Strips porcelain status prefixes and handles renames.
 * Preserves Korean / non-ASCII paths verbatim via core.quotePath=false.
 * Explicitly ignores `.asd/` and `node_modules` junction/directories.
 */
export function getChangedFiles(cwd: string): string[] {
  const res = runGit(["status", "--porcelain", "-uall"], { cwd });
  if (res.exitCode !== 0) {
    return [];
  }

  const lines = res.stdout.split(/\r?\n/);
  const files: string[] = [];

  for (const line of lines) {
    if (!line || line.trim() === "") continue;
    // Porcelain status line: 2 status characters + space + path
    let filePath = line.length > 3 ? line.slice(3).trim() : line.trim();

    // Strip wrapping quotes if git returned them
    if (filePath.startsWith('"') && filePath.endsWith('"')) {
      filePath = filePath.slice(1, -1);
    }

    // Handle renames (R  old -> new)
    if (filePath.includes(" -> ")) {
      const parts = filePath.split(" -> ");
      filePath = (parts[1] ?? filePath).trim();
      if (filePath.startsWith('"') && filePath.endsWith('"')) {
        filePath = filePath.slice(1, -1);
      }
    }

    const normalized = filePath.replaceAll("\\", "/");

    // Ignore .asd/ and node_modules
    if (
      normalized === ".asd" ||
      normalized.startsWith(".asd/") ||
      normalized === "node_modules" ||
      normalized.startsWith("node_modules/") ||
      normalized === ".omo" ||
      normalized.startsWith(".omo/")
    ) {
      continue;
    }

    files.push(normalized);
  }

  return files;
}

// ============================================================================
// 4. Verification Command Resolution & Execution
// ============================================================================

/**
 * Resolves verifyCmd by priority:
 * 1. Explicit verifyCmd override if non-empty string.
 * 2. package.json scripts: "typecheck" -> `npm run typecheck`, "test" -> `npm test`.
 * 3. tsconfig.json exists -> `npx tsc --noEmit`.
 * 4. skip (null).
 */
export function resolveVerifyCmd(
  projectRoot: string,
  explicitCmd?: string | null
): string | null {
  if (explicitCmd && explicitCmd.trim()) {
    return explicitCmd.trim();
  }

  const pkgJsonPath = path.join(projectRoot, "package.json");
  if (fs.existsSync(pkgJsonPath)) {
    try {
      const raw = fs.readFileSync(pkgJsonPath, "utf8");
      const pkg = JSON.parse(raw);
      if (pkg.scripts && typeof pkg.scripts === "object") {
        if (typeof pkg.scripts.typecheck === "string") {
          return "npm run typecheck";
        }
        if (typeof pkg.scripts.test === "string") {
          return "npm test";
        }
      }
    } catch {
      // invalid package.json, continue to tsconfig
    }
  }

  const tsconfigPath = path.join(projectRoot, "tsconfig.json");
  if (fs.existsSync(tsconfigPath)) {
    return "npx tsc --noEmit";
  }

  return null;
}

/**
 * Executes a verification command in cwd, capturing combined stdout/stderr.
 */
export function runVerifyCmd(
  verifyCmd: string,
  cwd: string,
  timeoutMs = 60000
): { success: boolean; output: string; exitCode: number } {
  try {
    const res = child_process.spawnSync(verifyCmd, {
      cwd,
      shell: true,
      encoding: "utf8",
      timeout: timeoutMs,
      windowsHide: true,
    });
    const output = (res.stdout ?? "") + (res.stderr ?? "");
    const exitCode = res.status ?? (res.error ? 1 : 0);
    return {
      success: exitCode === 0,
      output,
      exitCode,
    };
  } catch (err: unknown) {
    return {
      success: false,
      output: String(err),
      exitCode: 1,
    };
  }
}

// ============================================================================
// 5. Boundary & Secret Scanning
// ============================================================================

export function checkChangedFilesAndSecrets(
  changedFiles: string[],
  allowedFiles: string[] | undefined,
  targetDir: string
): BoundaryAndSecretCheckResult {
  const violations: string[] = [];

  // 1. Boundary inspection via policy.ts
  const boundaryResult = verifyChangedFilesBoundary(
    changedFiles,
    allowedFiles ?? [],
    targetDir
  );
  if (!boundaryResult.valid) {
    violations.push(...boundaryResult.violations);
  }

  // 2. Secret scan via redact.ts (skip test files which intentionally contain sample redaction fixtures)
  for (const relFile of changedFiles) {
    const normRel = relFile.replaceAll("\\", "/").toLowerCase();
    if (
      normRel.startsWith("tests/") ||
      normRel.endsWith(".test.ts") ||
      normRel.endsWith(".spec.ts")
    ) {
      continue;
    }
    const absPath = path.resolve(targetDir, relFile);
    try {
      if (fs.existsSync(absPath) && fs.statSync(absPath).isFile()) {
        const content = fs.readFileSync(absPath, "utf8");
        if (hasLeakedSecrets(content)) {
          violations.push(
            `File '${relFile}' contains leaked secrets or credentials matching redact patterns`
          );
        }
      }
    } catch {
      // Non-text file or read error; ignore
    }
  }

  return {
    valid: violations.length === 0,
    violations,
  };
}

// ============================================================================
// 6. Unborn HEAD Safeguard & Baseline Prep
// ============================================================================

/**
 * Prepares baseline before session or task execution:
 * 1. Ensures project initialized and .git/info/exclude contains `.asd/`.
 * 2. If repo has no commits yet (unborn HEAD), creates initial empty baseline commit.
 * 3. If working tree has uncommitted user files, stashes them and records stash SHA.
 */
export function prepareBaseline(
  projectRoot: string,
  options?: PrepareBaselineOptions
): PrepareBaselineResult {
  // Ensure git repo exists or initialize if missing
  const repoCheck = runGit(["rev-parse", "--is-inside-work-tree"], {
    cwd: projectRoot,
  });
  if (repoCheck.exitCode !== 0) {
    runGit(["init"], { cwd: projectRoot });
  }

  // Ensure git user identity is configured locally
  ensureGitUserIdentity(projectRoot);

  // Ensure .asd/ is initialized and excluded
  ensureProjectInitialized(projectRoot);
  ensureGitExclude(projectRoot, ".asd/");

  // Check unborn HEAD
  const headCheck = runGit(["rev-parse", "--verify", "HEAD"], {
    cwd: projectRoot,
  });
  if (headCheck.exitCode !== 0) {
    runGit(
      [
        "commit",
        "--allow-empty",
        "-m",
        "asd(init): root baseline",
        "--no-verify",
      ],
      { cwd: projectRoot }
    );
  }

  // Check dirty working tree (uncommitted user files)
  const changed = getChangedFiles(projectRoot);
  let stashedWorkSha: string | undefined;

  if (changed.length > 0) {
    const stashRes = runGit(["stash", "push", "-u", "-m", "asd-auto-stash"], {
      cwd: projectRoot,
    });
    if (stashRes.exitCode === 0) {
      const parseStash = runGit(["rev-parse", "refs/stash"], {
        cwd: projectRoot,
      });
      if (parseStash.exitCode === 0 && parseStash.stdout.trim()) {
        stashedWorkSha = parseStash.stdout.trim();
        if (options?.db && options?.sessionId) {
          options.db.recordStashedWork(options.sessionId, stashedWorkSha);
        }
      }
    }
  }

  const baseSha = runGit(["rev-parse", "HEAD"], {
    cwd: projectRoot,
  }).stdout.trim();

  return {
    baseSha,
    stashedWorkSha,
  };
}

// ============================================================================
// 7. LIGHT Track Lifecycle
// ============================================================================

/**
 * Rolls back uncommitted edits in projectRoot while preserving prior checkpoint commits.
 */
export function rollbackLightChanges(projectRoot: string): void {
  runGit(["reset", "HEAD", "--", "."], { cwd: projectRoot });
  runGit(["checkout", "--", "."], { cwd: projectRoot });
  runGit(["clean", "-fd", "-e", ".asd", "-e", ".omo"], { cwd: projectRoot });
}

/**
 * LIGHT Track single worker in-place verification & checkpoint commit:
 * 1. Inspects changed files against boundary & secret scan.
 * 2. Runs verifyCmd.
 * 3. On Pass: creates local checkpoint commit `asd(<taskId>): <title>` with --no-verify.
 * 4. On Failure: rolls back only uncommitted edits, preserving prior checkpoints.
 */
export function verifyAndCommitLightTask(
  options: VerifyLightTaskOptions
): VerifyTaskResult {
  const {
    projectRoot,
    taskId,
    title,
    allowedFiles,
    verifyCmd,
    sessionId,
    db,
    autoApprove = true,
  } = options;

  ensureGitUserIdentity(projectRoot);

  const changedFiles = getChangedFiles(projectRoot);

  // 1. Check boundary & secrets
  const check = checkChangedFilesAndSecrets(
    changedFiles,
    allowedFiles,
    projectRoot
  );
  if (!check.valid) {
    rollbackLightChanges(projectRoot);
    if (db && sessionId) {
      db.updateTaskStatus(sessionId, taskId, "failed");
    }
    return {
      verified: false,
      status: "failed",
      rollbackPerformed: true,
      violations: check.violations,
      error: "Boundary or secret check failed",
      changedFiles,
    };
  }

  // 2. Run verify command
  const resolvedCmd = resolveVerifyCmd(projectRoot, verifyCmd);
  if (resolvedCmd) {
    const cmdRes = runVerifyCmd(resolvedCmd, projectRoot);
    if (!cmdRes.success) {
      rollbackLightChanges(projectRoot);
      if (db && sessionId) {
        db.updateTaskStatus(sessionId, taskId, "failed");
      }
      return {
        verified: false,
        status: "failed",
        rollbackPerformed: true,
        testOutput: cmdRes.output,
        error: `Verification command failed with exit code ${cmdRes.exitCode}: ${resolvedCmd}`,
        changedFiles,
      };
    }
  }

  // 2b. Manual Approval Gate: if autoApprove is false, pause at 'verifying' before committing
  if (autoApprove === false) {
    if (db && sessionId) {
      db.updateTaskStatus(sessionId, taskId, "verifying");
    }
    return {
      verified: true,
      status: "verifying",
      pendingApproval: true,
      rollbackPerformed: false,
      changedFiles,
    };
  }

  // 3. Pass: create checkpoint commit
  if (changedFiles.length > 0) {
    runGit(["add", "--", ...changedFiles], { cwd: projectRoot });
    const commitRes = runGit(
      ["commit", "-m", `asd(${taskId}): ${title}`, "--no-verify"],
      { cwd: projectRoot }
    );
    if (commitRes.exitCode !== 0) {
      // If nothing staged or commit error
      const commitErr = commitRes.stderr || commitRes.stdout;
      return {
        verified: false,
        status: "failed",
        rollbackPerformed: false,
        error: `Checkpoint commit failed: ${commitErr}`,
        changedFiles,
      };
    }
  }

  const commitSha = runGit(["rev-parse", "HEAD"], {
    cwd: projectRoot,
  }).stdout.trim();

  if (db && sessionId) {
    db.updateTaskStatus(sessionId, taskId, "done", { commitSha });
  }

  return {
    verified: true,
    status: "done",
    commitSha,
    rollbackPerformed: false,
    changedFiles,
  };
}

// ============================================================================
// 8. HEAVY Track Worktree Lifecycle
// ============================================================================

/**
 * Creates an isolated worktree for a HEAVY parallel task at:
 * <projectRoot>/.asd/wt/<turn>-<taskId> on branch `asd/wt-<turn>-<taskId>`.
 * Links node_modules via directory junction if present at root, and excludes it.
 */
export function createTaskWorktree(
  projectRoot: string,
  turn: number,
  taskId: string
): TaskWorktreeInfo {
  ensureProjectInitialized(projectRoot);
  ensureGitUserIdentity(projectRoot);

  const wtPath = path.join(projectRoot, ".asd", "wt", `${turn}-${taskId}`);
  const branchName = `asd/wt-${turn}-${taskId}`;

  fs.mkdirSync(path.dirname(wtPath), { recursive: true });

  // Add worktree branching from HEAD
  const addRes = runGit(
    ["worktree", "add", "-b", branchName, wtPath, "HEAD"],
    { cwd: projectRoot }
  );
  if (addRes.exitCode !== 0) {
    throw new Error(
      `Failed to create worktree at '${wtPath}': ${addRes.stderr || addRes.stdout}`
    );
  }

  // Worktree inherits git user identity
  ensureGitUserIdentity(wtPath);

  // Link node_modules junction if present in projectRoot
  const rootNm = path.join(projectRoot, "node_modules");
  const wtNm = path.join(wtPath, "node_modules");
  let hasNodeModulesJunction = false;

  if (fs.existsSync(rootNm)) {
    // Remove if already exists (stale link)
    try {
      const stat = fs.lstatSync(wtNm);
      if (stat.isSymbolicLink() || stat.isDirectory()) {
        try {
          fs.unlinkSync(wtNm);
        } catch {
          fs.rmSync(wtNm, { recursive: false, force: true });
        }
      }
    } catch {
      // not existing
    }

    const symlinkType = process.platform === "win32" ? "junction" : "dir";
    try {
      fs.symlinkSync(rootNm, wtNm, symlinkType);
      hasNodeModulesJunction = true;
    } catch {
      // Symlink failed; continue without junction
    }

    // Exclude /node_modules from worktree git status
    ensureGitExclude(wtPath, "/node_modules");
  }

  return {
    wtPath,
    branchName,
    turn,
    taskId,
    hasNodeModulesJunction,
  };
}

/**
 * Safely unlinks a node_modules junction without deleting target directory contents.
 */
export function unlinkNodeModulesJunction(wtNm: string): void {
  try {
    const stat = fs.lstatSync(wtNm);
    if (stat.isSymbolicLink() || (process.platform === "win32" && stat.isDirectory())) {
      try {
        fs.unlinkSync(wtNm);
      } catch {
        try {
          fs.rmdirSync(wtNm);
        } catch {
          fs.rmSync(wtNm, { recursive: false, force: true });
        }
      }
    }
  } catch {
    // Already unlinked or not present
  }
}

/**
 * Cleans up a worktree:
 * 1. Unlinks node_modules junction if present.
 * 2. Removes worktree via `git worktree remove --force`.
 * 3. Removes disk directory if anything remains.
 * 4. Runs `git worktree prune`.
 * 5. Deletes temporary branch.
 */
export function cleanupWorktree(
  projectRoot: string,
  wtPath: string,
  branchName?: string,
  options?: { forceBranchDelete?: boolean }
): void {
  const wtNm = path.join(wtPath, "node_modules");
  unlinkNodeModulesJunction(wtNm);

  // Remove worktree in git
  runGit(["worktree", "remove", "--force", wtPath], { cwd: projectRoot });

  // Clean directory on disk if remaining
  if (fs.existsSync(wtPath)) {
    try {
      fs.rmSync(wtPath, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }

  // Prune worktree metadata
  runGit(["worktree", "prune"], { cwd: projectRoot });

  // Delete branch
  if (branchName) {
    const flag = options?.forceBranchDelete ? "-D" : "-d";
    const delRes = runGit(["branch", flag, branchName], { cwd: projectRoot });
    if (delRes.exitCode !== 0 && !options?.forceBranchDelete) {
      // Fallback to -D if -d failed
      runGit(["branch", "-D", branchName], { cwd: projectRoot });
    }
  }
}

/**
 * HEAVY Track Worktree verification, commit & mutexed merge:
 *
 * Strict Ordering:
 * 1. Check changed files against boundary & secret scan.
 * 2. Run verifyCmd inside wtPath while node_modules junction is intact.
 * 3. Remove node_modules junction immediately before git add -A.
 * 4. If boundary/test failed: clean up worktree and return failure.
 * 5. Commit inside worktree: `git add -A && git commit -m "asd(<taskId>): <title>" --no-verify`.
 * 6. Process-Internal Async Merge Mutex (withMergeLock):
 *    - Record pre_merge_sha.
 *    - `git merge --no-ff asd/wt-<turn>-<taskId> -m "asd(merge): <taskId>"`.
 * 7. On merge conflict: `git merge --abort`, mark "merge_conflict", preserve worktree.
 * 8. On merge success: run optional smoke check:
 *    - If smoke check fails: `git reset --hard <pre_merge_sha>`, mark failed.
 *    - If smoke check passes: `git worktree remove --force <wtPath>` and `git branch -d asd/wt-...`.
 */
export async function verifyAndMergeHeavyTask(
  options: VerifyHeavyTaskOptions
): Promise<VerifyHeavyTaskResult> {
  const {
    projectRoot,
    turn,
    taskId,
    title,
    allowedFiles,
    verifyCmd,
    smokeCmd,
    sessionId,
    db,
    autoApprove = true,
  } = options;

  const wtPath =
    options.wtPath ?? path.join(projectRoot, ".asd", "wt", `${turn}-${taskId}`);
  const branchName = options.branchName ?? `asd/wt-${turn}-${taskId}`;
  const wtNm = path.join(wtPath, "node_modules");

  ensureGitUserIdentity(wtPath);

  // 1. Boundary & Secret scan inside worktree
  const changedFiles = getChangedFiles(wtPath);
  const check = checkChangedFilesAndSecrets(changedFiles, allowedFiles, wtPath);

  if (!check.valid) {
    // Step 4: Boundary failed - clean up worktree and return failure
    cleanupWorktree(projectRoot, wtPath, branchName, {
      forceBranchDelete: true,
    });
    if (db && sessionId) {
      db.updateTaskStatus(sessionId, taskId, "failed");
    }
    return {
      verified: false,
      status: "failed",
      violations: check.violations,
      error: "Boundary or secret check failed",
    };
  }

  // 2. Run verifyCmd inside wtPath while node_modules junction is intact
  const resolvedCmd = resolveVerifyCmd(wtPath, verifyCmd);
  if (resolvedCmd) {
    const cmdRes = runVerifyCmd(resolvedCmd, wtPath);
    if (!cmdRes.success) {
      // Step 4: Test failed - clean up worktree and return failure
      cleanupWorktree(projectRoot, wtPath, branchName, {
        forceBranchDelete: true,
      });
      if (db && sessionId) {
        db.updateTaskStatus(sessionId, taskId, "failed");
      }
      return {
        verified: false,
        status: "failed",
        testOutput: cmdRes.output,
        error: `Verification command failed with exit code ${cmdRes.exitCode}: ${resolvedCmd}`,
      };
    }
  }

  // 2b. Manual Approval Gate: if autoApprove is false, pause at 'verifying' and preserve worktree for GUI diff inspection
  if (autoApprove === false) {
    if (db && sessionId) {
      db.updateTaskStatus(sessionId, taskId, "verifying", {
        worktreePath: wtPath,
      });
    }
    return {
      verified: true,
      status: "verifying",
      pendingApproval: true,
      changedFiles,
    };
  }

  // 3. Remove node_modules junction immediately before git add -A
  unlinkNodeModulesJunction(wtNm);

  // 5. Commit inside worktree
  runGit(["add", "-A"], { cwd: wtPath });
  const commitRes = runGit(
    ["commit", "-m", `asd(${taskId}): ${title}`, "--no-verify"],
    { cwd: wtPath }
  );
  if (commitRes.exitCode !== 0) {
    // If nothing changed, we still check HEAD commit
    const headSha = runGit(["rev-parse", "HEAD"], { cwd: wtPath }).stdout.trim();
    if (!headSha) {
      cleanupWorktree(projectRoot, wtPath, branchName, {
        forceBranchDelete: true,
      });
      return {
        verified: false,
        status: "failed",
        error: `Failed to commit inside worktree: ${commitRes.stderr || commitRes.stdout}`,
      };
    }
  }

  // 6. Mutex-serialized merge into main branch
  return await withMergeLock(async () => {
    ensureGitUserIdentity(projectRoot);

    const preMergeSha = runGit(["rev-parse", "HEAD"], {
      cwd: projectRoot,
    }).stdout.trim();

    // Run git merge --no-ff
    const mergeRes = runGit(
      ["merge", "--no-ff", branchName, "-m", `asd(merge): ${taskId}`],
      { cwd: projectRoot }
    );

    if (mergeRes.exitCode !== 0) {
      // 7. On merge conflict: git merge --abort, mark merge_conflict, PRESERVE worktree
      runGit(["merge", "--abort"], { cwd: projectRoot });
      if (db && sessionId) {
        db.updateTaskStatus(sessionId, taskId, "merge_conflict");
      }
      return {
        verified: false,
        status: "merge_conflict",
        error: `Merge conflict while merging branch '${branchName}': ${mergeRes.stderr || mergeRes.stdout}`,
      };
    }

    // 8. On merge success: run optional smoke check
    if (smokeCmd && smokeCmd.trim()) {
      const smokeRes = runVerifyCmd(smokeCmd.trim(), projectRoot);
      if (!smokeRes.success) {
        // Smoke check failed: rollback main branch to pre_merge_sha
        runGit(["reset", "--hard", preMergeSha], { cwd: projectRoot });
        if (db && sessionId) {
          db.updateTaskStatus(sessionId, taskId, "failed");
        }
        return {
          verified: false,
          status: "failed",
          error: `Smoke check failed after merge: ${smokeRes.output}`,
          rolledBackTo: preMergeSha,
        };
      }
    }

    // Smoke check passed (or skipped): clean up worktree and branch
    cleanupWorktree(projectRoot, wtPath, branchName, {
      forceBranchDelete: false,
    });

    const finalCommitSha = runGit(["rev-parse", "HEAD"], {
      cwd: projectRoot,
    }).stdout.trim();

    if (db && sessionId) {
      db.updateTaskStatus(sessionId, taskId, "done", {
        commitSha: finalCommitSha,
      });
    }

    return {
      verified: true,
      status: "done",
      commitSha: finalCommitSha,
      changedFiles,
    };
  });
}

// ============================================================================
// 9. Worktree Diff Inspection & Manual Approval / Rejection Helpers (GUI Gate)
// ============================================================================

export interface WorktreeDiffSnapshot {
  targetDir: string;
  exists: boolean;
  changedFiles: string[];
  statusShort: string;
  diff: string;
}

/**
 * Collects changed files, `git status --short`, and unified `git diff HEAD`
 * (including untracked file contents) for either a task worktree or projectRoot.
 */
export function getWorktreeDiff(
  projectRoot: string,
  options?: { wtPath?: string | null; turn?: number; taskId?: string }
): WorktreeDiffSnapshot {
  const inferredWt =
    options?.wtPath ||
    (options?.turn !== undefined && options?.taskId
      ? path.join(projectRoot, ".asd", "wt", `${options.turn}-${options.taskId}`)
      : null);
  const targetDir =
    inferredWt && fs.existsSync(inferredWt)
      ? path.resolve(inferredWt)
      : path.resolve(projectRoot);

  if (!fs.existsSync(targetDir)) {
    return {
      targetDir,
      exists: false,
      changedFiles: [],
      statusShort: "",
      diff: "",
    };
  }

  const changedFiles = getChangedFiles(targetDir);
  const statusRes = runGit(["status", "--short", "-uall"], { cwd: targetDir });
  const diffRes = runGit(["diff", "HEAD"], { cwd: targetDir });

  // Also include diffs for newly created untracked files so GUI diff viewer sees new files
  const untrackedDiffs: string[] = [];
  const statusLines = statusRes.stdout.split(/\r?\n/);
  for (const line of statusLines) {
    if (!line.startsWith("?? ")) continue;
    const relPath = line.slice(3).trim().replace(/^"(.*)"$/, "$1");
    const norm = relPath.replaceAll("\\", "/");
    if (
      norm === ".asd" ||
      norm.startsWith(".asd/") ||
      norm === "node_modules" ||
      norm.startsWith("node_modules/")
    ) {
      continue;
    }
    const absFile = path.join(targetDir, relPath);
    try {
      if (fs.existsSync(absFile) && fs.statSync(absFile).isFile()) {
        const content = fs.readFileSync(absFile, "utf8");
        const contentLines = content.split(/\r?\n/);
        untrackedDiffs.push(
          [
            `diff --git a/${norm} b/${norm}`,
            `new file mode 100644`,
            `--- /dev/null`,
            `+++ b/${norm}`,
            `@@ -0,0 +1,${contentLines.length} @@`,
            ...contentLines.map((l) => `+${l}`),
          ].join("\n")
        );
      }
    } catch {
      // Ignore binary/unreadable untracked file
    }
  }

  const combinedDiff = [diffRes.stdout.trim(), ...untrackedDiffs]
    .filter(Boolean)
    .join("\n\n");

  return {
    targetDir,
    exists: true,
    changedFiles,
    statusShort: statusRes.stdout.trim(),
    diff: combinedDiff,
  };
}

/**
 * Approves and merges/commits a task that was paused at `'verifying'` status
 * when `autoApprove` was disabled.
 */
export async function approvePendingTask(options: {
  projectRoot: string;
  sessionId: string;
  taskId: string;
  db: SqliteDriver;
  smokeCmd?: string | null;
}): Promise<{
  ok: boolean;
  status: TaskStatus;
  commitSha?: string;
  changedFiles?: string[];
  error?: string;
}> {
  const { projectRoot, sessionId, taskId, db, smokeCmd } = options;
  const task = db.getTask(sessionId, taskId);
  if (!task) {
    throw new Error(`Task not found: ${sessionId}/${taskId}`);
  }

  let allowedFiles: string[] = [];
  try {
    allowedFiles = JSON.parse(task.target_files_json || "[]");
  } catch {
    allowedFiles = [];
  }
  if (allowedFiles.length > 0 && !allowedFiles.includes("tests/**")) {
    allowedFiles = [...allowedFiles, "tests/**", "**/*.test.ts", "**/*.spec.ts"];
  }

  if (task.track === "HEAVY" || (task.worktree_path && fs.existsSync(task.worktree_path))) {
    const res = await verifyAndMergeHeavyTask({
      projectRoot,
      turn: task.turn,
      taskId: task.task_id,
      title: task.title,
      wtPath: task.worktree_path ?? undefined,
      allowedFiles,
      verifyCmd: task.verify_cmd,
      smokeCmd,
      sessionId,
      db,
      autoApprove: true,
    });
    if (res.verified) {
      db.recordTaskVerified(
        sessionId,
        taskId,
        res.commitSha || "",
        {
          summary: `Approved and merged task ${task.task_id}: ${task.title}`,
          changed_files: res.changedFiles ?? allowedFiles,
          key_decisions: ["Approved via manual review gate"],
          risks: [],
        },
        task.duration_ms ?? 0
      );
    }
    return {
      ok: res.verified,
      status: res.status,
      commitSha: res.commitSha,
      changedFiles: res.changedFiles,
      error: res.error,
    };
  }

  const res = verifyAndCommitLightTask({
    projectRoot,
    taskId: task.task_id,
    title: task.title,
    allowedFiles,
    verifyCmd: task.verify_cmd,
    sessionId,
    db,
    autoApprove: true,
  });
  if (res.verified) {
    db.recordTaskVerified(
      sessionId,
      taskId,
      res.commitSha || "",
      {
        summary: `Approved and committed task ${task.task_id}: ${task.title}`,
        changed_files: res.changedFiles ?? allowedFiles,
        key_decisions: ["Approved via manual review gate"],
        risks: [],
      },
      task.duration_ms ?? 0
    );
  }
  return {
    ok: res.verified,
    status: res.status ?? (res.verified ? "done" : "failed"),
    commitSha: res.commitSha,
    changedFiles: res.changedFiles,
    error: res.error,
  };
}

/**
 * Rejects and rolls back a task paused at `'verifying'` (or `'merge_conflict'`),
 * cleaning up its worktree or uncommitted changes and marking it `'failed'`.
 */
export function rejectPendingTask(options: {
  projectRoot: string;
  sessionId: string;
  taskId: string;
  db: SqliteDriver;
}): { ok: boolean; status: TaskStatus } {
  const { projectRoot, sessionId, taskId, db } = options;
  const task = db.getTask(sessionId, taskId);
  if (!task) {
    throw new Error(`Task not found: ${sessionId}/${taskId}`);
  }

  const wtPath =
    task.worktree_path ||
    path.join(projectRoot, ".asd", "wt", `${task.turn}-${task.task_id}`);
  const branchName = `asd/wt-${task.turn}-${task.task_id}`;

  if (task.track === "HEAVY" || fs.existsSync(wtPath)) {
    cleanupWorktree(projectRoot, wtPath, branchName, {
      forceBranchDelete: true,
    });
  } else {
    rollbackLightChanges(projectRoot);
  }

  db.updateTaskStatus(sessionId, taskId, "failed");
  return { ok: true, status: "failed" };
}
