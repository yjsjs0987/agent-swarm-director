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
import { cursorAdapter } from "../adapters/cursor.ts";
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
    noPath?: boolean;
    fromMarkdown?: boolean;
    diff?: boolean;
  };
  options: {
    home?: string;
    harness?: string;
    payload?: string;
    file?: string;
    projectRoot?: string;
    port?: number;
    session?: string;
    task?: string;
    turn?: number;
    mode?: string;
    action?: string;
    title?: string;
    tasks?: string;
    topic?: string;
    proposal?: string;
    proposalFile?: string;
    summary?: string;
    files?: string;
    cmd?: string;
  };
  rest: string[];
}

export function parseCliArgs(args: string[]): CliArgs {
  const flags: CliArgs["flags"] = {};
  const options: CliArgs["options"] = {};
  const positional: string[] = [];

  const readOptVal = (arg: string, prefix: string, nextIdx: () => string | undefined): string | undefined => {
    if (arg === prefix) return nextIdx();
    if (arg.startsWith(`${prefix}=`)) return arg.substring(prefix.length + 1);
    return undefined;
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const next = () => args[++i];
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
    } else if (arg === "--no-path" || arg === "--noPath") {
      flags.noPath = true;
    } else if (arg === "--from-markdown" || arg === "--from-md") {
      flags.fromMarkdown = true;
    } else if (arg === "--diff") {
      flags.diff = true;
    } else if (arg === "--home" || arg.startsWith("--home=")) {
      options.home = readOptVal(arg, "--home", next);
    } else if (arg === "--harness" || arg.startsWith("--harness=")) {
      options.harness = readOptVal(arg, "--harness", next);
    } else if (arg === "--payload" || arg.startsWith("--payload=")) {
      options.payload = readOptVal(arg, "--payload", next);
    } else if (arg === "--file" || arg.startsWith("--file=")) {
      options.file = readOptVal(arg, "--file", next);
    } else if (arg === "--session" || arg.startsWith("--session=") || arg === "--session-id" || arg.startsWith("--session-id=")) {
      options.session = readOptVal(arg, arg.startsWith("--session-id") ? "--session-id" : "--session", next);
    } else if (arg === "--task" || arg.startsWith("--task=") || arg === "--task-id" || arg.startsWith("--task-id=")) {
      options.task = readOptVal(arg, arg.startsWith("--task-id") ? "--task-id" : "--task", next);
    } else if (arg === "--turn" || arg.startsWith("--turn=")) {
      const t = Number.parseInt(readOptVal(arg, "--turn", next) || "", 10);
      if (Number.isFinite(t)) options.turn = t;
    } else if (arg === "--mode" || arg.startsWith("--mode=")) {
      options.mode = readOptVal(arg, "--mode", next);
    } else if (arg === "--action" || arg.startsWith("--action=")) {
      options.action = readOptVal(arg, "--action", next);
    } else if (arg === "--title" || arg.startsWith("--title=")) {
      options.title = readOptVal(arg, "--title", next);
    } else if (arg === "--tasks" || arg.startsWith("--tasks=")) {
      options.tasks = readOptVal(arg, "--tasks", next);
    } else if (arg === "--topic" || arg.startsWith("--topic=")) {
      options.topic = readOptVal(arg, "--topic", next);
    } else if (arg === "--proposal" || arg.startsWith("--proposal=")) {
      options.proposal = readOptVal(arg, "--proposal", next);
    } else if (arg === "--proposal-file" || arg.startsWith("--proposal-file=")) {
      options.proposalFile = readOptVal(arg, "--proposal-file", next);
    } else if (arg === "--summary" || arg.startsWith("--summary=")) {
      options.summary = readOptVal(arg, "--summary", next);
    } else if (arg === "--files" || arg.startsWith("--files=")) {
      options.files = readOptVal(arg, "--files", next);
    } else if (arg === "--cmd" || arg.startsWith("--cmd=") || arg === "--verify-cmd" || arg.startsWith("--verify-cmd=")) {
      options.cmd = readOptVal(arg, arg.startsWith("--verify-cmd") ? "--verify-cmd" : "--cmd", next);
    } else if (arg === "--project-root" || arg === "--projectRoot") {
      options.projectRoot = next();
    } else if (
      arg.startsWith("--project-root=") ||
      arg.startsWith("--projectRoot=")
    ) {
      const idx = arg.indexOf("=");
      options.projectRoot = arg.substring(idx + 1);
    } else if (arg === "--port" || arg === "-p") {
      const p = Number.parseInt(next() || "", 10);
      if (Number.isFinite(p)) options.port = p;
    } else if (arg.startsWith("--port=")) {
      const p = Number.parseInt(arg.substring("--port=".length), 10);
      if (Number.isFinite(p)) options.port = p;
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
    case "cursor":
      return cursorAdapter;
    default:
      return claudeCodeAdapter;
  }
}

