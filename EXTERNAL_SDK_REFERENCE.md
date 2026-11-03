# ASD v2.4.0 External SDK Reference (`asd-multiagent`)

> **Version**: `2.4.0` (Breaking SQLite schema & SDK surface upgrade — incompatible with `2.3.x`)  
> **Runtime Dependencies**: `0` (Pure Node.js v22.6+ / v24+ built-ins: `node:sqlite`, `node:fs`, `node:child_process`, `node:http`, `node:crypto`)  
> **Entrypoint**: [`src/index.ts`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/index.ts) (`import { ... } from "asd-multiagent"`)

---

## 1. Overview & v2.4.0 Breaking Changes

`asd-multiagent` exposes its entire multi-harness orchestration core, SQLite SSOT (`~/.asd/state/core.db`), 5-harness CLI session discovery, transcript parser, real-time turn execution driver, and local dashboard snapshot APIs through [`src/index.ts`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/index.ts).

### What Changed in v2.4.0
1. **Version Bump & DB Compatibility (`2.4.0`)**:
   - `ASD_CONFIG_VERSION` and `package.json` version are now `"2.4.0"`.
   - Shared SQLite database `~/.asd/state/core.db` includes `session_drivers` multi-driver ownership, `harness_session_id` bidirectional resume metadata, and `cli-recent.json` transcript preservation. `2.3.x` clients should not be mixed with `2.4.0`.
