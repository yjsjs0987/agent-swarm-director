/**
 * ASD v2.2 2-Path configuration.
 *
 * globalStateDir (~/.asd): SQLite DB + global routing/mcp config only.
 * localViewDir (<project>/.asd): PLAN.md, sessions, worktrees, local routing override.
 *
 * <project-hash> is case-normalized (win32/darwin) so `C:\Proj` and `c:/proj/`
 * hash identically — blocks case-swap security bypasses (.GIT/, .Asd/, .ENV).
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseJsonc } from "./jsonc.ts";
import type { RoutingConfig } from "./types.ts";

/**
 * Resolve the closest EXISTING ancestor of targetPath via realpathSync.native,
 * then re-join the remaining (possibly non-existent) segments.
 * Never throws ENOENT; if even the root doesn't exist, returns input unchanged.
 */
export function resolveExistingAncestorRealpath(targetPath: string): string {
  let current = path.resolve(targetPath);
  const remainder: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native(current);
      return remainder.length === 0
        ? real
        : path.resolve(real, ...[...remainder].reverse());
    } catch {
      // Ancestor missing/unreadable — walk up one segment.
    }
    const parent = path.dirname(current);
    if (parent === current) return targetPath; // reached root without a hit
    remainder.push(path.basename(current));
    current = parent;
  }
}

/**
 * Normalize a path for comparison/hashing:
 * realpath-resolve, `\` → `/`, strip trailing `/` (bare roots kept),
 * lowercase on win32/darwin.
 */
export function normalizePathForCompare(p: string): string {
  const real = resolveExistingAncestorRealpath(p);
  let s = real.replaceAll("\\", "/");
  if (s.length > 1 && s.endsWith("/")) {
    const stripped = s.replace(/\/+$/, "");
    if (stripped === "") s = "/"; // bare POSIX root
    else if (/^[A-Za-z]:$/.test(stripped)) s = stripped + "/"; // bare drive root
    else s = stripped;
  }
  if (process.platform === "win32" || process.platform === "darwin") {
    s = s.toLowerCase();
  }
  return s;
}

/** <project-hash> = sha256(normalizedRoot).hex.slice(0, 12) */
export function computeProjectHash(projectRoot: string): string {
  return crypto
    .createHash("sha256")
    .update(normalizePathForCompare(projectRoot))
    .digest("hex")
    .slice(0, 12);
}

export interface AsdPaths {
  projectHash: string;
  /** <home>/.asd — global DB + global config only */
  globalStateDir: string;
  dbPath: string;
  lastSyncPath: string;
  globalRoutingPath: string;
  globalMcpPath: string;
  /** <projectRoot>/.asd — docs view, sessions, worktrees */
  localViewDir: string;
  localRoutingPath: string;
  planMdPath: string;
  worktreesDir: string;
  sessionsDir: string;
}

/** Resolve the 2-Path layout for a project. Pure computation; creates nothing. */
export function resolveAsdPaths(projectRoot: string, homeDir?: string): AsdPaths {
  const home = homeDir ?? os.homedir();
  const projectHash = computeProjectHash(projectRoot);
  const globalStateDir = path.join(home, ".asd");
  const localViewDir = path.join(projectRoot, ".asd");
  return {
    projectHash,
    globalStateDir,
    dbPath: path.join(globalStateDir, "state", projectHash, "core.db"),
    lastSyncPath: path.join(globalStateDir, "state", "last-sync.json"),
    globalRoutingPath: path.join(globalStateDir, "routing.jsonc"),
    globalMcpPath: path.join(globalStateDir, "mcp.jsonc"),
    localViewDir,
    localRoutingPath: path.join(localViewDir, "routing.jsonc"),
    planMdPath: path.join(localViewDir, "PLAN.md"),
    worktreesDir: path.join(localViewDir, "wt"),
    sessionsDir: path.join(localViewDir, "sessions"),
  };
}

/**
 * Load routing config. Owner Decision #3:
 * 1st priority: <projectRoot>/.asd/routing.jsonc (local override).
 * Fallback: <home>/.asd/routing.jsonc, bootstrapped from presets/default-routing.jsonc
 * on first use (parent dirs created, preset content copied).
 */
export function loadRoutingConfig(
  projectRoot: string,
  homeDir?: string
): RoutingConfig {
  const paths = resolveAsdPaths(projectRoot, homeDir);
  if (fs.existsSync(paths.localRoutingPath)) {
    return parseJsonc<RoutingConfig>(
      fs.readFileSync(paths.localRoutingPath, "utf8")
    );
  }
  if (!fs.existsSync(paths.globalRoutingPath)) {
    const presetPath = path.join(
      import.meta.dirname,
      "..",
      "..",
      "presets",
      "default-routing.jsonc"
    );
    fs.mkdirSync(path.dirname(paths.globalRoutingPath), { recursive: true });
    fs.copyFileSync(presetPath, paths.globalRoutingPath);
  }
  return parseJsonc<RoutingConfig>(
    fs.readFileSync(paths.globalRoutingPath, "utf8")
  );
}

/**
 * Lazy Project Auto-Init: create <project>/.asd/{wt,sessions} and
 * <home>/.asd/state/<hash>/, and register `.asd/` in .git/info/exclude
 * when the project is a git repo. Idempotent.
 */
export function ensureProjectInitialized(
  projectRoot: string,
  homeDir?: string
): void {
  const paths = resolveAsdPaths(projectRoot, homeDir);
  fs.mkdirSync(paths.worktreesDir, { recursive: true });
  fs.mkdirSync(paths.sessionsDir, { recursive: true });
  fs.mkdirSync(path.dirname(paths.dbPath), { recursive: true });

  const gitInfoDir = path.join(projectRoot, ".git", "info");
  if (!fs.existsSync(gitInfoDir)) return;
  const excludePath = path.join(gitInfoDir, "exclude");
  let content = "";
  if (fs.existsSync(excludePath)) {
    content = fs.readFileSync(excludePath, "utf8");
    if (content.split(/\r?\n/).some((l) => l.trim() === ".asd/")) return;
  }
  const sep = content === "" || content.endsWith("\n") ? "" : "\n";
  fs.writeFileSync(excludePath, `${content}${sep}.asd/\n`);
}
