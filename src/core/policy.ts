/**
 * ASD v2.3 Security Policy Engine (src/core/policy.ts)
 *
 * Implements:
 * 1. Ancestor-safe path resolution (`resolveSafeTargetPath`) using
 *    resolveExistingAncestorRealpath and normalizePathForCompare from config.ts
 *    to prevent jailbreaks and symlink traversal even when intermediate directories do not exist.
 * 2. Case-normalized protected path checks (.git/, .asd/, .env, *.pem, *.key, id_rsa).
 * 3. PreToolUse Hook guard (`evaluatePreToolUse`):
 *    - <1ms zero-DB read of ASD_SUBAGENT_META (meta.json).
 *    - Fail-closed if ASD_SESSION_ROLE === "subagent" and meta.json missing/unreadable.
 *    - Manifest-based write tool extraction and bash destructive/redirection inspection.
 * 4. Stop Hook guard (`evaluateStopHook`):
 *    - Subagent Shield: immediate allow without touching DB when subagent.
 *    - Main session 3-strike circuit breaker against no_progress_count in SQLite.
 * 5. Post-execution changed files boundary verification (`verifyChangedFilesBoundary`).
 *
 * Must NOT import anything from src/adapters/*.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  normalizePathForCompare,
  resolveAsdPaths,
} from "./config.ts";
import { SqliteDriver } from "./db.ts";
import type { SubagentSessionMeta } from "./types.ts";

// ============================================================================
// Manifest & Policy Types
// ============================================================================

export interface HarnessToolConfig {
  WriteTools: string[];
  BashTools: string[];
  FilePathKeys: string[];
}

export interface HarnessToolManifest {
  _asdVersion?: string;
  harnesses: Record<string, HarnessToolConfig>;
}

export const DEFAULT_HARNESS_TOOL_MANIFEST: HarnessToolManifest = {
  _asdVersion: "2.3.0",
  harnesses: {
    "claude-code": {
      WriteTools: ["Write", "Edit", "MultiEdit", "NotebookEdit"],
      BashTools: ["Bash"],
      FilePathKeys: [
        "tool_input.file_path",
        "tool_input.notebook_path",
        "file_path",
        "path",
      ],
    },
    opencode: {
      WriteTools: ["write", "edit", "patch", "multiedit"],
      BashTools: ["bash"],
      FilePathKeys: ["filePath", "file_path", "path", "target"],
    },
    codex: {
      WriteTools: ["apply_patch", "write_file", "edit_file"],
      BashTools: ["shell", "exec_command", "bash"],
      FilePathKeys: ["path", "file_path", "target_file"],
    },
    antigravity: {
      WriteTools: ["write_file", "edit_file"],
      BashTools: ["run_command"],
      FilePathKeys: ["Path", "TargetFile", "path", "file_path"],
    },
    cursor: {
      WriteTools: [
        "Write",
        "Edit",
        "StrReplace",
        "MultiEdit",
        "write_file",
        "edit_file",
        "apply_patch",
        "Delete",
      ],
      BashTools: ["Shell", "Bash", "run_terminal_cmd", "shell"],
      FilePathKeys: [
        "tool_input.file_path",
        "tool_input.path",
        "file_path",
        "path",
        "target_file",
        "filePath",
      ],
    },
  },
};

export interface SafePathResult {
  safe: boolean;
  resolvedPath: string;
  normalizedPath?: string;
  relativeToRoot?: string;
  reason?: string;
}

export interface ProtectedPathCheckResult {
  protected: boolean;
  reason?: string;
}

export interface PreToolUsePayload {
  harness?: string;
  toolName?: string;
  tool_name?: string;
  tool?: string;
  name?: string;
  tool_input?: Record<string, unknown>;
  input?: Record<string, unknown>;
  projectRoot?: string;
  [key: string]: unknown;
}

export interface PreToolUseResult {
  allowed: boolean;
  reason?: string;
}

export interface StopHookPayload {
  sessionId?: string;
  projectRoot?: string;
  roleType?: string;
  [key: string]: unknown;
}

export interface StopHookResult {
  decision: "allow" | "block";
  circuitBreakerTripped?: boolean;
  reason?: string;
}

export interface ChangedFilesBoundaryResult {
  valid: boolean;
  violations: string[];
}

// ============================================================================
// 1. Ancestor-Safe Path Resolution
// ============================================================================

/**
 * Resolves targetPath relative to rootDir, checking that the canonical normalized path
 * stays strictly inside rootDir even if intermediate directories do not exist yet.
 * Uses resolveExistingAncestorRealpath and normalizePathForCompare from config.ts.
 */
