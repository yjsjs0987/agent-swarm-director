/**
 * ASD v2.2 Core Broker Blind Debate Engine (src/core/debate.ts).
 *
 * Implements:
 * 1. Zero-polling parallel blind cross-model debate.
 * 2. Cross-model diverse reviewer selection via `selectDiverseReviewer` (router.ts).
 * 3. Round 1 (Blind Openings): parallel subagent spawn via Promise.allSettled with
 *    physical isolation (independent subagent sessions, zero visibility into peer openings).
 * 4. Graceful recovery when 1 reviewer times out or crashes as long as at least 1 valid opening survives.
 * 5. Structured verdict parsing (APPROVE | MINOR_AMEND | REJECT, hard_constraints, decisions, risks).
 * 6. Early Exit: if all surviving openings are APPROVE or MINOR_AMEND, synthesizes InsightVerdict
 *    immediately without Round 2.
 * 7. Round 2 (Conflict Resolution & Arbiter Verdict): if any reviewer returns REJECT, runs
 *    rebuttal/arbiter pass with collected Round 1 bundle to produce final InsightVerdict.
 * 8. SQLite persistence in `debates` table (status = 'done') and automatic injection into
 *    `tasks.acceptance` and atomic `.asd/PLAN.md` update when taskId is provided.
 *
 * Invariants:
 * - Zero imports from `src/adapters/*` (core engine purity).
 * - Zero external runtime npm dependencies.
 * - TypeScript erasableSyntaxOnly: true (no enum, type-only imports where applicable).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { openProjectDb } from "./db.ts";
import type { SqliteDriver, SessionRow, TaskRow } from "./db.ts";
import { renderPlanMd, renderProgressBoard } from "./render.ts";
import { inferModelFamily, selectDiverseReviewer } from "./router.ts";
import type {
  DiverseReviewerSelection,
  ProposalRouteInput,
  RuntimeCapabilities,
} from "./router.ts";
import { spawnSubagent } from "./spawner.ts";
import type { CommandRunner } from "./spawner.ts";
import type {
  AgentRole,
  AsdDebateOutput,
  HarnessId,
  RoutingConfig,
} from "./types.ts";

// ============================================================================
// Types & Contracts
// ============================================================================

export type DebateVerdict = "APPROVE" | "MINOR_AMEND" | "REJECT";

export interface ParsedOpening {
  verdict: DebateVerdict;
  hard_constraints: string[];
  decisions: string[];
  risks: string[];
  reasoning: string;
}

export interface ReviewerSpec {
  role: AgentRole;
  harness: HarnessId;
  model: string;
  modelFamily: string;
  diversityDegraded: boolean;
}

export interface ReviewerOpening {
  reviewerId: string;
  role: AgentRole;
  harness: HarnessId;
  model: string;
  modelFamily: string;
  verdict: DebateVerdict;
  hard_constraints: string[];
  decisions: string[];
  risks: string[];
  reasoning: string;
  rawOutput?: string;
  durationMs?: number;
}

export interface FailedReviewer {
  reviewerId: string;
  role: AgentRole;
  harness: HarnessId;
  model: string;
  error: string;
}

export interface Round1Bundle {
  openings: ReviewerOpening[];
  failedReviewers: FailedReviewer[];
}

export interface Round2Bundle {
  arbiterVerdict: ReviewerOpening;
  round1Reference: Round1Bundle;
}

export interface InsightVerdict {
  verdict: DebateVerdict;
  hard_constraints: string[];
  decisions: string[];
  risks: string[];
  diversity_degraded?: boolean;
  reasoning?: string;
}

export interface RunDebateBrokerOptions {
  projectRoot: string;
  homeDir?: string;
  sessionId: string;
  taskId?: string | null;
  topic: string;
  proposal: string;
  debateId?: string;
  proposerRoute?: ProposalRouteInput;
  routingConfig?: RoutingConfig;
  runtimeCapabilities?: RuntimeCapabilities;
  reviewerRoles?: AgentRole[];
  reviewerRoutes?: Array<{
    harness: HarnessId;
    model: string;
    modelFamily?: string;
    role?: AgentRole;
  }>;
  arbiterRoute?: {
    harness: HarnessId;
    model: string;
    modelFamily?: string;
    role?: AgentRole;
  };
  commandRunner?: CommandRunner;
  commandBuilder?: (
    harness: HarnessId,
    prompt: string,
    model: string
  ) => { command: string; args: string[] };
  timeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
  db?: SqliteDriver;
}

export interface DebateBrokerResult extends AsdDebateOutput {
  sessionId: string;
  taskId?: string | null;
  topic: string;
  round1Bundle: Round1Bundle;
  round2Bundle: Round2Bundle | null;
  insightVerdict: InsightVerdict;
}

// ============================================================================
// Helper: Default Command Builder (Harness-Purity Compliant)
// ============================================================================

/**
 * Builds standard headless execution commands for the 4 supported harnesses
 * without requiring any import from src/adapters/*.
 */
