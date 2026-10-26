#!/usr/bin/env node
process.env.NODE_NO_WARNINGS = "1";

/**
 * ASD v2.2 Unified Terminal CLI & Internal Hook Runner (src/cli/index.ts)
 *
 * Implements 5 User Commands + 2 Internal Runners:
 * 1. asd sync [--force] [--home <dir>]:
 *    - Calls runAsdSync (installer.ts) to deploy global-only configurations.
 * 2. asd status [--json]:
 *    - Reads active session & tasks from SQLite; renders live progress board.
 *    - Detects unapplied auto-stash and prints warning.
 * 3. asd doctor [--json]:
 *    - Runs fast zero-token diagnostic probe (runAsdDoctor); exits 0 if healthy, 1 on error.
 * 4. asd clean [--pop] [--all]:
 *    - Cleans leftover .asd/wt/* worktrees and runs git worktree prune.
 *    - Deletes orphaned asd/wt-* branches.
 *    - With --pop: restores auto-stashed work and clears stashed_work_sha in SQLite.
 * 5. asd uninstall [--home <dir>]:
 *    - Calls runAsdUninstall (installer.ts) to surgically restore user configurations.
 * 6. asd hook <pre-tool-use|stop> [--harness <id>]:
 *    - Evaluates policy guards and formats output per target harness adapter.
 * 7. asd mcp:
 *    - Starts AsdMcpServer stdio JSON-RPC transport.
 *
 * Invariants:
 * - Erasable TypeScript only (zero enums, type-only imports where applicable).
 * - Zero external runtime npm dependencies.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { antigravityAdapter } from "../adapters/antigravity.ts";
import { claudeCodeAdapter } from "../adapters/claude-code.ts";
import { codexAdapter } from "../adapters/codex.ts";
import {
  runAsdDoctor,
  runAsdSync,
  runAsdUninstall,
} from "../adapters/installer.ts";
import { opencodeAdapter } from "../adapters/opencode.ts";
import { resolveAsdPaths } from "../core/config.ts";
import {
  openProjectDb,
  type SessionRow,
  type SqliteDriver,
  type TaskRow,
} from "../core/db.ts";
import {
  DEFAULT_HARNESS_TOOL_MANIFEST,
  evaluatePreToolUse,
  evaluateStopHook,
  type PreToolUsePayload,
  type StopHookPayload,
} from "../core/policy.ts";
import { renderProgressBoard } from "../core/render.ts";
import {
  ASD_VERSION,
  type HarnessAdapter,
  type HarnessId,
} from "../core/types.ts";
import { cleanupWorktree, runGit } from "../core/workspace.ts";

// ============================================================================
// CLI Argument Parsing
// ============================================================================

export interface CliArgs {
  command: string;
  subcommand?: string;
  flags: {
    force?: boolean;
    json?: boolean;
    pop?: boolean;
    all?: boolean;
    help?: boolean;
    version?: boolean;
  };
  options: {
    home?: string;
    harness?: string;
    payload?: string;
    projectRoot?: string;
  };
  rest: string[];
}

export function parseCliArgs(args: string[]): CliArgs {
  const flags: CliArgs["flags"] = {};
  const options: CliArgs["options"] = {};
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      flags.help = true;
    } else if (arg === "--version" || arg === "-v") {
      flags.version = true;
    } else if (arg === "--force") {
      flags.force = true;
    } else if (arg === "--json") {
      flags.json = true;
    } else if (arg === "--pop") {
      flags.pop = true;
    } else if (arg === "--all") {
      flags.all = true;
    } else if (arg === "--home") {
      options.home = args[++i];
    } else if (arg.startsWith("--home=")) {
      options.home = arg.substring("--home=".length);
    } else if (arg === "--harness") {
      options.harness = args[++i];
    } else if (arg.startsWith("--harness=")) {
      options.harness = arg.substring("--harness=".length);
    } else if (arg === "--payload") {
      options.payload = args[++i];
    } else if (arg.startsWith("--payload=")) {
      options.payload = arg.substring("--payload=".length);
    } else if (arg === "--project-root" || arg === "--projectRoot") {
      options.projectRoot = args[++i];
    } else if (
      arg.startsWith("--project-root=") ||
      arg.startsWith("--projectRoot=")
    ) {
      const idx = arg.indexOf("=");
      options.projectRoot = arg.substring(idx + 1);
    } else if (arg.startsWith("-")) {
      // unrecognized flag; ignore
    } else {
      positional.push(arg);
    }
  }

  const command = positional[0] || "";
  const subcommand = positional[1];
  const rest = positional.slice(2);

  return { command, subcommand, flags, options, rest };
}

// ============================================================================
// Stdin Reader Helper
// ============================================================================

export function readStdin(): string {
  if (process.stdin.isTTY) {
    return "";
  }
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

// ============================================================================
// Adapter Resolver Helper
// ============================================================================

export function getAdapter(harnessId?: string): HarnessAdapter {
  switch (harnessId) {
    case "claude-code":
      return claudeCodeAdapter;
    case "opencode":
      return opencodeAdapter;
    case "codex":
      return codexAdapter;
    case "antigravity":
      return antigravityAdapter;
    default:
      return claudeCodeAdapter;
  }
}

// ============================================================================
// Latest Session Query Helper
// ============================================================================

export function getLatestSession(db: SqliteDriver): SessionRow | undefined {
  if (typeof (db as unknown as { getLatestSession?: () => SessionRow | undefined }).getLatestSession === "function") {
    return (db as unknown as { getLatestSession: () => SessionRow | undefined }).getLatestSession();
  }
  try {
    const rawDb = (db as unknown as { db: DatabaseSync }).db;
    return rawDb
      .prepare("SELECT * FROM sessions ORDER BY created_at DESC LIMIT 1")
      .get() as unknown as SessionRow | undefined;
  } catch {
    return undefined;
  }
}

// ============================================================================
// Workspace Cleanup Engine (`asd clean`)
// ============================================================================

export interface CleanResult {
  worktreesRemoved: string[];
  branchesDeleted: string[];
  stashPopped: boolean;
  stashSha?: string;
  message?: string;
}

export function runAsdClean(options?: {
  pop?: boolean;
  all?: boolean;
  projectRoot?: string;
  homeDir?: string;
}): CleanResult {
  const projectRoot = path.resolve(options?.projectRoot || process.cwd());
  const homeDir = options?.homeDir;
  const worktreesRemoved: string[] = [];
  const branchesDeleted: string[] = [];
  let stashPopped = false;
  let stashSha: string | undefined;

  // 1. Clean leftover .asd/wt/* worktrees
  const wtBaseDir = path.join(projectRoot, ".asd", "wt");
  if (fs.existsSync(wtBaseDir)) {
    try {
      const entries = fs.readdirSync(wtBaseDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const wtPath = path.join(wtBaseDir, entry.name);
          cleanupWorktree(projectRoot, wtPath, undefined, {
            forceBranchDelete: true,
          });
          worktreesRemoved.push(entry.name);
        }
      }
    } catch {
      // ignore directory read issues
    }
  }

  // Check git worktree list for any lingering worktrees pointing inside .asd/wt
  try {
    const wtListRes = runGit(["worktree", "list", "--porcelain"], {
      cwd: projectRoot,
    });
    if (wtListRes.exitCode === 0) {
      const lines = wtListRes.stdout.split("\n");
      for (const line of lines) {
        if (line.startsWith("worktree ")) {
          const wtPath = line.substring("worktree ".length).trim();
          const normalized = wtPath.replace(/\\/g, "/");
          if (normalized.includes("/.asd/wt/")) {
            cleanupWorktree(projectRoot, wtPath, undefined, {
              forceBranchDelete: true,
            });
            const name = path.basename(wtPath);
            if (!worktreesRemoved.includes(name)) {
              worktreesRemoved.push(name);
            }
          }
        }
      }
    }
  } catch {
    // ignore
  }

  // Prune git worktree metadata
  runGit(["worktree", "prune"], { cwd: projectRoot });

  // 2. Delete orphaned asd/wt-* branches
  try {
    const branchRes = runGit(["branch", "--list", "asd/wt-*"], {
      cwd: projectRoot,
    });
    if (branchRes.exitCode === 0) {
      const lines = branchRes.stdout.split("\n");
      for (const rawLine of lines) {
        const branchName = rawLine.replace(/^\*?\s+/, "").trim();
        if (branchName && branchName.startsWith("asd/wt-")) {
          const delRes = runGit(["branch", "-D", branchName], {
            cwd: projectRoot,
          });
          if (delRes.exitCode === 0) {
            branchesDeleted.push(branchName);
          }
        }
      }
    }
  } catch {
    // ignore
  }

  // 3. When --pop flag is passed: inspect session's stashed_work_sha & restore
  if (options?.pop) {
    let db: SqliteDriver | undefined;
    try {
      const paths = resolveAsdPaths(projectRoot, homeDir);
      if (fs.existsSync(paths.dbPath)) {
        db = openProjectDb(projectRoot, homeDir);
        const session = getLatestSession(db);
        if (session && session.stashed_work_sha) {
          stashSha = session.stashed_work_sha;

          let popTarget = "";
          const listRes = runGit(["stash", "list", "--format=%gd %H %s"], {
            cwd: projectRoot,
          });
          if (listRes.exitCode === 0) {
            const lines = listRes.stdout.split("\n");
            for (const l of lines) {
              if (l.includes(stashSha) || l.includes("asd-auto-stash")) {
                const match = l.match(/^(stash@\{\d+\})/);
                if (match) {
                  popTarget = match[1];
                  break;
                }
              }
            }
          }

          const popArgs = popTarget
            ? ["stash", "pop", popTarget]
            : ["stash", "pop"];
          const popRes = runGit(popArgs, { cwd: projectRoot });
          if (popRes.exitCode === 0) {
            stashPopped = true;
          } else {
            // Fallback to git stash apply
            const applyArgs = popTarget
              ? ["stash", "apply", popTarget]
              : ["stash", "apply"];
            const applyRes = runGit(applyArgs, { cwd: projectRoot });
            if (applyRes.exitCode === 0) {
              stashPopped = true;
            }
          }

          if (stashPopped) {
            // Clear stashed_work_sha in SQLite session
            db.withImmediateTx(() => {
              const rawDb = (db as unknown as { db: DatabaseSync }).db;
              rawDb
                .prepare(
                  "UPDATE sessions SET stashed_work_sha = NULL, updated_at = ? WHERE session_id = ?"
                )
                .run(Date.now(), session.session_id);
            });
          }
        }
      }
    } catch {
      // ignore
    } finally {
      if (db) {
        try {
          db.close();
        } catch {
          // ignore
        }
      }
    }
  }

  // Clean empty .asd/wt directory if --all is requested
  if (options?.all && fs.existsSync(wtBaseDir)) {
    try {
      const remaining = fs.readdirSync(wtBaseDir);
      if (remaining.length === 0) {
        fs.rmdirSync(wtBaseDir);
      }
    } catch {
      // ignore
    }
  }

  return {
    worktreesRemoved,
    branchesDeleted,
    stashPopped,
    stashSha,
  };
}

// ============================================================================
// Help Menu Display
// ============================================================================

export function printHelp(): void {
  console.log(`ASD Multi-Agent Orchestration Harness (v${ASD_VERSION})

Usage:
  asd <command> [options]

Commands:
  sync [--force] [--home <dir>]      Sync ASD harnesses, agents, and skills globally
  status [--json]                    Display current session progress board and warnings
  doctor [--json]                    Verify environment, tools, and policy health
  clean [--pop] [--all]              Clean temporary worktrees and restore auto-stash
  uninstall [--home <dir>]           Surgically restore user harness configurations
  hook <pre-tool-use|stop>           Internal hook evaluator for harnesses
  mcp                                Start ASD MCP server over stdio

Options:
  -h, --help                         Show this help message
  -v, --version                      Show ASD version
      --json                         Output result in JSON format
      --force                        Force overwriting existing configurations (sync)
      --pop                          Restore stashed work (clean)
      --all                          Clean all leftover workspace state (clean)
      --home <dir>                   Custom home directory path
      --harness <id>                 Target harness for hook evaluation
`);
}

// ============================================================================
// Main CLI Router
// ============================================================================

export async function main(
  args: string[] = process.argv.slice(2)
): Promise<number> {
  const parsed = parseCliArgs(args);

  if (parsed.flags.version) {
    console.log(`ASD v${ASD_VERSION}`);
    return 0;
  }

  if (parsed.flags.help || !parsed.command || parsed.command === "help") {
    printHelp();
    return 0;
  }

  const { command, subcommand, flags, options } = parsed;
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const homeDir = options.home || process.env.ASD_HOME_DIR;

  try {
    switch (command) {
      case "sync": {
        const res = await runAsdSync({
          homeDir,
          force: flags.force,
          projectRoot,
        });
        if (flags.json) {
          console.log(JSON.stringify(res, null, 2));
        } else {
          console.log(`ASD Harness Configuration Synchronizer`);
          console.log(`Status: ${res.status}`);
          console.log(`Config Hash: ${res.configHash}`);
          console.log(`Harnesses:`);
          for (const [h, s] of Object.entries(res.harnesses)) {
            const files =
              s.filesWritten.length > 0
                ? ` (${s.filesWritten.length} files)`
                : "";
            console.log(`  - ${h}: ${s.status}${files}`);
          }
        }
        return 0;
      }

      case "status": {
        const paths = resolveAsdPaths(projectRoot, homeDir);
        let session: SessionRow | undefined;
        let tasks: TaskRow[] = [];

        if (fs.existsSync(paths.dbPath)) {
          let db: SqliteDriver | undefined;
          try {
            db = openProjectDb(projectRoot, homeDir);
            session = getLatestSession(db);
            if (session) {
              tasks = db.getSessionTasks(session.session_id);
            }
          } finally {
            if (db) {
              try {
                db.close();
              } catch {
                // ignore
              }
            }
          }
        }

        if (flags.json) {
          console.log(
            JSON.stringify(
              {
                session: session ?? null,
                tasks,
                hasStashedWork: !!session?.stashed_work_sha,
              },
              null,
              2
            )
          );
          return 0;
        }

        if (!session) {
          console.log(
            "No active ASD session found. Run an ASD command or skill to start a session."
          );
          return 0;
        }

        const board = renderProgressBoard(session, tasks);
        console.log(board);

        if (session.stashed_work_sha) {
          console.log(
            "\nWarning: Unapplied auto-stash detected. Run 'asd clean --pop' to restore auto-stashed work."
          );
        }
        return 0;
      }

      case "doctor": {
        const res = await runAsdDoctor({ homeDir, projectRoot });
        if (flags.json) {
          console.log(JSON.stringify(res, null, 2));
        } else {
          console.log("ASD Doctor Diagnostic Probe");
          console.log(
            `Node.js Version: ${res.nodeVersion.version} (>=22.13.0) - ${
              res.nodeVersion.ok ? "OK" : "FAIL"
            }`
          );
          console.log(
            `SQLite WAL Mode: ${res.sqliteWal.ok ? "OK" : "FAIL"}`
          );
          console.log(
            `Git Repository: ${
              res.gitRepo.isRepo ? "OK" : "Not a git repository"
            }`
          );
          console.log(`Policy Probe: ${res.policyProbe.ok ? "OK" : "FAIL"}`);
          console.log("Harness CLI Availability:");
          for (const [h, info] of Object.entries(res.harnesses)) {
            console.log(
              `  - ${h}: ${info.installed ? "Available" : "Not found"}`
            );
          }
          console.log(`Duration: ${res.durationMs.toFixed(1)}ms`);
          if (!res.ok) {
            console.error("\nErrors detected:");
            for (const err of res.errors) {
              console.error(`  - ${err}`);
            }
          }
        }
        return res.ok ? 0 : 1;
      }

      case "clean": {
        const res = runAsdClean({
          pop: flags.pop,
          all: flags.all,
          projectRoot,
          homeDir,
        });
        if (flags.json) {
          console.log(JSON.stringify(res, null, 2));
        } else {
          console.log("ASD Workspace Clean completed.");
          console.log(`  Worktrees removed: ${res.worktreesRemoved.length}`);
          if (res.worktreesRemoved.length > 0) {
            for (const wt of res.worktreesRemoved) {
              console.log(`    - ${wt}`);
            }
          }
          console.log(`  Branches deleted: ${res.branchesDeleted.length}`);
          if (res.branchesDeleted.length > 0) {
            for (const b of res.branchesDeleted) {
              console.log(`    - ${b}`);
            }
          }
          if (flags.pop) {
            if (res.stashPopped) {
              console.log(
                `  Restored auto-stashed work (${res.stashSha || "HEAD"}).`
              );
            } else if (res.stashSha) {
              console.warn(
                `  Warning: Could not auto-pop stash ${res.stashSha}. Run 'git stash pop' manually.`
              );
            } else {
              console.log("  No auto-stashed work found to restore.");
            }
          }
        }
        return 0;
      }

      case "uninstall": {
        const res = await runAsdUninstall({ homeDir });
        if (flags.json) {
          console.log(JSON.stringify(res, null, 2));
        } else {
          console.log(
            "ASD Harness Configurations Uninstalled successfully."
          );
          console.log(
            `Restored user backup files (${res.restoredFiles.length}):`
          );
          for (const f of res.restoredFiles) {
            console.log(`  - ${f}`);
          }
          console.log(
            `Removed ASD-managed files (${res.removedFiles.length}):`
          );
          for (const f of res.removedFiles) {
            console.log(`  - ${f}`);
          }
        }
        return 0;
      }

      case "hook": {
        if (
          !subcommand ||
          (subcommand !== "pre-tool-use" && subcommand !== "stop")
        ) {
          console.error("Usage: asd hook <pre-tool-use|stop> [--harness <id>]");
          return 1;
        }

        let rawPayload = readStdin();
        if (!rawPayload && options.payload) {
          rawPayload = options.payload;
        }

        let payload: Record<string, unknown> = {};
        if (rawPayload && rawPayload.trim()) {
          try {
            payload = JSON.parse(rawPayload);
          } catch {
            // Fail-closed on malformed JSON for pre-tool-use
            if (subcommand === "pre-tool-use") {
              const hId = (options.harness || "claude-code") as HarnessId;
              const adapter = getAdapter(hId);
              const formatted = adapter.formatPreToolUseDeny(
                "Fail-closed: malformed hook payload JSON"
              );
              if (formatted.stdout) {
                process.stdout.write(formatted.stdout + "\n");
              }
              if (formatted.stderr) {
                process.stderr.write(formatted.stderr + "\n");
              }
              return formatted.exitCode;
            }
          }
        }

        const harnessId = (options.harness ||
          payload.harness ||
          "claude-code") as HarnessId;
        if (!payload.harness) {
          payload.harness = harnessId;
        }
        if (!payload.projectRoot && projectRoot) {
          payload.projectRoot = projectRoot;
        }

        // Normalize target file keys across camelCase and snake_case
        if (payload.filePath && !payload.file_path) {
          payload.file_path = payload.filePath;
        }
        if (payload.file_path && !payload.filePath) {
          payload.filePath = payload.file_path;
        }
        if (payload.path) {
          if (!payload.file_path) payload.file_path = payload.path;
          if (!payload.filePath) payload.filePath = payload.path;
        }

        const adapter = getAdapter(harnessId);

        if (subcommand === "pre-tool-use") {
          const decision = evaluatePreToolUse(
            payload as PreToolUsePayload,
            DEFAULT_HARNESS_TOOL_MANIFEST,
            process.env
          );
          if (!decision.allowed) {
            const reason =
              decision.reason || "Tool execution denied by ASD policy";
            const formatted = adapter.formatPreToolUseDeny(reason);
            if (formatted.stdout) {
              process.stdout.write(formatted.stdout + "\n");
            }
            if (formatted.stderr) {
              process.stderr.write(formatted.stderr + "\n");
            }
            return formatted.exitCode;
          }
          return 0;
        } else if (subcommand === "stop") {
          let db: SqliteDriver | undefined;
          try {
            const rootDir = (payload.projectRoot as string) || projectRoot;
            const paths = resolveAsdPaths(rootDir, homeDir);
            if (fs.existsSync(paths.dbPath)) {
              db = openProjectDb(rootDir, homeDir);
            }
            const decision = evaluateStopHook(
              payload as StopHookPayload,
              process.env,
              db
            );
            if (decision.decision === "block") {
              const reason = decision.reason || "Stop blocked by ASD policy";
              const formatted = adapter.formatStopBlock(reason);
              if (formatted.stdout) {
                process.stdout.write(formatted.stdout + "\n");
              }
              if (formatted.stderr) {
                process.stderr.write(formatted.stderr + "\n");
              }
              return formatted.exitCode;
            }
            return 0;
          } finally {
            if (db) {
              try {
                db.close();
              } catch {
                // ignore
              }
            }
          }
        }
        return 0;
      }

      case "mcp": {
        const { AsdMcpServer } = await import("../mcp/server.ts");
        const server = new AsdMcpServer({
          projectRoot,
          homeDir,
        });
        server.start();
        return 0;
      }

      default: {
        console.error(
          `Unknown command: ${command}\n\nRun 'asd --help' for usage.`
        );
        return 1;
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error executing 'asd ${command}': ${msg}`);
    return 1;
  }
}

// ============================================================================
// Direct Execution Guard
// ============================================================================

const isDirectRun = (): boolean => {
  if (!process.argv[1]) return false;
  try {
    const entryPath = path.resolve(process.argv[1]);
    const currentPath = path.resolve(fileURLToPath(import.meta.url));
    if (entryPath === currentPath) return true;
    return (
      entryPath.endsWith(path.join("src", "cli", "index.ts")) ||
      entryPath.endsWith(path.join("src", "cli", "index.js")) ||
      entryPath.endsWith(`${path.sep}asd`) ||
      entryPath.endsWith(`${path.sep}asd.cmd`) ||
      entryPath.endsWith(`${path.sep}asd.ps1`)
    );
  } catch {
    return false;
  }
};

if (isDirectRun()) {
  main()
    .then((code) => {
      if (code !== 0) {
        process.exit(code);
      }
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