export function resolveSafeTargetPath(
  targetPath: string,
  rootDir: string
): SafePathResult {
  if (!targetPath || typeof targetPath !== "string") {
    return {
      safe: false,
      resolvedPath: "",
      reason: "Target path must be a non-empty string",
    };
  }

  if (targetPath.includes("\0")) {
    return {
      safe: false,
      resolvedPath: targetPath,
      reason: "Target path contains null byte",
    };
  }

  // Determine absolute target path
  const absTarget = path.isAbsolute(targetPath)
    ? path.normalize(targetPath)
    : path.resolve(rootDir, targetPath);

  // Normalize target and root for comparison (walks up existing ancestors with realpathSync.native)
  const normTarget = normalizePathForCompare(absTarget);
  const normRoot = normalizePathForCompare(rootDir);

  // Root prefix: ensure trailing slash to avoid matching sibling dirs with common prefixes
  const rootPrefix = normRoot.endsWith("/") ? normRoot : normRoot + "/";

  const isInside = normTarget === normRoot || normTarget.startsWith(rootPrefix);
  if (!isInside) {
    return {
      safe: false,
      resolvedPath: absTarget,
      normalizedPath: normTarget,
      reason: `Target path '${targetPath}' escapes root directory (${rootDir})`,
    };
  }

  return {
    safe: true,
    resolvedPath: absTarget,
    normalizedPath: normTarget,
    relativeToRoot: path.relative(rootDir, absTarget).replaceAll("\\", "/"),
  };
}

// ============================================================================
// 2. Protected Path & Secret File Checks
// ============================================================================

/**
 * Checks whether a relative path targets protected directories (.git/, .asd/)
 * or secret files (.env, *.pem, *.key, id_rsa). Case-normalized.
 */
export function checkProtectedPath(relPath: string): ProtectedPathCheckResult {
  const normalized = relPath.replaceAll("\\", "/").replace(/^\/+/, "");
  const segments = normalized.toLowerCase().split("/").filter(Boolean);
  if (segments.length === 0) {
    return { protected: false };
  }

  // 1. Any segment named .git
  if (segments.some((seg) => seg === ".git")) {
    return {
      protected: true,
      reason: `Protected path: target '${relPath}' is inside protected .git directory`,
    };
  }

  // 2. Any segment named .asd
  if (segments.some((seg) => seg === ".asd")) {
    return {
      protected: true,
      reason: `Protected path: target '${relPath}' is inside protected .asd directory`,
    };
  }

  const basename = (segments[segments.length - 1] ?? "").toLowerCase();

  // 3. .env or .env.*
  if (basename === ".env" || basename.startsWith(".env.")) {
    return {
      protected: true,
      reason: `Protected file: target '${relPath}' is a protected .env file`,
    };
  }

  // 4. *.pem
  if (basename.endsWith(".pem")) {
    return {
      protected: true,
      reason: `Protected file: target '${relPath}' is a protected PEM certificate/key`,
    };
  }

  // 5. *.key
  if (basename.endsWith(".key")) {
    return {
      protected: true,
      reason: `Protected file: target '${relPath}' is a protected private key`,
    };
  }

  // 6. id_rsa, id_rsa.*, id_ed25519*, id_ecdsa*
  if (
    basename === "id_rsa" ||
    basename.startsWith("id_rsa.") ||
    basename === "id_ed25519" ||
    basename.startsWith("id_ed25519.") ||
    basename === "id_ecdsa" ||
    basename.startsWith("id_ecdsa.")
  ) {
    return {
      protected: true,
      reason: `Protected file: target '${relPath}' is a protected SSH key`,
    };
  }

  return { protected: false };
}

export const isProtectedPath = checkProtectedPath;

// ============================================================================
// 3. Glob & Prefix Matcher for allowedFiles
// ============================================================================

/**
 * Matches target relative path against a glob or prefix pattern.
 * Case-normalized. Supports directory prefixes ("src/"), exact files, and globs ("*", "**").
 */
export function matchGlobOrPrefix(
  targetRelPath: string,
  pattern: string
): boolean {
  const target = targetRelPath
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .toLowerCase();

  const pat = pattern
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .toLowerCase();

  if (pat === "" || pat === "*" || pat === "**") {
    return true;
  }

  // Exact match
  if (target === pat) {
    return true;
  }

  // Directory prefix match: if pat ends with /
  if (pat.endsWith("/")) {
    return target.startsWith(pat);
  }

  // If pat has no wildcards, it may match directory without trailing slash
  if (!pat.includes("*") && !pat.includes("?")) {
    return target.startsWith(pat + "/");
  }

  // Glob matching via Node built-in path.posix.matchesGlob
  try {
    return path.posix.matchesGlob(target, pat);
  } catch {
    return false;
  }
}

