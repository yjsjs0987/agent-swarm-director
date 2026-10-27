/**
 * ASD v2.2 Model Router & Diversity Engine (src/core/router.ts).
 *
 * Implements:
 * 1. 4-tier route resolution (Explicit Pin -> Specialist Role -> Domain Category -> Difficulty Tier).
 * 2. @ag Headless Spawn Asymmetry Fallback for subagents.
 * 3. 3-attempt task escalation (Attempt 1 -> Attempt 2 rollback retry -> Attempt 3 escalated to architect -> fail).
 * 4. Cross-model diverse reviewer selection with `[DIVERSITY_DEGRADED: single_model_family]` warning.
 *
 * Invariants:
 * - Zero imports from `src/adapters/*` (core engine purity).
 * - Zero external runtime npm dependencies.
 * - TypeScript erasableSyntaxOnly: true (no enum, type-only imports where applicable).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { loadRoutingConfig } from "./config.ts";
import type {
  AgentRole,
  DifficultyTier,
  DomainCategory,
  HarnessId,
  RouteEntry,
  RoutingConfig,
  TaskStatus,
} from "./types.ts";

// ============================================================================
// Constants & Tag Definitions
// ============================================================================

export const DIVERSITY_DEGRADED_TAG =
  "[DIVERSITY_DEGRADED: single_model_family]" as const;

export const SPECIALIST_ROLES: readonly AgentRole[] = [
  "director",
  "planner",
  "analyst",
  "critic",
  "arbiter",
  "architect",
  "scout",
  "verifier",
] as const;

export const REGISTERED_DOMAIN_CATEGORIES: readonly DomainCategory[] = [
  "visual-ui",
  "design",
  "research",
  "writing",
] as const;

export const CLI_HARNESSES: readonly HarnessId[] = [
  "claude-code",
  "opencode",
  "codex",
] as const;

// ============================================================================
// Type Definitions
// ============================================================================

export type ModelFamily =
  | "claude"
  | "gpt"
  | "gemini"
  | "glm"
  | "deepseek"
  | string;

export interface RouteRequest {
  role?: AgentRole | string;
  category?: DomainCategory | string;
  difficulty?: DifficultyTier | string;
  harness?: HarnessId | string;
  model?: string;
  isSubagentSpawn?: boolean;
  mainHarness?: HarnessId | string;
  mode?: "parallel_spawn" | "claim_only" | string;
}

export interface RuntimeCapabilities {
  antigravityHeadlessSupported?: boolean;
  availableHarnesses?: HarnessId[];
  availableModelFamilies?: string[];
}

export interface ResolvedRoute {
  harness: HarnessId;
  model: string;
  modelFamily: ModelFamily;
  fallbacks: Array<{
    harness: HarnessId;
    model: string;
    modelFamily: string;
  }>;
  tier: 1 | 2 | 3 | 4;
  fallbackApplied?: boolean;
}

export interface TaskRouteTarget {
  taskId?: string;
  role?: AgentRole | string;
  category?: DomainCategory | string;
  difficulty?: DifficultyTier | string;
  assignedHarness?: HarnessId | string | null;
  assignedModel?: string | null;
  assigned_harness?: string | null;
  assigned_model?: string | null;
  status?: TaskStatus | string;
  attempts?: number;
}

export interface EscalationResult {
  status: TaskStatus;
  route: ResolvedRoute | null;
  harness: HarnessId | null;
  model: string | null;
  modelFamily: string | null;
  escalated: boolean;
  failed: boolean;
  attempts: number;
}

export interface ProposalRouteInput {
  harness?: HarnessId | string;
  model?: string;
  modelFamily?: string;
}

export interface DiverseReviewerSelection {
  route: ResolvedRoute;
  harness: HarnessId;
  model: string;
  modelFamily: string;
  diversityDegraded: boolean;
  tag?: string;
  warning?: string;
}

// ============================================================================
// Helper: Antigravity Model Tier Normalization & CLI Harness Discovery
// ============================================================================

export type AntigravityModelTier = "inherit" | "flash_lite" | "flash" | "pro";

/**
 * Normalizes any Gemini/Antigravity model string (e.g. "gemini-3-flash-lite",
 * "gemini-3.8-flash", "gemini-3-pro", "inherent", "pro") into one of Antigravity's
 * 4 native subagent model tiers: "inherit" | "flash_lite" | "flash" | "pro".
 */
