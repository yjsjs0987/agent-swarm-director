# Patch Notes (`agent-swarm-director` / ASD v2.4.0)

**English** | [한국어](./PATCH_NOTES_ko.md) | [📖 Back to README](./README.md) | [🏛️ Architecture & Code Reference](./PROJECT_STATUS.md) | [🔌 External SDK Reference](./EXTERNAL_SDK_REFERENCE.md)

Complete chronological patch history for **Agent Swarm Director (ASD v2.4.0)**, organized from the latest updates to the initial foundation.

---

## 1. Latest Orchestration, External GUI SDK & Performance Updates (v2.4.0)

### `v2.4.0` — 4-Way Transcript Classification, Real-Time Streaming (`onEvent`), Bidirectional CLI ↔ ASD Session Promotion/Demotion, Multi-Harness Session Discovery & Startup Caching
- **Breaking Version & Shared DB Schema Upgrade (`2.4.0`)**:
  - Bumped `ASD_VERSION` and package version to `2.4.0` across core, skills, presets, and documentation (incompatible with `2.3.x` per-project hash DB layout).
- **4-Way Structured Transcript Classification (`readHarnessTranscript` — `8b4980c`)**:
  - Upgraded `TranscriptMessage` in `src/core/transcripts.ts` with `category: "user" | "assistant" | "thinking" | "tool_use" | "tool_result" | "system"`, `thinking`, `toolUse`, and `toolResult`.
  - Added full 4-way classification across **Claude Code** (`thinking`, `tool_use`, `tool_result`, `text` blocks), **Codex CLI** (`agent_reasoning`, `function_call`, `custom_tool_call`, `function_call_output`), **OpenCode** (`opencode.db` SQLite `part` table + JSON storage), and **Antigravity** (`USER_INPUT`, `PLANNER_RESPONSE`, `TOOL_RESPONSE` + automatic `transcript_full.jsonl` fallback when `truncated_fields` is present).
- **Real-Time Streaming Turn Execution (`runDriverTurn` & `parseDriverStreamLine` — `ea92b73`)**:
  - Added `onEvent?: (event: DriverStreamEvent) => void` and `streamJson?: boolean` (default `true`) to `runDriverTurn` in `src/core/drivers.ts`.
  - Automatically passes `--output-format stream-json --verbose` for Claude Code / Cursor, `--json` for Codex, and `--format json` for OpenCode, emitting real-time `thinking`, `tool_use`, `tool_result`, and `assistant` events while the CLI turn is running.
- **Bidirectional CLI ↔ ASD Session Promotion, Demotion & Deletion (`ea92b73`, `31421ba`)**:
  - Added `promoteCliSessionToAsd()` in `src/core/session-tracker.ts` to promote any standalone CLI session into an ASD session in `core.db` (idempotent if already promoted) and optionally attach an active driver lease.
  - Added `unlinkHarnessSessionFromAsdSession()`, `buildSessionDemotion()`, and the `asd resume` CLI command to detach active drivers, reset `asdSessionId: null` in `cli-recent.json`, and return/execute the interactive native CLI resume command.
  - Added `SqliteDriver.findSessionByHarnessSessionId(sid, harness?)` and transactional cascade `SqliteDriver.deleteSession(sessionId)` in `src/core/db.ts`.
- **Project-Scoped Multi-Harness CLI Session Discovery (`discoverProjectCliSessions` — `c29200b`, `0e26088`)**:
  - Added `discoverProjectCliSessions()` to discover all local CLI sessions executed in a project across all 5 harnesses and cross-reference `core.db` (`isPromotedToAsd`, `asdSessionId`, `asdPhase`).
  - Expanded `syncLocalHarnessTranscripts()` from Antigravity-only to also scan **Claude Code** (`~/.claude/projects`), **Codex** (`~/.codex/sessions`), and **OpenCode** (`opencode.db`) with `mtimeMs`-based per-file caching (`transcriptDiscoveryCache`), and preserved first-prompt `summary` and `transcriptPath` across subsequent `PreToolUse`/`Stop` hook updates in `recordCliRecentSession()`.
