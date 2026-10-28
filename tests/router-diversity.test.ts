/**
 * ASD v2.2 Router & Diversity Tests (tests/router-diversity.test.ts).
 *
 * Covers:
 * 1. 4-tier model resolution:
 *    - Tier 1: Explicit pin override (harness, model).
 *    - Tier 2: Specialist roles (director, planner, analyst, critic, arbiter, architect, scout, verifier).
 *    - Tier 3: builder/worker + registered domain categories (visual-ui, design, research, writing).
 *    - Tier 4: builder/worker + general/unknown category -> difficulty tier (trivial..critical).
 * 2. @ag non-headless fallback:
 *    - isSubagentSpawn: true with @ag falls back to CLI harness when headless unsupported.
 *    - Preserves @ag when headlessSupported is true.
 *    - Preserves @ag when mainHarness === "antigravity" and mode === "claim_only".
 *    - Preserves @ag when isSubagentSpawn is false (main session).
 * 3. 3-attempt escalation:
 *    - Attempt 1 (attempts = 0): initial route, pending.
 *    - Attempt 2 (attempts = 1): same model after rollback retry.
 *    - Attempt 3 (attempts = 2): status = 'escalated', upgraded to architect high-tier model.
 *    - After Attempt 3 failure (attempts >= 3): status = 'failed', route = null.
 * 4. Cross-model diversity selection + DIVERSITY_DEGRADED warning:
 *    - Selects different modelFamily first, different harness second.
 *    - DIVERSITY_DEGRADED warning when restricted to a single model family.
 * 5. resolveFallback:
 *    - Fallback step-through with runtime capability filtering.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseJsonc } from "../src/core/jsonc.ts";
import type { RoutingConfig } from "../src/core/types.ts";
import {
  DIVERSITY_DEGRADED_TAG,
  REGISTERED_DOMAIN_CATEGORIES,
  SPECIALIST_ROLES,
  escalateTaskRoute,
  inferModelFamily,
  normalizeAntigravityModel,
  resolveFallback,
  resolveRoute,
  selectDiverseReviewer,
} from "../src/core/router.ts";

// Load the canonical default-routing preset
const defaultRoutingPath = path.join(
  import.meta.dirname,
  "..",
  "presets",
  "default-routing.jsonc"
);
const defaultRouting: RoutingConfig = parseJsonc<RoutingConfig>(
  fs.readFileSync(defaultRoutingPath, "utf8")
);

// ============================================================================
// 1. Four-Tier Model Resolution
// ============================================================================

test("Tier 1: explicit pin override overrides all roles, categories, and difficulty", () => {
  // Pinned harness and model
  const route = resolveRoute(
    {
      role: "director", // would normally be claude-opus-4-6
      category: "design", // would normally be claude-sonnet-4-6
      difficulty: "critical",
      harness: "opencode",
      model: "glm-5",
    },
    defaultRouting
  );

  assert.equal(route.tier, 1);
  assert.equal(route.harness, "opencode");
  assert.equal(route.model, "glm-5");
  assert.equal(route.modelFamily, "glm");
});

test("Tier 1: model-only pin infers harness and modelFamily", () => {
  const route = resolveRoute(
    {
      role: "worker",
      model: "gpt-5-codex",
    },
    defaultRouting
  );

  assert.equal(route.tier, 1);
  assert.equal(route.model, "gpt-5-codex");
  assert.equal(route.harness, "codex");
  assert.equal(route.modelFamily, "gpt");
});

test("Tier 1: harness-only pin adapts base route to target harness", () => {
  const route = resolveRoute(
    {
      role: "planner", // default is claude-code / claude-sonnet-4-6
      harness: "codex",
    },
    defaultRouting
  );

  assert.equal(route.tier, 1);
  assert.equal(route.harness, "codex");
  assert.equal(route.model, "gpt-5-codex");
  assert.equal(route.modelFamily, "gpt");
});

test("Tier 2: specialist roles match routingConfig.agents[role]", () => {
  for (const role of SPECIALIST_ROLES) {
    const route = resolveRoute({ role }, defaultRouting);
    const expected = defaultRouting.agents[role];

    assert.equal(route.tier, 2, `role ${role} should resolve to Tier 2`);
    assert.equal(route.harness, expected.harness);
    assert.equal(route.model, expected.model);
    assert.equal(route.modelFamily, expected.modelFamily);
  }
});

test("Tier 3: builder or worker + registered domain categories (including design)", () => {
  for (const cat of REGISTERED_DOMAIN_CATEGORIES) {
    // Test with 'worker'
    const workerRoute = resolveRoute(
      { role: "worker", category: cat },
      defaultRouting
    );
    const expected = defaultRouting.categories[cat];

    assert.equal(
      workerRoute.tier,
      3,
      `category ${cat} for worker should resolve to Tier 3`
    );
    assert.equal(workerRoute.harness, expected.harness);
    assert.equal(workerRoute.model, expected.model);
    assert.equal(workerRoute.modelFamily, expected.modelFamily);

    // Test with 'builder'
    const builderRoute = resolveRoute(
      { role: "builder", category: cat },
      defaultRouting
    );
    assert.equal(
      builderRoute.tier,
      3,
      `category ${cat} for builder should resolve to Tier 3`
    );
    assert.equal(builderRoute.model, expected.model);
  }

  // Specifically assert 'design' category details
  const designRoute = resolveRoute(
    { role: "builder", category: "design" },
    defaultRouting
  );
  assert.equal(designRoute.tier, 3);
  assert.equal(designRoute.harness, "claude-code");
  assert.equal(designRoute.model, "claude-sonnet-4-6");
  assert.equal(designRoute.modelFamily, "claude");
});

test("Tier 4: builder or worker + general or unknown category -> difficulty tiers", () => {
  const tiers = ["low", "medium", "high"] as const;

  for (const diff of tiers) {
    // Explicit 'general' category with difficulty
    const route = resolveRoute(
      { role: "worker", category: "general", difficulty: diff },
      defaultRouting
    );
    const expected = defaultRouting.categories[diff];

    assert.equal(
      route.tier,
      4,
      `difficulty ${diff} for worker should resolve to Tier 4`
    );
    assert.equal(route.harness, expected.harness);
    assert.equal(route.model, expected.model);
    assert.equal(route.modelFamily, expected.modelFamily);

    // Unknown category with difficulty (also testing legacy 'builder' alias -> 'worker')
    const unknownCatRoute = resolveRoute(
      { role: "builder" as any, category: "custom-domain", difficulty: diff },
      defaultRouting
    );
    assert.equal(unknownCatRoute.tier, 4);
    assert.equal(unknownCatRoute.model, expected.model);
  }

  // Legacy difficulty aliases ('trivial' -> 'low', 'critical' -> 'high')
  const trivialRoute = resolveRoute(
    { role: "worker", category: "general", difficulty: "trivial" as any },
    defaultRouting
  );
  assert.equal(trivialRoute.tier, 4);
  assert.equal(trivialRoute.model, defaultRouting.categories["low"].model);

  const criticalRoute = resolveRoute(
    { role: "worker", category: "general", difficulty: "critical" as any },
    defaultRouting
  );
  assert.equal(criticalRoute.tier, 4);
  assert.equal(criticalRoute.model, defaultRouting.categories["high"].model);

  // Default difficulty when unspecified is 'medium'
  const defaultDiffRoute = resolveRoute(
    { role: "worker", category: "general" },
    defaultRouting
  );
  assert.equal(defaultDiffRoute.tier, 4);
  assert.equal(defaultDiffRoute.model, defaultRouting.categories["medium"].model);
});

// ============================================================================
// 2. @ag Headless Spawn Asymmetry Fallback
// ============================================================================

test("@ag fallback: falls back to first CLI harness in fallbacks when headless unsupported", () => {
  // Scout role default in presets is antigravity / gemini-3-flash-lite
  // Fallback 1: codex / gpt-5-codex, Fallback 2: opencode / glm-5
  const route = resolveRoute(
    {
      role: "scout",
      isSubagentSpawn: true,
      mainHarness: "claude-code",
    },
    defaultRouting,
    { antigravityHeadlessSupported: false }
  );

  assert.equal(route.harness, "codex");
  assert.equal(route.model, "gpt-5-codex");
  assert.equal(route.modelFamily, "gpt");
  assert.equal(route.fallbackApplied, true);
});

test("@ag fallback: retains antigravity when headless is supported", () => {
  const route = resolveRoute(
    {
      role: "scout",
      isSubagentSpawn: true,
      mainHarness: "claude-code",
    },
    defaultRouting,
    { antigravityHeadlessSupported: true }
  );

  assert.equal(route.harness, "antigravity");
  assert.equal(route.model, "gemini-3-flash-lite");
  assert.equal(route.fallbackApplied, undefined);
});

test("@ag fallback: retains antigravity when mainHarness is antigravity and mode is claim_only", () => {
  const route = resolveRoute(
    {
      role: "scout",
      isSubagentSpawn: true,
      mainHarness: "antigravity",
      mode: "claim_only",
    },
    defaultRouting,
    { antigravityHeadlessSupported: false }
  );

  assert.equal(route.harness, "antigravity");
  assert.equal(route.model, "gemini-3-flash-lite");
  assert.equal(route.fallbackApplied, undefined);
});

test("@ag fallback: retains antigravity when isSubagentSpawn is false (main host session)", () => {
  const route = resolveRoute(
    {
      role: "scout",
      isSubagentSpawn: false,
    },
    defaultRouting,
    { antigravityHeadlessSupported: false }
  );

  assert.equal(route.harness, "antigravity");
  assert.equal(route.model, "gemini-3-flash-lite");
});

test("@ag fallback: respects availableHarnesses constraint during fallback", () => {
  // Scout fallbacks: codex, opencode. If codex is unavailable, picks opencode.
  const route = resolveRoute(
    {
      role: "scout",
      isSubagentSpawn: true,
      mainHarness: "claude-code",
    },
    defaultRouting,
    {
      antigravityHeadlessSupported: false,
      availableHarnesses: ["claude-code", "opencode"], // codex NOT available
    }
  );

  assert.equal(route.harness, "opencode");
  assert.equal(route.model, "glm-5");
  assert.equal(route.fallbackApplied, true);
});

// ============================================================================
// 3. 3-Attempt Task Escalation
// ============================================================================

test("escalateTaskRoute: Attempt 1 (attempts = 0) returns initial route as pending", () => {
  const task = {
    taskId: "T1.1",
    role: "worker",
    category: "general",
    difficulty: "medium",
    status: "pending",
  };

  const res = escalateTaskRoute(task, 0, defaultRouting);
  assert.equal(res.status, "pending");
  assert.equal(res.escalated, false);
  assert.equal(res.failed, false);
  assert.equal(res.attempts, 0);
  assert.ok(res.route);
  assert.equal(res.harness, "opencode");
  assert.equal(res.model, "glm-5");
});

test("escalateTaskRoute: Attempt 2 (attempts = 1) keeps same model after rollback retry", () => {
  const task = {
    taskId: "T1.1",
    role: "worker",
    category: "general",
    difficulty: "medium",
    assignedHarness: "opencode" as const,
    assignedModel: "glm-5",
    status: "running",
  };

  const res = escalateTaskRoute(task, 1, defaultRouting);
  assert.equal(res.status, "running");
  assert.equal(res.escalated, false);
  assert.equal(res.failed, false);
  assert.equal(res.attempts, 1);
  assert.ok(res.route);
  assert.equal(res.harness, "opencode");
  assert.equal(res.model, "glm-5");
});

test("escalateTaskRoute: Attempt 3 (attempts = 2) sets status 'escalated' and upgrades to architect model", () => {
  const task = {
    taskId: "T1.1",
    role: "worker",
    category: "general",
    difficulty: "medium",
    assignedHarness: "opencode" as const,
    assignedModel: "glm-5",
  };

  const res = escalateTaskRoute(task, 2, defaultRouting);
  assert.equal(res.status, "escalated");
  assert.equal(res.escalated, true);
  assert.equal(res.failed, false);
  assert.equal(res.attempts, 2);
  assert.ok(res.route);
  // Upgraded to architect role route (claude-code / claude-opus-4-6)
  assert.equal(res.harness, "claude-code");
  assert.equal(res.model, "claude-opus-4-6");
  assert.equal(res.modelFamily, "claude");
});

test("escalateTaskRoute: after Attempt 3 failure (attempts >= 3) sets status 'failed'", () => {
  const task = {
    taskId: "T1.1",
    role: "worker",
    category: "general",
    difficulty: "medium",
  };

  const res3 = escalateTaskRoute(task, 3, defaultRouting);
  assert.equal(res3.status, "failed");
  assert.equal(res3.escalated, false);
  assert.equal(res3.failed, true);
  assert.equal(res3.route, null);
  assert.equal(res3.harness, null);
  assert.equal(res3.model, null);

  const res4 = escalateTaskRoute(task, 4, defaultRouting);
  assert.equal(res4.status, "failed");
  assert.equal(res4.failed, true);
});

// ============================================================================
// 4. Cross-Model Diversity Selection & Degraded Warning
// ============================================================================

test("selectDiverseReviewer: prioritizes different modelFamily and different harness", () => {
  // Proposer is codex / gpt-5-codex (family: gpt, harness: codex)
  // Critic primary is codex / gpt-5-codex (same family, same harness)
  // Critic fallback 1 is claude-code / claude-opus-4-6 (different family: claude, different harness: claude-code)
  const sel = selectDiverseReviewer(
    {
      harness: "codex",
      model: "gpt-5-codex",
      modelFamily: "gpt",
    },
    "critic",
    defaultRouting
  );

  assert.equal(sel.diversityDegraded, false);
  assert.equal(sel.modelFamily, "claude");
  assert.equal(sel.harness, "claude-code");
  assert.equal(sel.model, "claude-opus-4-6");
  assert.equal(sel.tag, undefined);
  assert.equal(sel.warning, undefined);
});

test("selectDiverseReviewer: selects primary when primary already has different modelFamily", () => {
  // Proposer is claude-code / claude-sonnet-4-6 (family: claude)
  // Critic primary is codex / gpt-5-codex (family: gpt)
  const sel = selectDiverseReviewer(
    {
      harness: "claude-code",
      model: "claude-sonnet-4-6",
      modelFamily: "claude",
    },
    "critic",
    defaultRouting
  );

  assert.equal(sel.diversityDegraded, false);
  assert.equal(sel.modelFamily, "gpt");
  assert.equal(sel.harness, "codex");
  assert.equal(sel.model, "gpt-5-codex");
});

test("selectDiverseReviewer: sets diversityDegraded: true and warning tag when single model family available", () => {
  // Restrict available model families to 'gpt' only
  const sel = selectDiverseReviewer(
    {
      harness: "codex",
      model: "gpt-5-codex",
      modelFamily: "gpt",
    },
    "critic",
    defaultRouting,
    { availableModelFamilies: ["gpt"] }
  );

  assert.equal(sel.diversityDegraded, true);
  assert.equal(sel.tag, DIVERSITY_DEGRADED_TAG);
  assert.equal(sel.warning, "[DIVERSITY_DEGRADED: single_model_family]");
  assert.equal(sel.modelFamily, "gpt");
  assert.equal(sel.harness, "codex");
});

test("selectDiverseReviewer: arbiter role selects diverse reviewer from claude proposer", () => {
  // Arbiter primary is claude-code / claude-opus-4-6 (family: claude)
  // Proposer is claude
  // Fallback 1: codex / gpt-5-codex (family: gpt)
  const sel = selectDiverseReviewer(
    {
      harness: "claude-code",
      model: "claude-opus-4-6",
      modelFamily: "claude",
    },
    "arbiter",
    defaultRouting
  );

  assert.equal(sel.diversityDegraded, false);
  assert.equal(sel.modelFamily, "gpt");
  assert.equal(sel.harness, "codex");
  assert.equal(sel.model, "gpt-5-codex");
});

// ============================================================================
// 5. Fallback Resolution (resolveFallback)
// ============================================================================

test("resolveFallback: steps through available fallbacks in order", () => {
  const primary = defaultRouting.agents.critic;
  // Fallbacks: [0] claude-code / claude-opus-4-6, [1] opencode / glm-5

  const fb1 = resolveFallback(primary, defaultRouting);
  assert.ok(fb1);
  assert.equal(fb1.harness, "claude-code");
  assert.equal(fb1.model, "claude-opus-4-6");
  assert.equal(fb1.fallbacks.length, 1);

  const fb2 = resolveFallback(fb1, defaultRouting);
  assert.ok(fb2);
  assert.equal(fb2.harness, "opencode");
  assert.equal(fb2.model, "glm-5");
  assert.equal(fb2.fallbacks.length, 0);

  const fb3 = resolveFallback(fb2, defaultRouting);
  assert.equal(fb3, null);
});

test("resolveFallback: skips unavailable harnesses based on runtimeCapabilities", () => {
  const primary = defaultRouting.agents.critic;
  // Fallbacks: [0] claude-code, [1] opencode

  const fb = resolveFallback(primary, defaultRouting, {
    availableHarnesses: ["opencode"], // claude-code not available
  });

  assert.ok(fb);
  assert.equal(fb.harness, "opencode");
  assert.equal(fb.model, "glm-5");
});

// ============================================================================
// 6. inferModelFamily helper
// ============================================================================

test("inferModelFamily: correctly identifies model families from names", () => {
  assert.equal(inferModelFamily("claude-3-5-sonnet"), "claude");
  assert.equal(inferModelFamily("claude-opus-4-6"), "claude");
  assert.equal(inferModelFamily("gpt-5-codex"), "gpt");
  assert.equal(inferModelFamily("o3-mini"), "gpt");
  assert.equal(inferModelFamily("gemini-3-pro"), "gemini");
  assert.equal(inferModelFamily("gemini-3.8-flash"), "gemini");
  assert.equal(inferModelFamily("flash_lite"), "gemini");
  assert.equal(inferModelFamily("flash"), "gemini");
  assert.equal(inferModelFamily("pro"), "gemini");
  assert.equal(inferModelFamily("inherit"), "gemini");
  assert.equal(inferModelFamily("inherent"), "gemini");
  assert.equal(inferModelFamily("glm-5"), "glm");
  assert.equal(inferModelFamily("deepseek-r1"), "deepseek");
});

test("normalizeAntigravityModel: maps arbitrary Gemini/Antigravity names to native tiers", () => {
  assert.equal(normalizeAntigravityModel("gemini-3-flash-lite"), "flash_lite");
  assert.equal(normalizeAntigravityModel("gemini-3.8-flash-lite"), "flash_lite");
  assert.equal(normalizeAntigravityModel("flash-lite"), "flash_lite");
  assert.equal(normalizeAntigravityModel("flash_lite"), "flash_lite");
  assert.equal(normalizeAntigravityModel("gemini-3.8-flash"), "flash");
  assert.equal(normalizeAntigravityModel("gemini-3-flash"), "flash");
  assert.equal(normalizeAntigravityModel("flash"), "flash");
  assert.equal(normalizeAntigravityModel("gemini-3-pro"), "pro");
  assert.equal(normalizeAntigravityModel("gemini-3.1-pro"), "pro");
  assert.equal(normalizeAntigravityModel("pro"), "pro");
  assert.equal(normalizeAntigravityModel("inherit"), "inherit");
  assert.equal(normalizeAntigravityModel("inherent"), "inherit");
  assert.equal(normalizeAntigravityModel(""), "inherit");
  assert.equal(normalizeAntigravityModel(undefined), "inherit");
});
