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
import * as os from "node:os";
import * as path from "node:path";
import { ensureGitExclude, ensureProjectInitialized, getGitExcludePath } from "./config.ts";
import type { SqliteDriver } from "./db.ts";
import { verifyChangedFilesBoundary } from "./policy.ts";
import { hasLeakedSecrets } from "./redact.ts";
import { renderPlanMd, renderSessionSummaryMd } from "./render.ts";
import { finalizeSubagentArtifacts } from "./spawner.ts";
import type { DoneClaim, TaskStatus } from "./types.ts";

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
  untouchedFiles?: string[];
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

export interface MergeLockOptions {
  projectRoot?: string;
  purpose?: string;
  timeoutMs?: number;
}

export interface MergeLockFilePayload {
  pid: number;
  hostname: string;
  acquiredAt: number;
  purpose: string;
}

const DEFAULT_MERGE_LOCK_TIMEOUT_MS = 120_000;
const STALE_MERGE_LOCK_MAX_AGE_MS = 10 * 60 * 1000;
const heldProjectLockDepth = new Map<string, number>();

function normalizeLockKey(projectRoot: string): string {
  const resolved = path.resolve(projectRoot).replaceAll("\\", "/");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "EPERM") return true;
    return false;
  }
}

function isLockFileStale(lockPath: string, now: number): boolean {
  let raw = "";
  try {
    raw = fs.readFileSync(lockPath, "utf8");
  } catch {
    return false;
  }

  if (!raw.trim()) {
    try {
      const stat = fs.statSync(lockPath);
      return now - stat.mtimeMs > 2_000;
    } catch {
      return false;
    }
  }

  try {
    const parsed = JSON.parse(raw) as Partial<MergeLockFilePayload>;
    const pid = typeof parsed.pid === "number" ? parsed.pid : -1;
    const acquiredAt = typeof parsed.acquiredAt === "number" ? parsed.acquiredAt : 0;
    if (now - acquiredAt > STALE_MERGE_LOCK_MAX_AGE_MS) {
      return true;
    }
    if (!isPidAlive(pid)) {
      return true;
    }
    return false;
  } catch {
    try {
      const stat = fs.statSync(lockPath);
      return now - stat.mtimeMs > 2_000;
    } catch {
      return false;
    }
  }
}

