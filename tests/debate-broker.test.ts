/**
 * ASD v2.2 Debate Broker Unit & Integration Tests (tests/debate-broker.test.ts).
 *
 * Verifies:
 * 1. Structured verdict parser (parseReviewerOpening) with code blocks, direct JSON, embedded JSON.
 * 2. Unanimous APPROVE/MINOR_AMEND early exit after Round 1 (no Round 2 spawn).
 * 3. REJECT triggering Round 2 arbiter synthesis and automatic injection into tasks.acceptance and PLAN.md.
 * 4. Graceful recovery when one parallel reviewer crashes/times out as long as at least 1 survives.
 * 5. Failure when all reviewers crash/fail in Round 1.
 * 6. Cross-model diverse reviewer selection and diversity degradation tag handling.
 * 7. Debate execution without taskId.
 */

import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  runDebateBroker,
  parseReviewerOpening,
  formatDebateAcceptance,
  deduplicateStrings,
  buildDefaultHarnessCommand,
  buildDebateCodeContext,
} from "../src/core/debate.ts";
import { openProjectDb, SqliteDriver } from "../src/core/db.ts";
import type { CommandRunner, CommandRunnerRunOptions } from "../src/core/spawner.ts";
import type { SubagentSessionMeta } from "../src/core/types.ts";

const tmpDirs: string[] = [];
const openDrivers: SqliteDriver[] = [];

function makeProjectRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asd-debate-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const drv of openDrivers) {
    try {
      drv.close();
    } catch {
      // Ignore already-closed
    }
  }
  openDrivers.length = 0;

  for (const dir of tmpDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  }
  tmpDirs.length = 0;
});

