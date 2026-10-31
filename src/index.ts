/**
 * Agent Swarm Director (ASD) Public Library Entrypoint (src/index.ts)
 *
 * Exposes all core orchestration modules, SQLite SSOT drivers, session trackers,
 * worktree/diff verification gates, 5-harness adapters, and dashboard services
 * so external applications (such as `asd-gui`) can reuse the ASD core with
 * zero code duplication.
 */

export * from "./core/types.ts";
export * from "./core/config.ts";
export * from "./core/db.ts";
export * from "./core/session-tracker.ts";
export * from "./core/spawner.ts";
export * from "./core/router.ts";
export * from "./core/workspace.ts";
export * from "./core/render.ts";
export * from "./core/policy.ts";
export * from "./core/redact.ts";
export * from "./core/jsonc.ts";
export * from "./core/debate.ts";

export * from "./adapters/claude-code.ts";
export * from "./adapters/opencode.ts";
export * from "./adapters/codex.ts";
export * from "./adapters/antigravity.ts";
export * from "./adapters/cursor.ts";
export * from "./adapters/installer.ts";

export {
  AsdMcpServer,
  ASD_MCP_TOOLS,
  handlePlan,
  handleDispatch,
  handleVerify,
  handleDebate,
} from "./mcp/server.ts";

export {
  scanSubagentLogs,
  runAsdLogs,
  runAsdClean,
  getAdapter,
  getLatestSession,
  type SubagentLogRecord,
  type CleanResult,
} from "./cli/index.ts";

export {
  collectDashboardSnapshot,
  discoverHarnessModels,
  saveSessionMemo,
  saveProjectRoutingConfig,
  runSubagentControlAction,
  startDashboardServer,
  type DashboardSnapshot,
  type DashboardStateSnapshot,
  type DashboardServerHandle,
  type HarnessModelCatalog,
} from "./cli/dashboard.ts";