export function normalizeAntigravityModel(
  model?: string | null
): AntigravityModelTier {
  if (!model) return "inherit";
  const m = model.toLowerCase().trim();
  if (
    m === "flash_lite" ||
    m === "flash-lite" ||
    m.includes("flash_lite") ||
    m.includes("flash-lite")
  ) {
    return "flash_lite";
  }
  if (m === "flash" || m.includes("flash")) {
    return "flash";
  }
  if (m === "pro" || m.includes("pro")) {
    return "pro";
  }
  if (m === "inherit" || m === "inherent") {
    return "inherit";
  }
  return "inherit";
}

/**
 * Detects which CLI harnesses (`claude-code`, `opencode`, `codex`) are installed
 * on the current system PATH. Used during live subagent routing and debates so
 * uninstalled harnesses are skipped automatically.
 */
export function detectAvailableCliHarnesses(
  env: Record<string, string | undefined> = process.env
): HarnessId[] {
  const pathEnv = env.PATH || env.Path || process.env.PATH || process.env.Path || "";
  const dirs = pathEnv.split(path.delimiter).filter(Boolean);
  const candidates: Array<{ harness: HarnessId; bin: string }> = [
    { harness: "claude-code", bin: "claude" },
    { harness: "opencode", bin: "opencode" },
    { harness: "codex", bin: "codex" },
  ];

  const found: HarnessId[] = [];
  for (const { harness, bin } of candidates) {
    let exists = false;
    for (const dir of dirs) {
      if (process.platform === "win32") {
        if (
          fs.existsSync(path.join(dir, `${bin}.cmd`)) ||
          fs.existsSync(path.join(dir, `${bin}.exe`)) ||
          fs.existsSync(path.join(dir, `${bin}.bat`)) ||
          fs.existsSync(path.join(dir, bin))
        ) {
          exists = true;
          break;
        }
      } else if (fs.existsSync(path.join(dir, bin))) {
        exists = true;
        break;
      }
    }
    if (exists) {
      found.push(harness);
    }
  }

  return found.length > 0 ? found : [...CLI_HARNESSES];
}

// ============================================================================
// Helper: Infer Model Family
// ============================================================================

/**
 * Infer the model family identifier from model name and optional harness hint.
 */
export function inferModelFamily(model: string, harness?: HarnessId): string {
  const m = model.toLowerCase().trim();
  if (
    m.includes("claude") ||
    m.includes("sonnet") ||
    m.includes("opus") ||
    m.includes("haiku")
  ) {
    return "claude";
  }
  if (
    m.includes("gpt") ||
    m.includes("o1") ||
    m.includes("o3") ||
    m.includes("codex")
  ) {
    return "gpt";
  }
  if (
    m.includes("gemini") ||
    m === "flash_lite" ||
    m === "flash-lite" ||
    m === "flash" ||
    m === "pro" ||
    m === "inherit" ||
    m === "inherent"
  ) {
    return "gemini";
  }
  if (m.includes("glm")) {
    return "glm";
  }
  if (m.includes("deepseek") || m.includes("r1")) {
    return "deepseek";
  }
  if (harness === "claude-code") return "claude";
  if (harness === "codex") return "gpt";
  if (harness === "antigravity") return "gemini";
  if (harness === "opencode") return "glm";
  return "general";
}

// ============================================================================
// Core: 4-Tier Route Resolution + @ag Headless Fallback
// ============================================================================

