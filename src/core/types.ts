/**
 * ASD v2.2 Core Types
 * Single module exporting all type unions, constants, and interfaces.
 * Uses ONLY erasable TypeScript syntax: type unions and as const arrays.
 * No enum, no parameter properties, no namespace.
 */

// ============================================================================
// Version Constants
// ============================================================================

export const _asdVersion = "2.2.0" as const;
export const ASD_VERSION = "2.2.0" as const;

// ============================================================================
// Agent Roles (5 standard roles)
// ============================================================================

export const AGENT_ROLES = [
  "planner",
  "architect",
  "worker",
  "scout",
  "critic",
] as const;

export type AgentRole = (typeof AGENT_ROLES)[number];

// ============================================================================
// Domain Categories (4 categories + design)
// ============================================================================

export const DOMAIN_CATEGORIES = [
  "visual-ui",
  "design",
  "research",
  "writing",
  "general",
] as const;

export type DomainCategory = (typeof DOMAIN_CATEGORIES)[number];

// ============================================================================
// Difficulty Tiers (3 tiers)
// ============================================================================

export const DIFFICULTY_TIERS = [
  "low",
  "medium",
  "high",
] as const;

export type DifficultyTier = (typeof DIFFICULTY_TIERS)[number];

// ============================================================================
// Harness & Track Types
// ============================================================================

export type HarnessId = "claude-code" | "opencode" | "codex" | "antigravity";

export type TaskTrack = "LIGHT" | "HEAVY";

export type TaskStatus =
  | "pending"
  | "running"
  | "verifying"
  | "done"
  | "escalated"
  | "failed"
  | "merge_conflict";

export type SessionPhase = "planning" | "running" | "paused" | "done";

// ============================================================================
// Done Claim Interface
// ============================================================================

export interface DoneClaim {
  summary: string;
  changed_files: string[];
  key_decisions: string[];
  risks: string[];
}

// ============================================================================
// Session Metadata
// ============================================================================

export interface MainSessionMeta {
  sessionId: string;
  roleType: "main";
  harness: HarnessId;
  role: "director";
  phase: SessionPhase;
  pid: number;
  startedAt: string;
}

export interface SubagentSessionMeta {
  subSessionId: string;
  parentSessionId: string;
  roleType: "subagent";
  role: AgentRole;
  harness: HarnessId;
  model: string;
  taskId: string;
  pid: number;
  worktreePath: string | null;
  allowedFiles: string[];
  status: "running" | "done" | "failed";
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
}

// ============================================================================
// Routing Configuration
// ============================================================================

export interface RouteEntry {
  harness: HarnessId;
  model: string;
  modelFamily: "claude" | "gpt" | "gemini" | "glm" | "deepseek" | string;
  thinkingEffort?: string;
  fallbacks: Array<{
    harness: HarnessId;
    model: string;
    modelFamily: string;
    thinkingEffort?: string;
  }>;
}

export interface RoutingConfig {
  _asdVersion: string;
  agents: Record<AgentRole, RouteEntry>;
  categories: Record<string, RouteEntry>;
}

// ============================================================================
// MCP Catalog Configuration
// ============================================================================

export interface McpCatalogConfig {
  _asdVersion: string;
  mcpServers: Record<
    string,
    {
      command?: string;
      args?: string[];
      url?: string;
      [k: string]: unknown;
    }
  >;
}

// ============================================================================
// MCP Tool I/O Types
// ============================================================================

export interface AsdPlanInput {
  action: "create" | "get" | "update" | "sync_from_md";
  sessionId?: string;
  mainHarness?: HarnessId;
  tasks?: Array<{
    taskId: string;
    turn: number;
    title: string;
    track?: TaskTrack;
    role?: AgentRole;
    category?: string;
    difficulty?: DifficultyTier;
    dependsOn?: string[];
    targetFiles: string[];
    contextHint?: string;
    acceptance?: string;
    verifyCmd?: string;
  }>;
}

export interface AsdPlanOutput {
  sessionId: string;
  stateVersion: number;
  phase: SessionPhase;
  tasks: Array<{
    taskId: string;
    turn: number;
    title: string;
    track: TaskTrack;
    role: AgentRole;
    category: string;
    difficulty: DifficultyTier;
    status: TaskStatus;
    assignedHarness?: HarnessId;
    assignedModel?: string;
    dependsOn: string[];
    targetFiles: string[];
    contextHint?: string;
    acceptance?: string;
    verifyCmd?: string;
  }>;
  planMdPath: string;
  progressBoard: string;
}

export interface AsdDispatchInput {
  sessionId: string;
  turn?: number;
  taskIds?: string[];
  mode?: "parallel_spawn" | "claim_only";
  harness?: HarnessId;
}

export interface AsdDispatchOutput {
  sessionId: string;
  turn: number;
  results: Array<{
    taskId: string;
    status: TaskStatus;
    harness: HarnessId;
    model: string;
    commitSha?: string;
    durationMs: number;
    error?: string;
  }>;
  progressBoard: string;
}

export interface AsdVerifyInput {
  sessionId: string;
  taskId: string;
  doneClaim: DoneClaim;
  verifyCmd?: string;
}

export interface AsdVerifyOutput {
  verified: boolean;
  taskId: string;
  status: TaskStatus;
  commitSha?: string;
  rollbackPerformed?: boolean;
  violations?: string[];
  testOutput?: string;
  error?: string;
  progressBoard: string;
}

export interface AsdDebateInput {
  sessionId: string;
  taskId?: string;
  topic: string;
  proposal: string;
  files?: string[];
  includeDiff?: boolean;
  harness?: HarnessId;
}

export interface AsdDebateOutput {
  debateId: string;
  status: "done";
  verdict: "APPROVE" | "MINOR_AMEND" | "REJECT";
  hardConstraints: string[];
  decisions: string[];
  risks: string[];
  diversityDegraded: boolean;
  updatedAcceptance?: string;
  progressBoard: string;
}

// ============================================================================
// Harness Adapter Contract
// ============================================================================

export interface HarnessAdapter {
  harnessId: HarnessId;
  buildHeadlessCommand(
    prompt: string,
    model: string,
    opts?: { reasoningEffort?: string }
  ): { cmd: string; args: string[] };
  formatPreToolUseDeny(reason: string): {
    exitCode: number;
    stdout?: string;
    stderr?: string;
  };
  formatStopBlock(reason: string): {
    exitCode: number;
    stdout?: string;
    stderr?: string;
  };
  globalConfigTargets(homeDir: string): string[];
  supportsHeadlessSpawn?: boolean;
}