- **Fast Model, Worktree Status & Project Loading Optimizations (`fa59456`, `c29200b`)**:
  - Optimized `discoverHarnessModels()` in `src/cli/dashboard.ts` with parallel async probes (`Promise.all`) and a persistent 10-minute disk cache at `~/.asd/state/models-cache.json` (`getModelsDiskCachePath`).
  - Added `worktreeStatusCache` (3.5s TTL) and `skipCliSpawn` option to `collectDashboardSnapshot()` in `src/cli/dashboard.ts` to eliminate repeated `git status --short` subprocess bottlenecks.
  - Optimized `listKnownProjects()` in `src/core/session-tracker.ts` with a 15-second in-memory FS stat cache, `skipDiskCheck`, and `db` instance reuse.
- **Codex Notify Hook & Cursor Nested Hook Schema (`aad8d91`, `8d68e01`)**:
  - Added Codex `notify` hook installation in `~/.codex/config.toml` and updated Cursor `~/.cursor/hooks.json` to the official nested `{"version": 1, "hooks": {...}}` schema with full payload extraction tests.

### `v2.3.3` (`fe668d3`) — Single Shared State DB (`~/.asd/state/core.db`) & Project-Scoped SQLite Driver
- Consolidated per-project `~/.asd/state/<projectHash>/core.db` files into a single shared `~/.asd/state/core.db` with `SqliteDriver(dbPath, projectRoot?)` project scoping and `resolveHomeDir()` test isolation.
- Rewrote `listKnownProjects()` to query `core.db` directly instead of scanning thousands of hash directories.

### `v2.3.2` — GUI Core Integration: Multi-Driver History (`session_drivers`), 0-Token Driver Briefing, Headless Driver Runner (`runDriverTurn`), 5-Harness Transcript Reader, Cross-Process Merge Lock & Orphan Task Recovery
- Added `session_drivers` table and driver lifecycle APIs (`attachDriver`, `setDriverHarnessSessionId`, `detachDriver`, `getActiveDriver`, `listDrivers`, `buildDriverBriefing`, `runDriverTurn`).
- Removed automatic hook session hijacking (CR-04), added `ASD_DRIVER_ID` hook binding, and enforced 10-minute TTL on `cli-recent.json` inference.
- Added `readHarnessTranscript` & `locateHarnessTranscript` (CR-10), `finalizeSubagentArtifacts` (CR-09), cross-process `.asd/merge.lock` (CR-11), `recoverOrphanedTasks` & atomic `tryClaimTask` (CR-12), state-dependent subagent `resume` with `follow_up_of` (CR-13), `PLAN.md` foreground session guards (CR-14), and scoped LIGHT rollback (CR-07).

### `v2.3.0` — 5th Harness (`Cursor CLI` / `@cr`), Skill Modernization, Test-File Permission Rule & `asd ui` Inspector Upgrade
- **5th Harness Support (`Cursor CLI` / `@cr`)**:
  - Added `CursorAdapter` (`src/adapters/cursor.ts`) supporting headless execution (`agent -p <prompt> --force --output-format json --model <model>`), `PreToolUse` / `Stop` hooks, and global synchronization under `~/.cursor/`.
- **Modernized & Differentiated All 6 Skills (`src/skills/*/SKILL.md`)**:
  - Upgraded `/asd`, `/asd-plan`, `/asd-run`, `/asd-debate`, `/asd-debug`, and `/handoff` (`/asd-handoff`), documenting Cross-Scope `autoCreatedTasks` (max 2) + `deferredCrossScopeRequests`.
- **Automatic Test File Write Permission & `claim_only` Subagent Audit Logs**:
  - Subagent `allowedFiles` in `src/mcp/server.ts` automatically permits creating/updating test files (`tests/**`, `**/*.test.ts`, `**/*.spec.ts`).
  - Dispatches in `claim_only` mode record structured `.asd/sessions/<sessionId>/subagents/<subSessionId>/{meta.json,prompt.md,output.log}` artifacts.
- **`asd ui` Task Log Selection Fix**:
  - Fixed a dashboard bug where clicking a task with 0 subagent logs fell back to displaying all session logs (`sessionLogs`).