/**
 * Resolve the optimal execution route according to ASD v2.2 4-tier model rules:
 * - Tier 1: Explicit pin override (`request.harness`, `request.model`).
 * - Tier 2: Specialist role match (`director`, `planner`, `analyst`, `critic`,
 *           `arbiter`, `architect`, `scout`, `verifier` -> `routingConfig.agents[role]`).
 * - Tier 3: `builder` or `worker` + registered domain category (`visual-ui`, `design`,
 *           `research`, `writing` -> `routingConfig.categories[category]`).
 * - Tier 4: `builder` or `worker` + `general` (or unknown category) -> difficulty tier
 *           (`routingConfig.categories[difficulty]`: `trivial`..`critical`, default: `medium`).
 *
 * If `request.isSubagentSpawn` is true and selected harness is `"antigravity"`:
 * checks `runtimeCapabilities.antigravityHeadlessSupported` (and whether `mainHarness === "antigravity"`
 * with `claim_only` mode). If headless CLI spawn is unavailable, automatically falls back
 * to the first available CLI harness (`@cc`, `@oc`, `@cx`) in `fallbacks`.
 */
export function resolveRoute(
  request: RouteRequest,
  routingConfig?: RoutingConfig,
  runtimeCapabilities?: RuntimeCapabilities
): ResolvedRoute {
  const cfg = routingConfig ?? loadRoutingConfig(process.cwd());
  let resolved: ResolvedRoute;

  // --------------------------------------------------------------------------
  // Tier 1: Explicit pin override (request.harness, request.model)
  // --------------------------------------------------------------------------
  if (request.harness || request.model) {
    if (request.harness && request.model) {
      const h = request.harness as HarnessId;
      const m = request.model;
      // Search config to inherit known fallbacks or modelFamily if present
      let matchedFamily: string | undefined;
      let matchedFallbacks: Array<{
        harness: HarnessId;
        model: string;
        modelFamily: string;
      }> = [];

      for (const entry of [
        ...Object.values(cfg.agents),
        ...Object.values(cfg.categories),
      ]) {
        if (entry.harness === h && entry.model === m) {
          matchedFamily = entry.modelFamily;
          matchedFallbacks = [...entry.fallbacks];
          break;
        }
      }

      resolved = {
        harness: h,
        model: m,
        modelFamily: matchedFamily ?? inferModelFamily(m, h),
        fallbacks: matchedFallbacks,
        tier: 1,
      };
    } else if (request.model && !request.harness) {
      // Model given, harness omitted: find matching entry in config or infer
      const m = request.model;
      let matchedHarness: HarnessId | undefined;
      let matchedFamily: string | undefined;
      let matchedFallbacks: Array<{
        harness: HarnessId;
        model: string;
        modelFamily: string;
      }> = [];

      for (const entry of [
        ...Object.values(cfg.agents),
        ...Object.values(cfg.categories),
      ]) {
        if (entry.model === m) {
          matchedHarness = entry.harness;
          matchedFamily = entry.modelFamily;
          matchedFallbacks = [...entry.fallbacks];
          break;
        }
      }

      const inferredFamily = matchedFamily ?? inferModelFamily(m);
      const h: HarnessId =
        matchedHarness ??
        (inferredFamily === "claude"
          ? "claude-code"
          : inferredFamily === "gpt"
            ? "codex"
            : inferredFamily === "gemini"
              ? "antigravity"
              : "opencode");

      resolved = {
        harness: h,
        model: m,
        modelFamily: inferredFamily,
        fallbacks: matchedFallbacks,
        tier: 1,
      };
    } else {
      // Harness given, model omitted: resolve base route from Tier 2-4 and adapt
      const h = request.harness as HarnessId;
      const base = resolveBaseRoute(
        { ...request, harness: undefined, model: undefined },
        cfg
      );

      if (base.harness === h) {
        resolved = { ...base, tier: 1 };
      } else {
        const matchingFallback = base.fallbacks.find((fb) => fb.harness === h);
        if (matchingFallback) {
          const remainingFallbacks = base.fallbacks.filter(
            (fb) => fb !== matchingFallback
          );
          resolved = {
            harness: matchingFallback.harness,
            model: matchingFallback.model,
            modelFamily: matchingFallback.modelFamily,
            fallbacks: remainingFallbacks,
            tier: 1,
          };
        } else {
          // Find any route with this harness in config
          const matchInConfig = [
            ...Object.values(cfg.agents),
            ...Object.values(cfg.categories),
          ].find((e) => e.harness === h);

          if (matchInConfig) {
            resolved = {
              harness: h,
              model: matchInConfig.model,
              modelFamily: matchInConfig.modelFamily,
              fallbacks: [...matchInConfig.fallbacks],
              tier: 1,
            };
          } else {
            resolved = {
              harness: h,
              model: base.model,
              modelFamily: inferModelFamily(base.model, h),
              fallbacks: base.fallbacks,
              tier: 1,
            };
          }
        }
      }
    }
  } else {
    // ------------------------------------------------------------------------
    // Tiers 2, 3, 4: Normal hierarchical resolution
    // ------------------------------------------------------------------------
    resolved = resolveBaseRoute(request, cfg);
  }

  // --------------------------------------------------------------------------
  // @ag Headless Spawn Asymmetry & Uninstalled CLI Harness Fallback:
  // 1. When spawning a subagent (isSubagentSpawn: true) and selected harness is
  //    "antigravity", check if headless CLI spawn is available.
  // 2. When spawning a CLI subagent (mode !== "claim_only") and
  //    runtimeCapabilities.availableHarnesses is provided, if resolved.harness
  //    is not installed, automatically fall back to the first available harness.
  // --------------------------------------------------------------------------
  if (request.isSubagentSpawn) {
    const headlessSupported = Boolean(
      runtimeCapabilities?.antigravityHeadlessSupported
    );
    const isClaimOnlyOnAg =
      request.mainHarness === "antigravity" && request.mode === "claim_only";
    const needsAgFallback =
      resolved.harness === "antigravity" && !headlessSupported && !isClaimOnlyOnAg;

    const avail = runtimeCapabilities?.availableHarnesses;
    const needsCliAvailabilityFallback =
      request.mode !== "claim_only" &&
      Array.isArray(avail) &&
      avail.length > 0 &&
      !avail.includes(resolved.harness);

    if (needsAgFallback || needsCliAvailabilityFallback) {
      const fallback = resolved.fallbacks.find((fb) => {
        if (!CLI_HARNESSES.includes(fb.harness)) return false;
        if (avail && avail.length > 0 && !avail.includes(fb.harness)) {
          return false;
        }
        return true;
      });

      if (fallback) {
        const remainingFallbacks = resolved.fallbacks.filter(
          (fb) => fb !== fallback && fb.harness !== "antigravity"
        );
        resolved = {
          harness: fallback.harness,
          model: fallback.model,
          modelFamily: fallback.modelFamily,
          fallbacks: remainingFallbacks,
          tier: resolved.tier,
          fallbackApplied: true,
        };
      } else if (avail && avail.length > 0) {
        const targetHarness = avail[0]!;
        const matchInConfig = [
          ...Object.values(cfg.agents),
          ...Object.values(cfg.categories),
        ].find((e) => e.harness === targetHarness);
        resolved = {
          harness: targetHarness,
          model: matchInConfig?.model ?? "default",
          modelFamily:
            matchInConfig?.modelFamily ?? inferModelFamily("default", targetHarness),
          fallbacks: [],
          tier: resolved.tier,
          fallbackApplied: true,
        };
      } else {
        // Fallback to standard CLI medium category / worker route
        const defaultCli =
          cfg.categories["medium"] ?? cfg.agents.worker;
        if (defaultCli && defaultCli.harness !== "antigravity") {
          resolved = {
            harness: defaultCli.harness,
            model: defaultCli.model,
            modelFamily: defaultCli.modelFamily,
            fallbacks: defaultCli.fallbacks.filter(
              (fb) => fb.harness !== "antigravity"
            ),
            tier: resolved.tier,
            fallbackApplied: true,
          };
        }
      }
    }
  }

  return resolved;
}

