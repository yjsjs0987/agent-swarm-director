/**
 * ASD v2.2 Subagent Spawner (src/core/spawner.ts)
 *
 * Spawns isolated subagent processes with:
 * - Session artifact logging under
 *   <projectRoot>/.asd/sessions/<mainSessionId>/subagents/<subSessionId>/:
 *   meta.json (SubagentSessionMeta), prompt.md, output.log.
 * - Secret-redacted log piping: every stdout/stderr chunk passes through
 *   redactSecrets BEFORE it is written to output.log.
 * - Env injection for MCP recursion blocking (fork-bomb prevention):
 *   NODE_NO_WARNINGS=1, ASD_MAIN_SESSION_ID, ASD_SESSION_ROLE=subagent,
 *   ASD_SUBAGENT_META=<abs path to meta.json>.
 * - AbortSignal + timeout integration with process-tree termination
 *   (Windows: taskkill /PID <pid> /T /F; POSIX: kill -TERM -pgid then
 *   SIGKILL after 3s) so cancellation leaves zero zombie processes.
 */

import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveAsdPaths } from "./config.ts";
import { redactSecrets } from "./redact.ts";
import { extractHarnessSessionIdFromOutput } from "./session-tracker.ts";
import type { AgentRole, HarnessId, SubagentSessionMeta } from "./types.ts";

// ============================================================================
// CommandRunner contract (mockable for deterministic tests)
// ============================================================================

export interface CommandRunnerRunOptions {
  cwd?: string;
  env: Record<string, string>;
  signal?: AbortSignal;
  onStdout: (chunk: string) => void;
  onStderr: (chunk: string) => void;
  /** Called synchronously with the child pid as soon as the process exists. */
  onSpawn?: (pid: number) => void;
}

export interface CommandRunner {
  run(
    cmd: string,
    args: string[],
    opts: CommandRunnerRunOptions
  ): Promise<{ exitCode: number; pid: number }>;
}

// ============================================================================
// Spawn options / result
// ============================================================================

export interface SpawnSubagentOptions {
  projectRoot: string;
  homeDir?: string;
  mainSessionId: string;
  subSessionId: string;
  role: AgentRole;
  harness: HarnessId;
  model: string;
  harnessSessionId?: string | null;
  taskId: string;
  prompt: string;
  allowedFiles: string[];
  worktreePath?: string | null;
  command: string;
  args: string[];
  signal?: AbortSignal;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  cwd?: string;
  commandRunner?: CommandRunner;
}

export const DEFAULT_DISPATCH_TIMEOUT_MS =
  Number.parseInt(process.env.ASD_SPAWN_TIMEOUT_MS || "", 10) || 60 * 60_000;
export const DEFAULT_DEBATE_TIMEOUT_MS =
  Number.parseInt(
    process.env.ASD_DEBATE_TIMEOUT_MS || process.env.ASD_SPAWN_TIMEOUT_MS || "",
    10
  ) || 15 * 60_000;
export const DEFAULT_IDLE_TIMEOUT_MS =
  Number.parseInt(process.env.ASD_SPAWN_IDLE_TIMEOUT_MS || "", 10) ||
  10 * 60_000;

export interface SpawnSubagentResult {
  exitCode: number;
  durationMs: number;
  metaPath: string;
  harnessSessionId?: string | null;
  timedOut?: boolean;
}

// ============================================================================
// Windows .cmd / npm Shim Safe Resolver
// ============================================================================

/**
 * Resolves a command and arguments for safe cross-platform execution.
 * On Windows, npm global CLIs (`claude`, `codex`, `opencode`, `agy`, `npx`)
 * are installed as `.cmd` batch shims, which throw ENOENT when spawned with
 * `shell: false`, or break on multiline prompts when spawned with `shell: true`.
 *
 * This resolver locates the `.cmd` shim on PATH, extracts the underlying Node.js
 * entrypoint script if it is an npm shim, and invokes `process.execPath` directly
 * with `shell: false`.
 */
