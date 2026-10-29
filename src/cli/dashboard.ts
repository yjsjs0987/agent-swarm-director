/**
 * ASD v2.2 Lightweight Zero-Dependency Web Dashboard (src/cli/dashboard.ts)
 *
 * Uses built-in `node:http` with zero external runtime dependencies.
 * Provides:
 * - `GET /api/state`: Live JSON snapshot of all SQLite sessions (with `.asd` memos
 *   and standalone debate separation), tasks, debates, subagent logs, harness
 *   availability, project routing config, and discovered models per harness.
 * - `GET /api/models` & `POST /api/models/refresh`: Dynamic per-harness model
 *   discovery (`opencode models` CLI + `.codex/models_cache.json` + `.codex/config.toml`
 *   + `.claude/settings.json` + `.gemini/` + `routing.jsonc`).
 * - `POST /api/session-memo`: Updates the short session memo in `.asd/core.db`
 *   and `.asd/sessions/<sessionId>/main.json`.
 * - `POST /api/routing`: Saves or resets project-scoped `.asd/routing.jsonc`.
 * - `POST /api/subagent-action`: Executes runtime actions on a subagent:
 *   `kill` (force terminate process tree), `retry` (re-run same harness/model),
 *   `fallback` (run next configured fallback), or `custom` (run user-picked harness/model).
 * - `GET /`: Master-detail dark-mode Web UI with session grouping, memos,
 *   2x2 harness model inspector popup modal, project routing editor with dynamic
 *   primary model dropdowns, and 4-option subagent controller.
 */

import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

import { runAsdDoctor } from "../adapters/installer.ts";
import { loadRoutingConfig, resolveAsdPaths } from "../core/config.ts";
import {
  type DebateRow,
  openProjectDb,
  type SessionRow,
  type SqliteDriver,
  type TaskRow,
} from "../core/db.ts";
import {
  buildDefaultHarnessCommand,
  deduplicateStrings,
  parseReviewerOpening,
} from "../core/debate.ts";
import { atomicWriteFileSync } from "../core/render.ts";
import {
  inferModelFamily,
  normalizeAgentRole,
  resolveFallback,
} from "../core/router.ts";
import {
  type CommandRunner,
  DEFAULT_DEBATE_TIMEOUT_MS,
  DEFAULT_IDLE_TIMEOUT_MS,
  killProcessTree,
  resolveSpawnCommand,
  spawnSubagent,
} from "../core/spawner.ts";
import {
  type AgentRole,
  ASD_VERSION,
  type HarnessId,
  type RoutingConfig,
} from "../core/types.ts";
import { scanSubagentLogs, type SubagentLogRecord } from "./index.ts";

export type HarnessModelCatalog = Record<HarnessId, string[]>;

export interface DashboardSnapshot {
  version: string;
  projectRoot: string;
  systemLocale: string;
  timestamp: number;
  session: SessionRow | null;
  sessions: SessionRow[];
  tasks: TaskRow[];
  allTasks: TaskRow[];
  debates: DebateRow[];
  allDebates: DebateRow[];
  subagentLogs: SubagentLogRecord[];
  routingConfig: RoutingConfig;
  hasLocalRouting: boolean;
  localRoutingPath: string;
  availableModels: HarnessModelCatalog;
  harnesses: Record<
    string,
    { installed: boolean; headlessSupported: boolean; binary?: string; resolvedPath?: string | null }
  >;
}

const doctorCache = new Map<string, DashboardSnapshot["harnesses"]>();
const modelCatalogCache = new Map<string, HarnessModelCatalog>();

function detectSystemLocale(): string {
  try {
    const resolved = Intl.DateTimeFormat().resolvedOptions().locale;
    if (resolved) return resolved;
  } catch {
    // Ignore
  }
  return process.env.LC_ALL || process.env.LANG || "en-US";
}