/**
 * Internal helper: resolves Tiers 2, 3, and 4.
 */
function resolveBaseRoute(
  request: RouteRequest,
  cfg: RoutingConfig
): ResolvedRoute {
  const role = request.role as AgentRole | undefined;

  // Tier 2: Specialist role match (director, planner, analyst, critic, arbiter, architect, scout, verifier)
  if (role && SPECIALIST_ROLES.includes(role)) {
    const agentEntry = cfg.agents[role];
    if (agentEntry) {
      return {
        harness: agentEntry.harness,
        model: agentEntry.model,
        modelFamily: agentEntry.modelFamily,
        fallbacks: [...agentEntry.fallbacks],
        tier: 2,
      };
    }
  }

  // Tier 3: builder or worker + registered domain category (visual-ui, design, research, writing)
  const isBuilderOrWorker =
    !role || role === "builder" || role === "worker";

  if (isBuilderOrWorker && request.category) {
    const cat = request.category as DomainCategory;
    if (REGISTERED_DOMAIN_CATEGORIES.includes(cat)) {
      const catEntry = cfg.categories[cat];
      if (catEntry) {
        return {
          harness: catEntry.harness,
          model: catEntry.model,
          modelFamily: catEntry.modelFamily,
          fallbacks: [...catEntry.fallbacks],
          tier: 3,
        };
      }
    }
  }

  // Tier 4: builder or worker + general (or unknown category) -> difficulty tier (trivial..critical)
  const diffKey = (request.difficulty ?? "medium") as string;
  const diffEntry =
    cfg.categories[diffKey] ??
    cfg.categories["general"] ??
    (role && cfg.agents[role]) ??
    cfg.agents.worker;

  if (diffEntry) {
    return {
      harness: diffEntry.harness,
      model: diffEntry.model,
      modelFamily: diffEntry.modelFamily,
      fallbacks: [...diffEntry.fallbacks],
      tier: 4,
    };
  }

  // Ultimate fallback to worker
  const workerEntry = cfg.agents.worker;
  return {
    harness: workerEntry?.harness ?? "opencode",
    model: workerEntry?.model ?? "glm-5",
    modelFamily: workerEntry?.modelFamily ?? "glm",
    fallbacks: workerEntry ? [...workerEntry.fallbacks] : [],
    tier: 4,
  };
}