function tryOpenMergeLockFile(lockPath: string, purpose: string): boolean {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  let fd: number | undefined;
  try {
    fd = fs.openSync(lockPath, "wx");
    const payload: MergeLockFilePayload = {
      pid: process.pid,
      hostname: os.hostname(),
      acquiredAt: Date.now(),
      purpose,
    };
    fs.writeFileSync(fd, JSON.stringify(payload) + "\n", "utf8");
    return true;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "EEXIST" || code === "EPERM" || code === "EACCES") {
      return false;
    }
    throw err;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

function releaseMergeLockFile(lockPath: string): void {
  try {
    if (!fs.existsSync(lockPath)) return;
    const raw = fs.readFileSync(lockPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<MergeLockFilePayload>;
    if (parsed.pid === process.pid) {
      fs.unlinkSync(lockPath);
    }
  } catch {
    // ignore
  }
}

function sleepSync(ms: number): void {
  if (ms <= 0) return;
  try {
    const sab = new SharedArrayBuffer(4);
    const view = new Int32Array(sab);
    Atomics.wait(view, 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      // busy-wait fallback
    }
  }
}

function withFileMergeLockSync<T>(
  projectRoot: string,
  purpose: string,
  fn: () => T,
  timeoutMs = DEFAULT_MERGE_LOCK_TIMEOUT_MS
): T {
  const key = normalizeLockKey(projectRoot);
  const currentDepth = heldProjectLockDepth.get(key) ?? 0;
  if (currentDepth > 0) {
    heldProjectLockDepth.set(key, currentDepth + 1);
    try {
      return fn();
    } finally {
      heldProjectLockDepth.set(key, currentDepth);
    }
  }

  const lockPath = path.join(projectRoot, ".asd", "merge.lock");
  const start = Date.now();
  let attempt = 0;

  while (true) {
    if (tryOpenMergeLockFile(lockPath, purpose)) {
      break;
    }
    const now = Date.now();
    if (isLockFileStale(lockPath, now)) {
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // ignore race
      }
      continue;
    }
    const elapsed = now - start;
    if (elapsed >= timeoutMs) {
      throw new Error("MERGE_LOCK_TIMEOUT");
    }
    const backoff = Math.min(1000, 200 * Math.pow(2, attempt));
    const waitMs = Math.min(backoff, Math.max(1, timeoutMs - elapsed));
    attempt++;
    sleepSync(waitMs);
  }

  heldProjectLockDepth.set(key, 1);
  try {
    return fn();
  } finally {
    heldProjectLockDepth.delete(key);
    releaseMergeLockFile(lockPath);
  }
}

/**
 * 2-stage merge lock:
 * 1. Process-internal AsyncMutex (`mergeMutex`).
 * 2. Cross-process `.asd/merge.lock` file lock when `options.projectRoot` is provided.
 *
 * Known limitation: On Windows, OS PID reuse within the 10-minute stale window
 * could theoretically match an unrelated live process.
 */
export async function withMergeLock<T>(
  fn: () => Promise<T>,
  options?: MergeLockOptions
): Promise<T> {
  return mergeMutex.runExclusive(async () => {
    const projectRoot = options?.projectRoot;
    if (!projectRoot) {
      return await fn();
    }

    const key = normalizeLockKey(projectRoot);
    const currentDepth = heldProjectLockDepth.get(key) ?? 0;
    if (currentDepth > 0) {
      heldProjectLockDepth.set(key, currentDepth + 1);
      try {
        return await fn();
      } finally {
        heldProjectLockDepth.set(key, currentDepth);
      }
    }

    const purpose = options?.purpose ?? "merge";
    const timeoutMs = options?.timeoutMs ?? DEFAULT_MERGE_LOCK_TIMEOUT_MS;
    const lockPath = path.join(projectRoot, ".asd", "merge.lock");
    const start = Date.now();
    let attempt = 0;

    while (true) {
      if (tryOpenMergeLockFile(lockPath, purpose)) {
        break;
      }
      const now = Date.now();
      if (isLockFileStale(lockPath, now)) {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // ignore race
        }
        continue;
      }
      const elapsed = now - start;
      if (elapsed >= timeoutMs) {
        throw new Error("MERGE_LOCK_TIMEOUT");
      }
      const backoff = Math.min(1000, 200 * Math.pow(2, attempt));
      const waitMs = Math.min(backoff, Math.max(1, timeoutMs - elapsed));
      attempt++;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }

    heldProjectLockDepth.set(key, 1);
    try {
      return await fn();
    } finally {
      heldProjectLockDepth.delete(key);
      releaseMergeLockFile(lockPath);
    }
  });
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

function filterIgnoredRelPaths(rawOutput: string): string[] {
  const out: string[] = [];
  for (const line of rawOutput.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const normalized = trimmed.replaceAll("\\", "/");
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
    out.push(normalized);
  }
  return out;
}

/**
 * CR-08: Computes files committed in a worktree relative to projectRoot HEAD,
 * excluding files that came strictly from merging main into the worktree.
 */
export function getCommittedWorktreeChanges(
  projectRoot: string,
  wtPath: string
): string[] {
  const mainHead = runGit(["rev-parse", "HEAD"], { cwd: projectRoot }).stdout.trim();
  const wtHead = runGit(["rev-parse", "HEAD"], { cwd: wtPath }).stdout.trim();
  if (!mainHead || !wtHead || mainHead === wtHead) {
    return [];
  }

  const mbRes = runGit(["merge-base", mainHead, wtHead], { cwd: wtPath });
  const mergeBase = mbRes.exitCode === 0 ? mbRes.stdout.trim() : "";
  if (!mergeBase || mergeBase === wtHead) {
    return [];
  }

  // Files changed along the worktree branch since merge-base
  const sinceMbRes = runGit(["diff", "--name-only", mergeBase, wtHead], {
    cwd: wtPath,
  });
  const sinceMb = new Set(
    sinceMbRes.exitCode === 0 ? filterIgnoredRelPaths(sinceMbRes.stdout) : []
  );

  // Files whose tree state in wtHead actually differs from current mainHead
  const vsMainRes = runGit(["diff", "--name-only", mainHead, wtHead], {
    cwd: wtPath,
  });
  const vsMain = new Set(
    vsMainRes.exitCode === 0 ? filterIgnoredRelPaths(vsMainRes.stdout) : []
  );

  // Intersection excludes files modified only on main (whether merged into wt or not)
  const result: string[] = [];
  for (const f of sinceMb) {
    if (vsMain.has(f)) {
      result.push(f);
    }
  }
  return result;
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
function partitionFilesByScope(
  changedFiles: string[],
  allowedFiles: string[] | undefined,
  projectRoot: string
): { scopedFiles: string[]; untouchedFiles: string[] } {
  if (!allowedFiles || allowedFiles.length === 0) {
    return { scopedFiles: [...changedFiles], untouchedFiles: [] };
  }
  const scopedFiles: string[] = [];
  const untouchedFiles: string[] = [];
  for (const file of changedFiles) {
    const check = verifyChangedFilesBoundary([file], allowedFiles, projectRoot);
    if (check.valid) {
      scopedFiles.push(file);
    } else {
      untouchedFiles.push(file);
    }
  }
  return { scopedFiles, untouchedFiles };
}

/**
 * Rolls back uncommitted edits in projectRoot while preserving prior checkpoint commits.
 * When options.files is provided, only those specific files are restored/cleaned.
 */
export function rollbackLightChanges(
  projectRoot: string,
  options?: { files?: string[] }
): void {
  withFileMergeLockSync(projectRoot, "rollbackLightChanges", () => {
    if (options?.files !== undefined) {
      const targetFiles = options.files.filter((f) => f && f.trim().length > 0);
      if (targetFiles.length === 0) {
        return;
      }
      runGit(["reset", "HEAD", "--", ...targetFiles], { cwd: projectRoot });
      const checkoutHeadRes = runGit(["checkout", "HEAD", "--", ...targetFiles], {
        cwd: projectRoot,
      });
      if (checkoutHeadRes.exitCode !== 0) {
        for (const f of targetFiles) {
          const resetRes = runGit(["reset", "HEAD", "--", f], { cwd: projectRoot });
          void resetRes;
          const coRes = runGit(["checkout", "HEAD", "--", f], { cwd: projectRoot });
          if (coRes.exitCode !== 0) {
            runGit(["checkout", "--", f], { cwd: projectRoot });
          }
        }
      }
      runGit(["clean", "-fd", "--", ...targetFiles], { cwd: projectRoot });
      for (const f of targetFiles) {
        const trackedCheck = runGit(["ls-files", "--error-unmatch", "--", f], {
          cwd: projectRoot,
        });
        if (trackedCheck.exitCode !== 0) {
          const abs = path.resolve(projectRoot, f);
          try {
            if (fs.existsSync(abs)) {
              fs.rmSync(abs, { recursive: true, force: true });
            }
          } catch {
            // ignore
          }
        }
      }
      return;
    }

    runGit(["reset", "HEAD", "--", "."], { cwd: projectRoot });
    runGit(["checkout", "--", "."], { cwd: projectRoot });
    runGit(["clean", "-fd", "-e", ".asd", "-e", ".omo"], { cwd: projectRoot });
  });
}

/**
 * LIGHT Track single worker in-place verification & checkpoint commit:
 * 1. Inspects changed files against boundary & secret scan.
 * 2. Runs verifyCmd.
 * 3. On Pass: creates local checkpoint commit `asd(<taskId>): <title>` with --no-verify.
 * 4. On Failure: rolls back only scoped uncommitted edits, preserving user edits outside scope and prior checkpoints.
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
  const { scopedFiles, untouchedFiles } = partitionFilesByScope(
    changedFiles,
    allowedFiles,
    projectRoot
  );

  // 1. Check boundary & secrets
  const check = checkChangedFilesAndSecrets(
    changedFiles,
    allowedFiles,
    projectRoot
  );
  if (!check.valid) {
    rollbackLightChanges(projectRoot, { files: scopedFiles });
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
      untouchedFiles,
    };
  }

  // 2. Run verify command
  const resolvedCmd = resolveVerifyCmd(projectRoot, verifyCmd);
  if (resolvedCmd) {
    const cmdRes = runVerifyCmd(resolvedCmd, projectRoot);
    if (!cmdRes.success) {
      rollbackLightChanges(projectRoot, { files: scopedFiles });
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
        untouchedFiles,
      };
    }
  }

  // Re-evaluate changed files after verifyCmd (which might have generated/mutated files)
  let postChangedFiles = getChangedFiles(projectRoot);
  const postPartition = partitionFilesByScope(
    postChangedFiles,
    allowedFiles,
    projectRoot
  );
  const postCheck = checkChangedFilesAndSecrets(
    postChangedFiles,
    allowedFiles,
    projectRoot
  );
  if (!postCheck.valid) {
    rollbackLightChanges(projectRoot, { files: postPartition.scopedFiles });
    if (db && sessionId) {
      db.updateTaskStatus(sessionId, taskId, "failed");
    }
    return {
      verified: false,
      status: "failed",
      rollbackPerformed: true,
      violations: postCheck.violations,
      error: "Post-verification boundary or secret check failed",
      changedFiles: postChangedFiles,
      untouchedFiles: postPartition.untouchedFiles,
    };
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
      changedFiles: postChangedFiles,
    };
  }

  // 3. Pass: create checkpoint commit under cross-process merge lock
  const lightCommitFailure = withFileMergeLockSync(
    projectRoot,
    `verifyAndCommitLightTask:${taskId}`,
    (): VerifyTaskResult | null => {
      postChangedFiles = getChangedFiles(projectRoot);
      const lockedPartition = partitionFilesByScope(
        postChangedFiles,
        allowedFiles,
        projectRoot
      );
      const lockedCheck = checkChangedFilesAndSecrets(
        postChangedFiles,
        allowedFiles,
        projectRoot
      );
      if (!lockedCheck.valid) {
        rollbackLightChanges(projectRoot, { files: lockedPartition.scopedFiles });
        if (db && sessionId) {
          db.updateTaskStatus(sessionId, taskId, "failed");
        }
        return {
          verified: false,
          status: "failed",
          rollbackPerformed: true,
          violations: lockedCheck.violations,
          error: "Boundary or secret check failed before commit",
          changedFiles: postChangedFiles,
          untouchedFiles: lockedPartition.untouchedFiles,
        };
      }

      if (postChangedFiles.length > 0) {
        const addRes = runGit(["add", "--", ...postChangedFiles], { cwd: projectRoot });
        if (addRes.exitCode !== 0) {
          const addErr = addRes.stderr || addRes.stdout;
          rollbackLightChanges(projectRoot, { files: lockedPartition.scopedFiles });
          if (db && sessionId) {
            db.updateTaskStatus(sessionId, taskId, "failed");
          }
          return {
            verified: false,
            status: "failed",
            rollbackPerformed: true,
            error: `git add failed: ${addErr}`,
            changedFiles: postChangedFiles,
            untouchedFiles: lockedPartition.untouchedFiles,
          };
        }
        const commitRes = runGit(
          ["commit", "-m", `asd(${taskId}): ${title}`, "--no-verify"],
          { cwd: projectRoot }
        );
        if (commitRes.exitCode !== 0) {
          const commitErr = commitRes.stderr || commitRes.stdout;
          if (db && sessionId) {
            db.updateTaskStatus(sessionId, taskId, "failed");
          }
          return {
            verified: false,
            status: "failed",
            rollbackPerformed: false,
            error: `Checkpoint commit failed: ${commitErr}`,
            changedFiles: postChangedFiles,
          };
        }
      }
      return null;
    }
  );
  if (lightCommitFailure) {
    return lightCommitFailure;
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
    changedFiles: postChangedFiles,
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

  // CR-12: If a preserved/orphaned worktree or branch from a prior attempt exists, clean it up before recreating
  const branchCheck = runGit(["rev-parse", "--verify", `refs/heads/${branchName}`], {
    cwd: projectRoot,
  });
  if (fs.existsSync(wtPath) || branchCheck.exitCode === 0) {
    cleanupWorktree(projectRoot, wtPath, branchName, {
      forceBranchDelete: true,
    });
    runGit(["worktree", "prune"], { cwd: projectRoot });
  }

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

  // Delete branch under cross-process merge lock
  if (branchName) {
    withFileMergeLockSync(projectRoot, `cleanupWorktree:${branchName}`, () => {
      const flag = options?.forceBranchDelete ? "-D" : "-d";
      const delRes = runGit(["branch", flag, branchName], { cwd: projectRoot });
      if (delRes.exitCode !== 0 && !options?.forceBranchDelete) {
        // Fallback to -D if -d failed
        runGit(["branch", "-D", branchName], { cwd: projectRoot });
      }
    });
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

  // 1. Boundary & Secret scan inside worktree (working tree union committed worktree changes)
  const workingChanges = getChangedFiles(wtPath);
  const committedChanges = getCommittedWorktreeChanges(projectRoot, wtPath);
  const changedFiles = Array.from(new Set([...workingChanges, ...committedChanges]));
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

  // 6. Mutex-serialized merge into main branch (2-stage: process mutex + .asd/merge.lock)
  return await withMergeLock(
    async () => {
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
        // Smoke check failed: rollback main branch to pre_merge_sha while preserving pre-existing uncommitted changes
        const keepRes = runGit(["reset", "--keep", preMergeSha], {
          cwd: projectRoot,
        });
        if (keepRes.exitCode !== 0) {
          const mergeDiff = runGit(
            ["diff", "--name-only", preMergeSha, "HEAD"],
            { cwd: projectRoot }
          )
            .stdout.split(/\r?\n/)
            .map((s) => s.trim())
            .filter(Boolean);
          if (mergeDiff.length > 0) {
            runGit(["checkout", "--", ...mergeDiff], { cwd: projectRoot });
          }
          runGit(["reset", "--keep", preMergeSha], { cwd: projectRoot });
        }
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
  },
  { projectRoot, purpose: `verifyAndMergeHeavyTask:${taskId}` }
  );
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
  mode: "working" | "committed";
  baseRef?: string;
}

/**
 * Collects changed files, `git status --short`, and unified diff
 * (including untracked file contents and committed worktree changes in merge-base mode)
 * for either a task worktree or projectRoot.
 */
export function getWorktreeDiff(
  projectRoot: string,
  options?: {
    wtPath?: string | null;
    turn?: number;
    taskId?: string;
    base?: "HEAD" | "merge-base";
  }
): WorktreeDiffSnapshot & { mode: "working" | "committed"; baseRef?: string } {
  const resolvedRoot = path.resolve(projectRoot);
  const inferredWt =
    options?.wtPath ||
    (options?.turn !== undefined && options?.taskId
      ? path.join(resolvedRoot, ".asd", "wt", `${options.turn}-${options.taskId}`)
      : null);
  const targetDir =
    inferredWt && fs.existsSync(inferredWt)
      ? path.resolve(inferredWt)
      : resolvedRoot;

  if (!fs.existsSync(targetDir)) {
    return {
      targetDir,
      exists: false,
      changedFiles: [],
      statusShort: "",
      diff: "",
      mode: "working",
    };
  }

  const mainHead = runGit(["rev-parse", "HEAD"], { cwd: resolvedRoot }).stdout.trim();
  const wtHead = runGit(["rev-parse", "HEAD"], { cwd: targetDir }).stdout.trim();

  let useMergeBase = false;
  if (options?.base === "merge-base") {
    useMergeBase = true;
  } else if (options?.base === "HEAD") {
    useMergeBase = false;
  } else if (mainHead && wtHead && mainHead !== wtHead) {
    const aheadRes = runGit(["rev-list", "--count", `${mainHead}..HEAD`], {
      cwd: targetDir,
    });
    const aheadCount = Number.parseInt(aheadRes.stdout.trim(), 10) || 0;
    if (aheadCount > 0) {
      useMergeBase = true;
    }
  }

  let mode: "working" | "committed" = "working";
  let baseRef: string | undefined = wtHead || undefined;
  let diffTarget = "HEAD";
  let committedFiles: string[] = [];

  if (useMergeBase && mainHead && wtHead) {
    const mbRes = runGit(["merge-base", mainHead, "HEAD"], { cwd: targetDir });
    const mb = mbRes.exitCode === 0 ? mbRes.stdout.trim() : "";
    if (mb) {
      mode = "committed";
      baseRef = mb;
      diffTarget = mb;
      const nameOnlyRes = runGit(["diff", "--name-only", mb], { cwd: targetDir });
      if (nameOnlyRes.exitCode === 0) {
        committedFiles = filterIgnoredRelPaths(nameOnlyRes.stdout);
      }
    }
  }

  const workingChanged = getChangedFiles(targetDir);
  const changedFiles = Array.from(new Set([...committedFiles, ...workingChanged]));
  const statusRes = runGit(["status", "--short", "-uall"], { cwd: targetDir });
  const diffRes = runGit(["diff", diffTarget], { cwd: targetDir });

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
    mode,
    ...(baseRef ? { baseRef } : {}),
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

  const parseSavedDoneClaim = (fallbackSummary: string, changedFiles?: string[]): DoneClaim => {
    if (task.done_claim_json) {
      try {
        const parsed = JSON.parse(task.done_claim_json) as Partial<DoneClaim>;
        if (parsed && typeof parsed === "object") {
          return {
            summary: typeof parsed.summary === "string" && parsed.summary.trim() ? parsed.summary : fallbackSummary,
            changed_files: Array.isArray(parsed.changed_files) && parsed.changed_files.length > 0 ? parsed.changed_files : (changedFiles ?? allowedFiles),
            key_decisions: Array.isArray(parsed.key_decisions) ? parsed.key_decisions : ["Approved via manual review gate"],
            risks: Array.isArray(parsed.risks) ? parsed.risks : [],
            ...(Array.isArray(parsed.cross_scope_requests) ? { cross_scope_requests: parsed.cross_scope_requests } : {}),
          };
        }
      } catch {
        // Fallback below
      }
    }
    return {
      summary: fallbackSummary,
      changed_files: changedFiles ?? allowedFiles,
      key_decisions: ["Approved via manual review gate"],
      risks: [],
    };
  };

  const finalizeSessionAfterApproval = (): void => {
    const sessionRow = db.getSession(sessionId);
    if (!sessionRow) return;
    const allTasks = db.getSessionTasks(sessionId);
    const allDone = allTasks.length > 0 && allTasks.every((t) => t.status === "done");
    if (allDone) {
      db.updateSessionPhase(sessionId, "done");
      const updatedSession = db.getSession(sessionId) ?? sessionRow;
      const sessionDebates = db.getSessionDebates(sessionId);
      renderSessionSummaryMd(
        updatedSession,
        allTasks,
        sessionDebates,
        path.join(projectRoot, ".asd", "summary.md")
      );
      renderSessionSummaryMd(
        updatedSession,
        allTasks,
        sessionDebates,
        path.join(projectRoot, ".asd", "sessions", sessionId, "summary.md")
      );
      renderPlanMd(updatedSession, allTasks);
    } else {
      renderPlanMd(sessionRow, allTasks);
    }
  };

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
        parseSavedDoneClaim(`Approved and merged task ${task.task_id}: ${task.title}`, res.changedFiles),
        task.duration_ms ?? 0
      );
      finalizeSessionAfterApproval();
    }
    if ((res.status === "done" || res.status === "failed") && task.sub_session_id) {
      finalizeSubagentArtifacts({
        projectRoot,
        sessionId,
        subSessionId: task.sub_session_id,
      });
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
      parseSavedDoneClaim(`Approved and committed task ${task.task_id}: ${task.title}`, res.changedFiles),
      task.duration_ms ?? 0
    );
    finalizeSessionAfterApproval();
  }
  const finalLightStatus = res.status ?? (res.verified ? "done" : "failed");
  if ((finalLightStatus === "done" || finalLightStatus === "failed") && task.sub_session_id) {
    finalizeSubagentArtifacts({
      projectRoot,
      sessionId,
      subSessionId: task.sub_session_id,
    });
  }
  return {
    ok: res.verified,
    status: finalLightStatus,
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
}): { ok: boolean; status: TaskStatus; untouchedFiles?: string[] } {
  const { projectRoot, sessionId, taskId, db } = options;
  const task = db.getTask(sessionId, taskId);
  if (!task) {
    throw new Error(`Task not found: ${sessionId}/${taskId}`);
  }

  const wtPath =
    task.worktree_path ||
    path.join(projectRoot, ".asd", "wt", `${task.turn}-${task.task_id}`);
  const branchName = `asd/wt-${task.turn}-${task.task_id}`;

  let untouchedFiles: string[] | undefined;

  withFileMergeLockSync(projectRoot, `rejectPendingTask:${taskId}`, () => {
    if (task.track === "HEAVY" || fs.existsSync(wtPath)) {
      cleanupWorktree(projectRoot, wtPath, branchName, {
        forceBranchDelete: true,
      });
    } else {
      let allowedFiles: string[] = [];
      try {
        allowedFiles = JSON.parse(task.target_files_json || "[]");
      } catch {
        allowedFiles = [];
      }
      if (allowedFiles.length > 0 && !allowedFiles.includes("tests/**")) {
        allowedFiles = [...allowedFiles, "tests/**", "**/*.test.ts", "**/*.spec.ts"];
      }
      const allChanged = getChangedFiles(projectRoot);
      const partitioned = partitionFilesByScope(
        allChanged,
        allowedFiles,
        projectRoot
      );
      untouchedFiles = partitioned.untouchedFiles;
      rollbackLightChanges(projectRoot, { files: partitioned.scopedFiles });
    }
  });

  db.updateTaskStatus(sessionId, taskId, "failed");
  if (task.sub_session_id) {
    finalizeSubagentArtifacts({
      projectRoot,
      sessionId,
      subSessionId: task.sub_session_id,
    });
  }
  return {
    ok: true,
    status: "failed",
    ...(untouchedFiles !== undefined ? { untouchedFiles } : {}),
  };
}