// ============================================================================
// Latest Session Query Helper
// ============================================================================

export function getLatestSession(db: SqliteDriver): SessionRow | undefined {
  return db.getLatestSession();
}

// ============================================================================
// Subagent Log Inspector (`asd logs [taskId]`)
// ============================================================================

export interface SubagentLogRecord {
  sessionId: string;
  subSessionId: string;
  taskId: string;
  role: string;
  harness: string;
  model: string;
  status: string;
  pid?: number;
  worktreePath?: string | null;
  allowedFiles?: string[];
  startedAt: number;
  finishedAt?: number;
  prompt: string;
  outputLog: string;
  dirPath: string;
}

export function scanSubagentLogs(projectRoot: string): SubagentLogRecord[] {
  const sessionsRoot = path.join(path.resolve(projectRoot), ".asd", "sessions");
  if (!fs.existsSync(sessionsRoot)) {
    return [];
  }

  const records: SubagentLogRecord[] = [];

  try {
    const sessionDirs = fs.readdirSync(sessionsRoot, { withFileTypes: true });
    for (const sDir of sessionDirs) {
      if (!sDir.isDirectory()) continue;
      const subagentsDir = path.join(sessionsRoot, sDir.name, "subagents");
      if (!fs.existsSync(subagentsDir)) continue;

      const subDirs = fs.readdirSync(subagentsDir, { withFileTypes: true });
      for (const subDir of subDirs) {
        if (!subDir.isDirectory()) continue;
        const dirPath = path.join(subagentsDir, subDir.name);
        const metaPath = path.join(dirPath, "meta.json");
        if (!fs.existsSync(metaPath)) continue;

        try {
          const metaStat = fs.statSync(metaPath);
          const meta = JSON.parse(fs.readFileSync(metaPath, "utf8")) as Record<string, unknown>;
          const promptPath = path.join(dirPath, "prompt.md");
          const outputPath = path.join(dirPath, "output.log");
          const prompt = fs.existsSync(promptPath) ? fs.readFileSync(promptPath, "utf8") : "";
          const outputLog = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, "utf8") : "";
          const startedAt =
            typeof meta.startedAt === "number" && meta.startedAt > 0
              ? meta.startedAt
              : Math.round(metaStat.birthtimeMs || metaStat.mtimeMs || 0);
          records.push({
            sessionId: String(meta.parentSessionId ?? meta.mainSessionId ?? sDir.name),
            subSessionId: String(meta.subSessionId ?? subDir.name),
            taskId: String(meta.taskId ?? ""),
            role: String(meta.role ?? ""),
            harness: String(meta.harness ?? ""),
            model: String(meta.model ?? ""),
            status: String(meta.status ?? "unknown"),
            pid: typeof meta.pid === "number" ? meta.pid : undefined,
            worktreePath: typeof meta.worktreePath === "string" ? meta.worktreePath : null,
            allowedFiles: Array.isArray(meta.allowedFiles)
              ? meta.allowedFiles.map((x) => String(x))
              : [],
            startedAt,
            finishedAt: typeof meta.finishedAt === "number" ? meta.finishedAt : undefined,
            prompt,
            outputLog,
            dirPath,
          });
        } catch {
          // Ignore malformed subagent meta
        }
      }
    }
  } catch {
    return [];
  }

  records.sort((a, b) => b.startedAt - a.startedAt);
  return records;
}