export function buildDefaultHarnessCommand(
  harness: HarnessId,
  prompt: string,
  model: string
): { command: string; args: string[] } {
  switch (harness) {
    case "claude-code": {
      const args = ["-p", prompt, "--output-format", "json"];
      if (model) args.push("--model", model);
      return { command: "claude", args };
    }
    case "opencode": {
      const args = ["run", prompt, "--format", "json"];
      if (model) args.push("--model", model);
      return { command: "opencode", args };
    }
    case "codex": {
      const args = ["exec", prompt, "--json"];
      if (model) args.push("-m", model);
      return { command: "codex", args };
    }
    case "antigravity": {
      const args = ["-p", prompt, "--output-format", "json"];
      if (model) args.push("--model", model);
      return { command: "agy", args };
    }
    default: {
      return {
        command: "node",
        args: [
          "-e",
          `console.log(JSON.stringify({ verdict: "APPROVE", hard_constraints: [], decisions: [], risks: [] }))`,
        ],
      };
    }
  }
}

// ============================================================================
// Helper: String Deduplication & Acceptance Formatting
// ============================================================================

export function deduplicateStrings(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const trimmed = item.trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      out.push(trimmed);
    }
  }
  return out;
}

export function formatDebateAcceptance(
  debateId: string,
  hardConstraints: string[],
  decisions: string[]
): string {
  const parts: string[] = [];
  if (decisions.length > 0) {
    parts.push(`[Debate ${debateId}] Decisions: ${decisions.join("; ")}`);
  }
  if (hardConstraints.length > 0) {
    parts.push(
      `[Debate ${debateId}] Hard Constraints: ${hardConstraints.join("; ")}`
    );
  }
  return parts.join("\n\n");
}

// ============================================================================
// Structured Verdict JSON Parser
// ============================================================================

function tryParseJsonObject(raw: string): ParsedOpening | null {
  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object") return null;

    const rawVerdict = String(obj.verdict ?? "").toUpperCase().trim();
    if (
      rawVerdict !== "APPROVE" &&
      rawVerdict !== "MINOR_AMEND" &&
      rawVerdict !== "REJECT"
    ) {
      return null;
    }

    const toStringArray = (val: unknown): string[] => {
      if (Array.isArray(val)) {
        return val.map((x) => String(x).trim()).filter(Boolean);
      }
      if (typeof val === "string" && val.trim().length > 0) {
        return [val.trim()];
      }
      return [];
    };

    const hardConstraints = toStringArray(
      obj.hard_constraints ?? obj.hardConstraints
    );
    const decisions = toStringArray(obj.decisions);
    const risks = toStringArray(obj.risks);
    const reasoning = String(obj.reasoning ?? obj.reason ?? "").trim();

    return {
      verdict: rawVerdict as DebateVerdict,
      hard_constraints: deduplicateStrings(hardConstraints),
      decisions: deduplicateStrings(decisions),
      risks: deduplicateStrings(risks),
      reasoning,
    };
  } catch {
    return null;
  }
}

/**
 * Extracts structured verdict from subagent output:
 * 1. Markdown ```json code fences
 * 2. Entire raw text as JSON
 * 3. Embedded JSON object spanning from first '{' to last '}'
 */