// ============================================================================
// CR-12: Orphaned Task Recovery (recoverOrphanedTasks)
// ============================================================================

/**
 * Recovers running tasks whose subagent and owner processes have died:
 * - parallel_spawn / control_action: if both sub pid and ownerPid are dead -> failed (reason='orphaned'),
 *   updating meta.json.status='failed' and preserving worktree.
 * - claim_only: untouched (main AI may still be working on it).
 * - legacy / missing meta or dispatchMode: failed only if pid is dead and startedAt > 24 hours ago.
 */
export function recoverOrphanedTasks(input: {
  db: SqliteDriver;
  projectRoot: string;
  sessionId?: string;
  now?: number;
}): Array<{
  sessionId: string;
  taskId: string;
  from: TaskStatus;
  to: TaskStatus;
  reason: string;
}> {
  const now = input.now ?? Date.now();
  const projectRoot = path.resolve(input.projectRoot);
  const runningTasks = (
    input.sessionId
      ? input.db.getSessionTasks(input.sessionId)
      : input.db.getAllTasks()
  ).filter((t) => t.status === "running");

  const recovered: Array<{
    sessionId: string;
    taskId: string;
    from: TaskStatus;
    to: TaskStatus;
    reason: string;
  }> = [];

  for (const t of runningTasks) {
    const subagentsDir = path.join(
      projectRoot,
      ".asd",
      "sessions",
      t.session_id,
      "subagents"
    );
    let metaPath: string | null = null;
    if (t.sub_session_id) {
      const candidate = path.join(subagentsDir, t.sub_session_id, "meta.json");
      if (fs.existsSync(candidate)) {
        metaPath = candidate;
      }
    }
    if (!metaPath && fs.existsSync(subagentsDir)) {
      try {
        let bestStarted = -1;
        for (const entry of fs.readdirSync(subagentsDir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const p = path.join(subagentsDir, entry.name, "meta.json");
          if (!fs.existsSync(p)) continue;
          try {
            const parsed = JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
            if (parsed.taskId === t.task_id) {
              const s = typeof parsed.startedAt === "number" ? parsed.startedAt : 0;
              if (s >= bestStarted) {
                bestStarted = s;
                metaPath = p;
              }
            }
          } catch {
            // ignore
          }
        }
      } catch {
        // ignore
      }
    }

    let meta: Record<string, unknown> | null = null;
    if (metaPath && fs.existsSync(metaPath)) {
      try {
        meta = JSON.parse(fs.readFileSync(metaPath, "utf8")) as Record<string, unknown>;
      } catch {
        meta = null;
      }
    }

    const dispatchMode =
      typeof meta?.dispatchMode === "string" ? meta.dispatchMode : undefined;

    if (dispatchMode === "claim_only") {
      continue;
    }

    const subPid = typeof meta?.pid === "number" ? meta.pid : undefined;
    const ownerPid = typeof meta?.ownerPid === "number" ? meta.ownerPid : undefined;
    const subAlive = subPid !== undefined && subPid > 0 ? isPidAlive(subPid) : false;
    const ownerAlive =
      ownerPid !== undefined && ownerPid > 0 ? isPidAlive(ownerPid) : false;

    let shouldFail = false;
    if (
      dispatchMode === "parallel_spawn" ||
      dispatchMode === "control_action" ||
      dispatchMode === "debate"
    ) {
      if (!subAlive && !ownerAlive) {
        shouldFail = true;
      }
    } else {
      // Legacy or missing meta / dispatchMode: fail only if meta has a recorded startedAt > 24h ago and pid is dead
      const startedAt = typeof meta?.startedAt === "number" ? meta.startedAt : undefined;
      const twentyFourHoursMs = 24 * 60 * 60 * 1000;
      if (!subAlive && startedAt !== undefined && startedAt > 0 && now - startedAt > twentyFourHoursMs) {
        shouldFail = true;
      }
    }

    if (shouldFail) {
      if (meta && metaPath) {
        try {
          meta.status = "failed";
          meta.finishedAt = now;
          fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n", "utf8");
          const subId =
            typeof meta.subSessionId === "string"
              ? meta.subSessionId
              : path.basename(path.dirname(metaPath));
          finalizeSubagentArtifacts({
            projectRoot,
            sessionId: t.session_id,
            subSessionId: subId,
          });
        } catch {
          // ignore
        }
      }

      input.db.updateTaskStatus(t.session_id, t.task_id, "failed");
      input.db.incrementStateVersion(t.session_id);
      recovered.push({
        sessionId: t.session_id,
        taskId: t.task_id,
        from: "running",
        to: "failed",
        reason: "orphaned",
      });
    }
  }

  return recovered;
}