// ============================================================================
// Fallback & Escalation
// ============================================================================

/**
 * Resolve the next valid fallback from a current route's fallback chain,
 * respecting runtime capabilities (e.g. available harnesses and headless support).
 */
export function resolveFallback(
  currentRoute: RouteEntry,
  routingConfig?: RoutingConfig,
  runtimeCapabilities?: RuntimeCapabilities
): ResolvedRoute | null {
  if (!currentRoute.fallbacks || currentRoute.fallbacks.length === 0) {
    return null;
  }

  const headlessSupported = Boolean(
    runtimeCapabilities?.antigravityHeadlessSupported
  );

  for (let i = 0; i < currentRoute.fallbacks.length; i++) {
    const candidate = currentRoute.fallbacks[i]!;

    if (
      runtimeCapabilities?.availableHarnesses &&
      !runtimeCapabilities.availableHarnesses.includes(candidate.harness)
    ) {
      continue;
    }

    if (
      runtimeCapabilities?.availableModelFamilies &&
      !runtimeCapabilities.availableModelFamilies.includes(candidate.modelFamily)
    ) {
      continue;
    }

    if (candidate.harness === "antigravity" && !headlessSupported) {
      continue;
    }

    const remainingFallbacks = currentRoute.fallbacks.slice(i + 1);
    return {
      harness: candidate.harness,
      model: candidate.model,
      modelFamily: candidate.modelFamily,
      fallbacks: remainingFallbacks,
      tier: (currentRoute as ResolvedRoute).tier ?? 4,
      fallbackApplied: true,
    };
  }

  return null;
}