export function parseReviewerOpening(rawText: string): ParsedOpening | null {
  if (!rawText || typeof rawText !== "string") return null;

  // 1. Look for markdown code fence
  const codeBlockRegex = /```(?:json)?\s*([\s\S]*?)\s*```/g;
  let match: RegExpExecArray | null;
  while ((match = codeBlockRegex.exec(rawText)) !== null) {
    const candidate = match[1]?.trim();
    if (candidate) {
      const parsed = tryParseJsonObject(candidate);
      if (parsed) return parsed;
    }
  }

  // 2. Direct JSON parse
  const direct = tryParseJsonObject(rawText.trim());
  if (direct) return direct;

  // 3. Outermost brace search
  const firstBrace = rawText.indexOf("{");
  const lastBrace = rawText.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const candidate = rawText.slice(firstBrace, lastBrace + 1);
    const parsed = tryParseJsonObject(candidate);
    if (parsed) return parsed;
  }

  return null;
}

// ============================================================================
// Prompts for Round 1 & Round 2
// ============================================================================

export function buildRound1Prompt(
  topic: string,
  proposal: string,
  taskId?: string | null
): string {
  return [
    `# ASD Debate Round 1: Blind Review`,
    `Topic: ${topic}`,
    `Task ID: ${taskId ?? "N/A"}`,
    ``,
    `## Proposal`,
    proposal,
    ``,
    `## Instructions`,
    `You are an independent reviewer evaluating this architectural or implementation proposal.`,
    `Critique the proposal thoroughly, identify failure modes, assess risks, and formulate any necessary hard constraints or decisions.`,
    ``,
    `You MUST return your judgment strictly as a JSON block with this schema:`,
    `\`\`\`json`,
    `{`,
    `  "verdict": "APPROVE" | "MINOR_AMEND" | "REJECT",`,
    `  "hard_constraints": ["Constraint 1", "Constraint 2"],`,
    `  "decisions": ["Decision 1", "Decision 2"],`,
    `  "risks": ["Risk 1", "Risk 2"],`,
    `  "reasoning": "Detailed explanation of your verdict"`,
    `}`,
    `\`\`\``,
  ].join("\n");
}

export function buildRound2Prompt(
  topic: string,
  proposal: string,
  round1: Round1Bundle,
  taskId?: string | null
): string {
  const openingsText = round1.openings
    .map(
      (o) =>
        `### Reviewer [${o.role} | @${o.harness}/${o.model}]\n` +
        `Verdict: ${o.verdict}\n` +
        `Reasoning: ${o.reasoning || "None"}\n` +
        `Decisions:\n${
          o.decisions.length > 0
            ? o.decisions.map((d) => `- ${d}`).join("\n")
            : "- None"
        }\n` +
        `Hard Constraints:\n${
          o.hard_constraints.length > 0
            ? o.hard_constraints.map((c) => `- ${c}`).join("\n")
            : "- None"
        }\n` +
        `Risks:\n${
          o.risks.length > 0
            ? o.risks.map((r) => `- ${r}`).join("\n")
            : "- None"
        }`
    )
    .join("\n\n");

  return [
    `# ASD Debate Round 2: Conflict Resolution & Arbiter Judgment`,
    `Topic: ${topic}`,
    `Task ID: ${taskId ?? "N/A"}`,
    ``,
    `## Original Proposal`,
    proposal,
    ``,
    `## Round 1 Openings & Disagreements`,
    openingsText,
    ``,
    `## Arbiter Instructions`,
    `At least one reviewer rejected the proposal or raised critical conflicts during Round 1.`,
    `As the final Arbiter, resolve the conflicts between the proposal and reviewer concerns.`,
    `Produce the definitive binding verdict and list of hard constraints and decisions.`,
    ``,
    `You MUST return your final judgment strictly as a JSON block with this schema:`,
    `\`\`\`json`,
    `{`,
    `  "verdict": "APPROVE" | "MINOR_AMEND" | "REJECT",`,
    `  "hard_constraints": ["Constraint 1", "Constraint 2"],`,
    `  "decisions": ["Decision 1", "Decision 2"],`,
    `  "risks": ["Risk 1", "Risk 2"],`,
    `  "reasoning": "Synthesis and final resolution"`,
    `}`,
    `\`\`\``,
  ].join("\n");
}

// ============================================================================
// Core Debate Broker
// ============================================================================