export function resolveSpawnCommand(
  cmd: string,
  args: string[],
  env: Record<string, string | undefined> = process.env
): { command: string; args: string[]; shell: boolean } {
  if (process.platform !== "win32") {
    return { command: cmd, args, shell: false };
  }

  // Direct node or .exe invocation needs no translation
  const lowerCmd = cmd.toLowerCase();
  if (lowerCmd === "node" || lowerCmd === "node.exe" || lowerCmd.endsWith(".exe")) {
    return { command: cmd, args, shell: false };
  }

  // Locate candidate on PATH if not already an existing path
  let resolvedPath = "";
  if (path.isAbsolute(cmd) || cmd.includes("\\") || cmd.includes("/")) {
    if (fs.existsSync(cmd)) {
      resolvedPath = cmd;
    } else if (fs.existsSync(`${cmd}.cmd`)) {
      resolvedPath = `${cmd}.cmd`;
    } else if (fs.existsSync(`${cmd}.exe`)) {
      return { command: `${cmd}.exe`, args, shell: false };
    }
  } else {
    const pathEnv = env.PATH || env.Path || process.env.PATH || process.env.Path || "";
    const dirs = pathEnv.split(path.delimiter).filter(Boolean);
    for (const dir of dirs) {
      const exeCandidate = path.join(dir, `${cmd}.exe`);
      if (fs.existsSync(exeCandidate)) {
        return { command: exeCandidate, args, shell: false };
      }
      const cmdCandidate = path.join(dir, `${cmd}.cmd`);
      if (fs.existsSync(cmdCandidate)) {
        resolvedPath = cmdCandidate;
        break;
      }
      const batCandidate = path.join(dir, `${cmd}.bat`);
      if (fs.existsSync(batCandidate)) {
        resolvedPath = batCandidate;
        break;
      }
    }
  }

  if (resolvedPath && /\.(cmd|bat)$/i.test(resolvedPath)) {
    try {
      const shimContent = fs.readFileSync(resolvedPath, "utf8");
      const shimDir = path.dirname(resolvedPath);
      // Match standard npm cmd shim pattern: "%dp0%\node_modules\...\bin.js" %*
      const match = shimContent.match(/"%(?:~)?dp0%\\([^"]+\.(?:c?m?js))"\s+%\*/i);
      if (match?.[1]) {
        const scriptPath = path.resolve(shimDir, match[1]);
        if (fs.existsSync(scriptPath)) {
          return {
            command: process.execPath,
            args: [scriptPath, ...args],
            shell: false,
          };
        }
      }
    } catch {
      // Fall through to cmd.exe wrapper
    }
    return { command: resolvedPath, args, shell: true };
  }

  return { command: cmd, args, shell: false };
}

// ============================================================================
// Default runner: real child_process.spawn
// ============================================================================