### `523c3cb` — Cross-Scope File Request Auto-Scheduling & Caller File Bundling
- **Structured Subagent Cross-Scope Reporting (`asd-report`)**: Subagents emit a trailing `asd-report` JSON block containing `summary`, `key_decisions`, `risks`, and `cross_scope_requests`.
- **Automatic Next-Turn Follow-Up Task Creation (Cap: Max 2 per Subagent)**:
  - Up to **2** `cross_scope_requests` per subagent are automatically scheduled into `Turn + 1` (`T<next>.x`), bundling caller files and inheriting `dependsOn: [A, B]`.

### `8439636` — Real Harness Model Discovery & Searchable Model Picker Popover
- Removed all fallback dummy model arrays from `discoverHarnessModels` in `src/cli/dashboard.ts` and added a searchable model picker popover in `asd ui`.

### `ca879a4` — Official Claude Code `settings.json` Hook Schema Compatibility
- Updated `createClaudeHookConfig`, `isAsdManagedClaudeHook`, and `mergeClaudeSettings` to generate the official nested `{ matcher: "", hooks: [{ type: "command", command: "..." }] }` structure.

### `0b39793` — Per-Harness Model Discovery Modal (`2x2`), Dropdown Selectors & Debate Session Isolation
- Added a `2x2` **Available Models by Harness** modal in `asd ui` (`GET /api/models`) and isolated standalone `asd debate` runs into dedicated `<timestamp>-debate` sessions.

### `48d09a7` — Project-Scoped Routing Editor (`.asd/routing.jsonc`) & 4 Subagent Runtime Controls
- Added an in-dashboard **Routing Editor** (`GET/POST /api/routing`) and 4 runtime control actions (`kill`, `retry`, `fallback`, `custom`) on each subagent card in `asd ui`.

### `bec4abb` — Dashboard Session Grouping, `.asd` Persistent Memos & Subagent Log Inspection
- Grouped tasks, subagent runs, and debates by session in `asd ui` and added persistent per-session memos (`POST /api/session-memo`).

### `ebb4927` — 5 Core Agent Personas + 3 Difficulty Tiers & Zero-Token Debate Code Slice Injection
- Consolidated the agent roster into **5 core roles** (`planner`, `architect`, `worker`, `scout`, `critic`) and **3 difficulty tiers** (`low`, `medium`, `high`), and added Zero-Token Code Slice Injection (`--files`, `--include-diff`) in `asd debate`.

---

## 2. Security Audit Fixes, CLI Direct Execution & Multi-Harness Reliability

| Commit | Summary |
| :--- | :--- |
| `f9b2f4a` | **P0/P1 Audit Fixes**: Removed regex-only fake LSP fallback, hardened secret redaction and path boundary checks, and fixed sync edge cases. |
| `6375b6b` | **Non-TTY & NDJSON Fixes**: Fixed non-TTY stdin hang in CLI, unwrapped NDJSON debate verdicts, enforced internal subagents on `LIGHT` track, and synced per-harness routing models. |
| `be4ded9` | **Multi-Harness `/handoff` Skill**: Added `/handoff` (`/asd-handoff`) skill to generate `handoff.md` for seamless session continuation across harnesses. |
| `afb2ac2` | **Automatic Fallback Chain Stepping**: `asd dispatch` and `asd debate` automatically step through configured `fallbacks` on rate-limit, quota, network, or non-zero CLI exit errors. |
| `625ec4f` | **Default `LIGHT` Track & Pre-Flight Briefing**: Defaulted `LIGHT` track to current harness and added the mandatory single pre-flight briefing across all `/asd*` skills. |
| `73faca5` | **CLI Documentation**: Documented both global `PATH` (`asd ...`) and non-`PATH` (`node --no-warnings src/cli/index.ts ...`) execution modes. |
| `fde3a2a` | **Direct CLI Execution**: Removed unused `asd-core` MCP registration in favor of direct CLI execution to eliminate 60s MCP RPC timeouts (`-32001`). |
| `d3a9cd5` | **Direct CLI Orchestration Commands**: Added `asd plan`, `asd dispatch`, `asd verify`, and `asd debate` CLI subcommands. |
| `f31a13c` | **Harness Availability & Model Normalization**: Filtered uninstalled CLI harnesses at runtime, retried without `--model` on fallback, and normalized Antigravity model tiers. |
| `022e109` | **Dashboard i18n (KO/EN)**: Added Korean/English internationalization with locale auto-detection and header toggle buttons in `asd ui`. |
| `d278c40` | **Surgical Uninstaller**: Preserved user-added post-sync MCP servers by stripping only `_asdManaged` entries during `asd uninstall`. |
| `ddea901` / `928c89d` | **Antigravity MCP Sync**: Ensured `~/.gemini/config/mcp_config.json` is created and synchronized on fresh installs. |
| `3753c45` | **Global `PATH` Shim**: Auto-installed `asd` CLI shim to global `PATH` on `asd sync` (with `--no-path` opt-out). |
| `5af81b9` | **Zero-Dependency Web Dashboard (`asd ui`)**: Added local HTTP web dashboard (`src/cli/dashboard.ts`). |
| `c349129` | **`asd logs` & Windows `.cmd` Resolver**: Added `asd logs [taskId]`, Windows `.cmd` shim resolution, and `thinkingEffort` support. |
| `1d181ff` | **Core Refactor**: Simplified glob matcher and deduplicated harness command and MCP sync helpers. |
| `01388f9` / `383ac67` | **Documentation & License**: Renamed package to `agent-swarm-director`, added `README.md`, `README_ko.md`, and `FSL-1.1-ALv2` license. |

