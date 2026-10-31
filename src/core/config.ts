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
import { ASD_VERSION, type RoutingConfig } from "./types.ts";

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
    const content = fs.readFileSync(presetPath, "utf8").replace(/"_asdVersion":\s*"[^"]*"/, `"_asdVersion": "${ASD_VERSION}"`);
    fs.writeFileSync(paths.globalRoutingPath, content, "utf8");
  }
  return parseJsonc<RoutingConfig>(
    fs.readFileSync(paths.globalRoutingPath, "utf8")
  );
}

/**
 * Resolves the path to git exclude file for both normal repositories (.git/info/exclude)
 * and worktrees (.git/worktrees/<wt>/info/exclude or linked gitdir).
 */
export function getGitExcludePath(dir: string): string | null {
  const gitPath = path.join(dir, ".git");
  if (!fs.existsSync(gitPath)) return null;

  try {
    const stat = fs.statSync(gitPath);
    let gitDir = gitPath;
    if (stat.isFile()) {
      const content = fs.readFileSync(gitPath, "utf8");
      const match = content.match(/^gitdir:\s*(.+)$/m);
      if (match && match[1]) {
        gitDir = path.resolve(dir, match[1].trim());
      }
    }
    return path.join(gitDir, "info", "exclude");
  } catch {
    return null;
  }
}

/**
 * Ensures a specific pattern is added to git exclude if not already present.
 */
export function ensureGitExclude(dir: string, pattern: string): void {
  const excludePath = getGitExcludePath(dir);
  if (!excludePath) return;

  try {
    fs.mkdirSync(path.dirname(excludePath), { recursive: true });
    let content = "";
    if (fs.existsSync(excludePath)) {
      content = fs.readFileSync(excludePath, "utf8");
      const lines = content.split(/\r?\n/).map((l) => l.trim());
      if (lines.includes(pattern.trim())) return;
    }
    const sep = content === "" || content.endsWith("\n") ? "" : "\n";
    fs.writeFileSync(excludePath, `${content}${sep}${pattern.trim()}\n`, "utf8");
  } catch {
    // best-effort
  }
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
  ensureGitExclude(projectRoot, ".asd/");
}

// ============================================================================
// Version Comparison & Cached Remote Update Check
// ============================================================================

export const DEFAULT_REMOTE_PKG_URL =
  "https://raw.githubusercontent.com/yjsjs0987/agent-swarm-director/main/package.json";
const UPDATE_CHECK_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

export interface UpdateCheckNotice {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  checkedAt: number;
}

export function compareSemver(a: string, b: string): number {
  const cleanA = a.replace(/^v/i, "").trim().split("-")[0] ?? "";
  const cleanB = b.replace(/^v/i, "").trim().split("-")[0] ?? "";
  const partsA = cleanA.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const partsB = cleanB.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const len = Math.max(partsA.length, partsB.length, 3);
  for (let i = 0; i < len; i++) {
    const va = partsA[i] ?? 0;
    const vb = partsB[i] ?? 0;
    if (va < vb) return -1;
    if (va > vb) return 1;
  }
  return 0;
}

function getUpdateCachePath(homeDir?: string): string {
  const home = homeDir || process.env.ASD_HOME_DIR || os.homedir();
  return path.join(home, ".asd", "state", "update-check.json");
}

export function readCachedUpdateNotice(homeDir?: string): UpdateCheckNotice | null {
  try {
    const cachePath = getUpdateCachePath(homeDir);
    if (!fs.existsSync(cachePath)) return null;
    const raw = JSON.parse(fs.readFileSync(cachePath, "utf8")) as {
      latestVersion?: string;
      checkedAt?: number;
    };
    if (typeof raw.latestVersion !== "string" || !raw.latestVersion.trim()) {
      return null;
    }
    const latestVersion = raw.latestVersion.trim();
    return {
      currentVersion: ASD_VERSION,
      latestVersion,
      updateAvailable: compareSemver(ASD_VERSION, latestVersion) < 0,
      checkedAt: typeof raw.checkedAt === "number" ? raw.checkedAt : 0,
    };
  } catch {
    return null;
  }
}

export async function checkForRemoteUpdate(options?: {
  homeDir?: string;
  force?: boolean;
  timeoutMs?: number;
  remoteUrl?: string;
}): Promise<{
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
}> {
  const cached = readCachedUpdateNotice(options?.homeDir);
  if (
    !options?.force &&
    cached &&
    Date.now() - cached.checkedAt < UPDATE_CHECK_TTL_MS
  ) {
    return {
      currentVersion: ASD_VERSION,
      latestVersion: cached.latestVersion,
      updateAvailable: cached.updateAvailable,
    };
  }

  const url =
    options?.remoteUrl ||
    process.env.ASD_UPDATE_CHECK_URL ||
    DEFAULT_REMOTE_PKG_URL;
  const isTempTestHome =
    !options?.force &&
    !options?.remoteUrl &&
    !process.env.ASD_UPDATE_CHECK_URL &&
    Boolean(
      options?.homeDir &&
        path
          .resolve(options.homeDir)
          .toLowerCase()
          .startsWith(path.resolve(os.tmpdir()).toLowerCase())
    );
  if (isTempTestHome) {
    return {
      currentVersion: ASD_VERSION,
      latestVersion: cached?.latestVersion ?? null,
      updateAvailable: cached?.updateAvailable ?? false,
    };
  }
  const timeoutMs = options?.timeoutMs ?? 1500;

  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      return {
        currentVersion: ASD_VERSION,
        latestVersion: cached?.latestVersion ?? null,
        updateAvailable: cached?.updateAvailable ?? false,
      };
    }
    const pkg = (await res.json()) as { version?: string };
    const latestVersion =
      typeof pkg.version === "string" && pkg.version.trim()
        ? pkg.version.trim()
        : null;
    if (!latestVersion) {
      return {
        currentVersion: ASD_VERSION,
        latestVersion: null,
        updateAvailable: false,
      };
    }

    const cachePath = getUpdateCachePath(options?.homeDir);
    try {
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      fs.writeFileSync(
        cachePath,
        JSON.stringify({ latestVersion, checkedAt: Date.now() }, null, 2) + "\n",
        "utf8"
      );
    } catch {
      // Ignore cache write errors
    }

    return {
      currentVersion: ASD_VERSION,
      latestVersion,
      updateAvailable: compareSemver(ASD_VERSION, latestVersion) < 0,
    };
  } catch {
    return {
      currentVersion: ASD_VERSION,
      latestVersion: cached?.latestVersion ?? null,
      updateAvailable: cached?.updateAvailable ?? false,
    };
  }
}

export function formatTerminalUpdateBanner(
  currentVersion: string,
  latestVersion: string
): string {
  const line1 = `💡 ASD update available: v${currentVersion} -> v${latestVersion}`;
  const line2 = `Run \`asd update\` to download the latest version and sync configs.`;
  return [
    "",
    "╭────────────────────────────────────────────────────────────────────╮",
    `│ ${line1.padEnd(65, " ")} │`,
    `│ ${line2.padEnd(66, " ")} │`,
    "╰────────────────────────────────────────────────────────────────────╯",
  ].join("\n");
}