/**
 * 3-attempt task escalation engine:
 * - Attempt 1 (attempts === 0): initial route (status: 'pending' or current status).
 * - Attempt 2 (attempts === 1): same model after rollback (status unchanged).
 * - Attempt 3 (attempts === 2): status = 'escalated', upgraded to high-tier architect/builder model.
 * - After Attempt 3 failure (attempts >= 3): status = 'failed', route = null.
 */
export function escalateTaskRoute(
  task: TaskRouteTarget,
  attempts: number,
  routingConfig?: RoutingConfig,
  runtimeCapabilities?: RuntimeCapabilities
): EscalationResult {
  const cfg = routingConfig ?? loadRoutingConfig(process.cwd());
  const currentAttempts = attempts ?? task.attempts ?? 0;

  // After Attempt 3 failure -> failed
  if (currentAttempts >= 3) {
    return {
      status: "failed",
      route: null,
      harness: null,
      model: null,
      modelFamily: null,
      escalated: false,
      failed: true,
      attempts: currentAttempts,
    };
  }

  // Attempt 3: status = 'escalated', upgraded to builder/architect high-tier model
  if (currentAttempts === 2) {
    const highTierRoute = resolveRoute(
      {
        ...task,
        role: "architect",
        difficulty: "critical",
        harness: undefined,
        model: undefined,
      },
      cfg,
      runtimeCapabilities
    );

    return {
      status: "escalated",
      route: highTierRoute,
      harness: highTierRoute.harness,
      model: highTierRoute.model,
      modelFamily: highTierRoute.modelFamily,
      escalated: true,
      failed: false,
      attempts: currentAttempts,
    };
  }

  // Attempt 2: same model after rollback
  if (currentAttempts === 1) {
    const assignedHarness = (task.assignedHarness ??
      task.assigned_harness) as HarnessId | undefined;
    const assignedModel =
      task.assignedModel ?? task.assigned_model ?? undefined;

    let route: ResolvedRoute;
    if (assignedHarness && assignedModel) {
      route = resolveRoute(
        {
          ...task,
          harness: assignedHarness,
          model: assignedModel,
        },
        cfg,
        runtimeCapabilities
      );
    } else {
      route = resolveRoute(task, cfg, runtimeCapabilities);
    }

    return {
      status: (task.status as TaskStatus) || "pending",
      route,
      harness: route.harness,
      model: route.model,
      modelFamily: route.modelFamily,
      escalated: false,
      failed: false,
      attempts: currentAttempts,
    };
  }

  // Attempt 1: initial attempt
  const initialRoute = resolveRoute(task, cfg, runtimeCapabilities);
  return {
    status: (task.status as TaskStatus) || "pending",
    route: initialRoute,
    harness: initialRoute.harness,
    model: initialRoute.model,
    modelFamily: initialRoute.modelFamily,
    escalated: false,
    failed: false,
    attempts: currentAttempts,
  };
}

// ============================================================================
// Cross-Model Reviewer Diversity Selection
// ============================================================================

/**
 * Select a diverse reviewer (`critic` or `arbiter`) prioritizing:
 * 1. Different `modelFamily` first
 * 2. Different `harness` second
 *
 * If only a single model family is available in the candidate pool or environment,
 * returns `diversityDegraded: true` and tag `"[DIVERSITY_DEGRADED: single_model_family]"`.
 */