2. **4-Way Structured Transcript Classification ([`readHarnessTranscript`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/transcripts.ts#L995-L1084))**:
   - Every [`TranscriptMessage`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/transcripts.ts#L21-L55) returned by `readHarnessTranscript()` is now classified into:
     - `category`: `"user" | "assistant" | "thinking" | "tool_use" | "tool_result" | "system"`
     - `thinking?: string` (reasoning / chain-of-thought text)
     - `toolUse?: { name: string; id?: string; input?: string }`
     - `toolResult?: { name?: string; toolUseId?: string; output: string; isError?: boolean }`
   - Full support added across **Claude Code**, **Codex**, **OpenCode** (`opencode.db` SQLite `part` table + JSON storage), **Antigravity** (`transcript.jsonl` + automatic `transcript_full.jsonl` fallback on `truncated_fields`), and **Cursor**.
3. **Real-Time Streaming Turn Execution ([`runDriverTurn`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/drivers.ts#L926-L1196) & [`parseDriverStreamLine`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/drivers.ts#L583-L920))**:
   - `runDriverTurn()` now accepts `onEvent?: (event: DriverStreamEvent) => void` and `streamJson?: boolean` (default `true`).
   - Emits real-time structured [`DriverStreamEvent`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/drivers.ts#L556-L577) items (`thinking`, `tool_use`, `tool_result`, `assistant`, `system`, `error`) while the CLI subprocess is still running.
   - Automatically passes `--output-format stream-json --verbose` for Claude Code / Cursor, `--json` for Codex, and `--format json` for OpenCode.
4. **Bidirectional Session Promotion & Demotion ([`promoteCliSessionToAsd`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/session-tracker.ts#L1619-L1740) & [`demoteAsdSession`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/session-tracker.ts#L1455-L1545))**:
   - **Promote (CLI -> ASD)**: `promoteCliSessionToAsd()` promotes any standalone CLI session (`claude-code`, `codex`, `opencode`, `antigravity`, `cursor`) into an ASD session in `core.db` (idempotent if already linked) and optionally attaches a driver lease (`driverSource: "gui"` or `"cli"`).
   - **Demote (ASD -> CLI)**: `demoteAsdSession()` pauses the ASD session, detaches active drivers, records the native `harness_session_id` into `cli-recent.json`, and returns the exact native CLI resume command (`resumeCommand`, `resumeArgv`).
5. **Project-Scoped Multi-Harness CLI Session Discovery ([`discoverProjectCliSessions`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/session-tracker.ts#L1774-L1895))**:
   - Discovers all native CLI sessions executed in a specific project directory across all 5 harnesses, cross-references `core.db` (`isPromotedToAsd`, `asdSessionId`), and sorts by most recent activity.
6. **Startup & Project Loading Optimizations**:
   - [`discoverHarnessModels`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/cli/dashboard.ts#L225-L470) now uses non-blocking parallel async probes + a persistent 10-minute disk cache at `~/.asd/state/models-cache.json` ([`getModelsDiskCachePath`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/cli/dashboard.ts#L244-L246)).
   - [`listKnownProjects`](file:///C:/Users/yjsjs0987/Desktop/Projects/asd-multiagent/src/core/session-tracker.ts#L1901-L1980) now supports a 15-second in-memory FS stat cache, `skipDiskCheck?: boolean`, and `db?: DatabaseSync` connection reuse.

---

## 2. Newly Added & Enhanced SDK APIs in v2.4.0

### 2.1 Multi-Harness CLI Session Discovery (`discoverProjectCliSessions`)

Finds all CLI sessions that ran in `projectPath` across Claude Code (`~/.claude/projects`), Codex (`~/.codex/sessions`), OpenCode (`opencode.db`), Antigravity (`brain/`), and Cursor (`cli-recent.json`), and links them against ASD sessions in `core.db`.

```ts
import {
  discoverProjectCliSessions,
  type DiscoveredCliSession,
  type DiscoverProjectCliSessionsOptions,
} from "asd-multiagent";

const sessions: DiscoveredCliSession[] = discoverProjectCliSessions("/path/to/project", {
  limit: 100,
  syncLocalTranscripts: true, // scans native harness storage before reading cli-recent.json
});
```

#### `DiscoveredCliSession` Shape
| Field | Type | Description |
|---|---|---|
| `harness` | `HarnessId` | `"claude-code" \| "opencode" \| "codex" \| "antigravity" \| "cursor"` |
| `harnessSessionId` | `string` | Native harness session UUID / ID |
| `projectRoot` | `string` | Normalized project root path |
| `updatedAt` | `number` | Last activity timestamp (epoch ms) |
| `model` | `string \| undefined` | Model ID detected from session or transcript |
| `summary` | `string \| undefined` | First user prompt or session title |
| `transcriptPath` | `string \| undefined` | Absolute path to transcript file or SQLite DB |
| `asdSessionId` | `string \| null` | Linked ASD `session_id` if promoted, otherwise `null` |
| `asdPhase` | `SessionPhase \| null` | `"planning" \| "running" \| "paused" \| "done" \| null` |
| `isPromotedToAsd` | `boolean` | `true` when registered in `core.db` `sessions` table |

---

### 2.2 4-Way Structured Transcript Reader (`readHarnessTranscript`)

Reads a conversation transcript from any of the 5 harnesses and separates **User Messages**, **Thinking**, **Tool Use**, **Tool Result**, and **Assistant Responses**.

```ts
import {
  readHarnessTranscript,
  readSessionTranscriptById,
  type TranscriptReadResult,
  type TranscriptMessage,
  type TranscriptMessageCategory,
} from "asd-multiagent";

// 1. Direct read for any CLI or ASD session:
const result: TranscriptReadResult = readHarnessTranscript({
  harness: "claude-code", // or "opencode" | "codex" | "antigravity" | "cursor"
  projectRoot: "/path/to/project",
  harnessSessionId: "eb7de063-fd75-4fa7-8312-9efcf3fd77e5",
  transcriptPath: undefined, // optional explicit path override
  maxMessages: 300,
});

// 2. Or read by ASD session_id / sub_session_id:
const asdTranscript = readSessionTranscriptById("/path/to/project", "asd-20261103-182153-i9ti", 300);
```

#### `TranscriptMessage` Shape (v2.4.0)
```ts
export type TranscriptMessageCategory =
  | "user"
  | "assistant"
  | "thinking"
  | "tool_use"
  | "tool_result"
  | "system";

export interface TranscriptMessage {
  role: "user" | "assistant" | "system" | "tool";
  category?: TranscriptMessageCategory;
  text: string;
  thinking?: string;
  toolName?: string;
  toolUse?: {
    name: string;
    id?: string;
    input?: string;
  };
  toolResult?: {
    name?: string;
    toolUseId?: string;
    output: string;
    isError?: boolean;
  };
  timestamp?: string;
}
```

---

### 2.3 Real-Time Interactive Turn Execution & Streaming (`runDriverTurn`, `parseDriverStreamLine`)

Sends a user message to the underlying harness CLI (`claude`, `codex`, `opencode`, `cursor-agent`, `agy`) and streams structured events (`thinking`, `tool_use`, `tool_result`, `assistant`) in real time.

```ts
import {
  runDriverTurn,
  parseDriverStreamLine,
  type DriverStreamEvent,
  type RunDriverTurnResult,
} from "asd-multiagent";

const result: RunDriverTurnResult = await runDriverTurn({
  projectPath: "/path/to/project",
  sessionId: "asd-20261103-182153-i9ti",
  prompt: "Explain the current session-tracker architecture.",
  driverSource: "gui",
  streamJson: true, // default true: enables real-time structured JSON stream parsing
  onEvent: (event: DriverStreamEvent) => {
    switch (event.category) {
      case "thinking":
        console.log("[Thinking]", event.thinking);
        break;
      case "tool_use":
        console.log("[Tool Use]", event.toolUse?.name, event.toolUse?.input);
        break;
      case "tool_result":
        console.log("[Tool Result]", event.toolResult?.output);
        break;
      case "assistant":
        console.log("[Assistant]", event.text);
        break;
    }
  },
});
```

#### Standalone Stream Line Parser (`parseDriverStreamLine`)
For custom subprocess pipelines that manage their own `stdout` reader:
```ts
const events: DriverStreamEvent[] = parseDriverStreamLine("claude-code", rawJsonLine);
```

---

### 2.4 Session Promotion & Demotion (`promoteCliSessionToAsd`, `demoteAsdSession`)

#### Promote a Standalone CLI Session to an ASD Session
```ts
import {
  promoteCliSessionToAsd,
  type PromoteCliSessionOptions,
  type PromoteCliSessionResult,
} from "asd-multiagent";

const promoted: PromoteCliSessionResult = promoteCliSessionToAsd({
  projectPath: "/path/to/project",
  harness: "claude-code",
  harnessSessionId: "eb7de063-fd75-4fa7-8312-9efcf3fd77e5",
  model: "claude-sonnet-4-6",
  phase: "running",         // default: "running"
  driverSource: "gui",      // optional: immediately attach a "gui" or "cli" driver lease
  memo: "Promoted from GUI session list",
});
// promoted.session -> SessionRow
// promoted.alreadyExisted -> boolean (true if already promoted earlier)
// promoted.driver -> DriverRow | null
```

#### Demote an ASD Session Back to a Native Harness CLI Session
```ts
import {
  demoteAsdSession,
  type DemoteSessionResult,
} from "asd-multiagent";

const demoted: DemoteSessionResult = demoteAsdSession(
  "/path/to/project",
  "asd-20261103-182153-i9ti",
  { reason: "manual" },
);
// demoted.resumeCommand -> e.g. 'claude --resume "eb7de063-fd75-4fa7-8312-9efcf3fd77e5"'
// demoted.resumeArgv    -> e.g. ["claude", "--resume", "eb7de063-fd75-4fa7-8312-9efcf3fd77e5"]
```

---

### 2.5 Fast Project & Model Discovery (`listKnownProjects`, `discoverHarnessModels`)

```ts
import {
  listKnownProjects,
  discoverHarnessModels,
  getModelsDiskCachePath,
} from "asd-multiagent";

// Fast project list (15s FS stat cache; pass skipDiskCheck: true for instant DB-only query)
const projects = listKnownProjects({
  skipDiskCheck: false,
  forceRefresh: false,
});

// Async model discovery with ~/.asd/state/models-cache.json (10-minute TTL)
const models = await discoverHarnessModels(false); // pass true to force refresh
const cacheFile = getModelsDiskCachePath();
```

---

## 3. Complete Catalog of Exported SDK Modules (`src/index.ts`)

### 3.1 Core Types & Configuration (`src/core/types.ts`, `src/core/config.ts`)
- **Constants & Types**:
  - `ASD_CONFIG_VERSION` (`"2.4.0"`), `HARNESS_IDS`, `AGENT_ROLES`, `TASK_CATEGORIES`, `DIFFICULTY_TIERS`, `TASK_TRACKS`, `TASK_STATUSES`, `SESSION_PHASES`, `THINKING_EFFORTS`, `DRIVER_SOURCES`, `DRIVER_DETACH_REASONS`
  - `HarnessId`, `AgentRole`, `TaskCategory`, `DifficultyTier`, `TaskTrack`, `TaskStatus`, `SessionPhase`, `ThinkingEffort`, `DriverSource`, `DriverDetachReason`, `AsdRoutingConfig`, `DoneClaim`
- **Configuration Functions**:
  - `resolveAsdHomeDir()`, `resolveGlobalAsdPaths()`, `resolveProjectRoot(startDir)`, `resolveProjectScopedKey(projectRoot)`, `resolveAsdPaths(projectRoot)`
  - `ensureProjectInitialized(projectRoot, options?)`
  - `loadRoutingConfig(projectRoot)`, `loadMcpConfig(projectRoot)`
  - `readHookLock(projectRoot)`, `writeHookLock(projectRoot, data)`

### 3.2 SQLite SSOT Database (`src/core/db.ts`)
- **Connection & Transactions**:
  - `openDatabase(projectRootOrDbPath)`, `withImmediateTx(db, fn)`
  - `generateAsdSessionId(now?)`, `isValidAsdSessionId(id)`
- **Sessions CRUD**:
  - `upsertSession(db, input)`, `getSession(db, sessionId)`, `listSessions(db, projectRoot?)`, `updateSessionPhase(db, sessionId, phase)`
  - `updateSessionHarnessSessionId(db, sessionId, harnessSessionId)`, `findSessionByHarnessSessionId(db, projectRoot, harness, harnessSessionId)`
  - `incrementNoProgress(db, sessionId)`, `resetNoProgress(db, sessionId)`, `setStashedWorkSha(db, sessionId, sha)`
- **Tasks CRUD**:
  - `upsertTask(db, input)`, `getTask(db, sessionId, taskId)`, `listTasks(db, sessionId)`, `listTasksByTurn(db, sessionId, turn)`
  - `updateTaskStatus(db, sessionId, taskId, status, extra?)`, `incrementTaskAttempts(db, sessionId, taskId)`
- **Debates CRUD**:
  - `upsertDebate(db, input)`, `getDebate(db, debateId)`, `listDebates(db, sessionId)`, `updateDebateBundles(db, debateId, bundles)`
- **Session Drivers CRUD**:
  - `upsertDriverRow(db, input)`, `getDriverRow(db, sessionId, source, pid)`, `listSessionDrivers(db, sessionId)`, `detachDriverRow(db, sessionId, source, pid, reason)`

### 3.3 Session Tracker & CLI Interop (`src/core/session-tracker.ts`)
- **ASD & CLI Session Resolution**:
  - `resolveActiveSession(db, projectRoot, options?)`
  - `buildSessionResumeTarget(db, sessionId)`, `listResumableSessions(projectRoot)`
  - `promoteCliSessionToAsd(options)` *(New in v2.4.0)*
  - `demoteAsdSession(projectRoot, sessionId, options?)`
  - `discoverProjectCliSessions(projectPath, options?)` *(New in v2.4.0)*
  - `syncLocalHarnessTranscripts(projectRoot, maxFiles?)` *(Expanded to all harnesses in v2.4.0)*
  - `recordCliRecentSession(entry)` *(Preserves summary & transcriptPath in v2.4.0)*
  - `readCliRecentSessions(projectRoot?)`, `linkHarnessSessionToAsdSession(projectRoot, sessionId, harness, explicitHarnessSessionId?)`
- **Multi-Project Registry**:
  - `listKnownProjects(options?)` *(Optimized with FS cache & `skipDiskCheck` in v2.4.0)*
  - `registerKnownProject(projectRoot)`, `removeKnownProject(projectRoot)`

### 3.4 Multi-Driver Ownership & Turn Execution (`src/core/drivers.ts`, `src/core/spawner.ts`)
- **Driver Lease Management**:
  - `attachDriver(db, input)`, `heartbeatDriver(db, sessionId, source, pid)`, `detachDriver(db, sessionId, source, pid, reason)`
  - `reapDeadDrivers(db, sessionId?)`, `listActiveDrivers(db, sessionId)`, `isProcessAlive(pid)`
- **Interactive Turn & Subagent Execution**:
  - `runDriverTurn(options)` *(Enhanced with `onEvent` & `streamJson` in v2.4.0)*
  - `parseDriverStreamLine(harness, rawLine)` *(New in v2.4.0)*
  - `spawnSubagent(options)`, `buildSubagentCliSpec(options)`, `extractJsonFence(rawOutput)`

### 3.5 Routing, Workspace, Policy, Redaction & Debate (`src/core/*`)
- **Router (`src/core/router.ts`)**:
  - `routeTask(task, config, mainHarness, mainModel)`, `resolveDebateTriad(config, mainHarness)`
- **Workspace & Git Isolation (`src/core/workspace.ts`)**:
  - `createTaskWorktree(projectRoot, turn, taskId)`, `mergeTaskWorktree(projectRoot, worktreePath, taskId, title)`, `removeTaskWorktree(projectRoot, worktreePath)`
  - `createCheckpointCommit(projectRoot, taskId, title, targetFiles)`, `rollbackLightChanges(projectRoot, targetFiles)`
  - `verifyTaskBoundary(projectRoot, changedFiles, targetFiles)`
- **Policy & Secret Redaction (`src/core/policy.ts`, `src/core/redact.ts`)**:
  - `evaluateToolUsePolicy(input)`, `scanFilesForSecrets(projectRoot, relPaths)`, `redactSecrets(text)`
- **Adversarial Debate (`src/core/debate.ts`)**:
  - `runDebateRound1(...)`, `runDebateRound2(...)`, `synthesizeDebateVerdict(...)`
- **Progress Board & PLAN.md Sync (`src/core/render.ts`)**:
  - `renderProgressBoard(session, tasks)`, `parsePlanMarkdown(markdown)`, `syncPlanMarkdownStatus(projectRoot, tasks)`

### 3.6 5-Harness Adapters & Installer (`src/adapters/*`)
- **Adapters**:
  - `ClaudeCodeAdapter`, `OpenCodeAdapter`, `CodexAdapter`, `AntigravityAdapter`, `CursorAdapter`, `getAdapter(harness)`
  - Each adapter implements `detectCli()`, `buildResumeSpec(harnessSessionId, cwd, model?)`, `buildInteractiveNewSpec(cwd, model?, prompt?)`, `buildSubagentSpec(...)`, and `syncConfig(projectRoot, options?)`.
- **Global & Project Installer (`src/adapters/installer.ts`)**:
  - `installGlobalAdapters(options?)`, `syncProjectAdapters(projectRoot, options?)`

### 3.7 Dashboard & MCP Server (`src/cli/dashboard.ts`, `src/mcp/server.ts`)
- **Dashboard Service Functions**:
  - `collectDashboardSnapshot(projectPath, filterProjectPath?)`
  - `discoverHarnessModels(forceRefresh?)`, `getModelsDiskCachePath()`
  - `saveSessionMemo(projectPath, sessionId, memo)`, `saveProjectRoutingConfig(projectPath, config)`
  - `runSubagentControlAction(projectPath, actionInput)`
  - `startDashboardServer(options)`
- **MCP Server**:
  - `AsdMcpServer`, `ASD_MCP_TOOLS`, `handlePlan`, `handleDispatch`, `handleVerify`, `handleDebate`