/**
 * Executes zero-polling parallel blind cross-model debate.
 *
 * Flow:
 * 1. Select diverse reviewers prioritizing different modelFamily.
 * 2. Round 1: spawn reviewers in parallel with physical isolation.
 * 3. Graceful degradation: survive single-reviewer crash/timeout.
 * 4. Early Exit: if all surviving openings are APPROVE/MINOR_AMEND -> done.
 * 5. Round 2: if any opening is REJECT -> spawn Arbiter with Round 1 bundle.
 * 6. Persist results in SQLite debates table; append to tasks.acceptance and update PLAN.md.
 */
export async function runDebateBroker(
  options: RunDebateBrokerOptions
): Promise<DebateBrokerResult> {
  const debateId =
    options.debateId ??
    `D-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

  const ownsDb = !options.db;
  const db =
    options.db ?? openProjectDb(options.projectRoot, options.homeDir);

  try {
    // Ensure parent session row exists to satisfy SQLite foreign keys
    if (!db.getSession(options.sessionId)) {
      db.createOrGetSession({
        sessionId: options.sessionId,
        projectRoot: options.projectRoot,
        mainHarness:
          (options.proposerRoute?.harness as HarnessId) ?? "claude-code",
      });
    }

    // Initialize debate record in SQLite (status = 'round1')
    db.createDebate({
      debateId,
      sessionId: options.sessionId,
      taskId: options.taskId ?? null,
      topic: options.topic,
      status: "round1",
    });

    options.onProgress?.(
      `[Debate ${debateId}] Initialized debate for topic: "${options.topic}"`
    );

    // 1. Select Reviewers prioritizing cross-model family diversity
    let diversityDegraded = false;
    const reviewers: ReviewerSpec[] = [];

    if (options.reviewerRoutes && options.reviewerRoutes.length > 0) {
      for (const route of options.reviewerRoutes) {
        const family =
          route.modelFamily ?? inferModelFamily(route.model, route.harness);
        reviewers.push({
          role: route.role ?? "critic",
          harness: route.harness,
          model: route.model,
          modelFamily: family,
          diversityDegraded: false,
        });
      }
    } else {
      const proposerRoute: ProposalRouteInput = options.proposerRoute ?? {
        harness: "claude-code",
        model: "claude-opus-4-6",
        modelFamily: "claude",
      };

      const roles = options.reviewerRoles ?? ["critic", "analyst"];

      // Select Reviewer 1 diverse against proposer
      const role1 = roles[0] ?? "critic";
      const sel1 = selectDiverseReviewer(
        proposerRoute,
        role1,
        options.routingConfig,
        options.runtimeCapabilities
      );
      if (sel1.diversityDegraded) diversityDegraded = true;

      reviewers.push({
        role: role1,
        harness: sel1.harness,
        model: sel1.model,
        modelFamily: sel1.modelFamily,
        diversityDegraded: sel1.diversityDegraded,
      });

      // Select Reviewer 2 diverse against Reviewer 1 and proposer
      if (roles.length > 1) {
        const role2 = roles[1] ?? "analyst";
        const sel2 = selectDiverseReviewer(
          {
            harness: sel1.harness,
            model: sel1.model,
            modelFamily: sel1.modelFamily,
          },
          role2,
          options.routingConfig,
          options.runtimeCapabilities
        );
        if (sel2.diversityDegraded) diversityDegraded = true;

        reviewers.push({
          role: role2,
          harness: sel2.harness,
          model: sel2.model,
          modelFamily: sel2.modelFamily,
          diversityDegraded: sel2.diversityDegraded,
        });
      }
    }

    options.onProgress?.(
      `[Debate ${debateId}] Selected ${reviewers.length} reviewer(s): ` +
        reviewers.map((r) => `@${r.harness}/${r.model} (${r.role})`).join(", ")
    );

    // 2. Round 1: Blind Openings in parallel via Promise.allSettled
    const round1Prompt = buildRound1Prompt(
      options.topic,
      options.proposal,
      options.taskId
    );

    const round1Promises = reviewers.map(async (reviewer, index) => {
      const subSessionId = `${options.sessionId}-deb-${debateId}-r1-${index + 1}`;
      const cmdInfo = options.commandBuilder
        ? options.commandBuilder(reviewer.harness, round1Prompt, reviewer.model)
        : buildDefaultHarnessCommand(
            reviewer.harness,
            round1Prompt,
            reviewer.model
          );

      const spawnResult = await spawnSubagent({
        projectRoot: options.projectRoot,
        homeDir: options.homeDir,
        mainSessionId: options.sessionId,
        subSessionId,
        role: reviewer.role,
        harness: reviewer.harness,
        model: reviewer.model,
        taskId: options.taskId ?? "",
        prompt: round1Prompt,
        allowedFiles: [],
        command: cmdInfo.command,
        args: cmdInfo.args,
        commandRunner: options.commandRunner,
        signal: options.signal,
        timeoutMs: options.timeoutMs,
      });

      if (spawnResult.exitCode !== 0) {
        throw new Error(
          `Reviewer process exited with non-zero exit code ${spawnResult.exitCode}`
        );
      }

      const logPath = path.join(
        path.dirname(spawnResult.metaPath),
        "output.log"
      );
      let output = "";
      if (fs.existsSync(logPath)) {
        output = fs.readFileSync(logPath, "utf8");
      }

      const parsed = parseReviewerOpening(output);
      if (!parsed) {
        throw new Error(
          `Failed to parse structured verdict JSON from reviewer output (${reviewer.role})`
        );
      }

      const opening: ReviewerOpening = {
        reviewerId: `r1-${index + 1}`,
        role: reviewer.role,
        harness: reviewer.harness,
        model: reviewer.model,
        modelFamily: reviewer.modelFamily,
        verdict: parsed.verdict,
        hard_constraints: parsed.hard_constraints,
        decisions: parsed.decisions,
        risks: parsed.risks,
        reasoning: parsed.reasoning,
        rawOutput: output,
        durationMs: spawnResult.durationMs,
      };
      return opening;
    });

    const settledResults = await Promise.allSettled(round1Promises);

    const survivingOpenings: ReviewerOpening[] = [];
    const failedReviewers: FailedReviewer[] = [];

    for (let i = 0; i < settledResults.length; i++) {
      const item = settledResults[i]!;
      const rev = reviewers[i]!;
      if (item.status === "fulfilled") {
        survivingOpenings.push(item.value);
      } else {
        const errorMsg =
          item.reason instanceof Error
            ? item.reason.message
            : String(item.reason);
        failedReviewers.push({
          reviewerId: `r1-${i + 1}`,
          role: rev.role,
          harness: rev.harness,
          model: rev.model,
          error: errorMsg,
        });
      }
    }

    // Graceful recovery check: must have at least 1 valid surviving opening
    if (survivingOpenings.length === 0) {
      const errDetails = failedReviewers
        .map((f) => `[@${f.harness}/${f.model}]: ${f.error}`)
        .join("; ");
      throw new Error(
        `All debate reviewers failed or timed out in Round 1: ${errDetails}`
      );
    }

    const round1Bundle: Round1Bundle = {
      openings: survivingOpenings,
      failedReviewers,
    };

    // Check for REJECT in surviving openings
    const rejectingOpenings = survivingOpenings.filter(
      (o) => o.verdict === "REJECT"
    );
    const hasReject = rejectingOpenings.length > 0;

    let round2Bundle: Round2Bundle | null = null;
    let insightVerdict: InsightVerdict;

    if (!hasReject) {
      // 3. Early Exit: All surviving openings are APPROVE or MINOR_AMEND
      const hasMinorAmend = survivingOpenings.some(
        (o) => o.verdict === "MINOR_AMEND"
      );
      const earlyVerdict: DebateVerdict = hasMinorAmend
        ? "MINOR_AMEND"
        : "APPROVE";

      const hardConstraints = deduplicateStrings(
        survivingOpenings.flatMap((o) => o.hard_constraints)
      );
      const decisions = deduplicateStrings(
        survivingOpenings.flatMap((o) => o.decisions)
      );
      const risks = deduplicateStrings(
        survivingOpenings.flatMap((o) => o.risks)
      );

      insightVerdict = {
        verdict: earlyVerdict,
        hard_constraints: hardConstraints,
        decisions,
        risks,
        diversity_degraded: diversityDegraded,
        reasoning: survivingOpenings
          .map((o) => `${o.role} (@${o.harness}): ${o.reasoning || o.verdict}`)
          .join("; "),
      };

      db.updateDebateVerdict(debateId, "done", {
        round1BundleJson: JSON.stringify(round1Bundle),
        round2BundleJson: null,
        insightVerdictJson: JSON.stringify(insightVerdict),
      });

      options.onProgress?.(
        `[Debate ${debateId}] Round 1 early exit: unanimous non-rejection (${earlyVerdict})`
      );
    } else {
      // 4. Round 2: Conflict Resolution & Arbiter Verdict
      options.onProgress?.(
        `[Debate ${debateId}] Conflict detected in Round 1 (REJECT present). Triggering Round 2 Arbiter pass...`
      );

      db.updateDebateVerdict(debateId, "round2", {
        round1BundleJson: JSON.stringify(round1Bundle),
      });

      // Select Arbiter
      let arbiterSpec: ReviewerSpec;
      if (options.arbiterRoute) {
        arbiterSpec = {
          role: options.arbiterRoute.role ?? "arbiter",
          harness: options.arbiterRoute.harness,
          model: options.arbiterRoute.model,
          modelFamily:
            options.arbiterRoute.modelFamily ??
            inferModelFamily(
              options.arbiterRoute.model,
              options.arbiterRoute.harness
            ),
          diversityDegraded: false,
        };
      } else {
        const rejectLead = rejectingOpenings[0]!;
        const arbiterSel = selectDiverseReviewer(
          {
            harness: rejectLead.harness,
            model: rejectLead.model,
            modelFamily: rejectLead.modelFamily,
          },
          "arbiter",
          options.routingConfig,
          options.runtimeCapabilities
        );
        if (arbiterSel.diversityDegraded) diversityDegraded = true;

        arbiterSpec = {
          role: "arbiter",
          harness: arbiterSel.harness,
          model: arbiterSel.model,
          modelFamily: arbiterSel.modelFamily,
          diversityDegraded: arbiterSel.diversityDegraded,
        };
      }

      const r2Prompt = buildRound2Prompt(
        options.topic,
        options.proposal,
        round1Bundle,
        options.taskId
      );
      const r2SubSessionId = `${options.sessionId}-deb-${debateId}-r2-arbiter`;
      const r2CmdInfo = options.commandBuilder
        ? options.commandBuilder(arbiterSpec.harness, r2Prompt, arbiterSpec.model)
        : buildDefaultHarnessCommand(
            arbiterSpec.harness,
            r2Prompt,
            arbiterSpec.model
          );

      let arbiterOpening: ReviewerOpening;
      try {
        const arbResult = await spawnSubagent({
          projectRoot: options.projectRoot,
          homeDir: options.homeDir,
          mainSessionId: options.sessionId,
          subSessionId: r2SubSessionId,
          role: arbiterSpec.role,
          harness: arbiterSpec.harness,
          model: arbiterSpec.model,
          taskId: options.taskId ?? "",
          prompt: r2Prompt,
          allowedFiles: [],
          command: r2CmdInfo.command,
          args: r2CmdInfo.args,
          commandRunner: options.commandRunner,
          signal: options.signal,
          timeoutMs: options.timeoutMs,
        });

        if (arbResult.exitCode !== 0) {
          throw new Error(
            `Arbiter process exited with code ${arbResult.exitCode}`
          );
        }

        const arbLogPath = path.join(
          path.dirname(arbResult.metaPath),
          "output.log"
        );
        let arbOutput = "";
        if (fs.existsSync(arbLogPath)) {
          arbOutput = fs.readFileSync(arbLogPath, "utf8");
        }

        const parsedArb = parseReviewerOpening(arbOutput);
        if (!parsedArb) {
          throw new Error(
            "Failed to parse structured verdict JSON from arbiter output"
          );
        }

        arbiterOpening = {
          reviewerId: "r2-arbiter",
          role: arbiterSpec.role,
          harness: arbiterSpec.harness,
          model: arbiterSpec.model,
          modelFamily: arbiterSpec.modelFamily,
          verdict: parsedArb.verdict,
          hard_constraints: parsedArb.hard_constraints,
          decisions: parsedArb.decisions,
          risks: parsedArb.risks,
          reasoning: parsedArb.reasoning,
          rawOutput: arbOutput,
          durationMs: arbResult.durationMs,
        };
      } catch (arbErr) {
        // Fallback resolution if Arbiter subagent crashes
        arbiterOpening = {
          reviewerId: "r2-arbiter-fallback",
          role: "arbiter",
          harness: arbiterSpec.harness,
          model: arbiterSpec.model,
          modelFamily: arbiterSpec.modelFamily,
          verdict: "REJECT",
          hard_constraints: deduplicateStrings(
            survivingOpenings.flatMap((o) => o.hard_constraints)
          ),
          decisions: deduplicateStrings(
            survivingOpenings.flatMap((o) => o.decisions)
          ),
          risks: deduplicateStrings(survivingOpenings.flatMap((o) => o.risks)),
          reasoning: `Arbiter failed to complete (${
            arbErr instanceof Error ? arbErr.message : String(arbErr)
          }); defaulting to REJECT based on Round 1 conflicts.`,
        };
      }

      round2Bundle = {
        arbiterVerdict: arbiterOpening,
        round1Reference: round1Bundle,
      };

      const finalHardConstraints = deduplicateStrings([
        ...arbiterOpening.hard_constraints,
        ...survivingOpenings
          .filter((o) => o.verdict !== "REJECT")
          .flatMap((o) => o.hard_constraints),
      ]);
      const finalDecisions = deduplicateStrings([
        ...arbiterOpening.decisions,
        ...survivingOpenings
          .filter((o) => o.verdict !== "REJECT")
          .flatMap((o) => o.decisions),
      ]);
      const finalRisks = deduplicateStrings([
        ...arbiterOpening.risks,
        ...survivingOpenings.flatMap((o) => o.risks),
      ]);

      insightVerdict = {
        verdict: arbiterOpening.verdict,
        hard_constraints: finalHardConstraints,
        decisions: finalDecisions,
        risks: finalRisks,
        diversity_degraded: diversityDegraded,
        reasoning: arbiterOpening.reasoning,
      };

      db.updateDebateVerdict(debateId, "done", {
        round1BundleJson: JSON.stringify(round1Bundle),
        round2BundleJson: JSON.stringify(round2Bundle),
        insightVerdictJson: JSON.stringify(insightVerdict),
      });

      options.onProgress?.(
        `[Debate ${debateId}] Round 2 Arbiter completed with verdict: ${insightVerdict.verdict}`
      );
    }

    // 5. Automatic acceptance injection into tasks and PLAN.md update
    let updatedAcceptance: string | undefined;

    if (options.taskId && options.taskId.trim().length > 0) {
      const acceptanceText = formatDebateAcceptance(
        debateId,
        insightVerdict.hard_constraints,
        insightVerdict.decisions
      );

      if (acceptanceText.length > 0) {
        db.injectDebateAcceptance(
          options.sessionId,
          options.taskId,
          acceptanceText
        );
      }

      const updatedTask = db.getTask(options.sessionId, options.taskId);
      updatedAcceptance = updatedTask?.acceptance ?? acceptanceText;

      // Automatically sync updated task acceptance into .asd/PLAN.md
      try {
        const sessionRow = db.getSession(options.sessionId);
        const taskRows = db.getSessionTasks(options.sessionId);
        if (sessionRow) {
          renderPlanMd(sessionRow, taskRows);
        }
      } catch {
        // Ignore PLAN.md rendering errors when running in isolated test DBs
      }
    }

    // 6. Generate Progress Board markdown
    let progressBoard = "";
    try {
      const sessionRow = db.getSession(options.sessionId);
      const taskRows = db.getSessionTasks(options.sessionId);
      progressBoard = renderProgressBoard(sessionRow, taskRows);
    } catch {
      progressBoard =
        "### 📊 ASD TODO 진행 현황 [Turn 1/1 완료 | 진행률: 0/0 (0%)]";
    }

    return {
      debateId,
      sessionId: options.sessionId,
      taskId: options.taskId ?? null,
      topic: options.topic,
      status: "done",
      verdict: insightVerdict.verdict,
      hardConstraints: insightVerdict.hard_constraints,
      decisions: insightVerdict.decisions,
      risks: insightVerdict.risks,
      diversityDegraded,
      updatedAcceptance,
      progressBoard,
      round1Bundle,
      round2Bundle,
      insightVerdict,
    };
  } finally {
    if (ownsDb) {
      try {
        db.close();
      } catch {
        // Already closed
      }
    }
  }
}