export function selectDiverseReviewer(
  proposalRoute: ProposalRouteInput,
  reviewerRole: AgentRole = "critic",
  routingConfig?: RoutingConfig,
  runtimeCapabilities?: RuntimeCapabilities
): DiverseReviewerSelection {
  const cfg = routingConfig ?? loadRoutingConfig(process.cwd());

  const propFamily =
    proposalRoute.modelFamily ||
    inferModelFamily(
      proposalRoute.model || "",
      proposalRoute.harness as HarnessId | undefined
    );
  const propHarness = proposalRoute.harness as HarnessId | undefined;

  // 1. Gather all reviewer candidates: primary + fallbacks of reviewerRole
  const primaryRoleEntry = cfg.agents[reviewerRole];
  const rawCandidates: Array<{
    harness: HarnessId;
    model: string;
    modelFamily: string;
  }> = [];

  if (primaryRoleEntry) {
    rawCandidates.push({
      harness: primaryRoleEntry.harness,
      model: primaryRoleEntry.model,
      modelFamily: primaryRoleEntry.modelFamily,
    });
    for (const fb of primaryRoleEntry.fallbacks) {
      rawCandidates.push({
        harness: fb.harness,
        model: fb.model,
        modelFamily: fb.modelFamily,
      });
    }
  }

  // Also include the other reviewer roles (arbiter / critic / analyst / architect)
  const peerRoles: AgentRole[] =
    reviewerRole === "critic"
      ? ["arbiter", "analyst", "architect"]
      : ["critic", "analyst", "architect"];

  for (const peer of peerRoles) {
    const peerEntry = cfg.agents[peer];
    if (peerEntry) {
      rawCandidates.push({
        harness: peerEntry.harness,
        model: peerEntry.model,
        modelFamily: peerEntry.modelFamily,
      });
      for (const fb of peerEntry.fallbacks) {
        rawCandidates.push({
          harness: fb.harness,
          model: fb.model,
          modelFamily: fb.modelFamily,
        });
      }
    }
  }

  // 2. Filter against runtimeCapabilities
  const headlessSupported = Boolean(
    runtimeCapabilities?.antigravityHeadlessSupported
  );

  const filteredCandidates = rawCandidates.filter((cand) => {
    // Harness availability
    if (
      runtimeCapabilities?.availableHarnesses &&
      !runtimeCapabilities.availableHarnesses.includes(cand.harness)
    ) {
      return false;
    }
    // Model family availability
    if (
      runtimeCapabilities?.availableModelFamilies &&
      !runtimeCapabilities.availableModelFamilies.includes(cand.modelFamily)
    ) {
      return false;
    }
    // Antigravity headless support for subagent reviewer
    if (cand.harness === "antigravity" && !headlessSupported) {
      return false;
    }
    return true;
  });

  // Deduplicate by harness::model
  const seen = new Set<string>();
  const candidates: Array<{
    harness: HarnessId;
    model: string;
    modelFamily: string;
  }> = [];

  for (const c of filteredCandidates) {
    const key = `${c.harness}::${c.model}`;
    if (!seen.has(key)) {
      seen.add(key);
      candidates.push(c);
    }
  }

  if (candidates.length === 0) {
    throw new Error(
      `No available candidate reviewer for role '${reviewerRole}' matching runtime capabilities`
    );
  }

  // 3. Assess cross-model diversity
  const uniqueFamilies = new Set(candidates.map((c) => c.modelFamily));
  const hasDifferentFamily = candidates.some(
    (c) => c.modelFamily !== propFamily
  );

  const singleFamilyInRuntime = Boolean(
    runtimeCapabilities?.availableModelFamilies &&
      runtimeCapabilities.availableModelFamilies.length <= 1
  );

  const diversityDegraded =
    singleFamilyInRuntime || uniqueFamilies.size <= 1 || !hasDifferentFamily;

  // 4. Rank candidates:
  // - Priority 1: Different modelFamily (weight 100)
  // - Priority 2: Different harness (weight 10)
  const scored = candidates.map((cand, index) => {
    let score = 0;
    if (cand.modelFamily !== propFamily) {
      score += 100;
    }
    if (propHarness && cand.harness !== propHarness) {
      score += 10;
    }
    return { cand, score, index };
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.index - b.index;
  });

  const chosen = scored[0]!.cand;
  const remainingFallbacks = candidates.filter((c) => c !== chosen);

  const tag = diversityDegraded ? DIVERSITY_DEGRADED_TAG : undefined;

  return {
    route: {
      harness: chosen.harness,
      model: chosen.model,
      modelFamily: chosen.modelFamily,
      fallbacks: remainingFallbacks,
      tier: 2,
    },
    harness: chosen.harness,
    model: chosen.model,
    modelFamily: chosen.modelFamily,
    diversityDegraded,
    tag,
    warning: tag,
  };
}
