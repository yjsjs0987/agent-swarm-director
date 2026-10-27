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
import { resolveAsdPaths } from "../core/config.ts";
import { openProjectDb, type SessionRow, type SqliteDriver, type TaskRow } from "../core/db.ts";
import { buildDefaultHarnessCommand, runDebateBroker } from "../core/debate.ts";
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
  normalizeAntigravityModel,
  resolveRoute,
} from "../core/router.ts";
import { spawnSubagent, type CommandRunner } from "../core/spawner.ts";
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
          enum: ["claude-code", "opencode", "codex", "antigravity"],
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
                enum: ["trivial", "low", "medium", "high", "critical"],
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
    "1. Modify ONLY the files listed under Allowed Target Files.",
    "2. Ensure implementation satisfies the acceptance criteria.",
    "3. Run automated tests and ensure zero errors."
  );

  return lines.join("\n");
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
    // When "main" (or undefined): trigger autoSyncIfNeeded (or injected onMainServerStart).
    if (this.sessionRole !== "subagent") {
      if (options?.onMainServerStart) {
        void Promise.resolve(options.onMainServerStart()).catch(() => {});
      } else if (options?.autoSync !== false) {
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
          version: "2.2.0",
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
      // Find latest session or generate a default ID
      const latest = this.db.getLatestSession();
      sessionId = latest?.session_id || `${Date.now()}-main`;
    }

    // Ensure session exists
    let sessionRow = this.db.getSession(sessionId);
    if (!sessionRow) {
      sessionRow = this.db.createOrGetSession({
        sessionId,
        projectRoot: this.projectRoot,
        mainHarness: input.mainHarness || "claude-code",
        mainPid: process.pid,
      });
    }

    const paths = resolveAsdPaths(this.projectRoot, this.homeDir);

    if (action === "create" || action === "update") {
      if (input.tasks && input.tasks.length > 0) {
        this.db.upsertTasks(
          sessionId,
          input.tasks.map((t) => ({
            taskId: t.taskId,
            turn: t.turn,
            title: t.title,
            track: t.track,
            role: t.role,
            category: t.category,
            difficulty: t.difficulty,
            dependsOn: t.dependsOn,
            targetFiles: t.targetFiles,
            contextHint: t.contextHint,
            acceptance: t.acceptance,
            verifyCmd: t.verifyCmd,
          }))
        );
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
    };
    atomicWriteFileSync(
      path.join(sessionDir, "main.json"),
      JSON.stringify(mainMeta, null, 2) + "\n"
    );

    // Retrieve fresh tasks
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
    const mode = input.mode ?? "parallel_spawn";

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

        const route = resolveRoute({
          role: t.role as AgentRole,
          category: t.category,
          difficulty: t.difficulty as DifficultyTier,
          harness: (t.assigned_harness as HarnessId) ?? undefined,
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

        this.db.updateTaskStatus(sessionId, t.task_id, "running", {
          assignedHarness: route.harness,
          assignedModel: effectiveModel,
          worktreePath: wtPath,
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

      let currentAttempts = t.attempts;
      let finalResult: AsdDispatchOutput["results"][number] | null = null;

      // Up to 3 attempts with escalation
      const runtimeCaps = !this.commandRunner
        ? { availableHarnesses: detectAvailableCliHarnesses() }
        : undefined;
      while (currentAttempts < 3) {
        const esc = escalateTaskRoute(
          {
            ...t,
            isSubagentSpawn: true,
            mainHarness: session.main_harness as HarnessId,
            mode: "parallel_spawn",
          } as TaskRow,
          currentAttempts,
          undefined,
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
        this.db.updateTaskStatus(sessionId, t.task_id, "running", { subSessionId });

        const prompt = buildPromptForTask(t, upCtx.upstreamDecisions, upCtx.upstreamFiles);
        const cmdInfo = buildDefaultHarnessCommand(
          route.harness,
          prompt,
          route.model,
          route.thinkingEffort ?? t.thinking_effort
        );

        let allowedFiles: string[] = [];
        try {
          allowedFiles = JSON.parse(t.target_files_json || "[]");
        } catch {
          allowedFiles = [];
        }

        let spawnResult = await spawnSubagent({
          projectRoot: wtInfo ? wtInfo.wtPath : this.projectRoot,
          homeDir: this.homeDir,
          mainSessionId: sessionId,
          subSessionId,
          role: t.role as AgentRole,
          harness: route.harness,
          model: route.model,
          taskId: t.task_id,
          prompt,
          allowedFiles,
          command: cmdInfo.command,
          args: cmdInfo.args,
          commandRunner: this.commandRunner,
          signal,
        });

        if (spawnResult.exitCode !== 0 && route.model && !this.commandRunner) {
          const defaultCmdInfo = buildDefaultHarnessCommand(
            route.harness,
            prompt,
            "",
            t.thinking_effort
          );
          const retryResult = await spawnSubagent({
            projectRoot: wtInfo ? wtInfo.wtPath : this.projectRoot,
            homeDir: this.homeDir,
            mainSessionId: sessionId,
            subSessionId: `${subSessionId}-default`,
            role: t.role as AgentRole,
            harness: route.harness,
            model: "default",
            taskId: t.task_id,
            prompt,
            allowedFiles,
            command: defaultCmdInfo.command,
            args: defaultCmdInfo.args,
            commandRunner: this.commandRunner,
            signal,
          });
          if (retryResult.exitCode === 0) {
            spawnResult = retryResult;
          }
        }

        // Verification
        let verifyResult: { verified: boolean; commitSha?: string; error?: string; status?: TaskStatus };
        if (t.track === "LIGHT") {
          verifyResult = verifyAndCommitLightTask({
            projectRoot: this.projectRoot,
            taskId: t.task_id,
            title: t.title,
            allowedFiles,
            verifyCmd: t.verify_cmd,
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
            sessionId,
            db: this.db,
          });
        }

        if (verifyResult.verified) {
          const claim: DoneClaim = {
            summary: `Completed task ${t.task_id}: ${t.title}`,
            changed_files: allowedFiles,
            key_decisions: [`Executed with @${route.harness}/${route.model}`],
            risks: [],
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
            `[✓ ${t.task_id} 완료 (@${route.harness}/${route.model}, ${(spawnResult.durationMs / 1000).toFixed(1)}s)]`
          );

          // Update PLAN.md atomically
          const currentTasks = this.db.getSessionTasks(sessionId);
          renderPlanMd(session, currentTasks);

          finalResult = {
            taskId: t.task_id,
            status: "done",
            harness: route.harness,
            model: route.model,
            commitSha: verifyResult.commitSha,
            durationMs: spawnResult.durationMs,
          };
          break;
        } else {
          const updated = this.db.recordTaskAttemptFailure(sessionId, t.task_id);
          currentAttempts = updated.attempts;
          if (currentAttempts >= 3) {
            finalResult = {
              taskId: t.task_id,
              status: "failed",
              harness: route.harness,
              model: route.model,
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

    // Check if all session tasks are complete
    const finalSessionTasks = this.db.getSessionTasks(sessionId);
    const allDone = finalSessionTasks.length > 0 && finalSessionTasks.every((t) => t.status === "done");
    if (allDone) {
      this.db.updateSessionPhase(sessionId, "done");
      session = this.db.getSession(sessionId) ?? session;
      renderSessionSummaryMd(session, finalSessionTasks, undefined, path.join(this.projectRoot, ".asd", "summary.md"));
      renderSessionSummaryMd(
        session,
        finalSessionTasks,
        undefined,
        path.join(this.projectRoot, ".asd", "sessions", sessionId, "summary.md")
      );
    }

    renderPlanMd(session, finalSessionTasks);
    const progressBoard = renderProgressBoard(session, finalSessionTasks);

    return {
      sessionId,
      turn: selectedTurn,
      dispatchedTasks: results,
      results,
      progressBoard,
    };
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

    if (verifyResult.verified) {
      this.db.recordTaskVerified(sessionId, taskId, verifyResult.commitSha || "", doneClaim, task.duration_ms ?? 0);
      this.db.resetNoProgress(sessionId);
    } else {
      this.db.recordTaskAttemptFailure(sessionId, taskId);
    }

    const allTasks = this.db.getSessionTasks(sessionId);
    const allDone = allTasks.length > 0 && allTasks.every((t) => t.status === "done");

    if (allDone) {
      this.db.updateSessionPhase(sessionId, "done");
      session = this.db.getSession(sessionId) ?? session;
      renderSessionSummaryMd(session, allTasks, undefined, path.join(this.projectRoot, ".asd", "summary.md"));
      renderSessionSummaryMd(
        session,
        allTasks,
        undefined,
        path.join(this.projectRoot, ".asd", "sessions", sessionId, "summary.md")
      );
    }

    renderPlanMd(session, allTasks);
    const progressBoard = renderProgressBoard(session, allTasks);

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
    const sessionId =
      input.sessionId?.trim() ||
      this.db.getLatestSession()?.session_id ||
      `${Date.now()}-main`;
    let progressStep = 0;
    const brokerResult = await runDebateBroker({
      projectRoot: this.projectRoot,
      homeDir: this.homeDir,
      sessionId,
      taskId: input.taskId,
      topic: input.topic,
      proposal: input.proposal,
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