---

## 3. Initial v2.2 Core Foundation

| Commit | Summary |
| :--- | :--- |
| `2bca203` | Built-in `lsp` MCP server and capability-aware gap-filling MCP sync. |
| `d3e4679` | Initial CLI commands (`sync`, `status`, `clean`, `doctor`, `uninstall`), hook runner, and E2E installer tests. |
| `b6f32fe` | `asd-core` MCP server (`asd_plan`, `asd_dispatch`, `asd_verify`, `asd_debate`), subagent isolation guard, and live `progressBoard`. |
| `53000fa` | Zero-polling blind cross-model debate broker and automatic acceptance constraint injector (`src/core/debate.ts`). |
| `e3492a9` | Global-only idempotent installer, surgical uninstaller, and `<100ms` `asd doctor` health probe (`src/adapters/installer.ts`). |
| `2ca663e` | `LIGHT` checkpoint commits/rollbacks and `HEAVY` Git worktree lifecycle with process-internal merge mutex (`src/core/workspace.ts`). |
| `57908c8` | Case-normalized realpath policy guard, `1ms` `meta.json` `PreToolUse` boundary check, and Subagent Shield (`src/core/policy.ts`). |
| `772f948` | Multi-harness model router, `@ag` fallback, and cross-model diversity enforcement (`src/core/router.ts`). |
| `71ddbec` | `.asd/PLAN.md` inline renderer/parser, bidirectional sync (`syncPlanFromMd`), `progressBoard`, and session summary generator (`src/core/render.ts`). |
| `02df2e0` | 4 harness adapters: Claude Code, OpenCode, Codex CLI, and Antigravity (`src/adapters/`). |
| `a1fb198` | 3-table SQLite SSOT driver (`sessions`, `tasks`, `debates`) with WAL mode and `BEGIN IMMEDIATE` transactions (`src/core/db.ts`). |
| `9ba1140` | Subagent spawner with `meta.json` tracking, idle/wall-clock timeouts, and cross-platform process-tree kill (`src/core/spawner.ts`). |
| `b7cd956` | Default routing (`presets/default-routing.jsonc`), MCP catalog (`presets/default-mcp.jsonc`), and adapter tool manifest. |
| `f60db2c` | 2-path config resolution, case-normalized project hash, and local routing priority (`src/core/config.ts`). |
| `24504a6` | Async `StdioRpcServer` JSON-RPC transport with progress streaming (`src/mcp/stdio-rpc.ts`). |
| `873894e` | Zero-dependency JSONC parser/stripper, TOML fence manager, and secret redactor (`src/core/`). |
| `8eaf651` / `69d7423` | Core TypeScript types (`src/core/types.ts`), `package.json`, and `tsconfig.json` for Node.js `>=22.13.0` native TS execution. |
