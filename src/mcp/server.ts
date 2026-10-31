/**
 * ASD v2.2 MCP Core Server (src/mcp/server.ts).
 *
 * Implements:
 * 1. StdioRpcServer-based JSON-RPC transport handling MCP protocol:
 *    - initialize, notifications/initialized, ping
 *    - tools/list (all 4 core tools with complete JSON schemas)
 *    - tools/call & direct method calls (asd_plan, asd_dispatch, asd_verify, asd_debate)
 * 2. Subagent Isolation Guard:
 *    - Check process.env.ASD_SESSION_ROLE === "subagent" (or options.sessionRole).
 *    - When "subagent":
 *      - NEVER run autoSync on startup.
 *      - Immediately reject calls to asd_plan, asd_dispatch, and asd_debate with
 *        error "Subagents cannot invoke orchestration tools", allowing ONLY asd_verify.
 *    - When "main" (or undefined):
 *      - Trigger autoSyncIfNeeded (or injected onMainServerStart).
 * 3. 4 Core MCP Tools:
 *    - asd_plan: create, get, update, sync_from_md; writes .asd/sessions/<sessionId>/main.json,
 *      updates SQLite sessions/tasks, renders .asd/PLAN.md, returns progressBoard.
 *    - asd_dispatch: parallel_spawn and claim_only modes; verifies upstream depends_on tasks are done,
 *      injects upstream DoneClaim.key_decisions & changed_files into context, creates worktree for HEAVY,
 *      Promise.all concurrent spawn with CommandRunner, verification, escalation (up to 3 attempts),
 *      and returns dispatchedTasks, results, and progressBoard.
 *    - asd_verify: LIGHT & HEAVY verification, resets no_progress_count, marks phase = "done" &
 *      generates .asd/summary.md when all tasks complete, returns progressBoard.
 *    - asd_debate: delegates to core debate broker, returns verdict & progressBoard.
 * 4. Every tool response includes progressBoard containing "### 📊 ASD TODO 진행 현황".
 *
 * Invariants:
 * - Erasable TypeScript only: NO enum, type-only imports where applicable.
 * - Zero external runtime npm dependencies.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { autoSyncIfNeeded } from "../adapters/installer.ts";
import { loadRoutingConfig, resolveAsdPaths } from "../core/config.ts";
import { openProjectDb, type SessionRow, type SqliteDriver, type TaskRow } from "../core/db.ts";
import { linkHarnessSessionToAsdSession } from "../core/session-tracker.ts";
import { buildDefaultHarnessCommand, runDebateBroker } from "../core/debate.ts";
import { checkProtectedPath, isPathAllowed } from "../core/policy.ts";
import {
  atomicWriteFileSync,
  renderPlanMd,
  renderProgressBoard,
  renderSessionSummaryMd,
  syncPlanFromMd,
} from "../core/render.ts";
import {
  detectAvailableCliHarnesses,
  escalateTaskRoute,
  isFallbackTriggerOutput,
  normalizeAntigravityModel,
  resolveRoute,
  runWithFallbacks,
  type ResolvedRoute,
} from "../core/router.ts";
import {
  DEFAULT_DISPATCH_TIMEOUT_MS,
  DEFAULT_IDLE_TIMEOUT_MS,
  spawnSubagent,
  type CommandRunner,
} from "../core/spawner.ts";
import {
  ASD_VERSION,
} from "../core/types.ts";
import type {
  AgentRole,
  AsdDebateInput,
  AsdDebateOutput,
  AsdDispatchInput,
  AsdDispatchOutput,
  AsdPlanInput,
  AsdPlanOutput,
  AsdVerifyInput,
  AsdVerifyOutput,
  AutoCreatedCrossScopeTask,
  CrossScopeRequest,
  DeferredCrossScopeRequest,
  DifficultyTier,
  DoneClaim,
  HarnessId,
  MainSessionMeta,
  SessionPhase,
  TaskStatus,
  TaskTrack,
} from "../core/types.ts";
import {
  createTaskWorktree,
  getChangedFiles,
  prepareBaseline,
  type TaskWorktreeInfo,
  verifyAndCommitLightTask,
  verifyAndMergeHeavyTask,
} from "../core/workspace.ts";
import { StdioRpcServer } from "./stdio-rpc.ts";

// ============================================================================
// Tool Schemas for tools/list
// ============================================================================

export const ASD_MCP_TOOLS = [
  {
    name: "asd_plan",
    description:
      "Manage ASD execution plan: create, get, update tasks, or sync manual edits from .asd/PLAN.md back to SQLite.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["create", "get", "update", "sync_from_md"],
          description: "Action to perform: 'create', 'get', 'update', or 'sync_from_md'.",
        },
        sessionId: {
          type: "string",
          description: "Target session ID. Defaults to active or newly generated session.",
        },
        mainHarness: {
          type: "string",
          enum: ["claude-code", "opencode", "codex", "antigravity", "cursor"],
          description: "Main session orchestrator harness.",
        },
        tasks: {
          type: "array",
          description: "Task definitions to add or update.",
          items: {
            type: "object",
            properties: {
              taskId: { type: "string", description: "Task ID e.g. 'T1.1'" },
              turn: { type: "integer", description: "Execution wave/turn number (1-based)" },
              title: { type: "string", description: "Task title" },
              track: { type: "string", enum: ["LIGHT", "HEAVY"] },
              role: { type: "string", description: "Agent role" },
              category: { type: "string", description: "Domain category" },
              difficulty: {
                type: "string",
                enum: ["low", "medium", "high"],
              },
              dependsOn: {
                type: "array",
                items: { type: "string" },
                description: "List of upstream task IDs that must complete first",
              },
              targetFiles: {
                type: "array",
                items: { type: "string" },
                description: "List of allowed target files/paths",
              },
              contextHint: { type: "string" },
              acceptance: { type: "string" },
              verifyCmd: { type: "string" },
            },
            required: ["taskId", "turn", "title", "targetFiles"],
          },
        },
      },
      required: ["action"],
    },
  },
  {
    name: "asd_dispatch",
    description:
      "Dispatch wave tasks concurrently in parallel_spawn mode or claim tasks in claim_only mode.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Session ID" },
        turn: {
          type: "integer",
          description: "Turn number to dispatch. If omitted, lowest pending turn is selected.",
        },
        taskIds: {
          type: "array",
          items: { type: "string" },
          description: "Optional list of specific task IDs to dispatch.",
        },
        mode: {
          type: "string",
          enum: ["parallel_spawn", "claim_only"],
          description: "Execution mode: 'parallel_spawn' (default) or 'claim_only'.",
        },
        harness: {
          type: "string",
          enum: ["claude-code", "opencode", "codex", "antigravity", "cursor"],
          description: "Optional harness override for task dispatch.",
        },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "asd_verify",
    description:
      "Fast-track verification, boundary enforcement, and checkpoint commit or worktree merge for a task.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Session ID" },
        taskId: { type: "string", description: "Task ID e.g. 'T1.1'" },
        doneClaim: {
          type: "object",
          properties: {
            summary: { type: "string" },
            changed_files: { type: "array", items: { type: "string" } },
            key_decisions: { type: "array", items: { type: "string" } },
            risks: { type: "array", items: { type: "string" } },
            cross_scope_requests: {
              type: "array",
              description:
                "Optional requests to modify files outside this task's allowedFiles (up to 2 auto-scheduled into next Turn; excess deferred to Main Agent).",
              items: {
                type: "object",
                properties: {
                  target_file: { type: "string" },
                  caller_files: { type: "array", items: { type: "string" } },
                  reason: { type: "string" },
                  suggested_change: { type: "string" },
                },
                required: ["target_file", "reason", "suggested_change"],
              },
            },
          },
          required: ["summary", "changed_files", "key_decisions", "risks"],
        },
        verifyCmd: {
          type: "string",
          description: "Optional explicit verification command override.",
        },
      },
      required: ["sessionId", "taskId", "doneClaim"],
    },
  },
  {
    name: "asd_debate",
    description: "Conduct blind cross-model debate across heterogeneous models.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Session ID" },
        taskId: { type: "string", description: "Optional associated task ID" },
        topic: { type: "string", description: "Debate topic" },
        proposal: { type: "string", description: "Proposal under critique" },
        files: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional file paths or file:start-end line slices to embed as ground-truth source code.",
        },
        includeDiff: {
          type: "boolean",
          description: "Optional flag to embed git diff HEAD into the debate prompt.",
        },
        harness: {
          type: "string",
          enum: ["claude-code", "opencode", "codex", "antigravity", "cursor"],
          description: "Optional proposer harness hint.",
        },
      },
      required: ["sessionId", "topic", "proposal"],
    },
  },
];

// ============================================================================
// Server Configuration
// ============================================================================

export interface AsdMcpServerOptions {
  projectRoot?: string;
  homeDir?: string;
  commandRunner?: CommandRunner;
  sessionRole?: string;
  autoSync?: boolean;
  onMainServerStart?: () => Promise<void> | void;
  db?: SqliteDriver;
}

// ============================================================================
// Helper Functions
// ============================================================================

function buildPromptForTask(
  task: TaskRow,
  upstreamDecisions: string[],
  upstreamFiles: string[]
): string {
  let targetFiles: string[] = [];
  try {
    targetFiles = JSON.parse(task.target_files_json || "[]");
  } catch {
    targetFiles = [];
  }

  const lines: string[] = [
    `# ASD Subagent Task: ${task.task_id}`,
    `Title: ${task.title}`,
    `Track: ${task.track}`,
    `Role: ${task.role}`,
    `Category: ${task.category}`,
    `Difficulty: ${task.difficulty}`,
    "",
    "## Allowed Target Files",
    targetFiles.length > 0 ? targetFiles.map((f) => `- ${f}`).join("\n") : "- None specified",
    "",
  ];

  if (task.context_hint) {
    lines.push("## Context Hint", task.context_hint, "");
  }

  if (task.acceptance) {
    lines.push("## Acceptance Criteria", task.acceptance, "");
  }

  if (upstreamDecisions.length > 0) {
    lines.push("## Upstream Key Decisions", upstreamDecisions.map((d) => `- ${d}`).join("\n"), "");
  }

  if (upstreamFiles.length > 0) {
    lines.push("## Upstream Changed Files", upstreamFiles.map((f) => `- ${f}`).join("\n"), "");
  }

  lines.push(
    "## Operational Guidelines",
    "1. Modify ONLY the files listed under Allowed Target Files (plus test files under tests/ or *.test.ts when needed to keep tests passing).",
    "2. Ensure implementation satisfies the acceptance criteria.",
    "3. Run automated tests and ensure zero errors.",
    "4. If you discover that a file OUTSIDE Allowed Target Files (e.g., owned by another harness/task) MUST be modified, DO NOT modify it directly (it will be blocked). Instead, complete your work within Allowed Target Files and emit an `asd-report` JSON block at the very end of your response:",
    "```asd-report",
    "{",
    '  "summary": "Brief summary of completed work",',
    '  "key_decisions": ["Key decision 1"],',
    '  "risks": ["Any remaining risk"],',
    '  "cross_scope_requests": [',
    "    {",
    '      "target_file": "path/to/other-harness-file.ts",',
    '      "caller_files": ["path/to/your-own-file-to-bundle.ts"],',
    '      "reason": "Why the external file needs modification",',
    '      "suggested_change": "Exact interface/function change needed"',
    "    }",
    "  ]",
    "}",
    "```",
    "(Up to 2 cross_scope_requests per task are automatically scheduled into the next Turn with your caller_files bundled; any additional requests beyond 2 are forwarded to the Main Director Agent for review.)"
  );

  return lines.join("\n");
}

export const MAX_AUTO_CROSS_SCOPE_PER_TASK = 2;
export const MAX_CROSS_SCOPE_CHAIN_DEPTH = 2;

export interface ParsedSubagentReport {
  summary?: string;
  key_decisions?: string[];
  risks?: string[];
  cross_scope_requests?: CrossScopeRequest[];
}

/**
 * Extracts structured `asd-report` (or trailing JSON report) emitted by a subagent
 * from its stdout/stderr log.
 */