export function isPathAllowed(
  relPath: string,
  allowedFiles: string[]
): boolean {
  if (!allowedFiles || allowedFiles.length === 0) {
    return false;
  }
  return allowedFiles.some((pat) => matchGlobOrPrefix(relPath, pat));
}

// ============================================================================
// 4. PreToolUse Hook Evaluator (1ms zero-DB guard)
// ============================================================================

function getNestedValue(
  obj: Record<string, unknown>,
  pathStr: string
): unknown {
  const parts = pathStr.split(".");
  let cur: unknown = obj;
  for (const part of parts) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function extractFilePaths(
  payload: PreToolUsePayload,
  filePathKeys: string[]
): string[] {
  const paths: string[] = [];
  const input = (payload.tool_input ?? payload.input ?? {}) as Record<
    string,
    unknown
  >;

  for (const key of filePathKeys) {
    const valFromPayload = getNestedValue(
      payload as Record<string, unknown>,
      key
    );
    if (typeof valFromPayload === "string" && valFromPayload.trim() !== "") {
      paths.push(valFromPayload.trim());
    } else if (Array.isArray(valFromPayload)) {
      for (const item of valFromPayload) {
        if (typeof item === "string" && item.trim() !== "") {
          paths.push(item.trim());
        }
      }
    }

    if (!key.includes(".")) {
      const valFromInput = getNestedValue(input, key);
      if (typeof valFromInput === "string" && valFromInput.trim() !== "") {
        paths.push(valFromInput.trim());
      } else if (Array.isArray(valFromInput)) {
        for (const item of valFromInput) {
          if (typeof item === "string" && item.trim() !== "") {
            paths.push(item.trim());
          }
        }
      }
    }
  }

  return Array.from(new Set(paths));
}

function extractBashCommand(payload: PreToolUsePayload): string {
  const input = (payload.tool_input ?? payload.input ?? payload) as Record<
    string,
    unknown
  >;
  const candidates = [
    input.command,
    input.cmd,
    input.CommandLine,
    input.commandLine,
    input.script,
    payload.command,
    payload.cmd,
    payload.CommandLine,
  ];
  for (const c of candidates) {
    if (typeof c === "string") return c;
  }
  return "";
}

/**
 * Evaluates PreToolUse hook requests in <1ms without opening SQLite.
 * Fail-closed if ASD_SESSION_ROLE === "subagent" and meta.json is missing or unreadable.
 */
export function evaluatePreToolUse(
  payload: PreToolUsePayload,
  manifest?: HarnessToolManifest,
  env?: Record<string, string | undefined>
): PreToolUseResult {
  const activeEnv = env ?? process.env;
  const isSubagent = activeEnv.ASD_SESSION_ROLE === "subagent";
  const manifestConfig = manifest ?? DEFAULT_HARNESS_TOOL_MANIFEST;

  // 1. Subagent fail-closed meta.json check
  let meta: SubagentSessionMeta | undefined;
  if (isSubagent) {
    const metaPath = activeEnv.ASD_SUBAGENT_META;
    if (!metaPath) {
      return {
        allowed: false,
        reason:
          "Fail-closed: ASD_SESSION_ROLE is subagent but ASD_SUBAGENT_META is not set",
      };
    }
    try {
      const raw = fs.readFileSync(metaPath, "utf8");
      meta = JSON.parse(raw) as SubagentSessionMeta;
    } catch (err) {
      return {
        allowed: false,
        reason: `Fail-closed: failed to read subagent meta.json at ${metaPath}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }
  } else if (activeEnv.ASD_SUBAGENT_META) {
    try {
      const raw = fs.readFileSync(activeEnv.ASD_SUBAGENT_META, "utf8");
      meta = JSON.parse(raw) as SubagentSessionMeta;
    } catch {
      // Ignore for non-subagent
    }
  }

  const toolName = (
    payload.toolName ??
    payload.tool_name ??
    payload.tool ??
    payload.name ??
    ""
  ).toString();

  const harnessId = (payload.harness ?? meta?.harness ?? "") as string;
  let harnessTools: HarnessToolConfig | undefined;
  if (harnessId && manifestConfig.harnesses[harnessId]) {
    harnessTools = manifestConfig.harnesses[harnessId];
  }

  const rootDir =
    meta?.worktreePath ??
    payload.projectRoot ??
    activeEnv.ASD_PROJECT_ROOT ??
    process.cwd();

  // 2. Check if tool is BashTool
  const isBashTool = harnessTools
    ? harnessTools.BashTools.some(
        (bt) => bt.toLowerCase() === toolName.toLowerCase()
      )
    : Object.values(manifestConfig.harnesses).some((h) =>
        h.BashTools.some((bt) => bt.toLowerCase() === toolName.toLowerCase())
      );

  if (isBashTool) {
    const cmd = extractBashCommand(payload);
    const cmdLower = cmd.toLowerCase();

    // Protect .git corruption for both host and subagent
    if (
      cmdLower.includes(".git/") ||
      cmdLower.includes(".git\\") ||
      /(?:^|[\s"'`/\\])\.git(?:[/\\]|[\s"'`]|$)/.test(cmdLower)
    ) {
      return {
        allowed: false,
        reason: "Bash command blocked: targets protected .git directory",
      };
    }

    if (isSubagent) {
      if (
        cmdLower.includes(".asd/") ||
        cmdLower.includes(".asd\\") ||
        /(?:^|[\s"'`/\\])\.asd(?:[/\\]|[\s"'`]|$)/.test(cmdLower)
      ) {
        return {
          allowed: false,
          reason:
            "Bash command blocked for subagent: targets protected .asd directory",
        };
      }
      if (cmdLower.includes(".env")) {
        return {
          allowed: false,
          reason: "Bash command blocked for subagent: targets protected .env file",
        };
      }
      // Block redirection writes: > or >> (excluding 2>&1 and >&2)
      if (cmd.includes(">>") || /(?:^|[^2&])>{1}(?!&)/.test(cmd)) {
        return {
          allowed: false,
          reason:
            "Bash command blocked for subagent: output redirection (>, >>) is forbidden",
        };
      }
      // Block destructive commands
      if (/\b(?:rm|rmdir|del|erase|mv|move)\b/i.test(cmd)) {
        return {
          allowed: false,
          reason:
            "Bash command blocked for subagent: destructive command (rm, del, mv) is forbidden",
        };
      }
    }

    return { allowed: true };
  }

  // 3. Check if tool is WriteTool
  const isWriteTool = harnessTools
    ? harnessTools.WriteTools.some(
        (wt) => wt.toLowerCase() === toolName.toLowerCase()
      )
    : Object.values(manifestConfig.harnesses).some((h) =>
        h.WriteTools.some((wt) => wt.toLowerCase() === toolName.toLowerCase())
      );

  if (!isWriteTool) {
    return { allowed: true };
  }

  // 4. WriteTool: extract target file paths
  const filePathKeys = harnessTools
    ? harnessTools.FilePathKeys
    : Array.from(
        new Set(
          Object.values(manifestConfig.harnesses).flatMap(
            (h) => h.FilePathKeys
          )
        )
      );

  const targetPaths = extractFilePaths(payload, filePathKeys);
  if (targetPaths.length === 0) {
    return {
      allowed: false,
      reason:
        "Write tool detected but target file path could not be extracted",
    };
  }

  // 5. Verify each target path
  for (const targetPath of targetPaths) {
    const safeCheck = resolveSafeTargetPath(targetPath, rootDir);
    if (!safeCheck.safe) {
      return {
        allowed: false,
        reason:
          safeCheck.reason ??
          `Target path '${targetPath}' escapes root directory`,
      };
    }

    const relPath = path
      .relative(rootDir, safeCheck.resolvedPath)
      .replaceAll("\\", "/");

    const protCheck = checkProtectedPath(relPath);
    if (protCheck.protected) {
      return {
        allowed: false,
        reason:
          protCheck.reason ?? `Target path '${relPath}' is a protected path`,
      };
    }

    if (isSubagent && meta) {
      if (!meta.allowedFiles || meta.allowedFiles.length === 0) {
        return {
          allowed: false,
          reason: `Target path '${relPath}' is blocked: subagent allowedFiles is empty`,
        };
      }
      const allowed = isPathAllowed(relPath, meta.allowedFiles);
      if (!allowed) {
        return {
          allowed: false,
          reason: `Target path '${relPath}' is outside allowedFiles boundary`,
        };
      }
    }
  }

  return { allowed: true };
}

// ============================================================================
// 5. Stop Hook Evaluator (Subagent Shield & 3-strike breaker)
// ============================================================================

/**
 * Evaluates Stop hook requests.
 * - Subagent Shield: immediate allow when subagent without touching DB.
 * - Main session: blocks while pending/running tasks remain until no_progress_count >= 3.
 */
export function evaluateStopHook(
  payload: StopHookPayload,
  env?: Record<string, string | undefined>,
  db?: SqliteDriver
): StopHookResult {
  const activeEnv = env ?? process.env;

  // Subagent Shield: env check
  if (activeEnv.ASD_SESSION_ROLE === "subagent") {
    return { decision: "allow" };
  }

  // Subagent Shield: payload check
  if (payload.roleType === "subagent") {
    return { decision: "allow" };
  }

  // Subagent Shield: meta.json check without opening SQLite
  const metaPath = activeEnv.ASD_SUBAGENT_META;
  if (metaPath) {
    try {
      const raw = fs.readFileSync(metaPath, "utf8");
      const meta = JSON.parse(raw);
      if (meta.roleType === "subagent") {
        return { decision: "allow" };
      }
    } catch {
      // Ignore read failure for stop hook
    }
  }

  // Main session: check SQLite sessions and tasks
  const sessionId =
    payload.sessionId ??
    activeEnv.ASD_MAIN_SESSION_ID ??
    activeEnv.ASD_SESSION_ID;

  if (!sessionId) {
    return { decision: "allow" };
  }

  let driver = db;
  let ownedDriver = false;

  if (!driver) {
    const projectRoot =
      payload.projectRoot ?? activeEnv.ASD_PROJECT_ROOT ?? process.cwd();
    const paths = resolveAsdPaths(projectRoot);
    if (!fs.existsSync(paths.dbPath)) {
      return { decision: "allow" };
    }
    driver = new SqliteDriver(paths.dbPath);
    ownedDriver = true;
  }

  try {
    const session = driver.getSession(sessionId);
    if (!session) {
      return { decision: "allow", reason: `Session not found: ${sessionId}` };
    }

    if (session.phase === "done") {
      return { decision: "allow", reason: "Session phase is done" };
    }

    const tasks = driver.getSessionTasks(sessionId);
    const unfinishedTasks = tasks.filter(
      (t) =>
        t.status === "pending" ||
        t.status === "running" ||
        t.status === "verifying"
    );

    if (unfinishedTasks.length === 0) {
      return { decision: "allow", reason: "All tasks are completed" };
    }

    // 3-strike circuit breaker
    if (session.no_progress_count >= 3) {
      return {
        decision: "allow",
        circuitBreakerTripped: true,
        reason: `Circuit breaker tripped after ${session.no_progress_count} no-progress attempts with ${unfinishedTasks.length} unfinished tasks`,
      };
    }

    driver.incrementNoProgress(sessionId);
    const newCount = session.no_progress_count + 1;
    return {
      decision: "block",
      reason: `Unfinished tasks remain (${unfinishedTasks.length} pending/running). Attempt ${newCount}/3 before circuit breaker.`,
    };
  } finally {
    if (ownedDriver && driver) {
      driver.close();
    }
  }
}

// ============================================================================
// 6. Post-execution Changed Files Boundary Verification
// ============================================================================

/**
 * Post-execution verification helper used by asd_verify to inspect
 * changed files from git status against allowedFiles and protected paths.
 */
export function verifyChangedFilesBoundary(
  changedFiles: string[],
  allowedFiles: string[],
  rootDir: string
): ChangedFilesBoundaryResult {
  const violations: string[] = [];

  for (const file of changedFiles) {
    if (!file || file.trim() === "") continue;

    const safeCheck = resolveSafeTargetPath(file, rootDir);
    if (!safeCheck.safe) {
      violations.push(
        `File '${file}' escapes rootDir (${rootDir}): ${
          safeCheck.reason ?? "outside root"
        }`
      );
      continue;
    }

    const relPath = path
      .relative(rootDir, safeCheck.resolvedPath)
      .replaceAll("\\", "/");

    const protCheck = checkProtectedPath(relPath);
    if (protCheck.protected) {
      violations.push(
        `File '${file}' targets protected path: ${protCheck.reason}`
      );
      continue;
    }

    if (allowedFiles && allowedFiles.length > 0) {
      const allowed = isPathAllowed(relPath, allowedFiles);
      if (!allowed) {
        violations.push(
          `File '${file}' ('${relPath}') is outside allowedFiles boundary [${allowedFiles.join(
            ", "
          )}]`
        );
      }
    }
  }

  return {
    valid: violations.length === 0,
    violations,
  };
}