const defaultCommandRunner: CommandRunner = {
  run(cmd, args, opts) {
    return new Promise((resolve) => {
      const resolved = resolveSpawnCommand(cmd, args, opts.env);
      let finalArgs = resolved.args;
      let stdinPayload: string | undefined;
      if (cmd === "claude") {
        // When prompt is very long (>1500 chars) on Windows, pass via stdin to avoid arg truncation or 3s stdin warning
        const pIdx = finalArgs.indexOf("-p");
        if (pIdx !== -1 && typeof finalArgs[pIdx + 1] === "string" && finalArgs[pIdx + 1]!.length > 1500) {
          stdinPayload = finalArgs[pIdx + 1];
          finalArgs = [...finalArgs.slice(0, pIdx + 1), ...finalArgs.slice(pIdx + 2)];
        }
        if (!finalArgs.includes("--dangerously-skip-permissions")) {
          finalArgs = [...finalArgs, "--dangerously-skip-permissions"];
        }
      }
      const child = child_process.spawn(resolved.command, finalArgs, {
        cwd: opts.cwd,
        env: opts.env,
        stdio: [stdinPayload !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
        windowsHide: true,
        shell: resolved.shell,
        // POSIX: own process group so process.kill(-pid) reaps the tree.
        // Windows: do NOT detach — taskkill /T handles the tree.
        detached: process.platform !== "win32",
      });
      if (stdinPayload !== undefined && child.stdin) {
        try {
          child.stdin.write(stdinPayload, "utf8");
          child.stdin.end();
        } catch {
          // ignore broken pipe
        }
      }
      opts.onSpawn?.(child.pid ?? 0);
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => opts.onStdout(chunk));
      child.stderr?.on("data", (chunk: string) => opts.onStderr(chunk));
      // "close" (not "exit"): fires after stdio drained, so no chunk is lost
      // before the runner resolves.
      child.on("close", (code) =>
        resolve({ exitCode: code ?? -1, pid: child.pid ?? -1 })
      );
      child.on("error", (err) => {
        const totalArgChars = finalArgs.reduce((acc, a) => acc + a.length, 0);
        const argHint =
          totalArgChars > 8000
            ? ` (arg length: ${totalArgChars} chars — may exceed OS command-line limit)`
            : "";
        opts.onStderr(
          `[asd:spawn-error] Failed to spawn '${resolved.command}': ${err.message}${argHint}\n`
        );
        resolve({ exitCode: -1, pid: child.pid ?? -1 });
      });
    });
  },
};

// ============================================================================
// Process-tree termination
// ============================================================================

/**
 * Kill an entire process tree. Best-effort: already-exited targets are
 * silently ignored (ESRCH-like failures swallowed).
 * - Windows: `taskkill /PID <pid> /T /F` (reliable tree kill).
 * - POSIX: SIGTERM to the process group, then SIGKILL after 3s.
 */
export function killProcessTree(pid: number): void {
  if (!pid || pid <= 0) return;
  if (process.platform === "win32") {
    try {
      child_process.spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
      });
    } catch {
      // Already exited (or taskkill unavailable) — nothing to do.
    }
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    return; // Process group already gone.
  }
  const killTimer = setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Already gone — fine.
    }
  }, 3000);
  killTimer.unref?.();
}

// ============================================================================
// spawnSubagent
// ============================================================================

/**
 * Spawn an isolated subagent process, record its session artifacts, and
 * resolve with { exitCode, durationMs, metaPath } once the child exits,
 * is aborted via options.signal, or exceeds options.timeoutMs.
 * Aborted/timed-out children are tree-killed and marked "failed" in meta.json.
 */