export function parseSubagentReport(rawOutput: string): ParsedSubagentReport | null {
  if (!rawOutput || typeof rawOutput !== "string") return null;

  const candidates: string[] = [];
  const fencedRegex = /```(?:asd-report|json)\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = fencedRegex.exec(rawOutput)) !== null) {
    if (match[1]?.trim()) {
      candidates.push(match[1].trim());
    }
  }

  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(candidates[i]!) as Record<string, unknown>;
      if (
        parsed &&
        typeof parsed === "object" &&
        ("cross_scope_requests" in parsed ||
          "key_decisions" in parsed ||
          "risks" in parsed ||
          "summary" in parsed)
      ) {
        const rawReqs = Array.isArray(parsed.cross_scope_requests)
          ? parsed.cross_scope_requests
          : [];
        const validReqs: CrossScopeRequest[] = [];
        for (const item of rawReqs) {
          if (!item || typeof item !== "object") continue;
          const r = item as Record<string, unknown>;
          const targetFile = typeof r.target_file === "string" ? r.target_file.trim() : "";
          const reason = typeof r.reason === "string" ? r.reason.trim() : "";
          const suggestedChange =
            typeof r.suggested_change === "string" ? r.suggested_change.trim() : "";
          if (!targetFile || !reason) continue;
          const callerFiles = Array.isArray(r.caller_files)
            ? r.caller_files
                .filter((f): f is string => typeof f === "string" && f.trim().length > 0)
                .map((f) => f.trim())
            : undefined;
          validReqs.push({
            target_file: targetFile,
            ...(callerFiles && callerFiles.length > 0 ? { caller_files: callerFiles } : {}),
            reason,
            suggested_change: suggestedChange || reason,
          });
        }

        return {
          summary: typeof parsed.summary === "string" ? parsed.summary.trim() : undefined,
          key_decisions: Array.isArray(parsed.key_decisions)
            ? parsed.key_decisions.filter((d): d is string => typeof d === "string")
            : undefined,
          risks: Array.isArray(parsed.risks)
            ? parsed.risks.filter((d): d is string => typeof d === "string")
            : undefined,
          cross_scope_requests: validReqs.length > 0 ? validReqs : undefined,
        };
      }
    } catch {
      // ignore malformed JSON block
    }
  }

  return null;
}

function formatTaskForOutput(t: TaskRow) {
  let dependsOn: string[] = [];
  try {
    dependsOn = JSON.parse(t.depends_on_json || "[]");
  } catch {
    dependsOn = [];
  }

  let targetFiles: string[] = [];
  try {
    targetFiles = JSON.parse(t.target_files_json || "[]");
  } catch {
    targetFiles = [];
  }

  return {
    taskId: t.task_id,
    task_id: t.task_id,
    turn: t.turn,
    title: t.title,
    track: t.track as TaskTrack,
    role: t.role as AgentRole,
    category: t.category,
    difficulty: t.difficulty as DifficultyTier,
    status: t.status as TaskStatus,
    assignedHarness: (t.assigned_harness as HarnessId) ?? undefined,
    assignedModel: t.assigned_model ?? undefined,
    dependsOn,
    targetFiles,
    contextHint: t.context_hint ?? undefined,
    acceptance: t.acceptance ?? undefined,
    verifyCmd: t.verify_cmd ?? undefined,
  };
}

// ============================================================================
// AsdMcpServer Class
// ============================================================================

export class AsdMcpServer {
  private readonly projectRoot: string;
  private readonly homeDir?: string;
  private readonly commandRunner?: CommandRunner;
  private readonly sessionRole: string;
  private readonly db: SqliteDriver;
  private readonly ownsDb: boolean;
  private rpcServer?: StdioRpcServer;
  private started = false;

  constructor(options?: AsdMcpServerOptions) {
    this.projectRoot = path.resolve(options?.projectRoot || process.cwd());
    this.homeDir = options?.homeDir;
    this.commandRunner = options?.commandRunner;
    this.sessionRole = options?.sessionRole ?? process.env.ASD_SESSION_ROLE ?? "main";

    if (options?.db) {
      this.db = options.db;
      this.ownsDb = false;
    } else {
      this.db = openProjectDb(this.projectRoot, this.homeDir);
      this.ownsDb = true;
    }

    // Subagent Isolation Guard:
    // When "subagent": NEVER run autoSync on startup.
    // When "main": run injected onMainServerStart or explicit opt-in autoSync.
    if (this.sessionRole !== "subagent") {
      if (options?.onMainServerStart) {
        void Promise.resolve(options.onMainServerStart()).catch(() => {});
      } else if (options?.autoSync === true) {
        void autoSyncIfNeeded({ homeDir: this.homeDir, projectRoot: this.projectRoot }).catch(() => {});
      }
    }
  }

  /**
   * Start the JSON-RPC stdio transport.
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.rpcServer = new StdioRpcServer({
      handleRequest: (method, params, signal) => this.handleRequest(method, params, signal),
    });
    this.rpcServer.onCleanup(() => {
      this.close();
    });
    this.rpcServer.start();
  }

  /**
   * Stop the server and clean up resources.
   */
  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.rpcServer?.stop();
    this.close();
  }

  close(): void {
    if (this.ownsDb) {
      try {
        this.db.close();
      } catch {
        // already closed
      }
    }
  }

  /**
   * Check if running in isolated subagent mode.
   */
  private isSubagent(): boolean {
    return this.sessionRole === "subagent" || process.env.ASD_SESSION_ROLE === "subagent";
  }

  /**
   * Send a progress notification if stdio RPC is active.
   */
  private sendProgress(progressToken: string | number, progress: number, total: number, message?: string): void {
    this.rpcServer?.sendProgress(progressToken, progress, total, message);
  }

  /**
   * Main request dispatcher handling MCP methods & direct tool invocations.
   */
  async handleRequest(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    // 1. MCP Standard Methods
    if (method === "initialize") {
      return {
        protocolVersion: "2024-11-05",
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: "asd-core",
          version: ASD_VERSION,
        },
      };
    }

    if (method === "notifications/initialized" || method === "ping") {
      return {};
    }

    if (method === "tools/list") {
      return { tools: ASD_MCP_TOOLS };
    }

    if (method === "tools/call") {
      const callParams = (params as { name?: string; arguments?: unknown }) ?? {};
      const toolName = callParams.name;
      if (!toolName) {
        throw new Error("Missing tool name in tools/call request");
      }
      return this.dispatchTool(toolName, callParams.arguments, signal, true);
    }

    // 2. Direct tool invocation by name
    if (
      method === "asd_plan" ||
      method === "asd_dispatch" ||
      method === "asd_verify" ||
      method === "asd_debate"
    ) {
      return this.dispatchTool(method, params, signal, false);
    }

    throw new Error(`Method not found: ${method}`);
  }

  /**
   * Subagent Isolation Guard & Tool Dispatcher
   */
  private async dispatchTool(
    name: string,
    args: unknown,
    signal?: AbortSignal,
    wrapMcpContent = false
  ): Promise<unknown> {
    // Subagent Isolation Guard:
    // Reject calls to asd_plan, asd_dispatch, and asd_debate with exact message
    if (this.isSubagent()) {
      if (name === "asd_plan" || name === "asd_dispatch" || name === "asd_debate") {
        throw new Error("Subagents cannot invoke orchestration tools");
      }
    }

    let result: unknown;
    switch (name) {
      case "asd_plan":
        result = await this.handlePlan((args as AsdPlanInput) ?? { action: "get" });
        break;
      case "asd_dispatch":
        result = await this.handleDispatch((args as AsdDispatchInput) ?? { sessionId: "" }, signal);
        break;
      case "asd_verify":
        result = await this.handleVerify((args as AsdVerifyInput) ?? { sessionId: "", taskId: "", doneClaim: {} as DoneClaim });
        break;
      case "asd_debate":
        result = await this.handleDebate((args as AsdDebateInput) ?? { sessionId: "", topic: "", proposal: "" }, signal);
        break;
      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    if (wrapMcpContent) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
        ...(typeof result === "object" && result !== null ? (result as Record<string, unknown>) : {}),
      };
    }

    return result;
  }

  // ==========================================================================
  // Tool 1: asd_plan
  // ==========================================================================

  async handlePlan(input: AsdPlanInput): Promise<AsdPlanOutput> {
    const action = input.action;
    let sessionId = input.sessionId;

    if (!sessionId || sessionId.trim() === "") {
      // Implicit session selection: mutating actions must never touch a
      // completed session — start a fresh one instead (read-only 'get' may
      // still reuse the latest session for status display).
      const latest = this.db.getLatestSession();
      const mutating =
        action === "create" || action === "update" || action === "sync_from_md";
      if (latest && mutating && latest.phase === "done") {
        sessionId = `${Date.now()}-main`;
      } else {
        sessionId = latest?.session_id || `${Date.now()}-main`;
      }
    }

    // Ensure session exists
    let sessionRow = this.db.getSession(sessionId);
    if (!sessionRow) {
      sessionRow = this.db.createOrGetSession({
        sessionId,
        projectRoot: this.projectRoot,
        mainHarness: input.mainHarness || "claude-code",
        mainPid: process.pid,
        mainModel: input.mainModel ?? null,
        harnessSessionId: input.harnessSessionId ?? null,
        autoApprove: input.autoApprove,
      });
    }

    const paths = resolveAsdPaths(this.projectRoot, this.homeDir);

    if (action === "create" || action === "update") {
      if (input.tasks && input.tasks.length > 0) {
        this.db.upsertTasks(
          sessionId,
          input.tasks.map((rawTask, idx) => {
            const t = rawTask as typeof rawTask & {
              id?: string;
              agent?: AgentRole;
              allowedFiles?: string[];
              verificationCmd?: string;
            };
            const turn =
              typeof t.turn === "number" && Number.isFinite(t.turn) && t.turn >= 1
                ? t.turn
                : 1;
            let taskId = String(t.taskId || t.id || `T${turn}.${idx + 1}`).trim();
            const dashMatch = taskId.match(/^T-(\d+)$/i);
            if (dashMatch) {
              taskId = `T${turn}.${dashMatch[1]}`;
            } else if (!/^T(?:-)?\d+(?:\.\d+|-\d+)?$/i.test(taskId)) {
              taskId = `T${turn}.${idx + 1}`;
            }
            return {
              taskId,
              turn,
              title: t.title,
              track: t.track,
              role: (t.role || t.agent) as AgentRole | undefined,
              category: t.category,
              difficulty: t.difficulty,
              dependsOn: t.dependsOn,
              targetFiles: t.targetFiles || t.allowedFiles,
              contextHint: t.contextHint,
              acceptance: t.acceptance,
              verifyCmd: t.verifyCmd ?? t.verificationCmd,
            };
          })
        );
        const autoMemo = (
          (input as { title?: string }).title ||
          input.tasks[0]?.title ||
          ""
        )
          .trim()
          .slice(0, 40);
        if (autoMemo && !sessionRow.memo) {
          this.db.updateSessionMemo(sessionId, autoMemo);
          sessionRow = this.db.getSession(sessionId) ?? sessionRow;
        }
      }
    } else if (action === "sync_from_md") {
      syncPlanFromMd(this.db, sessionId, paths.planMdPath);
      sessionRow = this.db.getSession(sessionId) ?? sessionRow;
    }

    // Write <projectRoot>/.asd/sessions/<sessionId>/main.json
    const sessionDir = path.join(this.projectRoot, ".asd", "sessions", sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });
    const mainMeta: MainSessionMeta = {
      sessionId,
      roleType: "main",
      harness: (sessionRow.main_harness as HarnessId) || "claude-code",
      role: "director",
      phase: sessionRow.phase as SessionPhase,
      pid: sessionRow.main_pid ?? process.pid,
      startedAt: new Date(sessionRow.created_at).toISOString(),
      ...(sessionRow.main_model ? { model: sessionRow.main_model } : {}),
      ...(sessionRow.harness_session_id ? { harnessSessionId: sessionRow.harness_session_id } : {}),
      autoApprove: sessionRow.auto_approve !== 0,
      ...(sessionRow.memo ? { memo: sessionRow.memo } : {}),
    };
    atomicWriteFileSync(
      path.join(sessionDir, "main.json"),
      JSON.stringify(mainMeta, null, 2) + "\n"
    );

    // Retrieve fresh tasks & link any active CLI harnessSessionId to this ASD session
    linkHarnessSessionToAsdSession({
      projectRoot: this.projectRoot,
      homeDir: this.homeDir,
      asdSessionId: sessionId,
      harness: (input.mainHarness || sessionRow.main_harness) as HarnessId,
      harnessSessionId: input.harnessSessionId ?? sessionRow.harness_session_id ?? null,
      mainModel: input.mainModel ?? sessionRow.main_model ?? null,
      autoApprove: input.autoApprove,
      db: this.db,
    });
    sessionRow = this.db.getSession(sessionId) ?? sessionRow;
    const taskRows = this.db.getSessionTasks(sessionId);

    // Renders .asd/PLAN.md
    renderPlanMd(sessionRow, taskRows, paths.planMdPath);

    // Live progress board
    const progressBoard = renderProgressBoard(sessionRow, taskRows);

    return {
      sessionId,
      stateVersion: sessionRow.state_version,
      phase: sessionRow.phase as SessionPhase,
      tasks: taskRows.map(formatTaskForOutput),
      planMdPath: paths.planMdPath,
      progressBoard,
    };
  }

  // ==========================================================================
  // Tool 2: asd_dispatch
  // ==========================================================================

  async handleDispatch(
    input: AsdDispatchInput,
    signal?: AbortSignal
  ): Promise<AsdDispatchOutput & { dispatchedTasks: AsdDispatchOutput["results"] }> {
    const sessionId =
      input.sessionId?.trim() ||
      this.db.getLatestSession()?.session_id ||
      input.sessionId;
    let session = this.db.getSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    // Baseline prep: ensure git baseline exists
    prepareBaseline(this.projectRoot, { sessionId, db: this.db });

    const allTasks = this.db.getSessionTasks(sessionId);

    // Determine target turn
    let selectedTurn: number;
    if (input.turn !== undefined) {
      selectedTurn = input.turn;
    } else {
      const unfinished = allTasks.filter((t) => t.status !== "done");
      if (unfinished.length === 0) {
        const board = renderProgressBoard(session, allTasks);
        return {
          sessionId,
          turn: 0,
          dispatchedTasks: [],
          results: [],
          progressBoard: board,
        };
      }
      const turns = [...new Set(unfinished.map((t) => t.turn))].sort((a, b) => a - b);
      selectedTurn = turns[0] ?? 1;
    }

    // Filter tasks for this turn
    let turnTasks = allTasks.filter((t) => t.turn === selectedTurn);
    if (input.taskIds && input.taskIds.length > 0) {
      const allowed = new Set(input.taskIds);
      turnTasks = turnTasks.filter((t) => allowed.has(t.task_id));
    }

    // Default track behavior:
    // - LIGHT tasks default to 'claim_only' (handled in current harness: main AI directly or internal subagents)
    // - HEAVY tasks default to 'parallel_spawn' (multi-harness execution in isolated worktrees)
    const mode =
      input.mode ??
      (turnTasks.length > 0 && turnTasks.every((t) => t.track === "LIGHT")
        ? "claim_only"
        : "parallel_spawn");

    const taskMap = new Map(allTasks.map((t) => [t.task_id, t]));

    // 1. Check upstream dependencies and collect upstream key_decisions & changed_files
    const taskUpstreamContext = new Map<
      string,
      { valid: boolean; missingDeps: string[]; upstreamDecisions: string[]; upstreamFiles: string[] }
    >();

    for (const t of turnTasks) {
      let dependsOn: string[] = [];
      try {
        dependsOn = JSON.parse(t.depends_on_json || "[]");
      } catch {
        dependsOn = [];
      }

      const missingDeps: string[] = [];
      const upstreamDecisions: string[] = [];
      const upstreamFiles: string[] = [];

      for (const depId of dependsOn) {
        const depTask = taskMap.get(depId);
        if (!depTask || depTask.status !== "done") {
          missingDeps.push(depId);
        } else if (depTask.done_claim_json) {
          try {
            const claim = JSON.parse(depTask.done_claim_json) as DoneClaim;
            if (Array.isArray(claim.key_decisions)) {
              upstreamDecisions.push(...claim.key_decisions);
            }
            if (Array.isArray(claim.changed_files)) {
              upstreamFiles.push(...claim.changed_files);
            }
          } catch {
            // ignore
          }
        }
      }

      taskUpstreamContext.set(t.task_id, {
        valid: missingDeps.length === 0,
        missingDeps,
        upstreamDecisions,
        upstreamFiles,
      });
    }

    // 2. Mode: claim_only
    if (mode === "claim_only") {
      const results: AsdDispatchOutput["results"] = [];

      for (const t of turnTasks) {
        const upCtx = taskUpstreamContext.get(t.task_id)!;
        if (!upCtx.valid) {
          results.push({
            taskId: t.task_id,
            status: t.status as TaskStatus,
            harness: (t.assigned_harness as HarnessId) ?? "opencode",
            model: t.assigned_model ?? "glm-5",
            durationMs: 0,
            error: `Upstream dependencies not satisfied: ${upCtx.missingDeps.join(", ")}`,
          });
          continue;
        }

        const preferredHarness =
          input.harness ??
          (t.assigned_harness as HarnessId | null) ??
          (t.track === "LIGHT" ? (session.main_harness as HarnessId) : undefined);

        const route = resolveRoute({
          role: t.role as AgentRole,
          category: t.category,
          difficulty: t.difficulty as DifficultyTier,
          harness: preferredHarness,
          model: t.assigned_model ?? undefined,
          isSubagentSpawn: true,
          mainHarness: session.main_harness as HarnessId,
          mode: "claim_only",
        });

        const effectiveModel =
          route.harness === "antigravity"
            ? normalizeAntigravityModel(route.model)
            : route.model;

        let wtPath: string | undefined;
        if (t.track === "HEAVY") {
          const wt = createTaskWorktree(this.projectRoot, t.turn, t.task_id);
          wtPath = wt.wtPath;
        }

        const subSessionId = `sub-${t.turn}-${t.task_id}-${t.role}-${route.harness}`;
        let allowedFiles: string[] = [];
        try {
          allowedFiles = JSON.parse(t.target_files_json || "[]");
        } catch {
          allowedFiles = [];
        }
        if (allowedFiles.length > 0 && !allowedFiles.includes("tests/**")) {
          allowedFiles = [...allowedFiles, "tests/**", "**/*.test.ts", "**/*.spec.ts"];
        }
        const subDir = path.join(this.projectRoot, ".asd", "sessions", sessionId, "subagents", subSessionId);
        fs.mkdirSync(subDir, { recursive: true });
        const promptText = buildPromptForTask(t, upCtx.upstreamDecisions, upCtx.upstreamFiles);
        const startedAt = Date.now();
        atomicWriteFileSync(path.join(subDir, "prompt.md"), promptText);
        atomicWriteFileSync(
          path.join(subDir, "meta.json"),
          JSON.stringify({
            subSessionId,
            parentSessionId: sessionId,
            roleType: "subagent",
            role: t.role,
            harness: route.harness,
            model: effectiveModel,
            taskId: t.task_id,
            pid: process.pid,
            worktreePath: wtPath ?? null,
            allowedFiles,
            status: "running",
            startedAt,
          }, null, 2) + "\n"
        );
        if (!fs.existsSync(path.join(subDir, "output.log"))) {
          atomicWriteFileSync(
            path.join(subDir, "output.log"),
            `[claim_only] Task ${t.task_id} claimed by @${route.harness}/${effectiveModel} at ${new Date(startedAt).toISOString()}\n`
          );
        }

        this.db.updateTaskStatus(sessionId, t.task_id, "running", {
          assignedHarness: route.harness,
          assignedModel: effectiveModel,
          worktreePath: wtPath,
          subSessionId,
        });

        results.push({
          taskId: t.task_id,
          status: "running",
          harness: route.harness,
          model: effectiveModel,
          durationMs: 0,
        });
      }

      const freshTasks = this.db.getSessionTasks(sessionId);
      renderPlanMd(session, freshTasks);
      const progressBoard = renderProgressBoard(session, freshTasks);

      return {
        sessionId,
        turn: selectedTurn,
        dispatchedTasks: results,
        results,
        progressBoard,
      };
    }

    // 3. Mode: parallel_spawn
    let completedCount = 0;
    const totalCount = turnTasks.length;

    const spawnPromises = turnTasks.map(async (t) => {
      const upCtx = taskUpstreamContext.get(t.task_id)!;
      if (!upCtx.valid) {
        return {
          taskId: t.task_id,
          status: t.status as TaskStatus,
          harness: (t.assigned_harness as HarnessId) ?? "opencode",
          model: t.assigned_model ?? "glm-5",
          durationMs: 0,
          error: `Upstream dependencies not satisfied: ${upCtx.missingDeps.join(", ")}`,
        };
      }

      // If mode was not explicitly forced to parallel_spawn, LIGHT tasks in a mixed turn
      // are also claimed for the current harness rather than spawning external CLIs.
      if (!input.mode && t.track === "LIGHT") {
        const preferredHarness =
          input.harness ??
          (t.assigned_harness as HarnessId | null) ??
          (session.main_harness as HarnessId);
        const route = resolveRoute({
          role: t.role as AgentRole,
          category: t.category,
          difficulty: t.difficulty as DifficultyTier,
          harness: preferredHarness,
          model: t.assigned_model ?? undefined,
          isSubagentSpawn: true,
          mainHarness: session.main_harness as HarnessId,
          mode: "claim_only",
        });
        const effectiveModel =
          route.harness === "antigravity"
            ? normalizeAntigravityModel(route.model)
            : route.model;
        this.db.updateTaskStatus(sessionId, t.task_id, "running", {
          assignedHarness: route.harness,
          assignedModel: effectiveModel,
        });
        return {
          taskId: t.task_id,
          status: "running" as TaskStatus,
          harness: route.harness,
          model: effectiveModel,
          durationMs: 0,
        };
      }

      let currentAttempts = t.attempts;
      let finalResult: AsdDispatchOutput["results"][number] | null = null;

      // Up to 3 attempts with escalation
      const runtimeCaps = input.harness
        ? { availableHarnesses: [input.harness] }
        : !this.commandRunner
          ? { availableHarnesses: detectAvailableCliHarnesses() }
          : undefined;
      const routingCfg = loadRoutingConfig(this.projectRoot, this.homeDir);
      while (currentAttempts < 3) {
        const esc = escalateTaskRoute(
          {
            ...t,
            isSubagentSpawn: true,
            mainHarness: session.main_harness as HarnessId,
            mode: "parallel_spawn",
          } as TaskRow,
          currentAttempts,
          routingCfg,
          runtimeCaps
        );
        const route = esc.route;
        if (!route) {
          this.db.updateTaskStatus(sessionId, t.task_id, "failed");
          finalResult = {
            taskId: t.task_id,
            status: "failed",
            harness: (t.assigned_harness as HarnessId) ?? "opencode",
            model: t.assigned_model ?? "glm-5",
            durationMs: 0,
            error: "Maximum escalation attempts exhausted (failed)",
          };
          break;
        }

        this.db.updateTaskStatus(sessionId, t.task_id, "running", {
          assignedHarness: route.harness,
          assignedModel: route.model,
        });

        let wtInfo: TaskWorktreeInfo | null = null;
        if (t.track === "HEAVY") {
          wtInfo = createTaskWorktree(this.projectRoot, t.turn, t.task_id);
          this.db.updateTaskStatus(sessionId, t.task_id, "running", {
            worktreePath: wtInfo.wtPath,
          });
        }

        const subSessionId = `sub-${t.turn}-${t.task_id}-${t.role}-${route.harness}`;

        const prompt = buildPromptForTask(t, upCtx.upstreamDecisions, upCtx.upstreamFiles);

        let allowedFiles: string[] = [];
        try {
          allowedFiles = JSON.parse(t.target_files_json || "[]");
        } catch {
          allowedFiles = [];
        }

        if (allowedFiles.length > 0 && !allowedFiles.includes("tests/**")) {
          allowedFiles = [...allowedFiles, "tests/**", "**/*.test.ts", "**/*.spec.ts"];
        }
        const workDir = wtInfo ? wtInfo.wtPath : this.projectRoot;
        const readSpawnOutput = (metaPath: string): string => {
          try {
            const logFile = path.join(path.dirname(metaPath), "output.log");
            return fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "";
          } catch {
            return "";
          }
        };

        const needsFallbackRetry = (res: { exitCode: number | null; timedOut?: boolean; metaPath: string }): boolean => {
          if (res.exitCode !== 0 || res.timedOut) return true;
          const out = readSpawnOutput(res.metaPath);
          if (!isFallbackTriggerOutput(out)) return false;
          return getChangedFiles(workDir).length === 0;
        };

        const run = await runWithFallbacks({
          initialRoute: route,
          routingConfig: routingCfg,
          runtimeCapabilities: runtimeCaps,
          baseSubSessionId: subSessionId,
          allowDefaultModelRetry: !this.commandRunner,
          shouldRetry: needsFallbackRetry,
          attempt: (r, sid) => {
            this.db.updateTaskStatus(sessionId, t.task_id, "running", {
              assignedHarness: r.harness,
              assignedModel: r.model,
              subSessionId: sid,
            });
            const cmdInfo = buildDefaultHarnessCommand(
              r.harness,
              prompt,
              r.model,
              r.thinkingEffort ?? t.thinking_effort
            );
            return spawnSubagent({
              projectRoot: this.projectRoot,
              cwd: workDir,
              worktreePath: wtInfo ? wtInfo.wtPath : null,
              homeDir: this.homeDir,
              mainSessionId: sessionId,
              subSessionId: sid,
              role: t.role as AgentRole,
              harness: r.harness,
              model: r.model,
              taskId: t.task_id,
              prompt,
              allowedFiles,
              command: cmdInfo.command,
              args: cmdInfo.args,
              commandRunner: this.commandRunner,
              timeoutMs: DEFAULT_DISPATCH_TIMEOUT_MS,
              idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
              signal,
            });
          },
        });
        const spawnResult = run.result;
        const activeRoute: ResolvedRoute = {
          ...route,
          harness: run.harness,
          model: run.model,
          modelFamily: run.modelFamily,
        };

        // Verification
        const effectiveAutoApprove =
          input.autoApprove !== undefined
            ? input.autoApprove
            : session.auto_approve !== 0;
        let verifyResult: { verified: boolean; commitSha?: string; error?: string; status?: TaskStatus; changedFiles?: string[] };
        if (t.track === "LIGHT") {
          verifyResult = verifyAndCommitLightTask({
            projectRoot: this.projectRoot,
            taskId: t.task_id,
            title: t.title,
            allowedFiles,
            verifyCmd: t.verify_cmd,
            autoApprove: effectiveAutoApprove,
            sessionId,
            db: this.db,
          });
        } else {
          verifyResult = await verifyAndMergeHeavyTask({
            projectRoot: this.projectRoot,
            turn: t.turn,
            taskId: t.task_id,
            title: t.title,
            wtPath: wtInfo?.wtPath,
            branchName: wtInfo?.branchName,
            allowedFiles,
            verifyCmd: t.verify_cmd,
            autoApprove: effectiveAutoApprove,
            sessionId,
            db: this.db,
          });
        }

        if (verifyResult.verified) {
          const parsedReport = parseSubagentReport(readSpawnOutput(spawnResult.metaPath));
          if (verifyResult.status === "verifying") {
            const currentTasks = this.db.getSessionTasks(sessionId);
            renderPlanMd(session, currentTasks);
            finalResult = {
              taskId: t.task_id,
              status: "verifying",
              harness: activeRoute.harness,
              model: activeRoute.model,
              durationMs: spawnResult.durationMs,
            };
            break;
          }
          const effectiveChangedFiles = verifyResult.changedFiles ?? allowedFiles;
          const claim: DoneClaim = {
            summary: parsedReport?.summary || `Completed task ${t.task_id}: ${t.title}`,
            changed_files: effectiveChangedFiles,
            key_decisions: [
              `Executed with @${activeRoute.harness}/${activeRoute.model}`,
              ...(parsedReport?.key_decisions ?? []),
            ],
            risks: parsedReport?.risks ?? [],
            ...(parsedReport?.cross_scope_requests && parsedReport.cross_scope_requests.length > 0
              ? { cross_scope_requests: parsedReport.cross_scope_requests }
              : {}),
          };
          this.db.recordTaskVerified(
            sessionId,
            t.task_id,
            verifyResult.commitSha || "",
            claim,
            spawnResult.durationMs
          );

          completedCount++;
          this.sendProgress(
            t.turn,
            completedCount,
            totalCount,
            `[✓ ${t.task_id} 완료 (@${activeRoute.harness}/${activeRoute.model}, ${(spawnResult.durationMs / 1000).toFixed(1)}s)]`
          );

          // Update PLAN.md atomically
          const currentTasks = this.db.getSessionTasks(sessionId);
          renderPlanMd(session, currentTasks);

          finalResult = {
            taskId: t.task_id,
            status: "done",
            harness: activeRoute.harness,
            model: activeRoute.model,
            commitSha: verifyResult.commitSha,
            durationMs: spawnResult.durationMs,
            ...(claim.cross_scope_requests && claim.cross_scope_requests.length > 0
              ? { crossScopeRequests: claim.cross_scope_requests }
              : {}),
          };
          break;
        } else {
          const updated = this.db.recordTaskAttemptFailure(sessionId, t.task_id);
          currentAttempts = updated.attempts;
          if (currentAttempts >= 3) {
            finalResult = {
              taskId: t.task_id,
              status: "failed",
              harness: activeRoute.harness,
              model: activeRoute.model,
              durationMs: spawnResult.durationMs,
              error: verifyResult.error || "Verification failed after 3 attempts",
            };
            break;
          }
        }
      }

      return finalResult!;
    });

    // Execute concurrently with Promise.all
    const results = await Promise.all(spawnPromises);

    // Process Cross-Scope modification requests (max 2 auto-scheduled per task; excess deferred to Main Agent)
    const { autoCreatedTasks, deferredCrossScopeRequests } = this.processCrossScopeRequests(
      sessionId,
      selectedTurn,
      results
        .filter((r) => r.status === "done" && Array.isArray(r.crossScopeRequests) && r.crossScopeRequests.length > 0)
        .map((r) => ({
          taskId: r.taskId,
          requests: r.crossScopeRequests!,
        }))
    );

    // Check if all session tasks are complete
    const finalSessionTasks = this.db.getSessionTasks(sessionId);
    const allDone = finalSessionTasks.length > 0 && finalSessionTasks.every((t) => t.status === "done");
    if (allDone) {
      this.db.updateSessionPhase(sessionId, "done");
      session = this.db.getSession(sessionId) ?? session;
      const sessionDebates = this.db.getSessionDebates(sessionId);
      renderSessionSummaryMd(
        session,
        finalSessionTasks,
        sessionDebates,
        path.join(this.projectRoot, ".asd", "summary.md")
      );
      renderSessionSummaryMd(
        session,
        finalSessionTasks,
        sessionDebates,
        path.join(this.projectRoot, ".asd", "sessions", sessionId, "summary.md")
      );
    }

    renderPlanMd(session, finalSessionTasks);
    const baseBoard = renderProgressBoard(session, finalSessionTasks);
    const progressBoard = this.appendCrossScopeSummaryToBoard(
      baseBoard,
      autoCreatedTasks,
      deferredCrossScopeRequests
    );

    return {
      sessionId,
      turn: selectedTurn,
      dispatchedTasks: results,
      results,
      ...(autoCreatedTasks.length > 0 ? { autoCreatedTasks } : {}),
      ...(deferredCrossScopeRequests.length > 0 ? { deferredCrossScopeRequests } : {}),
      progressBoard,
    };
  }

  private processCrossScopeRequests(
    sessionId: string,
    currentTurn: number,
    taskBatches: Array<{ taskId: string; requests: CrossScopeRequest[] }>
  ): {
    autoCreatedTasks: AutoCreatedCrossScopeTask[];
    deferredCrossScopeRequests: DeferredCrossScopeRequest[];
  } {
    const autoCreatedTasks: AutoCreatedCrossScopeTask[] = [];
    const deferredCrossScopeRequests: DeferredCrossScopeRequest[] = [];
    if (taskBatches.length === 0) {
      return { autoCreatedTasks, deferredCrossScopeRequests };
    }

    const allTasks = this.db.getSessionTasks(sessionId);
    const taskById = new Map<string, TaskRow>(allTasks.map((t) => [t.task_id, t]));

    const getCrossScopeChainDepth = (taskId: string, visited = new Set<string>()): number => {
      if (visited.has(taskId)) return 0;
      visited.add(taskId);
      const row = taskById.get(taskId);
      if (!row) return 0;
      const isCrossScope =
        row.is_cross_scope === 1 || row.title.startsWith("[Cross-Scope");
      let deps: string[] = [];
      try {
        deps = JSON.parse(row.depends_on_json || "[]");
      } catch {
        deps = [];
      }
      let maxUpstream = 0;
      for (const depId of deps) {
        maxUpstream = Math.max(maxUpstream, getCrossScopeChainDepth(depId, visited));
      }
      return (isCrossScope ? 1 : 0) + maxUpstream;
    };

    interface EligibleEntry {
      callerTask: TaskRow;
      callerAllowedFiles: string[];
      callerChangedFiles: string[];
      req: CrossScopeRequest;
    }

    const eligibleByTargetFile = new Map<string, EligibleEntry[]>();

    for (const batch of taskBatches) {
      const callerTask = taskById.get(batch.taskId);
      if (!callerTask) continue;

      const chainDepth = getCrossScopeChainDepth(batch.taskId);
      if (chainDepth >= MAX_CROSS_SCOPE_CHAIN_DEPTH) {
        for (const req of batch.requests) {
          deferredCrossScopeRequests.push({
            requestedByTaskId: batch.taskId,
            target_file: req.target_file,
            caller_files: req.caller_files,
            reason: req.reason,
            suggested_change: req.suggested_change,
            deferReason: `Exceeded maximum cross-scope chain depth (${MAX_CROSS_SCOPE_CHAIN_DEPTH}); Main Agent review required`,
          });
        }
        continue;
      }

      let callerAllowedFiles: string[] = [];
      try {
        callerAllowedFiles = JSON.parse(callerTask.target_files_json || "[]");
      } catch {
        callerAllowedFiles = [];
      }

      let callerChangedFiles: string[] = [];
      if (callerTask.done_claim_json) {
        try {
          const parsedClaim = JSON.parse(callerTask.done_claim_json) as DoneClaim;
          if (Array.isArray(parsedClaim.changed_files)) {
            callerChangedFiles = parsedClaim.changed_files;
          }
        } catch {
          callerChangedFiles = [];
        }
      }

      let acceptedCountForTask = 0;
      for (const req of batch.requests) {
        const cleanTarget = req.target_file.replaceAll("\\", "/").replace(/^\.\//, "").trim();
        if (!cleanTarget) continue;

        const prot = checkProtectedPath(cleanTarget);
        if (prot.protected) {
          deferredCrossScopeRequests.push({
            requestedByTaskId: batch.taskId,
            target_file: cleanTarget,
            caller_files: req.caller_files,
            reason: req.reason,
            suggested_change: req.suggested_change,
            deferReason: prot.reason || "Target path is protected",
          });
          continue;
        }

        if (acceptedCountForTask >= MAX_AUTO_CROSS_SCOPE_PER_TASK) {
          deferredCrossScopeRequests.push({
            requestedByTaskId: batch.taskId,
            target_file: cleanTarget,
            caller_files: req.caller_files,
            reason: req.reason,
            suggested_change: req.suggested_change,
            deferReason: `Exceeded max ${MAX_AUTO_CROSS_SCOPE_PER_TASK} auto cross-scope requests per subagent; deferred to Main Agent`,
          });
          continue;
        }

        acceptedCountForTask++;
        const list = eligibleByTargetFile.get(cleanTarget) ?? [];
        list.push({
          callerTask,
          callerAllowedFiles,
          callerChangedFiles,
          req: { ...req, target_file: cleanTarget },
        });
        eligibleByTargetFile.set(cleanTarget, list);
      }
    }

    if (eligibleByTargetFile.size === 0) {
      return { autoCreatedTasks, deferredCrossScopeRequests };
    }

    const nextTurn = currentTurn + 1;
    const existingNextTurnTasks = allTasks.filter((t) => t.turn === nextTurn);
    let nextIdx = existingNextTurnTasks.length + 1;
    const existingIds = new Set(allTasks.map((t) => t.task_id));

    const tasksToInsert: Array<{
      taskId: string;
      turn: number;
      title: string;
      track: TaskTrack;
      role: AgentRole;
      category: string;
      difficulty: DifficultyTier;
      dependsOn: string[];
      targetFiles: string[];
      contextHint: string;
      acceptance: string;
      verifyCmd: string | null;
      isCrossScope: boolean;
    }> = [];

    for (const [targetFile, entries] of eligibleByTargetFile.entries()) {
      while (existingIds.has(`T${nextTurn}.${nextIdx}`)) {
        nextIdx++;
      }
      const newTaskId = `T${nextTurn}.${nextIdx}`;
      existingIds.add(newTaskId);
      nextIdx++;

      // Find existing owner task(s) B in current or earlier turns that own targetFile
      const ownerTasks: TaskRow[] = [];
      for (const candidate of allTasks) {
        if (candidate.turn > currentTurn) continue;
        let candFiles: string[] = [];
        try {
          candFiles = JSON.parse(candidate.target_files_json || "[]");
        } catch {
          candFiles = [];
        }
        if (isPathAllowed(targetFile, candFiles)) {
          ownerTasks.push(candidate);
        }
      }

      // Bundle caller A's relevant files (up to 2 per caller) alongside targetFile
      const bundledFiles = new Set<string>([targetFile]);
      for (const entry of entries) {
        const requestedCallers = (entry.req.caller_files ?? [])
          .map((f) => f.replaceAll("\\", "/").replace(/^\.\//, "").trim())
          .filter(
            (f) =>
              f.length > 0 &&
              !checkProtectedPath(f).protected &&
              (isPathAllowed(f, entry.callerAllowedFiles) || entry.callerChangedFiles.includes(f))
          );

        if (requestedCallers.length > 0) {
          for (const cf of requestedCallers.slice(0, 2)) {
            bundledFiles.add(cf);
          }
        } else {
          // Fallback: automatically bundle up to 2 concrete files from caller A's changed_files or allowedFiles
          const autoPool =
            entry.callerChangedFiles.length > 0
              ? entry.callerChangedFiles
              : entry.callerAllowedFiles.filter((f) => !f.includes("*"));
          for (const cf of autoPool.slice(0, 2)) {
            const cleanCf = cf.replaceAll("\\", "/").replace(/^\.\//, "").trim();
            if (cleanCf && !checkProtectedPath(cleanCf).protected) {
              bundledFiles.add(cleanCf);
            }
          }
        }
      }

      const dependsOnSet = new Set<string>();
      const requestedBySet = new Set<string>();
      for (const entry of entries) {
        dependsOnSet.add(entry.callerTask.task_id);
        requestedBySet.add(entry.callerTask.task_id);
      }
      for (const owner of ownerTasks) {
        dependsOnSet.add(owner.task_id);
      }

      const primaryOwner = ownerTasks[0] ?? entries[0]!.callerTask;
      const targetFilesArr = Array.from(bundledFiles);
      const dependsOnArr = Array.from(dependsOnSet);
      const requestedByArr = Array.from(requestedBySet);

      const sanitizeInline = (s: string) =>
        s.replace(/[|()\r\n]+/g, " ").replace(/\s+/g, " ").trim();

      const reasonsSummary = entries
        .map((e) => `[from ${e.callerTask.task_id}] ${sanitizeInline(e.req.reason)}`)
        .join("; ");
      const changesSummary = entries
        .map((e) => `[from ${e.callerTask.task_id}] ${sanitizeInline(e.req.suggested_change)}`)
        .join("; ");

      const track: TaskTrack =
        targetFilesArr.length > 1 ||
        ownerTasks.some((o) => o.track === "HEAVY") ||
        entries.some((e) => e.callerTask.track === "HEAVY")
          ? "HEAVY"
          : "LIGHT";

      const title = `[Cross-Scope from ${requestedByArr.join(",")}] Update ${targetFile}`;

      tasksToInsert.push({
        taskId: newTaskId,
        turn: nextTurn,
        title,
        track,
        role: (primaryOwner.role as AgentRole) || "worker",
        category: primaryOwner.category || "general",
        difficulty: (primaryOwner.difficulty as DifficultyTier) || "medium",
        dependsOn: dependsOnArr,
        targetFiles: targetFilesArr,
        contextHint: reasonsSummary,
        acceptance: changesSummary,
        verifyCmd: primaryOwner.verify_cmd ?? entries[0]!.callerTask.verify_cmd ?? null,
        isCrossScope: true,
      });

      autoCreatedTasks.push({
        taskId: newTaskId,
        turn: nextTurn,
        title,
        targetFiles: targetFilesArr,
        dependsOn: dependsOnArr,
        requestedBy: requestedByArr,
      });
    }

    if (tasksToInsert.length > 0) {
      this.db.withImmediateTx(() => {
        this.db.upsertTasks(sessionId, tasksToInsert);
        this.db.incrementStateVersion(sessionId);
      });
    }

    return { autoCreatedTasks, deferredCrossScopeRequests };
  }

  private appendCrossScopeSummaryToBoard(
    progressBoard: string,
    autoCreatedTasks: AutoCreatedCrossScopeTask[],
    deferredCrossScopeRequests: DeferredCrossScopeRequest[]
  ): string {
    if (autoCreatedTasks.length === 0 && deferredCrossScopeRequests.length === 0) {
      return progressBoard;
    }
    const extra: string[] = [progressBoard, ""];
    if (autoCreatedTasks.length > 0) {
      extra.push("#### 🔄 자동 생성된 Cross-Scope 후속 태스크 (최대 2개/서브하네스)");
      for (const t of autoCreatedTasks) {
        extra.push(
          `- **${t.taskId}** (Turn ${t.turn}, 요청: ${t.requestedBy.join(", ")}, 선행: ${t.dependsOn.join(", ")}) → 묶인 파일: \`${t.targetFiles.join("`, `")}\``
        );
      }
      extra.push("");
    }
    if (deferredCrossScopeRequests.length > 0) {
      extra.push("#### ⚠️ 메인 에이전트 판단 필요 (보류된 Cross-Scope 요청)");
      for (const d of deferredCrossScopeRequests) {
        extra.push(
          `- **[요청: ${d.requestedByTaskId}]** 대상: \`${d.target_file}\` — 사유: ${d.reason} / 제안: ${d.suggested_change} *(보류 사유: ${d.deferReason})*`
        );
      }
      extra.push("");
    }
    return extra.join("\n").trimEnd();
  }

  // ==========================================================================
  // Tool 3: asd_verify
  // ==========================================================================

  async handleVerify(input: AsdVerifyInput): Promise<AsdVerifyOutput> {
    const { taskId, doneClaim, verifyCmd } = input;
    const sessionId =
      input.sessionId?.trim() ||
      this.db.getLatestSession()?.session_id ||
      input.sessionId;
    let session = this.db.getSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const task = this.db.getTask(sessionId, taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId} in session ${sessionId}`);
    }

    let allowedFiles: string[] = [];
    try {
      allowedFiles = JSON.parse(task.target_files_json || "[]");
    } catch {
      allowedFiles = [];
    }
    if (allowedFiles.length > 0 && !allowedFiles.includes("tests/**")) {
      allowedFiles = [...allowedFiles, "tests/**", "**/*.test.ts", "**/*.spec.ts"];
    }

    let verifyResult: {
      verified: boolean;
      commitSha?: string;
      rollbackPerformed?: boolean;
      violations?: string[];
      testOutput?: string;
      error?: string;
      status?: TaskStatus;
    };

    if (task.track === "LIGHT") {
      verifyResult = verifyAndCommitLightTask({
        projectRoot: this.projectRoot,
        taskId,
        title: task.title,
        allowedFiles,
        verifyCmd: verifyCmd ?? task.verify_cmd,
        sessionId,
        db: this.db,
      });
    } else {
      verifyResult = await verifyAndMergeHeavyTask({
        projectRoot: this.projectRoot,
        turn: task.turn,
        taskId,
        title: task.title,
        wtPath: task.worktree_path ?? undefined,
        allowedFiles,
        verifyCmd: verifyCmd ?? task.verify_cmd,
        sessionId,
        db: this.db,
      });
    }

    let autoCreatedTasks: AutoCreatedCrossScopeTask[] = [];
    let deferredCrossScopeRequests: DeferredCrossScopeRequest[] = [];

    if (task.sub_session_id) {
      try {
        const subDir = path.join(this.projectRoot, ".asd", "sessions", sessionId, "subagents", task.sub_session_id);
        const metaPath = path.join(subDir, "meta.json");
        const logPath = path.join(subDir, "output.log");
        if (fs.existsSync(metaPath)) {
          const meta = JSON.parse(fs.readFileSync(metaPath, "utf8")) as Record<string, unknown>;
          const finishedAt = Date.now();
          const startedAt = typeof meta.startedAt === "number" ? meta.startedAt : finishedAt;
          meta.status = verifyResult.verified ? "done" : "failed";
          meta.finishedAt = finishedAt;
          meta.durationMs = Math.max(0, finishedAt - startedAt);
          atomicWriteFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n");
          const logAppend = verifyResult.verified
            ? `[verify:PASS] Commit: ${verifyResult.commitSha || "n/a"} | Summary: ${doneClaim?.summary || "completed"}\n`
            : `[verify:FAIL] ${verifyResult.error || "Verification failed"}\n`;
          fs.appendFileSync(logPath, logAppend, "utf8");
        }
      } catch {
        // Ignore subagent log update error
      }
    }

    if (verifyResult.verified) {
      this.db.recordTaskVerified(sessionId, taskId, verifyResult.commitSha || "", doneClaim, task.duration_ms ?? 0);
      this.db.resetNoProgress(sessionId);

      if (Array.isArray(doneClaim.cross_scope_requests) && doneClaim.cross_scope_requests.length > 0) {
        const crossScopeRes = this.processCrossScopeRequests(sessionId, task.turn, [
          { taskId, requests: doneClaim.cross_scope_requests },
        ]);
        autoCreatedTasks = crossScopeRes.autoCreatedTasks;
        deferredCrossScopeRequests = crossScopeRes.deferredCrossScopeRequests;
      }
    } else {
      this.db.recordTaskAttemptFailure(sessionId, taskId);
    }

    const allTasks = this.db.getSessionTasks(sessionId);
    const allDone = allTasks.length > 0 && allTasks.every((t) => t.status === "done");

    if (allDone) {
      this.db.updateSessionPhase(sessionId, "done");
      session = this.db.getSession(sessionId) ?? session;
      const sessionDebates = this.db.getSessionDebates(sessionId);
      renderSessionSummaryMd(
        session,
        allTasks,
        sessionDebates,
        path.join(this.projectRoot, ".asd", "summary.md")
      );
      renderSessionSummaryMd(
        session,
        allTasks,
        sessionDebates,
        path.join(this.projectRoot, ".asd", "sessions", sessionId, "summary.md")
      );
    }

    renderPlanMd(session, allTasks);
    const baseBoard = renderProgressBoard(session, allTasks);
    const progressBoard = this.appendCrossScopeSummaryToBoard(
      baseBoard,
      autoCreatedTasks,
      deferredCrossScopeRequests
    );

    const finalStatus: TaskStatus = verifyResult.verified
      ? "done"
      : verifyResult.status ?? (this.db.getTask(sessionId, taskId)?.status as TaskStatus) ?? "failed";

    return {
      verified: verifyResult.verified,
      taskId,
      status: finalStatus,
      commitSha: verifyResult.commitSha,
      rollbackPerformed: verifyResult.rollbackPerformed,
      violations: verifyResult.violations,
      testOutput: verifyResult.testOutput,
      error: verifyResult.error,
      ...(autoCreatedTasks.length > 0 ? { autoCreatedTasks } : {}),
      ...(deferredCrossScopeRequests.length > 0 ? { deferredCrossScopeRequests } : {}),
      progressBoard,
    };
  }

  // ==========================================================================
  // Tool 4: asd_debate
  // ==========================================================================

  async handleDebate(
    input: AsdDebateInput,
    signal?: AbortSignal,
    onProgress?: (msg: string) => void
  ): Promise<AsdDebateOutput> {
    let sessionId = input.sessionId?.trim() || "";
    if (!sessionId) {
      if (input.taskId) {
        const latest = this.db.getLatestSession();
        sessionId = latest?.session_id || `${Date.now()}-debate`;
      } else {
        sessionId = `${Date.now()}-debate`;
      }
    }
    let progressStep = 0;
    linkHarnessSessionToAsdSession({
      projectRoot: this.projectRoot,
      homeDir: this.homeDir,
      asdSessionId: sessionId,
      harness: input.harness,
      db: this.db,
    });
    const brokerResult = await runDebateBroker({
      projectRoot: this.projectRoot,
      homeDir: this.homeDir,
      sessionId,
      taskId: input.taskId,
      topic: input.topic,
      proposal: input.proposal,
      files: input.files,
      includeDiff: input.includeDiff,
      ...(input.harness
        ? { runtimeCapabilities: { availableHarnesses: [input.harness] } }
        : {}),
      commandRunner: this.commandRunner,
      db: this.db,
      signal,
      onProgress: (msg) => {
        progressStep++;
        this.sendProgress(sessionId, progressStep, 4, msg);
        onProgress?.(msg);
      },
    });

    return {
      debateId: brokerResult.debateId,
      status: "done",
      verdict: brokerResult.verdict,
      hardConstraints: brokerResult.hardConstraints,
      decisions: brokerResult.decisions,
      risks: brokerResult.risks,
      diversityDegraded: brokerResult.diversityDegraded,
      updatedAcceptance: brokerResult.updatedAcceptance,
      progressBoard: brokerResult.progressBoard,
    };
  }
}

// ============================================================================
export async function handlePlan(
  input: AsdPlanInput,
  options?: AsdMcpServerOptions
): Promise<AsdPlanOutput> {
  const srv = new AsdMcpServer({ autoSync: false, ...options });
  try {
    return await srv.handlePlan(input);
  } finally {
    srv.close();
  }
}

export async function handleDispatch(
  input: AsdDispatchInput,
  options?: AsdMcpServerOptions & { signal?: AbortSignal }
): Promise<Awaited<ReturnType<AsdMcpServer["handleDispatch"]>>> {
  const srv = new AsdMcpServer({ autoSync: false, ...options });
  try {
    return await srv.handleDispatch(input, options?.signal);
  } finally {
    srv.close();
  }
}

export async function handleVerify(
  input: AsdVerifyInput,
  options?: AsdMcpServerOptions
): Promise<AsdVerifyOutput> {
  const srv = new AsdMcpServer({ autoSync: false, ...options });
  try {
    return await srv.handleVerify(input);
  } finally {
    srv.close();
  }
}

export async function handleDebate(
  input: AsdDebateInput,
  options?: AsdMcpServerOptions & {
    signal?: AbortSignal;
    onProgress?: (message: string) => void;
  }
): Promise<AsdDebateOutput> {
  const srv = new AsdMcpServer({ autoSync: false, ...options });
  try {
    return await srv.handleDebate(input, options?.signal, options?.onProgress);
  } finally {
    srv.close();
  }
}

// CLI Auto-Start Guard
// ============================================================================

const currentFilePath = fileURLToPath(import.meta.url);
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";

if (
  invokedPath &&
  (invokedPath === path.resolve(currentFilePath) ||
    invokedPath.endsWith("server.ts") ||
    invokedPath.endsWith("server.js"))
) {
  const server = new AsdMcpServer();
  server.start();
}