describe("debate-broker.ts", () => {
  describe("1. Structured Verdict JSON Parser", () => {
    test("parses pure JSON with snake_case and camelCase", () => {
      const json1 = JSON.stringify({
        verdict: "APPROVE",
        hard_constraints: ["Constraint 1", "Constraint 2"],
        decisions: ["Decision 1"],
        risks: ["Risk 1"],
        reasoning: "Looks solid",
      });
      const parsed1 = parseReviewerOpening(json1);
      assert.ok(parsed1);
      assert.equal(parsed1.verdict, "APPROVE");
      assert.deepEqual(parsed1.hard_constraints, ["Constraint 1", "Constraint 2"]);
      assert.deepEqual(parsed1.decisions, ["Decision 1"]);
      assert.deepEqual(parsed1.risks, ["Risk 1"]);
      assert.equal(parsed1.reasoning, "Looks solid");

      // camelCase keys
      const json2 = JSON.stringify({
        verdict: "MINOR_AMEND",
        hardConstraints: ["Constraint A"],
        decisions: ["Decision A"],
        risks: ["Risk A"],
        reason: "Needs small fix",
      });
      const parsed2 = parseReviewerOpening(json2);
      assert.ok(parsed2);
      assert.equal(parsed2.verdict, "MINOR_AMEND");
      assert.deepEqual(parsed2.hard_constraints, ["Constraint A"]);
      assert.equal(parsed2.reasoning, "Needs small fix");
    });

    test("extracts JSON enclosed within markdown ```json code blocks", () => {
      const text = `
Here is my review:
\`\`\`json
{
  "verdict": "REJECT",
  "hard_constraints": ["Must not alter global state"],
  "decisions": ["Rollback proposed architecture"],
  "risks": ["Race conditions in concurrent requests"],
  "reasoning": "Global mutable state causes unpredictable failures"
}
\`\`\`
Hope this helps!
`;
      const parsed = parseReviewerOpening(text);
      assert.ok(parsed);
      assert.equal(parsed.verdict, "REJECT");
      assert.deepEqual(parsed.hard_constraints, ["Must not alter global state"]);
      assert.deepEqual(parsed.decisions, ["Rollback proposed architecture"]);
      assert.deepEqual(parsed.risks, ["Race conditions in concurrent requests"]);
    });

    test("extracts JSON embedded in raw stdout surrounded by log noise", () => {
      const text = `
[INFO] Initializing subagent CLI...
[DEBUG] Model loaded: gpt-5-codex
{"verdict":"APPROVE","hard_constraints":[],"decisions":["Use Node 22 native TS"],"risks":[]}
[INFO] Finished execution with exit code 0
`;
      const parsed = parseReviewerOpening(text);
      assert.ok(parsed);
      assert.equal(parsed.verdict, "APPROVE");
      assert.deepEqual(parsed.decisions, ["Use Node 22 native TS"]);
    });

    test("returns null for invalid verdict or unparseable text", () => {
      assert.equal(parseReviewerOpening(""), null);
      assert.equal(parseReviewerOpening("Random non-json text without verdict"), null);
      assert.equal(parseReviewerOpening('{"verdict": "MAYBE"}'), null);
      assert.equal(parseReviewerOpening('{"some_key": 123}'), null);
    });
  });

  describe("2. Helper Utilities", () => {
    test("deduplicateStrings removes duplicates and trims whitespace", () => {
      const res = deduplicateStrings(["  a ", "b", "a", "c", "", "  b  "]);
      assert.deepEqual(res, ["a", "b", "c"]);
    });

    test("formatDebateAcceptance formats decisions and hard constraints cleanly", () => {
      const text = formatDebateAcceptance(
        "D1",
        ["Must use WAL mode", "Zero external deps"],
        ["Adopt SQLite SSOT"]
      );
      assert.ok(text.includes("[Debate D1] Decisions: Adopt SQLite SSOT"));
      assert.ok(text.includes("[Debate D1] Hard Constraints: Must use WAL mode; Zero external deps"));
    });

    test("buildDefaultHarnessCommand builds correct command and args per harness", () => {
      const cc = buildDefaultHarnessCommand("claude-code", "Review this", "claude-sonnet-4-6");
      assert.equal(cc.command, "claude");
      assert.deepEqual(cc.args, ["-p", "Review this", "--output-format", "json", "--model", "claude-sonnet-4-6"]);

      const oc = buildDefaultHarnessCommand("opencode", "Review this", "glm-5");
      assert.equal(oc.command, "opencode");
      assert.deepEqual(oc.args, ["run", "Review this", "--format", "json", "--model", "glm-5"]);

      const cx = buildDefaultHarnessCommand("codex", "Review this", "gpt-5-codex");
      assert.equal(cx.command, "codex");
      assert.deepEqual(cx.args, ["exec", "Review this", "--json", "-m", "gpt-5-codex"]);

      const ag = buildDefaultHarnessCommand("antigravity", "Review this", "gemini-3-pro");
      assert.equal(ag.command, "agy");
      assert.deepEqual(ag.args, ["-p", "Review this", "--output-format", "json", "--model", "gemini-3-pro"]);
    });
  });

  describe("3. Round 1 Early Exit (Unanimous APPROVE / MINOR_AMEND)", () => {
    test("unanimous APPROVE/MINOR_AMEND synthesizes InsightVerdict immediately without Round 2", async () => {
      const projectRoot = makeProjectRoot();
      const db = openProjectDb(projectRoot);
      openDrivers.push(db);

      const sessionId = "sess-early-exit";
      const taskId = "T1.1";

      db.createOrGetSession({
        sessionId,
        projectRoot,
        mainHarness: "claude-code",
      });

      db.upsertTasks(sessionId, [
        {
          taskId,
          turn: 1,
          title: "Implement Core Database",
          acceptance: "Base test suite must pass",
        },
      ]);

      const round1Calls: string[] = [];

      const mockRunner: CommandRunner = {
        async run(cmd, args, opts) {
          const metaPath = opts.env["ASD_SUBAGENT_META"] ?? "";
          const meta: SubagentSessionMeta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
          round1Calls.push(meta.subSessionId);

          opts.onSpawn?.(1001);

          if (meta.subSessionId.includes("r1-1")) {
            // Reviewer 1: APPROVE
            opts.onStdout(
              JSON.stringify({
                verdict: "APPROVE",
                hard_constraints: ["Keep zero external dependencies"],
                decisions: ["Use standard library fs and sqlite"],
                risks: ["Windows path separators"],
                reasoning: "Architecturally clean and minimal",
              })
            );
          } else {
            // Reviewer 2: MINOR_AMEND
            opts.onStdout(
              JSON.stringify({
                verdict: "MINOR_AMEND",
                hard_constraints: ["Enable WAL mode explicitly"],
                decisions: ["Set busy_timeout to 5000ms"],
                risks: ["Lock timeout on high concurrency"],
                reasoning: "Need WAL mode for safe multi-process reads",
              })
            );
          }
          return { exitCode: 0, pid: 1001 };
        },
      };

      const result = await runDebateBroker({
        projectRoot,
        sessionId,
        taskId,
        debateId: "D-EARLY",
        topic: "Use SQLite SSOT for session management",
        proposal: "Store sessions and tasks in local SQLite database with WAL mode.",
        commandRunner: mockRunner,
        db,
      });

      // 1. Assert early exit verdict is MINOR_AMEND (due to Reviewer 2)
      assert.equal(result.status, "done");
      assert.equal(result.verdict, "MINOR_AMEND");
      assert.equal(result.round2Bundle, null);
      assert.equal(round1Calls.length, 2);
      assert.ok(round1Calls.every((c) => !c.includes("r2")));

      // 2. Assert union of constraints and decisions
      assert.ok(result.hardConstraints.includes("Keep zero external dependencies"));
      assert.ok(result.hardConstraints.includes("Enable WAL mode explicitly"));
      assert.ok(result.decisions.includes("Use standard library fs and sqlite"));
      assert.ok(result.decisions.includes("Set busy_timeout to 5000ms"));

      // 3. Assert DB record
      const debateRow = db.getDebate("D-EARLY")!;
      assert.ok(debateRow);
      assert.equal(debateRow.status, "done");
      assert.ok(debateRow.round1_bundle_json);
      assert.equal(debateRow.round2_bundle_json, null);
      const parsedInsight = JSON.parse(debateRow.insight_verdict_json!);
      assert.equal(parsedInsight.verdict, "MINOR_AMEND");

      // 4. Assert automatic acceptance injection into tasks table
      const taskRow = db.getTask(sessionId, taskId)!;
      assert.ok(taskRow.acceptance);
      assert.ok(taskRow.acceptance.includes("Base test suite must pass"));
      assert.ok(taskRow.acceptance.includes("[Debate D-EARLY]"));
      assert.ok(taskRow.acceptance.includes("Enable WAL mode explicitly"));
      assert.ok(taskRow.acceptance.includes("Set busy_timeout to 5000ms"));

      // 5. Assert .asd/PLAN.md was created/updated
      const planMdPath = path.join(projectRoot, ".asd", "PLAN.md");
      assert.ok(fs.existsSync(planMdPath));
      const planContent = fs.readFileSync(planMdPath, "utf8");
      assert.ok(planContent.includes("T1.1"));
      assert.ok(planContent.includes("Enable WAL mode explicitly"));
    });
  });

  describe("4. Round 2 Conflict Resolution (REJECT -> Arbiter Pass)", () => {
    test("REJECT triggers Round 2 arbiter synthesis and automatic injection into tasks.acceptance", async () => {
      const projectRoot = makeProjectRoot();
      const db = openProjectDb(projectRoot);
      openDrivers.push(db);

      const sessionId = "sess-round2-test";
      const taskId = "T2.1";

      db.createOrGetSession({
        sessionId,
        projectRoot,
        mainHarness: "claude-code",
      });

      db.upsertTasks(sessionId, [
        {
          taskId,
          turn: 1,
          title: "Multi-Harness Dispatcher",
          acceptance: "Original acceptance criteria",
        },
      ]);

      const subSessionCalls: string[] = [];

      const mockRunner: CommandRunner = {
        async run(cmd, args, opts) {
          const metaPath = opts.env["ASD_SUBAGENT_META"] ?? "";
          const meta: SubagentSessionMeta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
          subSessionCalls.push(meta.subSessionId);

          opts.onSpawn?.(2002);

          if (meta.subSessionId.includes("r1-1")) {
            // Reviewer 1: REJECT
            opts.onStdout(
              JSON.stringify({
                verdict: "REJECT",
                hard_constraints: ["Must not spawn subagents without worktree isolation"],
                decisions: ["Reject in-place modifications for HEAVY tasks"],
                risks: ["Git index corruption during concurrent writes"],
                reasoning: "Concurrent writes on dirty working tree will cause severe merge conflicts",
              })
            );
          } else if (meta.subSessionId.includes("r1-2")) {
            // Reviewer 2: APPROVE
            opts.onStdout(
              JSON.stringify({
                verdict: "APPROVE",
                hard_constraints: [],
                decisions: ["Fast parallel execution is primary"],
                risks: [],
                reasoning: "In-place modifications are fastest",
              })
            );
          } else if (meta.subSessionId.includes("r2-arbiter")) {
            // Round 2 Arbiter: Resolves conflict -> MINOR_AMEND with Worktrees
            opts.onStdout(
              JSON.stringify({
                verdict: "MINOR_AMEND",
                hard_constraints: [
                  "HEAVY tasks must use isolated git worktrees",
                  "LIGHT tasks can use in-place commits",
                ],
                decisions: [
                  "Adopt dual-track execution (LIGHT vs HEAVY)",
                  "HEAVY tasks write to .asd/wt/<turn>-<taskId>/",
                ],
                risks: ["Worktree creation latency"],
                reasoning:
                  "Dual track balances speed for light changes with absolute isolation for heavy changes.",
              })
            );
          }
          return { exitCode: 0, pid: 2002 };
        },
      };

      const result = await runDebateBroker({
        projectRoot,
        sessionId,
        taskId,
        debateId: "D-CONFLICT",
        topic: "Concurrent execution safety mechanism",
        proposal: "Run subagents concurrently directly in the workspace directory without worktrees.",
        commandRunner: mockRunner,
        db,
      });

      // 1. Assert Round 2 was triggered and Arbiter verdict synthesized
      assert.equal(result.status, "done");
      assert.equal(result.verdict, "MINOR_AMEND");
      assert.ok(result.round2Bundle);
      assert.equal(result.round2Bundle.arbiterVerdict.verdict, "MINOR_AMEND");

      // Verify execution sequence: 2 Round 1 subagents + 1 Round 2 arbiter subagent
      assert.equal(subSessionCalls.length, 3);
      assert.ok(subSessionCalls.some((c) => c.includes("r1-1")));
      assert.ok(subSessionCalls.some((c) => c.includes("r1-2")));
      assert.ok(subSessionCalls.some((c) => c.includes("r2-arbiter")));

      // 2. Assert hard constraints and decisions contain Arbiter resolution
      assert.ok(result.hardConstraints.includes("HEAVY tasks must use isolated git worktrees"));
      assert.ok(result.decisions.includes("Adopt dual-track execution (LIGHT vs HEAVY)"));

      // 3. Assert DB record has both bundles populated
      const debateRow = db.getDebate("D-CONFLICT")!;
      assert.ok(debateRow);
      assert.equal(debateRow.status, "done");
      assert.ok(debateRow.round1_bundle_json);
      assert.ok(debateRow.round2_bundle_json);
      const parsedR2 = JSON.parse(debateRow.round2_bundle_json);
      assert.equal(parsedR2.arbiterVerdict.role, "arbiter");

      // 4. Assert automatic acceptance injection into tasks.acceptance
      const taskRow = db.getTask(sessionId, taskId)!;
      assert.ok(taskRow.acceptance);
      assert.ok(taskRow.acceptance.includes("Original acceptance criteria"));
      assert.ok(taskRow.acceptance.includes("[Debate D-CONFLICT]"));
      assert.ok(taskRow.acceptance.includes("HEAVY tasks must use isolated git worktrees"));
      assert.ok(taskRow.acceptance.includes("Adopt dual-track execution (LIGHT vs HEAVY)"));

      // 5. Assert .asd/PLAN.md contains the updated acceptance
      const planMdPath = path.join(projectRoot, ".asd", "PLAN.md");
      assert.ok(fs.existsSync(planMdPath));
      const planContent = fs.readFileSync(planMdPath, "utf8");
      assert.ok(planContent.includes("dual-track execution"));
    });
  });

  describe("5. Fault Tolerance & Graceful Recovery", () => {
    test("recovers gracefully when 1 reviewer crashes with exit code 1", async () => {
      const projectRoot = makeProjectRoot();
      const db = openProjectDb(projectRoot);
      openDrivers.push(db);

      const sessionId = "sess-crash-recovery";
      const taskId = "T3.1";

      db.createOrGetSession({
        sessionId,
        projectRoot,
        mainHarness: "claude-code",
      });

      db.upsertTasks(sessionId, [
        {
          taskId,
          turn: 1,
          title: "Fault Tolerant Task",
          acceptance: "Original",
        },
      ]);

      const mockRunner: CommandRunner = {
        async run(cmd, args, opts) {
          const metaPath = opts.env["ASD_SUBAGENT_META"] ?? "";
          const meta: SubagentSessionMeta = JSON.parse(fs.readFileSync(metaPath, "utf8"));

          opts.onSpawn?.(3003);

          if (meta.subSessionId.includes("r1-1")) {
            // Reviewer 1 crashes
            opts.onStderr("Fatal error: connection reset by peer");
            return { exitCode: 1, pid: 3003 };
          } else {
            // Reviewer 2 succeeds: APPROVE
            opts.onStdout(
              JSON.stringify({
                verdict: "APPROVE",
                hard_constraints: ["Graceful fallback mandatory"],
                decisions: ["Use surviving opening"],
                risks: [],
                reasoning: "One reviewer crashed, but surviving opening is sound",
              })
            );
            return { exitCode: 0, pid: 3003 };
          }
        },
      };

      const result = await runDebateBroker({
        projectRoot,
        sessionId,
        taskId,
        debateId: "D-CRASH",
        topic: "Graceful recovery test",
        proposal: "Survive single reviewer crash.",
        commandRunner: mockRunner,
        db,
      });

      // 1. Should complete without throwing
      assert.equal(result.status, "done");
      assert.equal(result.verdict, "APPROVE");

      // 2. Assert bundles record surviving opening and failure
      assert.equal(result.round1Bundle.openings.length, 1);
      assert.equal(result.round1Bundle.failedReviewers.length, 1);
      assert.ok(result.round1Bundle.failedReviewers[0]!.error.includes("code 1"));

      // 3. Assert surviving opening decisions and constraints were injected
      assert.ok(result.hardConstraints.includes("Graceful fallback mandatory"));
      assert.ok(result.decisions.includes("Use surviving opening"));

      const taskRow = db.getTask(sessionId, taskId)!;
      assert.ok(taskRow.acceptance!.includes("Graceful fallback mandatory"));
    });

    test("throws Error when ALL reviewers in Round 1 fail or crash", async () => {
      const projectRoot = makeProjectRoot();
      const db = openProjectDb(projectRoot);
      openDrivers.push(db);

      const sessionId = "sess-all-fail";

      const mockRunner: CommandRunner = {
        async run(cmd, args, opts) {
          opts.onSpawn?.(4004);
          opts.onStderr("Fatal process crash");
          return { exitCode: 1, pid: 4004 };
        },
      };

      await assert.rejects(
        async () => {
          await runDebateBroker({
            projectRoot,
            sessionId,
            topic: "All fail topic",
            proposal: "This should fail because no reviewers survive",
            commandRunner: mockRunner,
            db,
          });
        },
        /All debate reviewers failed or timed out in Round 1/
      );
    });
  });

  describe("6. Cross-Model Diversity Selection & Fallbacks", () => {
    test("selects diverse reviewers with different model families and harnesses", async () => {
      const projectRoot = makeProjectRoot();
      const db = openProjectDb(projectRoot);
      openDrivers.push(db);

      const capturedReviewers: Array<{ harness: string; model: string }> = [];

      const mockRunner: CommandRunner = {
        async run(cmd, args, opts) {
          const metaPath = opts.env["ASD_SUBAGENT_META"] ?? "";
          const meta: SubagentSessionMeta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
          capturedReviewers.push({ harness: meta.harness, model: meta.model });

          opts.onSpawn?.(5005);
          opts.onStdout(
            JSON.stringify({
              verdict: "APPROVE",
              hard_constraints: [],
              decisions: [],
              risks: [],
            })
          );
          return { exitCode: 0, pid: 5005 };
        },
      };

      const result = await runDebateBroker({
        projectRoot,
        sessionId: "sess-diversity",
        topic: "Cross model diversity",
        proposal: "Evaluate reviewer selection",
        proposerRoute: {
          harness: "claude-code",
          model: "claude-opus-4-6",
          modelFamily: "claude",
        },
        commandRunner: mockRunner,
        db,
      });

      assert.equal(result.status, "done");
      assert.equal(capturedReviewers.length, 2);

      // Proposer was claude-code / claude. Reviewer 1 (critic) should be codex/gpt, Reviewer 2 (analyst) should be opencode/glm
      const harnesses = capturedReviewers.map((r) => r.harness);
      assert.ok(harnesses.includes("codex") || harnesses.includes("opencode"));
      assert.equal(result.diversityDegraded, false);
    });

    test("flags diversityDegraded: true when single model family is available", async () => {
      const projectRoot = makeProjectRoot();
      const db = openProjectDb(projectRoot);
      openDrivers.push(db);

      const mockRunner: CommandRunner = {
        async run(cmd, args, opts) {
          opts.onSpawn?.(6006);
          opts.onStdout(
            JSON.stringify({
              verdict: "APPROVE",
              hard_constraints: [],
              decisions: [],
              risks: [],
            })
          );
          return { exitCode: 0, pid: 6006 };
        },
      };

      const result = await runDebateBroker({
        projectRoot,
        sessionId: "sess-single-family",
        topic: "Degraded diversity test",
        proposal: "Single family restricted environment",
        runtimeCapabilities: {
          availableModelFamilies: ["claude"],
        },
        commandRunner: mockRunner,
        db,
      });

      assert.equal(result.status, "done");
      assert.equal(result.diversityDegraded, true);
    });
  });

  describe("7. Debate without taskId", () => {
    test("completes successfully and persists debate record without modifying tasks table", async () => {
      const projectRoot = makeProjectRoot();
      const db = openProjectDb(projectRoot);
      openDrivers.push(db);

      const mockRunner: CommandRunner = {
        async run(cmd, args, opts) {
          opts.onSpawn?.(7007);
          opts.onStdout(
            JSON.stringify({
              verdict: "APPROVE",
              hard_constraints: ["Constraint X"],
              decisions: ["Decision Y"],
              risks: [],
            })
          );
          return { exitCode: 0, pid: 7007 };
        },
      };

      const result = await runDebateBroker({
        projectRoot,
        sessionId: "sess-no-task",
        topic: "General architecture question",
        proposal: "Should we use event-driven microservices?",
        commandRunner: mockRunner,
        db,
      });

      assert.equal(result.status, "done");
      assert.equal(result.verdict, "APPROVE");
      assert.equal(result.taskId, null);
      assert.equal(result.updatedAcceptance, undefined);

      const debateRow = db.getDebate(result.debateId);
      assert.ok(debateRow);
      assert.equal(debateRow.status, "done");
      assert.equal(debateRow.task_id, null);
    });

    test("retries without --model flag when preset model is unconfigured in CLI harness", async () => {
      const projectRoot = makeProjectRoot();
      const db = openProjectDb(projectRoot);
      openDrivers.push(db);

      const seenArgs: string[][] = [];
      const mockRunner: CommandRunner = {
        async run(cmd, args, opts) {
          seenArgs.push(args);
          opts.onSpawn?.(8008);
          if (args.includes("--model") || args.includes("-m")) {
            opts.onStderr("Error: model glm-5 not found in provider config\n");
            return { exitCode: 1, pid: 8008 };
          }
          opts.onStdout(
            JSON.stringify({
              verdict: "APPROVE",
              hard_constraints: ["Fallback to default CLI model succeeded"],
              decisions: ["Use default model when preset model is missing"],
              risks: [],
              reasoning: "Default model worked cleanly",
            })
          );
          return { exitCode: 0, pid: 8008 };
        },
      };

      const result = await runDebateBroker({
        projectRoot,
        sessionId: "sess-model-fallback",
        topic: "Unconfigured preset model fallback",
        proposal: "Retry without --model if exitCode !== 0",
        reviewerRoutes: [
          { harness: "opencode", model: "glm-5", role: "analyst" },
        ],
        commandRunner: mockRunner,
        db,
      });

      assert.equal(result.status, "done");
      assert.equal(result.verdict, "APPROVE");
      assert.equal(seenArgs.length, 2);
      assert.ok(seenArgs[0]!.includes("--model"));
      assert.ok(!seenArgs[1]!.includes("--model"));
      assert.equal(result.round1Bundle.openings[0]?.model, "default");
      assert.ok(
        result.hardConstraints.includes("Fallback to default CLI model succeeded")
      );
    });

    test("unwraps OpenCode NDJSON event stream containing escaped JSON markdown fence", () => {
      const ndjson = [
        JSON.stringify({ type: "step_start", timestamp: 1000, part: { type: "step-start" } }),
        JSON.stringify({
          type: "text",
          timestamp: 2000,
          part: {
            type: "text",
            text: '```json\n{\n  "verdict": "MINOR_AMEND",\n  "hard_constraints": ["Preserve NDJSON compatibility"],\n  "decisions": ["Unwrap part.text before parsing"],\n  "risks": ["Escaped quotes in outer JSON"],\n  "reasoning": "OpenCode --format json wraps assistant markdown inside NDJSON text events"\n}\n```',
          },
        }),
        JSON.stringify({ type: "step_finish", timestamp: 3000, part: { type: "step-finish" } }),
      ].join("\r\n");

      const parsed = parseReviewerOpening(ndjson);
      assert.ok(parsed);
      assert.equal(parsed.verdict, "MINOR_AMEND");
      assert.deepEqual(parsed.hard_constraints, ["Preserve NDJSON compatibility"]);
      assert.deepEqual(parsed.decisions, ["Unwrap part.text before parsing"]);
    });

    test("embeds ground-truth source slices (--files) and adversarial evidence instructions into Round 1 prompt", async () => {
      const projectRoot = makeProjectRoot();
      const db = openProjectDb(projectRoot);
      openDrivers.push(db);

      const sampleFile = path.join(projectRoot, "src", "sample.ts");
      fs.mkdirSync(path.dirname(sampleFile), { recursive: true });
      fs.writeFileSync(
        sampleFile,
        [
          "export function computeTotal(items: number[]): number {",
          "  let sum = 0;",
          "  for (const x of items) sum += x;",
          "  return sum;",
          "}",
        ].join("\n"),
        "utf8"
      );

      const ctx = buildDebateCodeContext(projectRoot, ["src/sample.ts:1-4"]);
      assert.ok(ctx.includes("### File: src/sample.ts (Lines 1-4 of 5)"));
      assert.ok(ctx.includes("1: export function computeTotal(items: number[]): number {"));
      assert.ok(ctx.includes("4:   return sum;"));
      assert.ok(!ctx.includes("5: }"));

      let capturedPrompt = "";
      const mockRunner: CommandRunner = {
        async run(cmd, args, opts) {
          capturedPrompt = args.join(" ");
          opts.onSpawn?.(9009);
          opts.onStdout(
            JSON.stringify({
              verdict: "MINOR_AMEND",
              hard_constraints: ["src/sample.ts:3 must guard against NaN"],
              decisions: ["Add Number.isFinite check at src/sample.ts:3"],
              risks: ["NaN propagation in src/sample.ts:3"],
              reasoning: "Verified against src/sample.ts:1-4",
            })
          );
          return { exitCode: 0, pid: 9009 };
        },
      };

      const result = await runDebateBroker({
        projectRoot,
        sessionId: "sess-code-context",
        topic: "Audit computeTotal implementation",
        proposal: "computeTotal has an off-by-one bug",
        files: ["src/sample.ts:1-4"],
        reviewerRoutes: [
          { harness: "opencode", model: "glm-5", role: "critic" },
        ],
        commandRunner: mockRunner,
        db,
      });

      assert.equal(result.verdict, "MINOR_AMEND");
      assert.ok(capturedPrompt.includes("## Ground-Truth Source Code"));
      assert.ok(capturedPrompt.includes("1: export function computeTotal"));
      assert.ok(capturedPrompt.includes("UNVERIFIED hypothesis"));
      assert.ok(capturedPrompt.includes("file:line"));
    });
  });
});