export function runAsdLogs(options?: {
  taskId?: string;
  projectRoot?: string;
  homeDir?: string;
}): { found: boolean; record: SubagentLogRecord | null; availableTaskIds: string[] } {
  const projectRoot = path.resolve(options?.projectRoot || process.cwd());
  const records = scanSubagentLogs(projectRoot);
  if (records.length === 0) {
    return { found: false, record: null, availableTaskIds: [] };
  }

  const targetTaskId = options?.taskId?.trim().toUpperCase();
  const availableTaskIds = [...new Set(records.map((r) => r.taskId || r.subSessionId).filter(Boolean))];

  const matched = targetTaskId
    ? records.find(
        (r) =>
          r.taskId.toUpperCase() === targetTaskId ||
          r.subSessionId.toUpperCase() === targetTaskId ||
          r.subSessionId.toUpperCase().includes(targetTaskId)
      ) ?? null
    : records[0] ?? null;

  return {
    found: matched !== null,
    record: matched,
    availableTaskIds,
  };
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
            db.clearStashedWork(session.session_id);
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
  plan [create|get|update|sync_from_md]  Create, query, or sync .asd/PLAN.md & SQLite tasks
  dispatch [--turn <n>] [--mode <m>]     Dispatch wave tasks in parallel_spawn or claim_only mode
  verify --task <id> [--summary <s>]     Verify task boundaries, run tests, and commit/merge
  debate --topic <t> --proposal <p>      Run zero-timeout cross-model blind debate via CLI
  sync [--force] [--no-path]             Sync ASD harnesses globally and install 'asd' CLI to PATH
  status [--json]                        Display current session progress board and warnings
  logs [taskId] [--json]                 Inspect latest (or task-specific) subagent prompt & output log
  ui [--port <num>] [--json]             Launch lightweight local web dashboard (default port: 3847)
  doctor [--json]                        Verify environment, tools, and policy health
  clean [--pop] [--all]                  Clean temporary worktrees and restore auto-stash
  uninstall [--home <dir>]               Surgically restore user harness configurations
  hook <pre-tool-use|stop>               Internal hook evaluator for harnesses
  mcp                                    Start ASD MCP server over stdio

Options:
  -h, --help                         Show this help message
  -v, --version                      Show ASD version
      --json                         Output result in JSON format
      --project-root <dir>           Target project root directory (default: cwd)
      --home <dir>                   Custom home directory path
      --harness <id>                 Target harness (claude-code|opencode|codex|antigravity|cursor)
      --session <id>                 Target session ID
      --task <id>                    Target task ID (or comma-separated IDs for dispatch)
      --turn <num>                   Target wave/turn number for dispatch
      --mode <mode>                  Dispatch mode (parallel_spawn|claim_only)
      --action <act>                 Plan action (create|get|update|sync_from_md)
      --topic <text>                 Debate topic for 'asd debate'
      --proposal <text>              Debate proposal text for 'asd debate'
      --proposal-file <path>         Path to proposal markdown/text file for 'asd debate'
      --diff                         Embed 'git diff HEAD' into 'asd debate' prompt
      --summary <text>               Completion summary for 'asd verify'
      --files <list>                 Comma-separated files (changed files for verify, or path[:start-end] for debate)
      --cmd <command>                Explicit verification command override for 'asd verify'
      --payload <json|->             Inline JSON payload (or '-' to read JSON from stdin)
      --file <path>                  Path to JSON payload file
      --port <num>                   Port for 'asd ui' web dashboard (default: 3847)
      --force                        Force overwriting existing configurations (sync)
      --no-path                      Skip installing 'asd' CLI shim to global PATH (sync)
      --pop                          Restore stashed work (clean)
      --all                          Clean all leftover workspace state (clean)
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
          noPath: flags.noPath,
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
          if (flags.noPath) {
            console.log(`CLI PATH Shims: skipped (--no-path)`);
          } else if (res.cliShimsInstalled && res.cliShimsInstalled.length > 0) {
            console.log(`CLI PATH Shims (${res.cliShimsInstalled.length}):`);
            for (const shim of res.cliShimsInstalled) {
              console.log(`  - ${shim}`);
            }
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

      case "logs": {
        const res = runAsdLogs({
          taskId: subcommand,
          projectRoot,
          homeDir,
        });
        if (flags.json) {
          console.log(JSON.stringify(res, null, 2));
          return res.found ? 0 : 1;
        }
        if (!res.found || !res.record) {
          const hint =
            res.availableTaskIds.length > 0
              ? ` Available task logs: ${res.availableTaskIds.join(", ")}`
              : "";
          console.log(
            subcommand
              ? `No subagent log found for task '${subcommand}'.${hint}`
              : "No subagent logs found in .asd/sessions/."
          );
          return 0;
        }
        const r = res.record;
        console.log(`=== ASD Subagent Log [${r.taskId}] ===`);
        console.log(`SubSession : ${r.subSessionId}`);
        console.log(`Harness    : ${r.harness} (${r.model}) | Role: ${r.role}`);
        console.log(`Status     : ${r.status}`);
        console.log(`Log Path   : ${r.dirPath}`);
        console.log(`\n--- Output Log ---\n${r.outputLog.trim() || "(empty)"}`);
        return 0;
      }

      case "ui":
      case "dashboard": {
        const { collectDashboardSnapshot, startDashboardServer } = await import(
          "./dashboard.ts"
        );
        if (flags.json) {
          const snap = await collectDashboardSnapshot({ projectRoot, homeDir });
          console.log(JSON.stringify(snap, null, 2));
          return 0;
        }
        const handle = await startDashboardServer({
          port: options.port ?? 3847,
          projectRoot,
          homeDir,
        });
        console.log(`ASD Web Dashboard running at ${handle.url}`);
        console.log(`Project Root: ${projectRoot}`);
        console.log(`Press Ctrl+C to stop.`);
        await new Promise<void>((resolve) => {
          const shutdown = () => {
            handle.close().then(resolve);
          };
          process.once("SIGINT", shutdown);
          process.once("SIGTERM", shutdown);
        });
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
            const detail = info.installed
              ? `Available (${info.resolvedPath ?? info.binary}) [Headless: ${info.headlessSupported ? "Yes" : "No"}]`
              : "Not found";
            console.log(`  - ${h}: ${detail}`);
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

      case "plan":
      case "dispatch":
      case "verify":
      case "debate": {
        const { AsdMcpServer } = await import("../mcp/server.ts");
        const server = new AsdMcpServer({
          projectRoot,
          homeDir,
          autoSync: false,
        });

        try {
          let jsonPayload: Record<string, unknown> = {};
          const explicitStdin = options.payload === "-";
          const rawJsonInput =
            (options.payload && !explicitStdin ? options.payload : "") ||
            (options.file && fs.existsSync(options.file)
              ? fs.readFileSync(options.file, "utf8")
              : "") ||
            (explicitStdin ? readStdin() : "");
          if (rawJsonInput && rawJsonInput.trim()) {
            try {
              jsonPayload = JSON.parse(rawJsonInput.trim()) as Record<string, unknown>;
            } catch (e) {
              throw new Error(
                `Invalid JSON payload provided to 'asd ${command}': ${
                  e instanceof Error ? e.message : String(e)
                }`
              );
            }
          }

          if (command === "plan") {
            let parsedTasks: unknown[] | undefined = Array.isArray(jsonPayload.tasks)
              ? jsonPayload.tasks
              : undefined;
            if (options.tasks) {
              try {
                const rawTasks = JSON.parse(options.tasks.trim());
                if (Array.isArray(rawTasks)) {
                  parsedTasks = rawTasks;
                }
              } catch (e) {
                throw new Error(
                  `Invalid JSON array passed to --tasks: ${
                    e instanceof Error ? e.message : String(e)
                  }`
                );
              }
            }
            const action = (options.action ||
              (flags.fromMarkdown ? "sync_from_md" : undefined) ||
              subcommand ||
              jsonPayload.action ||
              (Array.isArray(parsedTasks) ? "create" : "get")) as
              | "create"
              | "get"
              | "update"
              | "sync_from_md";
            const input = {
              ...jsonPayload,
              action,
              ...(options.title ? { title: options.title } : {}),
              ...(parsedTasks ? { tasks: parsedTasks } : {}),
              ...(options.session ? { sessionId: options.session } : {}),
              ...(options.harness ? { mainHarness: options.harness } : {}),
            };
            const res = await server.handlePlan(input as Parameters<typeof server.handlePlan>[0]);
            if (flags.json) {
              console.log(JSON.stringify(res, null, 2));
            } else {
              console.log(res.progressBoard);
              console.log(`\nSession ID: ${res.sessionId} | Phase: ${res.phase} | Plan: ${res.planMdPath}`);
            }
            return 0;
          }

          if (command === "dispatch") {
            const taskIdsFromOpt = options.task
              ? options.task.split(",").map((s) => s.trim()).filter(Boolean)
              : undefined;
            const input = {
              sessionId: (options.session || (jsonPayload.sessionId as string) || ""),
              ...jsonPayload,
              ...(options.turn !== undefined ? { turn: options.turn } : {}),
              ...(options.mode ? { mode: options.mode } : {}),
              ...(options.harness ? { harness: options.harness } : {}),
              ...(taskIdsFromOpt ? { taskIds: taskIdsFromOpt } : {}),
            };
            const res = await server.handleDispatch(input as Parameters<typeof server.handleDispatch>[0]);
            if (flags.json) {
              console.log(JSON.stringify(res, null, 2));
            } else {
              console.log(res.progressBoard);
              for (const r of res.results) {
                console.log(
                  `- ${r.taskId}: ${r.status} (@${r.harness}/${r.model})${r.error ? ` [Error: ${r.error}]` : ""}`
                );
              }
            }
            return 0;
          }

          if (command === "verify") {
            const taskId = options.task || subcommand || (jsonPayload.taskId as string) || "";
            if (!taskId) {
              throw new Error("Missing --task <taskId> for 'asd verify'");
            }
            const changedFiles = options.files
              ? options.files.split(",").map((s) => s.trim()).filter(Boolean)
              : [];
            const summary = options.summary || parsed.rest[0] || `Verified task ${taskId}`;
            const defaultClaim = {
              summary,
              changed_files: changedFiles,
              key_decisions: [],
              risks: [],
            };
            const input = {
              sessionId: (options.session || (jsonPayload.sessionId as string) || ""),
              taskId,
              doneClaim: (jsonPayload.doneClaim as typeof defaultClaim) ?? defaultClaim,
              ...(options.cmd ? { verifyCmd: options.cmd } : {}),
              ...jsonPayload,
            };
            const res = await server.handleVerify(input as Parameters<typeof server.handleVerify>[0]);
            if (flags.json) {
              console.log(JSON.stringify(res, null, 2));
            } else {
              console.log(res.progressBoard);
              console.log(
                `\nVerify [${res.taskId}]: ${res.verified ? "PASS" : "FAIL"} (status: ${res.status})${
                  res.commitSha ? ` | commit: ${res.commitSha}` : ""
                }${res.error ? `\nReason: ${res.error}` : ""}`
              );
            }
            return res.verified ? 0 : 1;
          }

          if (command === "debate") {
            if (process.env.ASD_SESSION_ROLE === "subagent") {
              throw new Error("Subagents cannot invoke orchestration tools");
            }
            const topic =
              options.topic ||
              (jsonPayload.topic as string) ||
              subcommand ||
              "";
            let proposal =
              options.proposal ||
              (jsonPayload.proposal as string) ||
              parsed.rest.join(" ") ||
              "";
            if (!proposal && options.proposalFile && fs.existsSync(options.proposalFile)) {
              proposal = fs.readFileSync(options.proposalFile, "utf8");
            }
            if (!topic || !proposal) {
              throw new Error(
                "Usage: asd debate --topic \"<topic>\" --proposal \"<proposal>\" [--files \"path[:start-end],...\"] [--diff] [--task <taskId>] [--session <sessionId>]"
              );
            }
            const debateFiles = options.files
              ? options.files.split(",").map((s) => s.trim()).filter(Boolean)
              : Array.isArray(jsonPayload.files)
                ? (jsonPayload.files as string[])
                : undefined;
            const includeDiff = Boolean(flags.diff || jsonPayload.includeDiff);
            const res = await server.handleDebate(
              {
                sessionId: options.session || (jsonPayload.sessionId as string) || "",
                taskId: options.task || (jsonPayload.taskId as string) || undefined,
                topic,
                proposal,
                ...(debateFiles && debateFiles.length > 0 ? { files: debateFiles } : {}),
                ...(includeDiff ? { includeDiff: true } : {}),
                ...(options.harness ? { harness: options.harness as HarnessId } : {}),
              },
              undefined,
              (msg) => {
                if (!flags.json) {
                  console.error(msg);
                }
              }
            );
            if (flags.json) {
              console.log(JSON.stringify(res, null, 2));
            } else {
              console.log(`\n=== ASD Debate Verdict [${res.debateId}]: ${res.verdict} ===`);
              if (res.decisions.length > 0) {
                console.log(`Decisions:\n${res.decisions.map((d) => `  - ${d}`).join("\n")}`);
              }
              if (res.hardConstraints.length > 0) {
                console.log(
                  `Hard Constraints:\n${res.hardConstraints.map((c) => `  - ${c}`).join("\n")}`
                );
              }
              if (res.risks.length > 0) {
                console.log(`Risks:\n${res.risks.map((r) => `  - ${r}`).join("\n")}`);
              }
              console.log(`\n${res.progressBoard}`);
            }
            return 0;
          }
          return 0;
        } finally {
          server.close();
        }
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
