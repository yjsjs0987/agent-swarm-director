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
  worktreeStatuses?: Record<string, string[]>;
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
 * Dynamically discovers ALL real available models for Antigravity, Claude Code, Codex, and OpenCode
 * by querying each harness's live CLI (`agy models`, `opencode models`), local model caches
 * (`~/.codex/models_cache.json`, `~/.claude/settings.json`, `~/.claude/litellm_config.yaml`),
 * and any configured remote OpenAI-compatible gateway (`integrate.api.nvidia.com/v1/models`, etc.).
 * Does NOT inject hardcoded fake/default models.
 */
export async function discoverHarnessModels(options?: {
  projectRoot?: string;
  homeDir?: string;
  forceRefresh?: boolean;
  skipCliSpawn?: boolean;
}): Promise<HarnessModelCatalog> {
  const projectRoot = path.resolve(options?.projectRoot || process.cwd());
  const homeDir = options?.homeDir || os.homedir();
  const cacheKey = `${projectRoot}::${homeDir}`;

  if (!options?.forceRefresh && modelCatalogCache.has(cacheKey)) {
    return modelCatalogCache.get(cacheKey)!;
  }

  const sets: Record<HarnessId, Set<string>> = {
    antigravity: new Set<string>(),
    "claude-code": new Set<string>(),
    codex: new Set<string>(),
    opencode: new Set<string>(),
    cursor: new Set<string>(["auto", "composer-2", "claude-sonnet-4.6", "claude-opus-4.6", "gpt-5.4"]),
  };

  // 1. Antigravity: query `agy models` CLI and `~/.gemini/antigravity-cli/settings.json`
  try {
    const agySettingsPath = path.join(homeDir, ".gemini", "antigravity-cli", "settings.json");
    if (fs.existsSync(agySettingsPath)) {
      const agySettings = JSON.parse(fs.readFileSync(agySettingsPath, "utf8")) as {
        model?: string;
      };
      if (typeof agySettings.model === "string" && agySettings.model.trim()) {
        sets.antigravity.add(agySettings.model.trim());
      }
    }
    if (!options?.skipCliSpawn) {
      const resolved = resolveSpawnCommand("agy", ["models"]);
      const res = child_process.spawnSync(resolved.command, resolved.args, {
        encoding: "utf8",
        timeout: 4000,
        windowsHide: true,
        shell: resolved.shell,
      });
      if (res.stdout) {
        const lines = res.stdout.split(/\r?\n/);
        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line || line.startsWith("Fetching")) continue;
          // `agy models` outputs `<model-id>\t<Display Name>`
          const firstCol = line.split("\t")[0]?.trim();
          if (firstCol && !firstCol.includes(" ")) {
            sets.antigravity.add(firstCol);
          }
        }
      }
    }
  } catch {
    // Ignore antigravity scan errors
  }

  // 2. Codex: scan `~/.codex/models_cache.json` and `~/.codex/config.toml`
  try {
    const codexCachePath = path.join(homeDir, ".codex", "models_cache.json");
    if (fs.existsSync(codexCachePath)) {
      const cacheObj = JSON.parse(fs.readFileSync(codexCachePath, "utf8")) as {
        models?: Array<{ slug?: string }>;
      };
      if (Array.isArray(cacheObj.models)) {
        for (const item of cacheObj.models) {
          if (item?.slug && typeof item.slug === "string" && item.slug.trim()) {
            sets.codex.add(item.slug.trim());
          }
        }
      }
    }
    const codexTomlPath = path.join(homeDir, ".codex", "config.toml");
    if (fs.existsSync(codexTomlPath)) {
      const tomlText = fs.readFileSync(codexTomlPath, "utf8");
      const matches = tomlText.matchAll(/^\s*model\s*=\s*["']([^"']+)["']/gm);
      for (const m of matches) {
        if (m[1]?.trim()) sets.codex.add(m[1].trim());
      }
    }
  } catch {
    // Ignore codex scan errors
  }

  // 3. Claude Code: scan `~/.claude/settings.json`, `~/.claude/litellm_config.yaml`, and remote NIM/gateway `/v1/models`
  try {
    const addClaudeModel = (raw: string | undefined) => {
      if (!raw || typeof raw !== "string") return;
      const trimmed = raw.trim();
      if (!trimmed) return;
      sets["claude-code"].add(trimmed);
      const stripped = trimmed.replace(/\[.*\]$/, "").trim();
      if (stripped) sets["claude-code"].add(stripped);
    };

    addClaudeModel(process.env.ANTHROPIC_MODEL);
    addClaudeModel(process.env.ANTHROPIC_CUSTOM_MODEL_OPTION);
    addClaudeModel(process.env.ANTHROPIC_DEFAULT_SONNET_MODEL);
    addClaudeModel(process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL);
    addClaudeModel(process.env.ANTHROPIC_DEFAULT_OPUS_MODEL);

    let gatewayToken = process.env.ANTHROPIC_AUTH_TOKEN || process.env.NVIDIA_NIM_API_KEY || "";
    let gatewayBase = "https://integrate.api.nvidia.com/v1";

    const claudeSettingsPath = path.join(homeDir, ".claude", "settings.json");
    if (fs.existsSync(claudeSettingsPath)) {
      const settingsObj = JSON.parse(fs.readFileSync(claudeSettingsPath, "utf8")) as {
        model?: string;
        env?: Record<string, string>;
      };
      addClaudeModel(settingsObj.model);
      const env = settingsObj.env ?? {};
      addClaudeModel(env.ANTHROPIC_MODEL);
      addClaudeModel(env.ANTHROPIC_CUSTOM_MODEL_OPTION);
      addClaudeModel(env.ANTHROPIC_DEFAULT_SONNET_MODEL);
      addClaudeModel(env.ANTHROPIC_DEFAULT_HAIKU_MODEL);
      addClaudeModel(env.ANTHROPIC_DEFAULT_OPUS_MODEL);
      if (env.ANTHROPIC_AUTH_TOKEN?.trim()) {
        gatewayToken = env.ANTHROPIC_AUTH_TOKEN.trim();
      }
    }

    const litellmYamlPath = path.join(homeDir, ".claude", "litellm_config.yaml");
    if (fs.existsSync(litellmYamlPath)) {
      const yamlText = fs.readFileSync(litellmYamlPath, "utf8");
      const defMatch = yamlText.match(/default_model:\s*["']?([^"'\r\n#]+)["']?/);
      if (defMatch?.[1]) addClaudeModel(defMatch[1]);
      const baseMatch = yamlText.match(/api_base:\s*["']?([^"'\r\n#]+)["']?/);
      if (baseMatch?.[1]?.trim()) {
        gatewayBase = baseMatch[1].trim().replace(/\/+$/, "");
      }
      for (const m of yamlText.matchAll(/-\s*model_name:\s*["']?([^"'\r\n#]+)["']?/g)) {
        if (m[1]) addClaudeModel(m[1]);
      }
      for (const m of yamlText.matchAll(/model:\s*["']?([^"'\r\n#]+)["']?/g)) {
        if (m[1]) addClaudeModel(m[1].trim().replace(/^nvidia_nim\//, ""));
      }
    }

    // If an API token is configured (e.g. nvapi-... for NVIDIA NIM), fetch `/v1/models`
    if (
      !options?.skipCliSpawn &&
      gatewayToken &&
      !gatewayToken.includes("dummy") &&
      !gatewayToken.includes("여기에_")
    ) {
      try {
        const res = await fetch(`${gatewayBase}/models`, {
          headers: { Authorization: `Bearer ${gatewayToken}` },
          signal: AbortSignal.timeout(3000),
        });
        if (res.ok) {
          const data = (await res.json()) as { data?: Array<{ id?: string }> };
          if (Array.isArray(data.data)) {
            for (const item of data.data) {
              if (item?.id && typeof item.id === "string" && item.id.trim()) {
                sets["claude-code"].add(item.id.trim());
              }
            }
          }
        }
      } catch {
        // Ignore remote gateway timeout/network error
      }
    }
  } catch {
    // Ignore claude scan errors
  }

  // 4. OpenCode: scan `~/.config/opencode/opencode.json` and `opencode models` CLI
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
        timeout: 4000,
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

  // 5. Cursor: scan ~/.cursor/cli-config.json
  try {
    const cursorCfgPath = path.join(homeDir, ".cursor", "cli-config.json");
    if (fs.existsSync(cursorCfgPath)) {
      const cObj = JSON.parse(fs.readFileSync(cursorCfgPath, "utf8")) as { model?: { modelId?: string } | string };
      if (typeof cObj.model === "string" && cObj.model.trim()) {
        sets.cursor.add(cObj.model.trim());
      } else if (cObj.model && typeof cObj.model === "object" && typeof cObj.model.modelId === "string" && cObj.model.modelId.trim()) {
        sets.cursor.add(cObj.model.modelId.trim());
      }
    }
  } catch {
    // Ignore cursor scan errors
  }

  const catalog: HarnessModelCatalog = {
    antigravity: [...sets.antigravity],
    "claude-code": [...sets["claude-code"]],
    codex: [...sets.codex],
    opencode: [...sets.opencode],
    cursor: [...sets.cursor],
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
  const availableModels = await discoverHarnessModels({
    projectRoot,
    homeDir,
    skipCliSpawn: false,
  });

  const worktreeStatuses: Record<string, string[]> = {};
  for (const t of allTasks) {
    if (t.worktree_path && fs.existsSync(t.worktree_path)) {
      try {
        const res = child_process.spawnSync("git", ["status", "--short"], {
          cwd: t.worktree_path,
          encoding: "utf8",
          timeout: 1500,
          windowsHide: true,
        });
        if (res.status === 0 && res.stdout) {
          worktreeStatuses[`${t.session_id}::${t.task_id}`] = res.stdout
            .split(/\r?\n/)
            .map((l) => l.trimEnd())
            .filter((l) => l.length > 0 && !l.includes("node_modules"));
        }
      } catch {
        // ignore worktree status errors
      }
    }
  }

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
    worktreeStatuses,
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

    /* Searchable Model Picker Popover */
    .model-picker-wrap {
      position: relative;
      display: inline-block;
      min-width: 195px;
    }
    .model-picker-btn {
      width: 100%;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
      background: #090d14;
      border: 1px solid var(--border);
      color: var(--text);
      border-radius: 4px;
      padding: 5px 8px;
      font-size: 12px;
      font-family: monospace;
      cursor: pointer;
      text-align: left;
    }
    .model-picker-btn:hover {
      border-color: var(--accent);
    }
    .model-picker-btn .mp-label {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .model-picker-btn .mp-caret {
      color: var(--muted);
      font-size: 10px;
      flex-shrink: 0;
    }
    .model-picker-popover {
      position: absolute;
      top: calc(100% + 4px);
      left: 0;
      min-width: 270px;
      max-width: 380px;
      background: #0f1726;
      border: 1px solid var(--accent);
      border-radius: 6px;
      box-shadow: 0 12px 28px rgba(0,0,0,0.65);
      z-index: 950;
      display: none;
      flex-direction: column;
      padding: 6px;
    }
    .model-picker-wrap.open .model-picker-popover {
      display: flex;
    }
    .mp-search {
      width: 100%;
      background: #070b12;
      border: 1px solid var(--border);
      color: var(--text);
      border-radius: 4px;
      padding: 5px 8px;
      font-size: 12px;
      margin-bottom: 6px;
      outline: none;
    }
    .mp-search:focus {
      border-color: var(--accent);
    }
    .mp-list {
      max-height: 210px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .mp-option {
      padding: 5px 8px;
      border-radius: 4px;
      font-size: 12px;
      font-family: monospace;
      color: var(--text);
      cursor: pointer;
      word-break: break-all;
    }
    .mp-option:hover, .mp-option.selected {
      background: rgba(88,166,255,0.22);
      color: var(--accent);
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
    const HARNESS_OPTIONS = ["claude-code", "opencode", "codex", "antigravity", "cursor"];
    let availableModelsByHarness = {
      "antigravity": [],
      "claude-code": [],
      "codex": [],
      "opencode": [],
      "cursor": []
    };

    const I18N = {
      ko: {
        headerTitle: "ASD 멀티 에이전트 컨트롤 플레인 (v${ASD_VERSION})",
        btnToggleRouting: "라우팅 편집",
        btnOpenModelsModal: "모델 확인",
        modelsModalTitle: "하네스별 사용 가능한 모델 목록",
        btnRefreshModelsOnly: "🔄 모델 목록 새로고침",
        btnCloseModelsModal: "닫기",
        modelSearchPlaceholder: "🔍 모델 검색...",
        modelEmptyText: "(조회된 모델 없음)",
        harnessLabels: {
          "antigravity": "안티그래비티 (Antigravity)",
          "claude-code": "클로드 코드 (Claude Code)",
          "codex": "코덱스 (Codex)",
          "opencode": "오픈코드 (OpenCode)",
          "cursor": "커서 (Cursor)"
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
        colPrimaryModel: "1순위 모델 (클릭·검색)",
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
        modelSearchPlaceholder: "🔍 Search models...",
        modelEmptyText: "(No models found)",
        harnessLabels: {
          "antigravity": "Antigravity",
          "claude-code": "Claude Code",
          "codex": "Codex",
          "opencode": "OpenCode",
          "cursor": "Cursor"
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
        colPrimaryModel: "Primary Model (Search)",
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
    let editingMemoSessionId = null;
    let editingMemoDraft = "";
    let routingEditorOpen = false;
    let modelsModalOpen = false;
    let customHarnessPick = "opencode";
    let customModelPick = "";
    let actionStatusMsg = "";
    let latestState = null;
    let prevHtmlCache = {};

    function setHtmlIfChanged(elId, nextHtml) {
      const el = document.getElementById(elId);
      if (!el) return;
      if (prevHtmlCache[elId] === nextHtml) return;
      prevHtmlCache[elId] = nextHtml;
      el.innerHTML = nextHtml;
    }

    function getModelsForHarness(harness) {
      return Array.isArray(availableModelsByHarness[harness])
        ? [...availableModelsByHarness[harness]]
        : [];
    }

    function renderPickerOptionsListHtml(harness, selectedModel, query) {
      const t = I18N[currentLang];
      const all = getModelsForHarness(harness);
      const q = (query || "").trim().toLowerCase();
      const filtered = q ? all.filter(m => m.toLowerCase().includes(q)) : all;
      if (!filtered.length) {
        return \`<div class="meta-bar" style="padding:6px;">\${esc(t.modelEmptyText)}</div>\`;
      }
      return filtered.map(m =>
        \`<div class="mp-option \${m === selectedModel ? 'selected' : ''}" data-model="\${esc(m)}" onclick="selectModelPickerOption(event, this)">\${esc(m)}</div>\`
      ).join("");
    }

    function buildSearchableModelPickerHtml(pickerId, harness, selectedModel, extraInputClass) {
      const t = I18N[currentLang];
      const models = getModelsForHarness(harness);
      const effectiveModel = selectedModel || models[0] || "";
      const optionsHtml = renderPickerOptionsListHtml(harness, effectiveModel, "");
      return \`
        <div class="model-picker-wrap" id="wrap_\${esc(pickerId)}" data-harness="\${esc(harness)}">
          <input type="hidden" class="mp-value \${esc(extraInputClass || '')}" id="\${esc(pickerId)}" value="\${esc(effectiveModel)}" />
          <button type="button" class="model-picker-btn" onclick="toggleModelPicker(event, 'wrap_\${esc(pickerId)}')">
            <span class="mp-label">\${esc(effectiveModel || t.modelEmptyText)}</span>
            <span class="mp-caret">▾</span>
          </button>
          <div class="model-picker-popover" onclick="event.stopPropagation()">
            <input type="text" class="mp-search" placeholder="\${esc(t.modelSearchPlaceholder)}" oninput="filterModelPicker(this)" />
            <div class="mp-list">\${optionsHtml}</div>
          </div>
        </div>
      \`;
    }

    function toggleModelPicker(ev, wrapId) {
      ev.stopPropagation();
      const wrap = document.getElementById(wrapId);
      if (!wrap) return;
      const wasOpen = wrap.classList.contains("open");
      document.querySelectorAll(".model-picker-wrap.open").forEach(el => el.classList.remove("open"));
      if (!wasOpen) {
        const harness = wrap.getAttribute("data-harness") || "opencode";
        const valInput = wrap.querySelector(".mp-value");
        const curVal = valInput ? valInput.value : "";
        const searchInput = wrap.querySelector(".mp-search");
        if (searchInput) searchInput.value = "";
        const listEl = wrap.querySelector(".mp-list");
        if (listEl) {
          listEl.innerHTML = renderPickerOptionsListHtml(harness, curVal, "");
        }
        wrap.classList.add("open");
        if (searchInput) {
          setTimeout(() => searchInput.focus(), 10);
        }
      }
    }

    function filterModelPicker(searchInputEl) {
      const wrap = searchInputEl.closest(".model-picker-wrap");
      if (!wrap) return;
      const harness = wrap.getAttribute("data-harness") || "opencode";
      const valInput = wrap.querySelector(".mp-value");
      const curVal = valInput ? valInput.value : "";
      const listEl = wrap.querySelector(".mp-list");
      if (listEl) {
        listEl.innerHTML = renderPickerOptionsListHtml(harness, curVal, searchInputEl.value);
      }
    }

    function selectModelPickerOption(ev, optionEl) {
      ev.stopPropagation();
      const wrap = optionEl.closest(".model-picker-wrap");
      if (!wrap) return;
      const chosen = optionEl.getAttribute("data-model") || "";
      const valInput = wrap.querySelector(".mp-value");
      if (valInput) {
        valInput.value = chosen;
        if (valInput.id === "customModelSelect") {
          customModelPick = chosen;
        }
      }
      const labelEl = wrap.querySelector(".mp-label");
      if (labelEl) labelEl.textContent = chosen;
      wrap.classList.remove("open");
    }

    document.addEventListener("click", () => {
      document.querySelectorAll(".model-picker-wrap.open").forEach(el => el.classList.remove("open"));
    });

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
      const gridOrder = ["antigravity", "claude-code", "codex", "opencode", "cursor"];
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
              // Refresh only the model picker options inside routing editor while preserving current selections
              document.querySelectorAll("#routingEditorBody tr[data-rt-section]").forEach(tr => {
                const hSel = tr.querySelector(".rt-harness");
                const wrap = tr.querySelector(".model-picker-wrap");
                if (hSel && wrap) {
                  const harness = hSel.value;
                  wrap.setAttribute("data-harness", harness);
                  const valInput = wrap.querySelector(".mp-value");
                  const curM = valInput ? valInput.value : "";
                  const models = getModelsForHarness(harness);
                  const nextM = curM || models[0] || "";
                  if (valInput) valInput.value = nextM;
                  const labelEl = wrap.querySelector(".mp-label");
                  if (labelEl) labelEl.textContent = nextM || I18N[currentLang].modelEmptyText;
                  const listEl = wrap.querySelector(".mp-list");
                  if (listEl) listEl.innerHTML = renderPickerOptionsListHtml(harness, nextM, "");
                }
              });
            }
            const customHSel = document.getElementById("customHarnessSelect");
            const customWrap = document.getElementById("wrap_customModelSelect");
            if (customHSel && customWrap) {
              const harness = customHSel.value;
              customWrap.setAttribute("data-harness", harness);
              const models = getModelsForHarness(harness);
              if (!customModelPick || !models.includes(customModelPick)) {
                customModelPick = models[0] || "";
              }
              const valInput = customWrap.querySelector(".mp-value");
              if (valInput) valInput.value = customModelPick;
              const labelEl = customWrap.querySelector(".mp-label");
              if (labelEl) labelEl.textContent = customModelPick || I18N[currentLang].modelEmptyText;
              const listEl = customWrap.querySelector(".mp-list");
              if (listEl) listEl.innerHTML = renderPickerOptionsListHtml(harness, customModelPick, "");
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
      const wrap = tr.querySelector(".model-picker-wrap");
      if (!wrap) return;
      const nextHarness = selectEl.value;
      wrap.setAttribute("data-harness", nextHarness);
      const models = getModelsForHarness(nextHarness);
      const defaultModel = models[0] || "";
      const valInput = wrap.querySelector(".mp-value");
      if (valInput) valInput.value = defaultModel;
      const labelEl = wrap.querySelector(".mp-label");
      if (labelEl) labelEl.textContent = defaultModel || I18N[currentLang].modelEmptyText;
      const listEl = wrap.querySelector(".mp-list");
      if (listEl) {
        listEl.innerHTML = renderPickerOptionsListHtml(nextHarness, defaultModel, "");
      }
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
        const pickerId = "rt_mp_" + sectionPrefix + "_" + key;
        const mPicker = buildSearchableModelPickerHtml(pickerId, h, m, "rt-model");
        return \`
          <tr data-rt-section="\${esc(sectionPrefix)}" data-rt-key="\${esc(key)}">
            <td><strong>\${esc(key)}</strong></td>
            <td><select class="rt-harness" onchange="onRoutingHarnessChange(this)">\${hOpts}</select></td>
            <td>\${mPicker}</td>
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
      const models = getModelsForHarness(customHarnessPick);
      customModelPick = models[0] || "";
      const wrap = document.getElementById("wrap_customModelSelect");
      if (wrap) {
        wrap.setAttribute("data-harness", customHarnessPick);
        const valInput = wrap.querySelector(".mp-value");
        if (valInput) valInput.value = customModelPick;
        const labelEl = wrap.querySelector(".mp-label");
        if (labelEl) labelEl.textContent = customModelPick || I18N[currentLang].modelEmptyText;
        const listEl = wrap.querySelector(".mp-list");
        if (listEl) {
          listEl.innerHTML = renderPickerOptionsListHtml(customHarnessPick, customModelPick, "");
        }
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

    function editSessionMemo(ev, sessionId, currentMemo) {
      ev.stopPropagation();
      editingMemoSessionId = sessionId;
      editingMemoDraft = currentMemo || "";
      render(latestState);
      setTimeout(() => {
        const inp = document.getElementById("inlineMemoInput");
        if (inp) {
          inp.focus();
          inp.select();
        }
      }, 15);
    }

    function cancelInlineMemo(ev) {
      if (ev) ev.stopPropagation();
      editingMemoSessionId = null;
      editingMemoDraft = "";
      render(latestState);
    }

    async function saveInlineMemo(ev, sessionId) {
      if (ev) ev.stopPropagation();
      const inp = document.getElementById("inlineMemoInput");
      const nextMemo = inp ? inp.value.trim() : editingMemoDraft.trim();
      editingMemoSessionId = null;
      editingMemoDraft = "";
      try {
        const res = await fetch("/api/session-memo", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, memo: nextMemo })
        });
        if (res.ok) {
          await poll();
        }
      } catch {}
    }

    function onInlineMemoKeyDown(ev, sessionId) {
      if (ev.key === "Enter") {
        ev.preventDefault();
        saveInlineMemo(ev, sessionId);
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        cancelInlineMemo(ev);
      }
    }

    function renderSelectedItemMetaCard(activeSess, tasks, debates, worktreeStatuses, t) {
      if (!selectedTaskId || selectedTaskId === "__ALL__") return "";
      const task = tasks.find(x => x.task_id === selectedTaskId);
      if (task) {
        let targetFiles = [];
        try { targetFiles = JSON.parse(task.target_files_json || "[]"); } catch {}
        let doneClaim = null;
        try { if (task.done_claim_json) doneClaim = JSON.parse(task.done_claim_json); } catch {}
        const wtKey = (activeSess ? activeSess.session_id : task.session_id) + "::" + task.task_id;
        const wtFiles = (worktreeStatuses && worktreeStatuses[wtKey]) || [];
        const statusText = t.statusMap[task.status] || task.status;
        const targetBadges = targetFiles.length
          ? targetFiles.map(f => \`<span class="badge st-pending" style="font-family:monospace;">\${esc(f)}</span>\`).join(" ")
          : "-";
        const wtSection = wtFiles.length
          ? \`<div class="meta-bar" style="margin-top:6px;"><strong>Worktree Git Status:</strong><pre style="max-height:90px;margin-top:4px;">\${esc(wtFiles.join("\\n"))}</pre></div>\`
          : "";
        const claimSummary = doneClaim && doneClaim.summary
          ? \`<div class="meta-bar" style="margin-top:4px;"><strong>Done Summary:</strong> \${esc(doneClaim.summary)}</div>\`
          : "";
        return \`
          <div class="control-box" style="margin-bottom:10px;">
            <div style="display:flex;justify-content:space-between;align-items:center;gap:6px;flex-wrap:wrap;">
              <div><strong>\${esc(task.task_id)}</strong> — \${esc(task.title)}</div>
              <span class="badge st-\${esc(task.status)}">\${esc(statusText)}</span>
            </div>
            <div class="meta-bar" style="margin-top:4px;">
              Turn \${task.turn} | Track: <strong>\${esc(task.track)}</strong> | Role: <strong>\${esc(task.role)}</strong> | Harness: <strong>\${esc((task.assigned_harness || "-") + "/" + (task.assigned_model || "pending"))}</strong>
              \${task.commit_sha ? ' | Commit: <code>' + esc(task.commit_sha.slice(0, 8)) + '</code>' : ''}
            </div>
            <div class="meta-bar" style="margin-top:4px;"><strong>Target Files:</strong> \${targetBadges}</div>
            \${task.context_hint ? '<div class="meta-bar" style="margin-top:4px;"><strong>Context Hint:</strong> ' + esc(task.context_hint) + '</div>' : ''}
            \${task.verify_cmd ? '<div class="meta-bar" style="margin-top:4px;"><strong>Verify Cmd:</strong> <code>' + esc(task.verify_cmd) + '</code></div>' : ''}
            \${task.worktree_path ? '<div class="meta-bar" style="margin-top:4px;"><strong>Worktree:</strong> <code>' + esc(task.worktree_path) + '</code></div>' : ''}
            \${claimSummary}
            \${wtSection}
          </div>
        \`;
      }
      const debate = debates.find(d => d.debate_id === selectedTaskId || d.task_id === selectedTaskId);
      if (debate) {
        return \`
          <div class="control-box" style="margin-bottom:10px;">
            <div><strong>\${esc(debate.debate_id)}</strong> — \${esc(debate.topic)} <span class="badge st-\${debate.status === 'done' ? 'done' : 'running'}">\${esc(debate.status)}</span></div>
          </div>
        \`;
      }
      return "";
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
      const activeEl = document.activeElement;
      if (!(activeEl && activeEl.id === "inlineMemoInput")) {
        const sessHtml = !sessions.length
          ? \`<div class="meta-bar">\${t.noSessions}</div>\`
          : sessions.map(s => {
              const isSel = activeSess && s.session_id === activeSess.session_id;
              const displayId = s.session_id.includes("::")
                ? s.session_id.split("::")[1]
                : s.session_id;
              const createdStr = formatCreatedTime(s.created_at);
              const memoStr = (s.memo && s.memo.trim()) ? s.memo.trim() : "";
              const isEditing = editingMemoSessionId === s.session_id;
              const memoRowContent = isEditing
                ? \`
                  <div style="display:flex;gap:4px;width:100%;margin-top:2px;" onclick="event.stopPropagation()">
                    <input id="inlineMemoInput" type="text" value="\${esc(editingMemoDraft)}" style="flex:1;min-width:0;background:var(--bg);color:var(--text);border:1px solid var(--accent);border-radius:4px;padding:2px 6px;font-size:11px;" onkeydown="onInlineMemoKeyDown(event, '\${esc(s.session_id)}')" oninput="editingMemoDraft = this.value" />
                    <button type="button" class="memo-edit-btn" style="color:var(--ok);border-color:var(--ok);" onclick="saveInlineMemo(event, '\${esc(s.session_id)}')">✓</button>
                    <button type="button" class="memo-edit-btn" onclick="cancelInlineMemo(event)">✕</button>
                  </div>
                \`
                : \`
                  <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">\${memoStr ? esc(memoStr) : '<span class="meta-bar">' + esc(t.memoPlaceholder) + '</span>'}</span>
                  <button type="button" class="memo-edit-btn" onclick="editSessionMemo(event, '\${esc(s.session_id)}', '\${esc(memoStr)}')">\${esc(t.editMemoBtn)}</button>
                \`;
              return \`
                <div class="session-item \${isSel ? 'active' : ''}" onclick="selectSession('\${esc(s.session_id)}')">
                  <div class="session-item-header">
                    <span>\${esc(displayId)}</span>
                  </div>
                  <div class="meta-bar">\${esc(createdStr)}</div>
                  <div class="session-memo-row">
                    \${memoRowContent}
                  </div>
                </div>
              \`;
            }).join("");
        setHtmlIfChanged("sessionList", sessHtml);
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

      setHtmlIfChanged("kpiGrid", \`
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
      \`);

      // 2. Render Debates in Selected Session
      const debatesHtml = !debates.length
        ? \`<div class="meta-bar">\${t.noDebates}</div>\`
        : debates.map(d => {
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
      setHtmlIfChanged("debateList", debatesHtml);

      // 3. Render Tasks in Selected Session
      const tasksHtml = !tasks.length
        ? \`<div class="meta-bar">\${t.noTasks}</div>\`
        : tasks.map(item => {
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
      setHtmlIfChanged("taskList", tasksHtml);

      // 4. Render Subagents in Selected Session + 4 Runtime Controls + Task Metadata Card
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

      const effectiveLogs = (selectedTaskId && selectedTaskId !== "__ALL__") ? filteredLogs : sessionLogs;

      const activeLog = selectedSubSessionId
        ? effectiveLogs.find(l => l.subSessionId === selectedSubSessionId) || effectiveLogs[0]
        : effectiveLogs[0];

      // Preserve user focus if interacting with custom selects or open model picker
      if (
        (activeEl && (activeEl.id === "customModelSelect" || activeEl.id === "customHarnessSelect" || activeEl.classList.contains("mp-search"))) ||
        document.querySelector("#inspector .model-picker-wrap.open")
      ) {
        return;
      }

      const itemMetaCardHtml = renderSelectedItemMetaCard(activeSess, tasks, debates, data.worktreeStatuses, t);
      const resetFilterBtn = (selectedTaskId && selectedTaskId !== "__ALL__" && sessionLogs.length > effectiveLogs.length)
        ? \`<div style="margin-bottom:6px;"><button type="button" class="memo-edit-btn" onclick="selectTask('__ALL__')">\${esc(t.showAllSessionLogs)} (\${sessionLogs.length})</button></div>\`
        : "";

      if (!activeLog) {
        const emptyInspectorHtml = \`
          \${resetFilterBtn}
          \${itemMetaCardHtml}
          <div class="meta-bar">\${t.noLogs}\${selectedTaskId && selectedTaskId !== '__ALL__' ? t.forTask + esc(selectedTaskId) : ''}.</div>
        \`;
        setHtmlIfChanged("inspector", emptyInspectorHtml);
      } else {
        const statusText = t.statusMap[activeLog.status] || activeLog.status;
        const logPills = effectiveLogs.map(l => {
          const isCur = l.subSessionId === activeLog.subSessionId;
          const realSessPrefix = l.sessionId.includes("::") ? l.sessionId.split("::")[0] : l.sessionId;
          const shortSub = l.subSessionId.replace(realSessPrefix + "-", "");
          const label = (l.role || l.taskId || "sub") + " [" + shortSub + "] @" + l.harness;
          return \`<span class="badge \${isCur ? 'st-running' : 'st-pending'}" style="cursor:pointer;" onclick="selectSubSession('\${esc(l.subSessionId)}')">\${esc(label)}</span>\`;
        }).join("");

        const curHarnessModels = getModelsForHarness(customHarnessPick);
        if (!customModelPick || !curHarnessModels.includes(customModelPick)) {
          customModelPick = curHarnessModels[0] || "";
        }

        const hOpts = HARNESS_OPTIONS.map(opt =>
          \`<option value="\${esc(opt)}" \${opt === customHarnessPick ? 'selected' : ''}>\${esc(opt)}</option>\`
        ).join("");
        const mPicker = buildSearchableModelPickerHtml("customModelSelect", customHarnessPick, customModelPick, "");
        const statusBanner = actionStatusMsg
          ? \`<div class="meta-bar" style="color:var(--ok);margin-top:4px;">\${esc(actionStatusMsg)}</div>\`
          : "";

        const headerKey = [
          selectedTaskId || "",
          activeLog.subSessionId,
          activeLog.status,
          activeLog.pid || "",
          customHarnessPick,
          customModelPick,
          actionStatusMsg,
          logPills,
          itemMetaCardHtml
        ].join("||");

        const outPre = document.getElementById("outputLogPre");
        const prmPre = document.getElementById("promptPre");
        const nextOutText = activeLog.outputLog || t.emptyText;
        const nextPrmText = activeLog.prompt || t.emptyText;

        if (outPre && prmPre && prevHtmlCache["inspectorHeaderKey"] === headerKey) {
          // Incremental text update: preserve scrollTop and user text selection!
          if (outPre.textContent !== nextOutText) {
            const wasAtBottom = (outPre.scrollHeight - outPre.scrollTop - outPre.clientHeight) < 24;
            const prevScroll = outPre.scrollTop;
            outPre.textContent = nextOutText;
            outPre.scrollTop = wasAtBottom ? outPre.scrollHeight : prevScroll;
          }
          if (prmPre.textContent !== nextPrmText) {
            const prevPrmScroll = prmPre.scrollTop;
            prmPre.textContent = nextPrmText;
            prmPre.scrollTop = prevPrmScroll;
          }
        } else {
          const prevOutScroll = outPre ? outPre.scrollTop : 0;
          const prevPrmScroll = prmPre ? prmPre.scrollTop : 0;
          prevHtmlCache["inspectorHeaderKey"] = headerKey;
          prevHtmlCache["inspector"] = "";
          document.getElementById("inspector").innerHTML = \`
            \${resetFilterBtn}
            \${itemMetaCardHtml}
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
                \${mPicker}
                <button type="button" class="btn btn-primary" onclick="triggerSubagentAction('custom', '\${esc(activeLog.sessionId)}', '\${esc(activeLog.subSessionId)}')">\${esc(t.btnCustomRun)}</button>
              </div>
              \${statusBanner}
            </div>
            <div class="card-title" style="margin-top:10px;">\${t.outputLog}</div>
            <pre id="outputLogPre">\${esc(nextOutText)}</pre>
            <div class="card-title" style="margin-top:10px;">\${t.promptLabel}</div>
            <pre id="promptPre">\${esc(nextPrmText)}</pre>
          \`;
          const newOutPre = document.getElementById("outputLogPre");
          const newPrmPre = document.getElementById("promptPre");
          if (newOutPre && prevOutScroll > 0) newOutPre.scrollTop = prevOutScroll;
          if (newPrmPre && prevPrmScroll > 0) newPrmPre.scrollTop = prevPrmScroll;
        }
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
        const availableModels = await discoverHarnessModels({
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
        const availableModels = await discoverHarnessModels({
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