export function spawnSubagent(
  options: SpawnSubagentOptions
): Promise<SpawnSubagentResult> {
  const paths = resolveAsdPaths(options.projectRoot, options.homeDir);
  const sessionDir = path.join(
    paths.sessionsDir,
    options.mainSessionId,
    "subagents",
    options.subSessionId
  );
  fs.mkdirSync(sessionDir, { recursive: true });

  const metaPath = path.join(sessionDir, "meta.json");
  const logPath = path.join(sessionDir, "output.log");

  fs.writeFileSync(path.join(sessionDir, "prompt.md"), options.prompt);

  const startedAt = Date.now();
  let detectedHarnessSessionId: string | null =
    options.harnessSessionId ?? null;
  let meta: SubagentSessionMeta = {
    subSessionId: options.subSessionId,
    parentSessionId: options.mainSessionId,
    roleType: "subagent",
    role: options.role,
    harness: options.harness,
    model: options.model,
    harnessSessionId: detectedHarnessSessionId,
    taskId: options.taskId,
    pid: 0,
    worktreePath: options.worktreePath ?? null,
    allowedFiles: options.allowedFiles,
    status: "running",
    startedAt,
  };
  const writeMeta = (): void => {
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  };
  writeMeta();

  // Secret-redacted streaming log. Error handler swallows writes that race
  // a post-settle close.
  const logStream = fs.createWriteStream(logPath, { flags: "a" });
  logStream.on("error", () => {});

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
  };
  env.NODE_NO_WARNINGS = "1";
  env.ASD_MAIN_SESSION_ID = options.mainSessionId;
  env.ASD_SESSION_ROLE = "subagent";
  env.ASD_SUBAGENT_META = metaPath;

  const runner = options.commandRunner ?? defaultCommandRunner;

  return new Promise<SpawnSubagentResult>((resolve) => {
    let pid = 0;
    let settled = false;
    let killRequested = false;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (exitCode: number, status: "done" | "failed"): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      if (options.signal) options.signal.removeEventListener("abort", onAbort);
      const finishedAt = Date.now();
      meta = {
        ...meta,
        pid,
        harnessSessionId: detectedHarnessSessionId,
        status,
        startedAt,
        finishedAt,
        durationMs: finishedAt - startedAt,
      };
      writeMeta();
      // Resolve only after the log stream has flushed to disk.
      logStream.end(() => {
        resolve({
          exitCode,
          durationMs: meta.durationMs ?? 0,
          metaPath,
          harnessSessionId: detectedHarnessSessionId,
          timedOut,
        });
      });
    };

    const requestKill = (): void => {
      killRequested = true;
      if (pid > 0) killProcessTree(pid);
    };

    const onAbort = (): void => {
      requestKill();
      finish(-1, "failed");
    };

    const onTimeout = (): void => {
      timedOut = true;
      onAbort();
    };

    const resetIdleTimer = (): void => {
      if (options.idleTimeoutMs === undefined || settled) return;
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      idleTimer = setTimeout(onTimeout, options.idleTimeoutMs);
      idleTimer.unref?.();
    };

    if (options.signal) {
      options.signal.addEventListener("abort", onAbort, { once: true });
      // Insurance: an already-aborted signal must not skip the kill path.
      if (options.signal.aborted && !settled) onAbort();
    }
    if (options.timeoutMs !== undefined) {
      timer = setTimeout(onTimeout, options.timeoutMs);
      timer.unref?.();
    }
    resetIdleTimer();

    void runner
      .run(options.command, options.args, {
        cwd: options.cwd,
        env,
        signal: options.signal,
        onStdout: (chunk) => {
          if (!settled) {
            if (chunk && chunk.length > 0) {
              resetIdleTimer();
              if (!detectedHarnessSessionId) {
                const extracted = extractHarnessSessionIdFromOutput(
                  chunk,
                  options.harness
                );
                if (extracted) {
                  detectedHarnessSessionId = extracted;
                  meta = { ...meta, harnessSessionId: extracted };
                  writeMeta();
                }
              }
            }
            logStream.write(redactSecrets(chunk));
          }
        },
        onStderr: (chunk) => {
          if (!settled) {
            if (chunk && chunk.length > 0) {
              resetIdleTimer();
              if (!detectedHarnessSessionId) {
                const extracted = extractHarnessSessionIdFromOutput(
                  chunk,
                  options.harness
                );
                if (extracted) {
                  detectedHarnessSessionId = extracted;
                  meta = { ...meta, harnessSessionId: extracted };
                  writeMeta();
                }
              }
            }
            logStream.write(redactSecrets(chunk));
          }
        },
        onSpawn: (p) => {
          pid = p;
          meta = { ...meta, pid };
          writeMeta();
          // Abort/timeout fired before the pid existed — kill now.
          if (killRequested) killProcessTree(pid);
        },
      })
      .then(
        (result) => {
          if (pid === 0 && result.pid > 0) {
            pid = result.pid;
            meta = { ...meta, pid };
          }
          finish(result.exitCode, result.exitCode === 0 ? "done" : "failed");
        },
        () => {
          finish(-1, "failed");
        }
      );
  });
}