function readMainJsonMeta(projectRoot: string, sessionId: string): Record<string, unknown> | null {
  try {
    const mainJsonPath = path.join(projectRoot, ".asd", "sessions", sessionId, "main.json");
    if (!fs.existsSync(mainJsonPath)) return null;
    return JSON.parse(fs.readFileSync(mainJsonPath, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Dynamically discovers available models for Antigravity, Claude Code, Codex, and OpenCode
 * by querying local CLI caches/configs and `opencode models`.
 */
export function discoverHarnessModels(options?: {
  projectRoot?: string;
  homeDir?: string;
  forceRefresh?: boolean;
  skipCliSpawn?: boolean;
}): HarnessModelCatalog {
  const projectRoot = path.resolve(options?.projectRoot || process.cwd());
  const homeDir = options?.homeDir || os.homedir();
  const cacheKey = `${projectRoot}::${homeDir}`;

  if (!options?.forceRefresh && modelCatalogCache.has(cacheKey)) {
    return modelCatalogCache.get(cacheKey)!;
  }

  const sets: Record<HarnessId, Set<string>> = {
    antigravity: new Set<string>([
      "gemini-3.1-pro",
      "gemini-3-flash",
      "gemini-3-flash-lite",
      "claude-opus-4-6",
      "claude-sonnet-4-6",
      "gpt-oss-120b",
    ]),
    "claude-code": new Set<string>([
      "claude-opus-4-6",
      "claude-sonnet-4-6",
      "claude-haiku-4-5",
      "opus",
      "sonnet",
      "haiku",
    ]),
    codex: new Set<string>([
      "gpt-5.4",
      "gpt-5.3-codex",
      "gpt-5-codex",
    ]),
    opencode: new Set<string>([
      "minimax-m2.5-free",
      "glm-5",
      "deepseek-r1",
    ]),
  };

  // 1. Collect any models referenced in project/global routing.jsonc
  try {
    const cfg = loadRoutingConfig(projectRoot, options?.homeDir);
    for (const entry of [
      ...Object.values(cfg.agents ?? {}),
      ...Object.values(cfg.categories ?? {}),
    ]) {
      if (entry?.harness && entry?.model && sets[entry.harness]) {
        sets[entry.harness].add(entry.model);
      }
      for (const fb of entry?.fallbacks ?? []) {
        if (fb?.harness && fb?.model && sets[fb.harness]) {
          sets[fb.harness].add(fb.model);
        }
      }
    }
  } catch {
    // Ignore routing parse error
  }

  // 2. Scan Codex ~/.codex/config.toml and ~/.codex/models_cache.json
  try {
    const codexTomlPath = path.join(homeDir, ".codex", "config.toml");
    if (fs.existsSync(codexTomlPath)) {
      const tomlText = fs.readFileSync(codexTomlPath, "utf8");
      const matches = tomlText.matchAll(/^\s*model\s*=\s*["']([^"']+)["']/gm);
      for (const m of matches) {
        if (m[1]?.trim()) sets.codex.add(m[1].trim());
      }
    }
    const codexCachePath = path.join(homeDir, ".codex", "models_cache.json");
    if (fs.existsSync(codexCachePath)) {
      const cacheObj = JSON.parse(fs.readFileSync(codexCachePath, "utf8")) as {
        models?: Array<{ slug?: string }>;
      };
      if (Array.isArray(cacheObj.models)) {
        for (const item of cacheObj.models) {
          if (item?.slug && typeof item.slug === "string") {
            sets.codex.add(item.slug.trim());
          }
        }
      }
    }
  } catch {
    // Ignore codex scan errors
  }

  // 3. Scan Claude Code ~/.claude/settings.json & env
  try {
    if (process.env.ANTHROPIC_MODEL?.trim()) {
      sets["claude-code"].add(process.env.ANTHROPIC_MODEL.trim());
    }
    const claudeSettingsPath = path.join(homeDir, ".claude", "settings.json");
    if (fs.existsSync(claudeSettingsPath)) {
      const settingsObj = JSON.parse(fs.readFileSync(claudeSettingsPath, "utf8")) as {
        model?: string;
        env?: Record<string, string>;
      };
      if (typeof settingsObj.model === "string" && settingsObj.model.trim()) {
        sets["claude-code"].add(settingsObj.model.trim());
      }
      if (settingsObj.env?.ANTHROPIC_MODEL?.trim()) {
        sets["claude-code"].add(settingsObj.env.ANTHROPIC_MODEL.trim());
      }
    }
  } catch {
    // Ignore claude scan errors
  }

  // 4. Scan OpenCode ~/.config/opencode/opencode.json and `opencode models` CLI
  try {
    const opencodeJsonPath = path.join(homeDir, ".config", "opencode", "opencode.json");
    if (fs.existsSync(opencodeJsonPath)) {
      const ocObj = JSON.parse(fs.readFileSync(opencodeJsonPath, "utf8")) as {
        model?: string;
        small_model?: string;
        provider?: Record<string, { models?: Record<string, unknown> }>;
      };
      if (typeof ocObj.model === "string" && ocObj.model.trim()) {
        sets.opencode.add(ocObj.model.trim());
      }
      if (typeof ocObj.small_model === "string" && ocObj.small_model.trim()) {
        sets.opencode.add(ocObj.small_model.trim());
      }
      if (ocObj.provider && typeof ocObj.provider === "object") {
        for (const [provKey, provVal] of Object.entries(ocObj.provider)) {
          if (provVal?.models && typeof provVal.models === "object") {
            for (const mKey of Object.keys(provVal.models)) {
              sets.opencode.add(`${provKey}/${mKey}`);
            }
          }
        }
      }
    }

    if (!options?.skipCliSpawn) {
      const resolved = resolveSpawnCommand("opencode", ["models"]);
      const res = child_process.spawnSync(resolved.command, resolved.args, {
        encoding: "utf8",
        timeout: 3500,
        windowsHide: true,
        shell: resolved.shell,
      });
      if (res.status === 0 && res.stdout) {
        const lines = res.stdout
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l.length > 0 && !l.startsWith("[") && !l.includes(" "));
        for (const line of lines) {
          sets.opencode.add(line);
        }
      }
    }
  } catch {
    // Ignore opencode CLI errors
  }

  const catalog: HarnessModelCatalog = {
    antigravity: [...sets.antigravity],
    "claude-code": [...sets["claude-code"]],
    codex: [...sets.codex],
    opencode: [...sets.opencode],
  };

  modelCatalogCache.set(cacheKey, catalog);
  return catalog;
}

export function saveSessionMemo(options: {
  projectRoot: string;
  homeDir?: string;
  sessionId: string;
  memo: string;
}): { ok: boolean; sessionId: string; memo: string } {
  const projectRoot = path.resolve(options.projectRoot);
  const sessionId = options.sessionId.trim();
  const memo = options.memo.trim().slice(0, 80);

  if (!sessionId || /[\\/]|\.\./.test(sessionId)) {
    throw new Error("Invalid sessionId");
  }

  // Handle virtual standalone debate session IDs (`<realSessionId>::<debateId>`)
  const virtualSplitIdx = sessionId.indexOf("::");
  const realSessionId =
    virtualSplitIdx !== -1 ? sessionId.slice(0, virtualSplitIdx) : sessionId;

  let db: SqliteDriver | undefined;
  try {
    db = openProjectDb(projectRoot, options.homeDir);
    const existing = db.getSession(realSessionId);
    if (!existing) {
      db.createOrGetSession({
        sessionId: realSessionId,
        projectRoot,
        mainHarness: "claude-code",
        memo,
      });
    } else if (virtualSplitIdx === -1) {
      db.updateSessionMemo(realSessionId, memo);
    }
  } finally {
    db?.close();
  }

  // Persist memo inside .asd/sessions/<realSessionId>/main.json (including per-debate memos map)
  try {
    const sessionDir = path.join(projectRoot, ".asd", "sessions", realSessionId);
    fs.mkdirSync(sessionDir, { recursive: true });
    const mainJsonPath = path.join(sessionDir, "main.json");
    const current = readMainJsonMeta(projectRoot, realSessionId) ?? {
      sessionId: realSessionId,
      roleType: "main",
      harness: "claude-code",
      role: "director",
      phase: "planning",
      pid: process.pid,
      startedAt: new Date().toISOString(),
    };
    if (virtualSplitIdx !== -1) {
      const debateId = sessionId.slice(virtualSplitIdx + 2);
      const debateMemos =
        current.debateMemos && typeof current.debateMemos === "object"
          ? (current.debateMemos as Record<string, string>)
          : {};
      debateMemos[debateId] = memo;
      current.debateMemos = debateMemos;
    } else {
      current.memo = memo;
    }
    atomicWriteFileSync(mainJsonPath, JSON.stringify(current, null, 2) + "\n");
  } catch {
    // Ignore file sync error if SQLite succeeded
  }

  return { ok: true, sessionId, memo };
}

export function saveProjectRoutingConfig(options: {
  projectRoot: string;
  homeDir?: string;
  action?: "save" | "reset";
  routingConfig?: RoutingConfig;
}): {
  ok: boolean;
  hasLocalRouting: boolean;
  localRoutingPath: string;
  routingConfig: RoutingConfig;
} {
  const projectRoot = path.resolve(options.projectRoot);
  const paths = resolveAsdPaths(projectRoot, options.homeDir);

  if (options.action === "reset") {
    if (fs.existsSync(paths.localRoutingPath)) {
      fs.unlinkSync(paths.localRoutingPath);
    }
    const effective = loadRoutingConfig(projectRoot, options.homeDir);
    return {
      ok: true,
      hasLocalRouting: false,
      localRoutingPath: paths.localRoutingPath,
      routingConfig: effective,
    };
  }

  if (!options.routingConfig || typeof options.routingConfig !== "object") {
    throw new Error("Missing routingConfig payload");
  }

  const normalizedConfig: RoutingConfig = {
    _asdVersion: options.routingConfig._asdVersion || ASD_VERSION,
    agents: { ...(options.routingConfig.agents ?? {}) } as RoutingConfig["agents"],
    categories: { ...(options.routingConfig.categories ?? {}) },
  };

  for (const entry of [
    ...Object.values(normalizedConfig.agents),
    ...Object.values(normalizedConfig.categories),
  ]) {
    if (!entry || typeof entry !== "object") continue;
    entry.modelFamily = inferModelFamily(entry.model || "", entry.harness);
    if (!Array.isArray(entry.fallbacks)) {
      entry.fallbacks = [];
    } else {
      for (const fb of entry.fallbacks) {
        if (fb && typeof fb === "object") {
          fb.modelFamily = inferModelFamily(fb.model || "", fb.harness);
        }
      }
    }
  }

  fs.mkdirSync(path.dirname(paths.localRoutingPath), { recursive: true });
  const content =
    `// Project-Scoped ASD Routing Override (.asd/routing.jsonc)\n` +
    JSON.stringify(normalizedConfig, null, 2) +
    "\n";
  atomicWriteFileSync(paths.localRoutingPath, content);

  return {
    ok: true,
    hasLocalRouting: true,
    localRoutingPath: paths.localRoutingPath,
    routingConfig: normalizedConfig,
  };
}

function tryRefreshDebateVerdictFromLog(
  projectRoot: string,
  homeDir: string | undefined,
  sessionId: string,
  taskId: string,
  subSessionId: string,
  role: string,
  harness: string,
  model: string,
  rawOutput: string
): void {
  const parsed = parseReviewerOpening(rawOutput);
  if (!parsed) return;

  const paths = resolveAsdPaths(projectRoot, homeDir);
  if (!fs.existsSync(paths.dbPath)) return;

  const realSessionId = sessionId.includes("::")
    ? sessionId.split("::")[0]!
    : sessionId;

  let db: SqliteDriver | undefined;
  try {
    db = openProjectDb(projectRoot, homeDir);
    const debates = db.getSessionDebates(realSessionId);
    const debMatch = subSessionId.match(/-deb-(D-[A-Za-z0-9-]+)-/);
    const debateId = debMatch?.[1] || taskId;
    const debateRow = debates.find(
      (d) => d.debate_id === debateId || (d.task_id && d.task_id === taskId)
    );
    if (!debateRow) return;

    let r1: { openings?: Array<Record<string, unknown>>; failedReviewers?: unknown[] } = {
      openings: [],
      failedReviewers: [],
    };
    try {
      if (debateRow.round1_bundle_json) {
        r1 = JSON.parse(debateRow.round1_bundle_json);
      }
    } catch {}

    const openings = Array.isArray(r1.openings) ? r1.openings : [];
    const newOpening = {
      reviewerId: subSessionId,
      role,
      harness,
      model,
      modelFamily: inferModelFamily(model, harness as HarnessId),
      verdict: parsed.verdict,
      hard_constraints: parsed.hard_constraints,
      decisions: parsed.decisions,
      risks: parsed.risks,
      reasoning: parsed.reasoning,
      rawOutput,
    };

    const existingIdx = openings.findIndex(
      (o) => o.role === role && o.harness === harness
    );
    if (existingIdx >= 0) {
      openings[existingIdx] = newOpening;
    } else {
      openings.push(newOpening);
    }

    const verdicts = openings.map((o) => String(o.verdict ?? "APPROVE"));
    const finalVerdict = verdicts.includes("REJECT")
      ? "REJECT"
      : verdicts.includes("MINOR_AMEND")
        ? "MINOR_AMEND"
        : "APPROVE";

    const hardConstraints = deduplicateStrings(
      openings.flatMap((o) =>
        Array.isArray(o.hard_constraints) ? (o.hard_constraints as string[]) : []
      )
    );
    const decisions = deduplicateStrings(
      openings.flatMap((o) =>
        Array.isArray(o.decisions) ? (o.decisions as string[]) : []
      )
    );
    const risks = deduplicateStrings(
      openings.flatMap((o) =>
        Array.isArray(o.risks) ? (o.risks as string[]) : []
      )
    );

    const insightVerdict = {
      verdict: finalVerdict,
      hard_constraints: hardConstraints,
      decisions,
      risks,
      reasoning: openings
        .map((o) => `${o.role} (@${o.harness}/${o.model}): ${o.reasoning || o.verdict}`)
        .join("; "),
    };

    db.updateDebateVerdict(debateRow.debate_id, "done", {
      round1BundleJson: JSON.stringify({
        openings,
        failedReviewers: r1.failedReviewers ?? [],
      }),
      insightVerdictJson: JSON.stringify(insightVerdict),
    });
  } catch {
    // Ignore DB refresh error
  } finally {
    db?.close();
  }
}

export async function runSubagentControlAction(options: {
  projectRoot: string;
  homeDir?: string;
  sessionId: string;
  subSessionId: string;
  action: "kill" | "retry" | "fallback" | "custom";
  harness?: HarnessId;
  model?: string;
  commandRunner?: CommandRunner;
  waitForCompletion?: boolean;
}): Promise<{
  ok: boolean;
  action: string;
  sessionId: string;
  subSessionId: string;
  newSubSessionId?: string;
  harness?: string;
  model?: string;
  status: string;
}> {
  const projectRoot = path.resolve(options.projectRoot);
  const logs = scanSubagentLogs(projectRoot);
  const realSessionId = options.sessionId.includes("::")
    ? options.sessionId.split("::")[0]!
    : options.sessionId;

  const target =
    logs.find(
      (l) =>
        l.subSessionId === options.subSessionId &&
        (!realSessionId || l.sessionId === realSessionId)
    ) ?? logs.find((l) => l.subSessionId === options.subSessionId);

  if (!target) {
    throw new Error(`Subagent not found: ${options.subSessionId}`);
  }

  const metaPath = path.join(target.dirPath, "meta.json");

  // 1. Action: kill
  if (options.action === "kill") {
    if (target.pid && target.pid > 0) {
      killProcessTree(target.pid);
    }
    try {
      if (fs.existsSync(metaPath)) {
        const meta = JSON.parse(fs.readFileSync(metaPath, "utf8")) as Record<string, unknown>;
        meta.status = "failed";
        meta.finishedAt = Date.now();
        atomicWriteFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n");
      }
      const logPath = path.join(target.dirPath, "output.log");
      fs.appendFileSync(logPath, "\n[ASD UI] Process terminated by user.\n", "utf8");
    } catch {
      // Ignore
    }
    return {
      ok: true,
      action: "kill",
      sessionId: target.sessionId,
      subSessionId: target.subSessionId,
      harness: target.harness,
      model: target.model,
      status: "failed",
    };
  }

  // 2. Determine target harness & model for retry / fallback / custom
  const routingCfg = loadRoutingConfig(projectRoot, options.homeDir);
  const normRole = normalizeAgentRole(target.role) ?? "worker";
  const roleRoute = routingCfg.agents[normRole];

  let nextHarness = (target.harness || "claude-code") as HarnessId;
  let nextModel = target.model || "claude-sonnet-4-6";
  let suffix = "retry";

  if (options.action === "retry") {
    suffix = `retry-${Date.now().toString(36).slice(-4)}`;
  } else if (options.action === "fallback") {
    suffix = `fb-${Date.now().toString(36).slice(-4)}`;
    const candidates = roleRoute
      ? [
          {
            harness: roleRoute.harness,
            model: roleRoute.model,
            modelFamily: roleRoute.modelFamily,
          },
          ...(roleRoute.fallbacks ?? []),
        ]
      : [];

    const curIdx = candidates.findIndex(
      (c) => c.harness === target.harness && c.model === target.model
    );
    const fbCandidate =
      curIdx >= 0 && curIdx + 1 < candidates.length
        ? candidates[curIdx + 1]
        : candidates.find(
            (c) => c.harness !== target.harness || c.model !== target.model
          );

    if (fbCandidate) {
      nextHarness = fbCandidate.harness;
      nextModel = fbCandidate.model;
    } else {
      const resolvedFb = resolveFallback(
        {
          harness: nextHarness,
          model: nextModel,
          modelFamily: inferModelFamily(nextModel, nextHarness),
          fallbacks: roleRoute?.fallbacks ?? [],
          tier: 2,
        },
        routingCfg
      );
      if (resolvedFb) {
        nextHarness = resolvedFb.harness;
        nextModel = resolvedFb.model;
      }
    }
  } else if (options.action === "custom") {
    suffix = `custom-${Date.now().toString(36).slice(-4)}`;
    if (!options.harness) {
      throw new Error("Missing harness for custom execution");
    }
    nextHarness = options.harness;
    nextModel =
      options.model && options.model.trim()
        ? options.model.trim()
        : roleRoute?.harness === nextHarness
          ? roleRoute.model
          : "";
  }

  const baseSubId = target.subSessionId.replace(/-(?:retry|fb|custom)-[a-z0-9]+$/i, "");
  const newSubSessionId = `${baseSubId}-${suffix}`;
  const promptText = target.prompt || "Continue task.";
  const cmdInfo = buildDefaultHarnessCommand(nextHarness, promptText, nextModel);

  const debMatch = target.subSessionId.match(/-deb-(D-[A-Za-z0-9-]+)-/);
  const effectiveTaskId = target.taskId || debMatch?.[1] || normRole;

  const runPromise = spawnSubagent({
    projectRoot,
    homeDir: options.homeDir,
    mainSessionId: target.sessionId,
    subSessionId: newSubSessionId,
    role: normRole as AgentRole,
    harness: nextHarness,
    model: nextModel || "default",
    taskId: effectiveTaskId,
    prompt: promptText,
    allowedFiles: target.allowedFiles ?? [],
    worktreePath: target.worktreePath ?? null,
    cwd:
      target.worktreePath && fs.existsSync(target.worktreePath)
        ? target.worktreePath
        : projectRoot,
    command: cmdInfo.command,
    args: cmdInfo.args,
    commandRunner: options.commandRunner,
    timeoutMs: DEFAULT_DEBATE_TIMEOUT_MS,
    idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
  }).then((res) => {
    try {
      const outPath = path.join(path.dirname(res.metaPath), "output.log");
      const rawOut = fs.existsSync(outPath) ? fs.readFileSync(outPath, "utf8") : "";
      if (res.exitCode === 0 && rawOut) {
        tryRefreshDebateVerdictFromLog(
          projectRoot,
          options.homeDir,
          target.sessionId,
          effectiveTaskId,
          newSubSessionId,
          normRole,
          nextHarness,
          nextModel || "default",
          rawOut
        );
      }
    } catch {
      // Ignore post-processing errors
    }
    return res;
  });

  if (options.waitForCompletion || options.commandRunner) {
    const completed = await runPromise;
    return {
      ok: completed.exitCode === 0,
      action: options.action,
      sessionId: options.sessionId || target.sessionId,
      subSessionId: target.subSessionId,
      newSubSessionId,
      harness: nextHarness,
      model: nextModel || "default",
      status: completed.exitCode === 0 ? "done" : "failed",
    };
  }

  // Fire-and-forget for real live UI responsiveness
  void runPromise.catch(() => {});

  return {
    ok: true,
    action: options.action,
    sessionId: options.sessionId || target.sessionId,
    subSessionId: target.subSessionId,
    newSubSessionId,
    harness: nextHarness,
    model: nextModel || "default",
    status: "running",
  };
}

export async function collectDashboardSnapshot(options?: {
  projectRoot?: string;
  homeDir?: string;
}): Promise<DashboardSnapshot> {
  const projectRoot = path.resolve(options?.projectRoot || process.cwd());
  const homeDir = options?.homeDir;
  const paths = resolveAsdPaths(projectRoot, homeDir);

  let rawSessions: SessionRow[] = [];
  let allTasks: TaskRow[] = [];
  let rawDebates: DebateRow[] = [];

  if (fs.existsSync(paths.dbPath)) {
    let db: SqliteDriver | undefined;
    try {
      db = openProjectDb(projectRoot, homeDir);
      rawSessions = db.listSessions();
      allTasks = db.getAllTasks();
      rawDebates = db.getAllDebates();
    } catch {
      // Ignore transient read issues
    } finally {
      db?.close();
    }
  }

  const rawSubagentLogs = scanSubagentLogs(projectRoot);

  // Backfill missing taskId on legacy debate subagent logs (`...-deb-<debateId>-r1-1`)
  const subagentLogs: SubagentLogRecord[] = rawSubagentLogs.map((l) => {
    const debMatch = l.subSessionId.match(/-deb-(D-[A-Za-z0-9-]+)-/);
    const inferredTaskId = l.taskId || debMatch?.[1] || "";
    return {
      ...l,
      taskId: inferredTaskId,
    };
  });

  // Split sessions that have multiple standalone (task_id === null) debates into
  // separate virtual session rows (`<sessionId>::<debateId>`) so historical debates
  // that were accidentally grouped under one session appear as individual entries.
  const sessionMap = new Map<string, SessionRow>();
  const allDebates: DebateRow[] = [];

  for (const s of rawSessions) {
    const mainMeta = readMainJsonMeta(projectRoot, s.session_id);
    const diskMemo = typeof mainMeta?.memo === "string" ? mainMeta.memo : "";
    const debateMemos =
      mainMeta?.debateMemos && typeof mainMeta.debateMemos === "object"
        ? (mainMeta.debateMemos as Record<string, string>)
        : {};

    const sTasks = allTasks.filter((t) => t.session_id === s.session_id);
    const sDebates = rawDebates.filter((d) => d.session_id === s.session_id);
    const standaloneDebates = sDebates.filter((d) => !d.task_id);

    if (sTasks.length === 0 && standaloneDebates.length > 1) {
      // Split each standalone debate into its own selectable session entry
      for (const d of standaloneDebates) {
        const virtualId = `${s.session_id}::${d.debate_id}`;
        const relatedLogs = subagentLogs.filter(
          (l) =>
            l.sessionId === s.session_id &&
            (l.taskId === d.debate_id || l.subSessionId.includes(`-deb-${d.debate_id}-`))
        );
        for (const rl of relatedLogs) {
          rl.sessionId = virtualId;
        }
        const startedTime =
          relatedLogs.length > 0
            ? Math.min(...relatedLogs.map((r) => r.startedAt || s.created_at))
            : s.created_at;
        const customDebateMemo = debateMemos[d.debate_id]?.trim();
        sessionMap.set(virtualId, {
          ...s,
          session_id: virtualId,
          memo: customDebateMemo || d.topic.slice(0, 40),
          created_at: startedTime,
          updated_at: startedTime,
        });
        allDebates.push({
          ...d,
          session_id: virtualId,
        });
      }
    } else {
      const autoDebateTopic = sDebates[0]?.topic ?? "";
      const autoTaskTitle = sTasks[0]?.title ?? "";
      const effectiveMemo =
        (s.memo && s.memo.trim()) ||
        diskMemo.trim() ||
        autoDebateTopic.slice(0, 40) ||
        autoTaskTitle.slice(0, 40) ||
        "";
      sessionMap.set(s.session_id, {
        ...s,
        memo: effectiveMemo,
      });
      allDebates.push(...sDebates);
    }
  }

  for (const log of subagentLogs) {
    if (!log.sessionId) continue;
    if (!sessionMap.has(log.sessionId)) {
      const mainMeta = readMainJsonMeta(projectRoot, log.sessionId);
      const diskMemo = typeof mainMeta?.memo === "string" ? mainMeta.memo : "";
      sessionMap.set(log.sessionId, {
        session_id: log.sessionId,
        project_root: projectRoot,
        main_harness: log.harness || "claude-code",
        main_pid: null,
        phase: "done",
        state_version: 1,
        base_sha: null,
        stashed_work_sha: null,
        no_progress_count: 0,
        memo: diskMemo || log.taskId || log.role || "",
        created_at: log.startedAt || Date.now(),
        updated_at: log.finishedAt || log.startedAt || Date.now(),
      });
    }
  }

  const sessions = [...sessionMap.values()].sort((a, b) => b.created_at - a.created_at);
  const session = sessions[0] ?? null;
  const tasks = session
    ? allTasks.filter((t) => t.session_id === session.session_id)
    : [];
  const debates = session
    ? allDebates.filter((d) => d.session_id === session.session_id)
    : [];

  const cacheKey = `${projectRoot}::${homeDir ?? ""}`;
  let harnesses = doctorCache.get(cacheKey);
  if (!harnesses) {
    const doctor = await runAsdDoctor({ projectRoot, homeDir });
    harnesses = doctor.harnesses;
    doctorCache.set(cacheKey, harnesses);
  }

  const routingConfig = loadRoutingConfig(projectRoot, homeDir);
  const hasLocalRouting = fs.existsSync(paths.localRoutingPath);
  const availableModels = discoverHarnessModels({
    projectRoot,
    homeDir,
    skipCliSpawn: false,
  });

  return {
    version: ASD_VERSION,
    projectRoot,
    systemLocale: detectSystemLocale(),
    timestamp: Date.now(),
    session,
    sessions,
    tasks,
    allTasks,
    debates,
    allDebates,
    subagentLogs,
    routingConfig,
    hasLocalRouting,
    localRoutingPath: paths.localRoutingPath,
    availableModels,
    harnesses,
  };
}

function renderDashboardHtml(defaultLocale = detectSystemLocale()): string {
  const defaultLang = defaultLocale.toLowerCase().startsWith("ko") ? "ko" : "en";
  return `<!DOCTYPE html>
<html lang="${defaultLang}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ASD v${ASD_VERSION} — Multi-Agent Control Plane</title>
  <style>
    :root {
      --bg: #0b0f17;
      --panel: #131b2b;
      --border: #23304a;
      --text: #e6edf3;
      --muted: #8b9bb4;
      --accent: #58a6ff;
      --ok: #3fb950;
      --warn: #d29922;
      --err: #f85149;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Pretendard", "Malgun Gothic", "Segoe UI", Roboto, monospace;
      background: var(--bg);
      color: var(--text);
      line-height: 1.5;
    }
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 14px 24px;
      background: var(--panel);
      border-bottom: 1px solid var(--border);
    }
    header h1 { margin: 0; font-size: 18px; color: var(--accent); }
    .header-right {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .lang-toggle {
      display: inline-flex;
      border: 1px solid var(--border);
      border-radius: 6px;
      overflow: hidden;
      background: #0d1421;
    }
    .lang-btn {
      background: transparent;
      border: none;
      color: var(--muted);
      padding: 5px 11px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
    }
    .lang-btn.active {
      background: var(--accent);
      color: #0b0f17;
    }
    .meta-bar { font-size: 12px; color: var(--muted); }
    .container {
      display: grid;
      grid-template-columns: 300px 1fr 480px;
      gap: 16px;
      padding: 20px 24px;
      max-width: 1800px;
      margin: 0 auto;
    }
    @media (max-width: 1280px) {
      .container { grid-template-columns: 1fr; }
    }
    .kpis {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 12px;
      margin-bottom: 16px;
    }
    .card {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 14px 16px;
    }
    .card-title { font-size: 12px; color: var(--muted); text-transform: uppercase; margin-bottom: 8px; font-weight: 600; }
    .card-value { font-size: 18px; font-weight: 700; word-break: break-all; }
    .progress-bar {
      height: 8px;
      background: #1c273d;
      border-radius: 4px;
      overflow: hidden;
      margin-top: 8px;
    }
    .progress-fill { height: 100%; background: var(--ok); transition: width 0.25s ease; }
    .session-item {
      padding: 10px 12px;
      border: 1px solid var(--border);
      border-radius: 6px;
      margin-bottom: 8px;
      cursor: pointer;
      background: #0f1624;
      transition: border-color 0.15s ease, background 0.15s ease;
    }
    .session-item:hover, .session-item.active {
      border-color: var(--accent);
      background: #162238;
    }
    .session-item-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 6px;
      font-size: 13px;
      font-weight: 700;
    }
    .session-memo-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 6px;
      margin-top: 4px;
      font-size: 12px;
      color: #c9d1d9;
    }
    .btn {
      background: #1c273d;
      border: 1px solid var(--border);
      color: var(--text);
      border-radius: 5px;
      padding: 5px 10px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.15s ease, color 0.15s ease;
    }
    .btn:hover { background: var(--accent); color: #0b0f17; border-color: var(--accent); }
    .btn-primary { background: rgba(88,166,255,0.2); border-color: var(--accent); color: var(--accent); }
    .btn-danger { background: rgba(248,81,73,0.18); border-color: var(--err); color: var(--err); }
    .btn-danger:hover { background: var(--err); color: #fff; }
    .btn-warn { background: rgba(210,153,34,0.18); border-color: var(--warn); color: var(--warn); }
    .btn-warn:hover { background: var(--warn); color: #0b0f17; }
    .memo-edit-btn {
      background: #1c273d;
      border: 1px solid var(--border);
      color: var(--accent);
      border-radius: 4px;
      padding: 2px 6px;
      font-size: 11px;
      cursor: pointer;
      flex-shrink: 0;
    }
    .memo-edit-btn:hover {
      background: var(--accent);
      color: #0b0f17;
    }
    .task-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 10px 12px;
      border: 1px solid var(--border);
      border-radius: 6px;
      margin-bottom: 8px;
      cursor: pointer;
      background: #0f1624;
    }
    .task-row:hover, .task-row.active { border-color: var(--accent); background: #162238; }
    .debate-row {
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 10px 12px;
      margin-bottom: 8px;
      cursor: pointer;
      background: #0f1624;
    }
    .debate-row:hover, .debate-row.active { border-color: var(--accent); background: #162238; }
    .badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 600;
      margin-right: 6px;
    }
    .st-done { background: rgba(63,185,80,0.18); color: var(--ok); }
    .st-running { background: rgba(88,166,255,0.18); color: var(--accent); }
    .st-failed, .st-escalated, .st-merge_conflict { background: rgba(248,81,73,0.18); color: var(--err); }
    .st-pending { background: rgba(139,155,180,0.15); color: var(--muted); }
    pre {
      background: #090d14;
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 12px;
      overflow-x: auto;
      font-size: 12px;
      max-height: 360px;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .harness-list { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 6px; }
    .pill-scroll {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
      max-height: 120px;
      overflow-y: auto;
      margin-bottom: 10px;
      padding-bottom: 4px;
    }
    .control-box {
      background: #0d1421;
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 10px;
      margin: 8px 0 10px 0;
    }
    .control-actions {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
      margin-bottom: 8px;
    }
    .custom-run-row {
      display: flex;
      gap: 6px;
      align-items: center;
      flex-wrap: wrap;
    }
    select, input[type="text"] {
      background: #090d14;
      border: 1px solid var(--border);
      color: var(--text);
      border-radius: 4px;
      padding: 4px 8px;
      font-size: 12px;
      font-family: inherit;
    }
    .routing-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
      margin-top: 8px;
    }
    .routing-table th, .routing-table td {
      border-bottom: 1px solid var(--border);
      padding: 6px 8px;
      text-align: left;
    }
    .routing-table th { color: var(--muted); font-weight: 600; }

    /* Popup Modal for 2x2 Harness Model Viewer */
    .modal-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(5, 8, 14, 0.78);
      display: none;
      align-items: center;
      justify-content: center;
      z-index: 1000;
      padding: 24px;
    }
    .modal-backdrop.open {
      display: flex;
    }
    .modal-window {
      background: var(--panel);
      border: 1px solid var(--accent);
      border-radius: 10px;
      width: 100%;
      max-width: 960px;
      max-height: 85vh;
      display: flex;
      flex-direction: column;
      box-shadow: 0 20px 50px rgba(0,0,0,0.6);
    }
    .modal-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 14px 20px;
      border-bottom: 1px solid var(--border);
    }
    .modal-body {
      padding: 18px 20px;
      overflow-y: auto;
    }
    .model-grid-2x2 {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
    }
    @media (max-width: 720px) {
      .model-grid-2x2 { grid-template-columns: 1fr; }
    }
    .model-harness-box {
      background: #0d1421;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 12px 14px;
      display: flex;
      flex-direction: column;
    }
    .model-harness-title {
      font-size: 14px;
      font-weight: 700;
      color: var(--accent);
      margin-bottom: 8px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .model-list-scroll {
      max-height: 220px;
      overflow-y: auto;
      border-top: 1px solid var(--border);
      padding-top: 8px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .model-item-pill {
      background: #131b2b;
      border: 1px solid #1f2b42;
      border-radius: 4px;
      padding: 4px 8px;
      font-size: 12px;
      color: var(--text);
      font-family: monospace;
    }
  </style>
</head>
<body>
  <header>
    <div>
      <h1 id="headerTitle">ASD Multi-Agent Control Plane (v${ASD_VERSION})</h1>
      <div class="meta-bar" id="projPath">Loading...</div>
    </div>
    <div class="header-right">
      <div class="meta-bar" id="lastUpdated">Auto-refresh: 2s</div>
      <button type="button" class="btn btn-primary" id="btnToggleRouting" onclick="toggleRoutingEditor()">라우팅 편집</button>
      <button type="button" class="btn" id="btnOpenModelsModal" onclick="openModelsModal()">모델 확인</button>
      <div class="lang-toggle" role="group" aria-label="Language toggle">
        <button type="button" class="lang-btn" id="btnKo" onclick="setLang('ko')">한국어</button>
        <button type="button" class="lang-btn" id="btnEn" onclick="setLang('en')">EN</button>
      </div>
    </div>
  </header>

  <!-- 2x2 Harness Model List Popup Modal -->
  <div class="modal-backdrop" id="modelsModalBackdrop" onclick="closeModelsModalOnBackdrop(event)">
    <div class="modal-window">
      <div class="modal-header">
        <div>
          <strong id="modelsModalTitle" style="font-size:15px;color:var(--accent);">하네스별 사용 가능한 모델 목록</strong>
        </div>
        <div style="display:flex; gap:8px;">
          <button type="button" class="btn btn-primary" id="btnRefreshModelsOnly" onclick="refreshModelCatalogOnly()">🔄 모델 목록 새로고침</button>
          <button type="button" class="btn" id="btnCloseModelsModal" onclick="closeModelsModal()">닫기</button>
        </div>
      </div>
      <div class="modal-body">
        <div class="model-grid-2x2" id="modelsGrid2x2"></div>
      </div>
    </div>
  </div>

  <div class="container">
    <nav>
      <div class="card" style="position:sticky; top:16px;">
        <div class="card-title" id="sessionsSectionTitle">Sessions (.asd)</div>
        <div id="sessionList">Loading...</div>
      </div>
    </nav>
    <main>
      <div class="card" id="routingEditorCard" style="display:none; margin-bottom:16px;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; flex-wrap:wrap; gap:8px;">
          <div>
            <div class="card-title" id="routingEditorTitle" style="margin-bottom:2px;">Project Routing Editor (.asd/routing.jsonc)</div>
            <div class="meta-bar" id="routingScopeBadge">-</div>
          </div>
          <div style="display:flex; gap:6px;">
            <button type="button" class="btn" id="btnRefreshModelsInRouting" onclick="refreshModelCatalogOnly()">🔄 모델 목록 새로고침</button>
            <button type="button" class="btn btn-primary" id="btnSaveRouting" onclick="saveRouting()">저장 (.asd/routing.jsonc)</button>
            <button type="button" class="btn btn-warn" id="btnResetRouting" onclick="resetRouting()">글로벌 기본값으로 초기화</button>
            <button type="button" class="btn" onclick="toggleRoutingEditor()">닫기</button>
          </div>
        </div>
        <div id="routingEditorBody"></div>
      </div>
      <div class="kpis" id="kpiGrid"></div>
      <div class="card" style="margin-bottom:16px;">
        <div class="card-title" id="debatesSectionTitle">Adversarial Debates in Selected Session</div>
        <div id="debateList">-</div>
      </div>
      <div class="card">
        <div class="card-title" id="tasksSectionTitle">Tasks & Wave Execution in Selected Session</div>
        <div id="taskList">Loading...</div>
      </div>
    </main>
    <aside>
      <div class="card" style="position:sticky; top:16px;">
        <div class="card-title" id="inspectorSectionTitle">Subagent Log & Prompt Inspector</div>
        <div id="inspector">-</div>
      </div>
    </aside>
  </div>
  <script>
    const SERVER_DEFAULT_LANG = "${defaultLang}";
    const HARNESS_OPTIONS = ["claude-code", "opencode", "codex", "antigravity"];
    let availableModelsByHarness = {
      "antigravity": ["gemini-3.1-pro", "gemini-3-flash", "gemini-3-flash-lite"],
      "claude-code": ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"],
      "codex": ["gpt-5.4", "gpt-5.3-codex", "gpt-5-codex"],
      "opencode": ["minimax-m2.5-free", "glm-5", "deepseek-r1"]
    };

    const I18N = {
      ko: {
        headerTitle: "ASD 멀티 에이전트 컨트롤 플레인 (v${ASD_VERSION})",
        btnToggleRouting: "라우팅 편집",
        btnOpenModelsModal: "모델 확인",
        modelsModalTitle: "하네스별 사용 가능한 모델 목록",
        btnRefreshModelsOnly: "🔄 모델 목록 새로고침",
        btnCloseModelsModal: "닫기",
        harnessLabels: {
          "antigravity": "안티그래비티 (Antigravity)",
          "claude-code": "클로드 코드 (Claude Code)",
          "codex": "코덱스 (Codex)",
          "opencode": "오픈코드 (OpenCode)"
        },
        routingEditorTitle: "프로젝트 종속 라우팅 편집기 (.asd/routing.jsonc)",
        routingLocalActive: "현재 상태: 프로젝트 전용 오버라이드 적용 중 (.asd/routing.jsonc)",
        routingGlobalFallback: "현재 상태: 글로벌 설정 사용 중 (저장 시 .asd/routing.jsonc 생성)",
        btnSaveRouting: "💾 프로젝트에 저장",
        btnResetRouting: "↺ 글로벌 기본값 복원",
        routingAgentsHeader: "코어 에이전트 5종 (Agents)",
        routingCategoriesHeader: "난이도 3단계 & 도메인 카테고리 (Categories)",
        colKey: "대상 (Role / Category)",
        colPrimaryHarness: "1순위 하네스",
        colPrimaryModel: "1순위 모델 (선택)",
        colEffort: "추론 강도 (Effort)",
        colFallbacks: "2순위+ Fallback 체인 (harness:model, 쉼표 구분)",
        savedAlert: "프로젝트 라우팅(.asd/routing.jsonc)이 저장되었습니다.",
        resetAlert: "프로젝트 로컬 라우팅을 삭제하고 글로벌 기본값으로 복원했습니다.",
        updatedPrefix: "최근 갱신: ",
        sessionsSectionTitle: "세션 목록 (클릭하여 상세 보기 · 메모 관리)",
        noSessions: "기록된 세션이 없습니다.",
        memoPlaceholder: "(메모 없음)",
        editMemoBtn: "메모",
        editMemoPrompt: "이 세션의 짧은 메모를 입력하세요 (.asd 내부에 저장됩니다):",
        activeSession: "선택된 세션",
        noSession: "없음",
        phasePrefix: "단계: ",
        progress: "세션 작업 진행률",
        harnesses: "하네스 가용 상태",
        installedOk: "설치됨",
        installedNo: "미설치",
        tasksSectionTitle: "세션 내 작업(Task) 실행 현황 (클릭 시 우측에 서브에이전트 로그 표시)",
        noTasks: "선택된 세션에 등록된 작업이 없습니다.",
        debatesSectionTitle: "세션 내 적대적 토론 (클릭 시 해당 토론의 리뷰어 서브에이전트 로그 표시)",
        noDebates: "선택된 세션에 기록된 토론 내역이 없습니다.",
        inspectorSectionTitle: "서브에이전트 제어 & 실행 로그 뷰어",
        noLogs: "선택된 항목의 서브에이전트 실행 로그가 없습니다",
        forTask: " — 대상: ",
        subSession: "서브세션",
        statusLabel: "상태",
        outputLog: "실행 출력 로그 (output.log)",
        promptLabel: "전달된 프롬프트 (prompt.md)",
        emptyText: "(비어 있음)",
        showAllSessionLogs: "이 세션의 전체 서브에이전트 보기",
        btnKill: "■ 강제 종료 (Kill)",
        btnRetry: "↻ 동일 모델 재실행",
        btnFallback: "⏭ Fallback으로 실행",
        btnCustomRun: "🎯 선택한 모델로 실행",
        actionTriggered: "실행 요청됨: ",
        statusMap: {
          done: "완료",
          running: "실행중",
          failed: "실패",
          escalated: "상위모델 승격",
          merge_conflict: "병합 충돌",
          pending: "대기중"
        }
      },
      en: {
        headerTitle: "ASD Multi-Agent Control Plane (v${ASD_VERSION})",
        btnToggleRouting: "Routing Editor",
        btnOpenModelsModal: "Models",
        modelsModalTitle: "Available Models by Harness",
        btnRefreshModelsOnly: "🔄 Refresh Model List",
        btnCloseModelsModal: "Close",
        harnessLabels: {
          "antigravity": "Antigravity",
          "claude-code": "Claude Code",
          "codex": "Codex",
          "opencode": "OpenCode"
        },
        routingEditorTitle: "Project-Scoped Routing Editor (.asd/routing.jsonc)",
        routingLocalActive: "Scope: Project Local Override Active (.asd/routing.jsonc)",
        routingGlobalFallback: "Scope: Inheriting Global Config (Saving creates .asd/routing.jsonc)",
        btnSaveRouting: "💾 Save to Project",
        btnResetRouting: "↺ Reset to Global",
        routingAgentsHeader: "5 Core Agents",
        routingCategoriesHeader: "3 Difficulty Tiers & Domain Categories",
        colKey: "Role / Category",
        colPrimaryHarness: "Primary Harness",
        colPrimaryModel: "Primary Model (Select)",
        colEffort: "Thinking Effort",
        colFallbacks: "2nd+ Fallbacks (harness:model, comma-separated)",
        savedAlert: "Saved project routing config to .asd/routing.jsonc.",
        resetAlert: "Removed local override and restored global routing config.",
        updatedPrefix: "Updated: ",
        sessionsSectionTitle: "Sessions (Click to inspect · Manage memos)",
        noSessions: "No sessions recorded.",
        memoPlaceholder: "(no memo)",
        editMemoBtn: "Memo",
        editMemoPrompt: "Enter a short memo for this session (saved in .asd):",
        activeSession: "Selected Session",
        noSession: "None",
        phasePrefix: "Phase: ",
        progress: "Session Task Progress",
        harnesses: "Harnesses",
        installedOk: "OK",
        installedNo: "N/A",
        tasksSectionTitle: "Session Tasks & Wave Execution (Click any task to inspect logs)",
        noTasks: "No tasks in selected session.",
        debatesSectionTitle: "Session Adversarial Debates (Click any debate to inspect reviewer logs)",
        noDebates: "No debates in selected session.",
        inspectorSectionTitle: "Subagent Controller & Log Inspector",
        noLogs: "No subagent log found",
        forTask: " for ",
        subSession: "SubSession",
        statusLabel: "Status",
        outputLog: "Output Log",
        promptLabel: "Prompt",
        emptyText: "(empty)",
        showAllSessionLogs: "Show all subagents in this session",
        btnKill: "■ Force Kill",
        btnRetry: "↻ Retry Same",
        btnFallback: "⏭ Run Fallback",
        btnCustomRun: "🎯 Run Selected",
        actionTriggered: "Triggered: ",
        statusMap: {
          done: "done",
          running: "running",
          failed: "failed",
          escalated: "escalated",
          merge_conflict: "merge_conflict",
          pending: "pending"
        }
      }
    };

    function detectInitialLang() {
      try {
        const saved = localStorage.getItem("asd_lang");
        if (saved === "ko" || saved === "en") return saved;
      } catch {}
      const navLang = (navigator.language || SERVER_DEFAULT_LANG || "en").toLowerCase();
      return navLang.startsWith("ko") ? "ko" : "en";
    }

    let currentLang = detectInitialLang();
    let selectedSessionId = null;
    let selectedTaskId = null;
    let selectedSubSessionId = null;
    let routingEditorOpen = false;
    let modelsModalOpen = false;
    let customHarnessPick = "opencode";
    let customModelPick = "minimax-m2.5-free";
    let actionStatusMsg = "";
    let latestState = null;

    function getModelsForHarness(harness, currentModel) {
      const base = Array.isArray(availableModelsByHarness[harness])
        ? [...availableModelsByHarness[harness]]
        : [];
      if (currentModel && !base.includes(currentModel)) {
        base.unshift(currentModel);
      }
      return base;
    }

    function buildModelSelectOptionsHtml(harness, selectedModel) {
      const models = getModelsForHarness(harness, selectedModel);
      return models.map(m =>
        \`<option value="\${esc(m)}" \${m === selectedModel ? 'selected' : ''}>\${esc(m)}</option>\`
      ).join("");
    }

    function updateLangButtons() {
      document.documentElement.lang = currentLang;
      document.getElementById("btnKo").classList.toggle("active", currentLang === "ko");
      document.getElementById("btnEn").classList.toggle("active", currentLang === "en");
      const t = I18N[currentLang];
      document.getElementById("headerTitle").textContent = t.headerTitle;
      document.getElementById("btnToggleRouting").textContent = t.btnToggleRouting;
      document.getElementById("btnOpenModelsModal").textContent = t.btnOpenModelsModal;
      document.getElementById("modelsModalTitle").textContent = t.modelsModalTitle;
      document.getElementById("btnRefreshModelsOnly").textContent = t.btnRefreshModelsOnly;
      document.getElementById("btnRefreshModelsInRouting").textContent = t.btnRefreshModelsOnly;
      document.getElementById("btnCloseModelsModal").textContent = t.btnCloseModelsModal;
      document.getElementById("routingEditorTitle").textContent = t.routingEditorTitle;
      document.getElementById("btnSaveRouting").textContent = t.btnSaveRouting;
      document.getElementById("btnResetRouting").textContent = t.btnResetRouting;
      document.getElementById("sessionsSectionTitle").textContent = t.sessionsSectionTitle;
      document.getElementById("tasksSectionTitle").textContent = t.tasksSectionTitle;
      document.getElementById("debatesSectionTitle").textContent = t.debatesSectionTitle;
      document.getElementById("inspectorSectionTitle").textContent = t.inspectorSectionTitle;
    }

    function setLang(lang) {
      if (lang !== "ko" && lang !== "en") return;
      currentLang = lang;
      try { localStorage.setItem("asd_lang", lang); } catch {}
      updateLangButtons();
      if (routingEditorOpen && latestState) renderRoutingEditor(latestState);
      if (modelsModalOpen) renderModelsModal();
      render(latestState);
    }

    function esc(s) {
      return String(s ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    }

    function openModelsModal() {
      modelsModalOpen = true;
      document.getElementById("modelsModalBackdrop").classList.add("open");
      renderModelsModal();
    }

    function closeModelsModal() {
      modelsModalOpen = false;
      document.getElementById("modelsModalBackdrop").classList.remove("open");
    }

    function closeModelsModalOnBackdrop(ev) {
      if (ev.target && ev.target.id === "modelsModalBackdrop") {
        closeModelsModal();
      }
    }

    function renderModelsModal() {
      const t = I18N[currentLang];
      // 2x2 order matching user sketch: Top-Left: Antigravity, Top-Right: Claude Code, Bottom-Left: Codex, Bottom-Right: OpenCode
      const gridOrder = ["antigravity", "claude-code", "codex", "opencode"];
      const html = gridOrder.map(h => {
        const list = availableModelsByHarness[h] || [];
        const label = (t.harnessLabels && t.harnessLabels[h]) || h;
        const itemsHtml = list.length
          ? list.map(m => \`<div class="model-item-pill">\${esc(m)}</div>\`).join("")
          : \`<div class="meta-bar">(없음)</div>\`;
        return \`
          <div class="model-harness-box">
            <div class="model-harness-title">
              <span>\${esc(label)}</span>
              <span class="badge st-running">\${list.length}</span>
            </div>
            <div class="model-list-scroll">\${itemsHtml}</div>
          </div>
        \`;
      }).join("");
      document.getElementById("modelsGrid2x2").innerHTML = html;
    }

    async function refreshModelCatalogOnly() {
      try {
        const res = await fetch("/api/models/refresh", { method: "POST" });
        if (res.ok) {
          const data = await res.json();
          if (data && data.availableModels) {
            availableModelsByHarness = data.availableModels;
            if (modelsModalOpen) renderModelsModal();
            if (routingEditorOpen) {
              // Refresh only the model <select> options inside routing editor while preserving current selections
              document.querySelectorAll("#routingEditorBody tr[data-rt-section]").forEach(tr => {
                const hSel = tr.querySelector(".rt-harness");
                const mSel = tr.querySelector(".rt-model");
                if (hSel && mSel) {
                  const curM = mSel.value;
                  mSel.innerHTML = buildModelSelectOptionsHtml(hSel.value, curM);
                }
              });
            }
            const customHSel = document.getElementById("customHarnessSelect");
            const customMSel = document.getElementById("customModelSelect");
            if (customHSel && customMSel) {
              customMSel.innerHTML = buildModelSelectOptionsHtml(customHSel.value, customModelPick);
            }
          }
        }
      } catch {}
    }

    function toggleRoutingEditor() {
      routingEditorOpen = !routingEditorOpen;
      const card = document.getElementById("routingEditorCard");
      card.style.display = routingEditorOpen ? "block" : "none";
      if (routingEditorOpen && latestState) {
        renderRoutingEditor(latestState);
      }
    }

    function onRoutingHarnessChange(selectEl) {
      const tr = selectEl.closest("tr");
      if (!tr) return;
      const modelSelect = tr.querySelector(".rt-model");
      if (!modelSelect) return;
      const nextHarness = selectEl.value;
      const models = getModelsForHarness(nextHarness, "");
      const defaultModel = models[0] || "";
      modelSelect.innerHTML = buildModelSelectOptionsHtml(nextHarness, defaultModel);
    }

    function renderRoutingRows(sectionPrefix, mapObj) {
      return Object.entries(mapObj || {}).map(([key, entry]) => {
        const h = entry.harness || "claude-code";
        const m = entry.model || "";
        const eff = entry.thinkingEffort || "";
        const fbs = Array.isArray(entry.fallbacks)
          ? entry.fallbacks.map(f => f.harness + ":" + f.model).join(", ")
          : "";
        const hOpts = HARNESS_OPTIONS.map(opt =>
          \`<option value="\${esc(opt)}" \${opt === h ? 'selected' : ''}>\${esc(opt)}</option>\`
        ).join("");
        const mOpts = buildModelSelectOptionsHtml(h, m);
        return \`
          <tr data-rt-section="\${esc(sectionPrefix)}" data-rt-key="\${esc(key)}">
            <td><strong>\${esc(key)}</strong></td>
            <td><select class="rt-harness" onchange="onRoutingHarnessChange(this)">\${hOpts}</select></td>
            <td><select class="rt-model" style="min-width:190px;">\${mOpts}</select></td>
            <td><input type="text" class="rt-effort" value="\${esc(eff)}" placeholder="-" style="width:75px;" /></td>
            <td><input type="text" class="rt-fallbacks" value="\${esc(fbs)}" style="width:100%;min-width:220px;" /></td>
          </tr>
        \`;
      }).join("");
    }

    function renderRoutingEditor(data) {
      if (!data || !data.routingConfig) return;
      const t = I18N[currentLang];
      document.getElementById("routingScopeBadge").textContent =
        data.hasLocalRouting ? t.routingLocalActive : t.routingGlobalFallback;

      const cfg = data.routingConfig;
      document.getElementById("routingEditorBody").innerHTML = \`
        <div class="meta-bar" style="margin-top:6px;font-weight:700;color:var(--accent);">\${esc(t.routingAgentsHeader)}</div>
        <table class="routing-table">
          <thead>
            <tr>
              <th>\${esc(t.colKey)}</th>
              <th>\${esc(t.colPrimaryHarness)}</th>
              <th>\${esc(t.colPrimaryModel)}</th>
              <th>\${esc(t.colEffort)}</th>
              <th>\${esc(t.colFallbacks)}</th>
            </tr>
          </thead>
          <tbody>\${renderRoutingRows("agents", cfg.agents)}</tbody>
        </table>
        <div class="meta-bar" style="margin-top:14px;font-weight:700;color:var(--accent);">\${esc(t.routingCategoriesHeader)}</div>
        <table class="routing-table">
          <thead>
            <tr>
              <th>\${esc(t.colKey)}</th>
              <th>\${esc(t.colPrimaryHarness)}</th>
              <th>\${esc(t.colPrimaryModel)}</th>
              <th>\${esc(t.colEffort)}</th>
              <th>\${esc(t.colFallbacks)}</th>
            </tr>
          </thead>
          <tbody>\${renderRoutingRows("categories", cfg.categories)}</tbody>
        </table>
      \`;
    }

    async function saveRouting() {
      if (!latestState || !latestState.routingConfig) return;
      const t = I18N[currentLang];
      const nextCfg = {
        _asdVersion: latestState.routingConfig._asdVersion || "${ASD_VERSION}",
        agents: {},
        categories: {}
      };
      const rows = document.querySelectorAll("#routingEditorBody tr[data-rt-section]");
      rows.forEach(tr => {
        const sec = tr.getAttribute("data-rt-section");
        const key = tr.getAttribute("data-rt-key");
        const harness = tr.querySelector(".rt-harness").value;
        const model = tr.querySelector(".rt-model").value.trim();
        const effort = tr.querySelector(".rt-effort").value.trim();
        const rawFbs = tr.querySelector(".rt-fallbacks").value;
        const fallbacks = rawFbs
          .split(",")
          .map(s => s.trim())
          .filter(Boolean)
          .map(pair => {
            const idx = pair.indexOf(":");
            if (idx === -1) return null;
            return {
              harness: pair.slice(0, idx).trim(),
              model: pair.slice(idx + 1).trim(),
              modelFamily: ""
            };
          })
          .filter(Boolean);

        const entry = {
          harness,
          model,
          modelFamily: "",
          ...(effort ? { thinkingEffort: effort } : {}),
          fallbacks
        };
        if (sec === "agents") nextCfg.agents[key] = entry;
        else nextCfg.categories[key] = entry;
      });

      const res = await fetch("/api/routing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "save", routingConfig: nextCfg })
      });
      if (res.ok) {
        await poll();
        renderRoutingEditor(latestState);
        window.alert(t.savedAlert);
      }
    }

    async function resetRouting() {
      const t = I18N[currentLang];
      const res = await fetch("/api/routing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reset" })
      });
      if (res.ok) {
        await poll();
        renderRoutingEditor(latestState);
        window.alert(t.resetAlert);
      }
    }

    function onCustomHarnessChange(selEl) {
      customHarnessPick = selEl.value;
      const models = getModelsForHarness(customHarnessPick, "");
      customModelPick = models[0] || "";
      const modelSelect = document.getElementById("customModelSelect");
      if (modelSelect) {
        modelSelect.innerHTML = buildModelSelectOptionsHtml(customHarnessPick, customModelPick);
      }
    }

    async function triggerSubagentAction(action, sessionId, subSessionId) {
      const t = I18N[currentLang];
      const payload = { action, sessionId, subSessionId };
      if (action === "custom") {
        const hEl = document.getElementById("customHarnessSelect");
        const mEl = document.getElementById("customModelSelect");
        payload.harness = hEl ? hEl.value : customHarnessPick;
        payload.model = mEl ? mEl.value.trim() : customModelPick;
        customHarnessPick = payload.harness;
        customModelPick = payload.model;
      }
      try {
        const res = await fetch("/api/subagent-action", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (res.ok && data.ok) {
          if (data.newSubSessionId) {
            selectedSubSessionId = data.newSubSessionId;
          }
          actionStatusMsg = t.actionTriggered + (data.newSubSessionId || data.subSessionId) + " (@" + (data.harness || "") + "/" + (data.model || "") + ")";
          await poll();
        }
      } catch {}
    }

    function selectSession(sessionId) {
      selectedSessionId = sessionId;
      selectedTaskId = null;
      selectedSubSessionId = null;
      actionStatusMsg = "";
      render(latestState);
    }

    function selectTask(taskId) {
      selectedTaskId = taskId;
      selectedSubSessionId = null;
      actionStatusMsg = "";
      render(latestState);
    }

    function selectSubSession(subSessionId) {
      selectedSubSessionId = subSessionId;
      actionStatusMsg = "";
      render(latestState);
    }

    async function editSessionMemo(ev, sessionId, currentMemo) {
      ev.stopPropagation();
      const t = I18N[currentLang];
      const nextMemo = window.prompt(t.editMemoPrompt, currentMemo || "");
      if (nextMemo === null) return;
      try {
        const res = await fetch("/api/session-memo", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, memo: nextMemo.trim() })
        });
        if (res.ok) {
          await poll();
        }
      } catch {}
    }

    function formatCreatedTime(ms) {
      if (!ms) return "-";
      const d = new Date(ms);
      return d.toLocaleString(currentLang === "ko" ? "ko-KR" : "en-US", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
      });
    }

    function render(data) {
      updateLangButtons();
      if (!data) return;
      latestState = data;
      if (data.availableModels) {
        availableModelsByHarness = data.availableModels;
      }
      const t = I18N[currentLang];

      document.getElementById("projPath").textContent = data.projectRoot;
      document.getElementById("lastUpdated").textContent =
        t.updatedPrefix + new Date(data.timestamp).toLocaleTimeString(currentLang === "ko" ? "ko-KR" : "en-US");

      const sessions = data.sessions || (data.session ? [data.session] : []);
      if (!selectedSessionId && sessions.length > 0) {
        selectedSessionId = sessions[0].session_id;
      }
      const activeSess = sessions.find(s => s.session_id === selectedSessionId) || sessions[0] || null;
      if (activeSess) {
        selectedSessionId = activeSess.session_id;
      }

      // 1. Render Left Session List
      if (!sessions.length) {
        document.getElementById("sessionList").innerHTML =
          \`<div class="meta-bar">\${t.noSessions}</div>\`;
      } else {
        document.getElementById("sessionList").innerHTML = sessions.map(s => {
          const isSel = activeSess && s.session_id === activeSess.session_id;
          const displayId = s.session_id.includes("::")
            ? s.session_id.split("::")[1]
            : s.session_id;
          const createdStr = formatCreatedTime(s.created_at);
          const memoStr = (s.memo && s.memo.trim()) ? s.memo.trim() : "";
          return \`
            <div class="session-item \${isSel ? 'active' : ''}" onclick="selectSession('\${esc(s.session_id)}')">
              <div class="session-item-header">
                <span>\${esc(displayId)}</span>
              </div>
              <div class="meta-bar">\${esc(createdStr)}</div>
              <div class="session-memo-row">
                <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">\${memoStr ? esc(memoStr) : '<span class="meta-bar">' + esc(t.memoPlaceholder) + '</span>'}</span>
                <button type="button" class="memo-edit-btn" onclick="editSessionMemo(event, '\${esc(s.session_id)}', '\${esc(memoStr)}')">\${esc(t.editMemoBtn)}</button>
              </div>
            </div>
          \`;
        }).join("");
      }

      const allTasks = data.allTasks || data.tasks || [];
      const allDebates = data.allDebates || data.debates || [];
      const tasks = activeSess ? allTasks.filter(x => x.session_id === activeSess.session_id) : [];
      const debates = activeSess ? allDebates.filter(d => d.session_id === activeSess.session_id) : [];

      // Auto-select first Debate or first Task in the active session so the right-hand
      // Subagent Inspector shows only the relevant item's subagents by default.
      if (!selectedTaskId) {
        if (debates.length > 0) {
          selectedTaskId = debates[0].debate_id;
        } else if (tasks.length > 0) {
          selectedTaskId = tasks[0].task_id;
        }
      }

      const done = tasks.filter(x => x.status === "done").length;
      const pct = tasks.length ? Math.round((done / tasks.length) * 100) : 0;

      const harnessBadges = Object.entries(data.harnesses || {})
        .map(([k, v]) => \`<span class="badge \${v.installed ? 'st-done' : 'st-pending'}">\${esc(k)}: \${v.installed ? t.installedOk : t.installedNo}</span>\`)
        .join("");

      const activeDisplayId = activeSess
        ? (activeSess.session_id.includes("::") ? activeSess.session_id.split("::")[1] : activeSess.session_id)
        : t.noSession;

      document.getElementById("kpiGrid").innerHTML = \`
        <div class="card">
          <div class="card-title">\${t.activeSession}</div>
          <div class="card-value">\${esc(activeDisplayId)}</div>
          <div class="meta-bar">\${activeSess && activeSess.memo ? esc(activeSess.memo) + ' · ' : ''}\${t.phasePrefix}\${activeSess ? esc(activeSess.phase) : "-"}</div>
        </div>
        <div class="card">
          <div class="card-title">\${t.progress}</div>
          <div class="card-value">\${done} / \${tasks.length} (\${pct}%)</div>
          <div class="progress-bar"><div class="progress-fill" style="width:\${pct}%"></div></div>
        </div>
        <div class="card">
          <div class="card-title">\${t.harnesses}</div>
          <div class="harness-list">\${harnessBadges}</div>
        </div>
      \`;

      // 2. Render Debates in Selected Session
      if (!debates.length) {
        document.getElementById("debateList").innerHTML =
          \`<div class="meta-bar">\${t.noDebates}</div>\`;
      } else {
        document.getElementById("debateList").innerHTML = debates.map(d => {
          let iv = null;
          try {
            if (d.insight_verdict_json) iv = JSON.parse(d.insight_verdict_json);
          } catch {}
          const verdictBadge = iv && iv.verdict
            ? \`<span class="badge \${iv.verdict === 'APPROVE' ? 'st-done' : iv.verdict === 'MINOR_AMEND' ? 'st-running' : 'st-failed'}">\${esc(iv.verdict)}</span>\`
            : "";
          const decisionsHtml = iv && Array.isArray(iv.decisions) && iv.decisions.length
            ? \`<div class="meta-bar" style="margin-top:6px;"><strong>Decisions:</strong><ul style="margin:4px 0 0 18px;padding:0;">\${iv.decisions.map(x => \`<li>\${esc(x)}</li>\`).join("")}</ul></div>\`
            : "";
          const constraintsHtml = iv && Array.isArray(iv.hard_constraints) && iv.hard_constraints.length
            ? \`<div class="meta-bar" style="margin-top:6px;"><strong>Hard Constraints:</strong><ul style="margin:4px 0 0 18px;padding:0;">\${iv.hard_constraints.map(x => \`<li>\${esc(x)}</li>\`).join("")}</ul></div>\`
            : "";
          const risksHtml = iv && Array.isArray(iv.risks) && iv.risks.length
            ? \`<div class="meta-bar" style="margin-top:6px;"><strong>Risks:</strong><ul style="margin:4px 0 0 18px;padding:0;">\${iv.risks.map(x => \`<li>\${esc(x)}</li>\`).join("")}</ul></div>\`
            : "";
          const targetLogKey = d.task_id || d.debate_id;
          const isSel = selectedTaskId === targetLogKey || selectedTaskId === d.debate_id;
          return \`
            <div class="debate-row \${isSel ? 'active' : ''}" onclick="selectTask('\${esc(d.debate_id)}')">
              <div>
                <strong>\${esc(d.debate_id)}</strong> — \${esc(d.topic)}
                <span class="badge st-\${d.status === 'done' ? 'done' : 'running'}">\${esc(d.status)}</span>
                \${verdictBadge}
              </div>
              \${decisionsHtml}
              \${constraintsHtml}
              \${risksHtml}
            </div>
          \`;
        }).join("");
      }

      // 3. Render Tasks in Selected Session
      if (!tasks.length) {
        document.getElementById("taskList").innerHTML =
          \`<div class="meta-bar">\${t.noTasks}</div>\`;
      } else {
        document.getElementById("taskList").innerHTML = tasks.map(item => {
          const isSel = selectedTaskId === item.task_id;
          const modelTag = (item.assigned_harness || "-") + "/" + (item.assigned_model || "pending");
          const dur = item.duration_ms ? (item.duration_ms / 1000).toFixed(1) + "s" : "";
          const statusText = t.statusMap[item.status] || item.status;
          return \`
            <div class="task-row \${isSel ? 'active' : ''}" onclick="selectTask('\${esc(item.task_id)}')">
              <div>
                <span class="badge st-\${esc(item.status)}">\${esc(statusText)}</span>
                <strong>\${esc(item.task_id)}</strong>
                <span class="meta-bar">[Turn \${item.turn} | \${esc(item.track)} | \${esc(item.role)}]</span>
                <div>\${esc(item.title)}</div>
              </div>
              <div style="text-align:right" class="meta-bar">
                <div>\${esc(modelTag)}</div>
                <div>\${esc(dur)} \${item.commit_sha ? '(' + esc(item.commit_sha.slice(0,7)) + ')' : ''}</div>
              </div>
            </div>
          \`;
        }).join("");
      }

      // 4. Render Subagents in Selected Session + 4 Runtime Controls
      const allLogs = data.subagentLogs || [];
      const sessionLogs = activeSess
        ? allLogs.filter(l => l.sessionId === activeSess.session_id)
        : allLogs;

      const filteredLogs = (selectedTaskId && selectedTaskId !== "__ALL__")
        ? sessionLogs.filter(l =>
            l.taskId.toUpperCase() === selectedTaskId.toUpperCase() ||
            l.subSessionId.toUpperCase().includes(selectedTaskId.toUpperCase())
          )
        : sessionLogs;

      const effectiveLogs = filteredLogs.length > 0 ? filteredLogs : sessionLogs;

      const activeLog = selectedSubSessionId
        ? effectiveLogs.find(l => l.subSessionId === selectedSubSessionId) || effectiveLogs[0]
        : effectiveLogs[0];

      // Preserve user focus if interacting with custom selects
      const activeEl = document.activeElement;
      if (activeEl && (activeEl.id === "customModelSelect" || activeEl.id === "customHarnessSelect")) {
        return;
      }

      if (!activeLog) {
        document.getElementById("inspector").innerHTML =
          \`<div class="meta-bar">\${t.noLogs}\${selectedTaskId && selectedTaskId !== '__ALL__' ? t.forTask + esc(selectedTaskId) : ''}.</div>\`;
      } else {
        const statusText = t.statusMap[activeLog.status] || activeLog.status;
        const resetFilterBtn = (selectedTaskId && selectedTaskId !== "__ALL__" && sessionLogs.length > effectiveLogs.length)
          ? \`<div style="margin-bottom:6px;"><button type="button" class="memo-edit-btn" onclick="selectTask('__ALL__')">\${esc(t.showAllSessionLogs)} (\${sessionLogs.length})</button></div>\`
          : "";
        const logPills = effectiveLogs.map(l => {
          const isCur = l.subSessionId === activeLog.subSessionId;
          const realSessPrefix = l.sessionId.includes("::") ? l.sessionId.split("::")[0] : l.sessionId;
          const shortSub = l.subSessionId.replace(realSessPrefix + "-", "");
          const label = (l.role || l.taskId || "sub") + " [" + shortSub + "] @" + l.harness;
          return \`<span class="badge \${isCur ? 'st-running' : 'st-pending'}" style="cursor:pointer;" onclick="selectSubSession('\${esc(l.subSessionId)}')">\${esc(label)}</span>\`;
        }).join("");

        const hOpts = HARNESS_OPTIONS.map(opt =>
          \`<option value="\${esc(opt)}" \${opt === customHarnessPick ? 'selected' : ''}>\${esc(opt)}</option>\`
        ).join("");
        const mOpts = buildModelSelectOptionsHtml(customHarnessPick, customModelPick);
        const statusBanner = actionStatusMsg
          ? \`<div class="meta-bar" style="color:var(--ok);margin-top:4px;">\${esc(actionStatusMsg)}</div>\`
          : "";

        document.getElementById("inspector").innerHTML = \`
          \${resetFilterBtn}
          <div class="pill-scroll">\${logPills}</div>
          <div><strong>\${esc(activeLog.taskId || activeLog.role || activeLog.subSessionId)}</strong> — \${esc(activeLog.harness)} (\${esc(activeLog.model)}) | <span class="meta-bar">Role: \${esc(activeLog.role)}</span></div>
          <div class="meta-bar">\${t.subSession}: \${esc(activeLog.subSessionId)} | \${t.statusLabel}: \${esc(statusText)}\${activeLog.pid ? ' | PID: ' + esc(activeLog.pid) : ''}</div>
          <div class="control-box">
            <div class="control-actions">
              <button type="button" class="btn btn-danger" onclick="triggerSubagentAction('kill', '\${esc(activeLog.sessionId)}', '\${esc(activeLog.subSessionId)}')">\${esc(t.btnKill)}</button>
              <button type="button" class="btn" onclick="triggerSubagentAction('retry', '\${esc(activeLog.sessionId)}', '\${esc(activeLog.subSessionId)}')">\${esc(t.btnRetry)}</button>
              <button type="button" class="btn btn-warn" onclick="triggerSubagentAction('fallback', '\${esc(activeLog.sessionId)}', '\${esc(activeLog.subSessionId)}')">\${esc(t.btnFallback)}</button>
            </div>
            <div class="custom-run-row">
              <select id="customHarnessSelect" onchange="onCustomHarnessChange(this)">\${hOpts}</select>
              <select id="customModelSelect" style="min-width:175px;" onchange="customModelPick=this.value">\${mOpts}</select>
              <button type="button" class="btn btn-primary" onclick="triggerSubagentAction('custom', '\${esc(activeLog.sessionId)}', '\${esc(activeLog.subSessionId)}')">\${esc(t.btnCustomRun)}</button>
            </div>
            \${statusBanner}
          </div>
          <div class="card-title" style="margin-top:10px;">\${t.outputLog}</div>
          <pre>\${esc(activeLog.outputLog || t.emptyText)}</pre>
          <div class="card-title" style="margin-top:10px;">\${t.promptLabel}</div>
          <pre>\${esc(activeLog.prompt || t.emptyText)}</pre>
        \`;
      }
    }

    updateLangButtons();
    async function poll() {
      try {
        const res = await fetch("/api/state");
        if (res.ok) render(await res.json());
      } catch {}
    }
    poll();
    setInterval(poll, 2000);
  </script>
</body>
</html>`;
}

export interface DashboardServerHandle {
  server: http.Server;
  url: string;
  port: number;
  close: () => Promise<void>;
}

function readRequestBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += String(chunk);
      if (body.length > 256 * 1024) {
        reject(new Error("Payload too large"));
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

export async function startDashboardServer(options?: {
  port?: number;
  host?: string;
  projectRoot?: string;
  homeDir?: string;
  commandRunner?: CommandRunner;
}): Promise<DashboardServerHandle> {
  const host = options?.host || "127.0.0.1";
  const requestedPort = options?.port ?? 3847;
  const projectRoot = path.resolve(options?.projectRoot || process.cwd());
  const homeDir = options?.homeDir;
  const commandRunner = options?.commandRunner;

  const server = http.createServer(async (req, res) => {
    try {
      const urlObj = new URL(req.url || "/", `http://${host}`);
      if (req.method === "GET" && urlObj.pathname === "/api/state") {
        const snapshot = await collectDashboardSnapshot({ projectRoot, homeDir });
        const body = JSON.stringify(snapshot);
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(body);
        return;
      }

      if (req.method === "GET" && urlObj.pathname === "/api/models") {
        const availableModels = discoverHarnessModels({
          projectRoot,
          homeDir,
          forceRefresh: false,
        });
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(JSON.stringify({ ok: true, availableModels }));
        return;
      }

      if (req.method === "POST" && urlObj.pathname === "/api/models/refresh") {
        const availableModels = discoverHarnessModels({
          projectRoot,
          homeDir,
          forceRefresh: true,
        });
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(JSON.stringify({ ok: true, availableModels }));
        return;
      }

      if (req.method === "POST" && urlObj.pathname === "/api/session-memo") {
        const rawBody = await readRequestBody(req);
        const parsed = JSON.parse(rawBody || "{}") as { sessionId?: string; memo?: string };
        if (!parsed.sessionId) {
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ error: "Missing sessionId" }));
          return;
        }
        const saved = saveSessionMemo({
          projectRoot,
          homeDir,
          sessionId: parsed.sessionId,
          memo: String(parsed.memo ?? ""),
        });
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(JSON.stringify(saved));
        return;
      }

      if (req.method === "POST" && urlObj.pathname === "/api/routing") {
        const rawBody = await readRequestBody(req);
        const parsed = JSON.parse(rawBody || "{}") as {
          action?: "save" | "reset";
          routingConfig?: RoutingConfig;
        };
        const result = saveProjectRoutingConfig({
          projectRoot,
          homeDir,
          action: parsed.action ?? "save",
          routingConfig: parsed.routingConfig,
        });
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(JSON.stringify(result));
        return;
      }

      if (req.method === "POST" && urlObj.pathname === "/api/subagent-action") {
        const rawBody = await readRequestBody(req);
        const parsed = JSON.parse(rawBody || "{}") as {
          sessionId?: string;
          subSessionId?: string;
          action?: "kill" | "retry" | "fallback" | "custom";
          harness?: HarnessId;
          model?: string;
          waitForCompletion?: boolean;
        };
        if (!parsed.subSessionId || !parsed.action) {
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ error: "Missing subSessionId or action" }));
          return;
        }
        const result = await runSubagentControlAction({
          projectRoot,
          homeDir,
          sessionId: parsed.sessionId || "",
          subSessionId: parsed.subSessionId,
          action: parsed.action,
          harness: parsed.harness,
          model: parsed.model,
          commandRunner,
          waitForCompletion: parsed.waitForCompletion,
        });
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(JSON.stringify(result));
        return;
      }

      if (req.method === "GET" && (urlObj.pathname === "/" || urlObj.pathname === "/index.html")) {
        const html = renderDashboardHtml();
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(html);
        return;
      }

      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not Found");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: msg }));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(requestedPort, host, () => resolve());
  });

  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : requestedPort;
  const url = `http://${host}:${actualPort}`;

  return {
    server,
    url,
    port: actualPort,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
