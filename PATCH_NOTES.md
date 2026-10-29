# Patch Notes (`agent-swarm-director` / ASD v2.3)

**English** | [한국어](./PATCH_NOTES_ko.md) | [📖 Back to README](./README.md)

Complete chronological patch history for **Agent Swarm Director (ASD v2.3)**, organized from the latest updates to the initial foundation.

---

## 1. Latest Orchestration, Dashboard & Cross-Harness Enhancements (v2.3.0)

### `v2.3.0` — 5th Harness (`Cursor CLI` / `@cr`), Skill Modernization, Test-File Permission Rule & `asd ui` Inspector Upgrade
- **5th Harness Support (`Cursor CLI` / `@cr`)**:
  - Added `CursorAdapter` (`src/adapters/cursor.ts`) supporting headless execution (`agent -p <prompt> --force --output-format json --model <model>`), `PreToolUse` / `Stop` hooks, and global synchronization under `~/.cursor/` (`agents/`, `skills/`, `hooks.json`, `mcp.json`, `cli-config.json`).
  - Wired `cursor` across `src/core/router.ts`, `src/core/debate.ts`, `src/adapters/installer.ts`, `src/core/policy.ts`, `src/mcp/server.ts`, `src/cli/index.ts`, and `src/cli/dashboard.ts`.
- **Modernized & Differentiated All 6 Skills (`src/skills/*/SKILL.md`)**:
  - Upgraded `/asd`, `/asd-plan`, `/asd-run`, `/asd-debate`, `/asd-debug`, and `/handoff` (`/asd-handoff`) to v2.3, eliminating legacy role names (`builder`, `analyst`, `verifier`), deduplicating boilerplate, and documenting Cross-Scope `autoCreatedTasks` (max 2) + `deferredCrossScopeRequests`.
- **Automatic Test File Write Permission & `claim_only` Subagent Audit Logs**:
  - Subagent `allowedFiles` in `src/mcp/server.ts` now automatically permits creating/updating test files (`tests/**`, `**/*.test.ts`, `**/*.spec.ts`) so agents can keep tests aligned with code changes during verification.
  - Dispatches in `claim_only` mode now record structured `.asd/sessions/<sessionId>/subagents/<subSessionId>/{meta.json,prompt.md,output.log}` artifacts and update them upon `asd verify`.
- **`asd ui` Task Log Selection Fix**:
  - Fixed a dashboard bug where clicking a task with 0 subagent logs fell back to displaying all session logs (`sessionLogs`).

### `523c3cb` — Cross-Scope File Request Auto-Scheduling & Caller File Bundling
- **Structured Subagent Cross-Scope Reporting (`asd-report`)**: Subagents are now instructed via `buildPromptForTask` not to directly touch files outside their `Allowed Target Files` (which are blocked by `PreToolUse`). Instead, they emit a trailing `asd-report` JSON block containing `summary`, `key_decisions`, `risks`, and `cross_scope_requests`.
- **Automatic Next-Turn Follow-Up Task Creation (Cap: Max 2 per Subagent)**:
  - Up to **2** `cross_scope_requests` per subagent are automatically scheduled into `Turn + 1` (`T<next>.x`).
  - **Caller A File Bundling**: Each auto-created follow-up task bundles the requested external `target_file` together with up to 2 relevant files from the requesting subagent (`caller_files` or actual git-modified `changedFiles` from `verifyAndMergeHeavyTask` / `verifyAndCommitLightTask`) so the follow-up agent can update both definition and caller sites together.
  - **Automatic `dependsOn: [A, B]` & Role Inheritance**: Automatically detects which task (`B`) owns `target_file` in the current or earlier turns, sets `dependsOn` to wait for both `A` and `B`, and inherits `B`'s `role` and `category`.
- **Main Agent Escalation for Excess Requests**: Any requests beyond 2 per subagent (or exceeding chain depth 2) are returned in `deferredCrossScopeRequests` and highlighted under `⚠️ 메인 에이전트 판단 필요 (보류된 Cross-Scope 요청)` on the `progressBoard` for Main Director review.

### `8439636` — Real Harness Model Discovery & Searchable Model Picker Popover
- **Zero Hardcoded Dummy Models**: Removed all fallback dummy model arrays from `discoverHarnessModels` in `src/cli/dashboard.ts`. Model lists now load strictly from real harness sources:
  - **Antigravity (`agy`)**: Parses `agy models` CLI output directly.
  - **Claude Code (`claude`)**: Combines local usage/settings models (`~/.claude/projects/**/*.jsonl`, `settings.json`) and live OpenAI-compatible `/v1/models` endpoints when `ANTHROPIC_BASE_URL` is configured.
  - **Codex CLI (`codex`)**: Reads `~/.codex/models_cache.json` (`slug` / `display_name`) and `config.toml`.
  - **OpenCode (`opencode`)**: Executes `opencode models` (increased `maxBuffer` and timeout so all 80+ models load without truncation).
- **Searchable Model Picker Popover**: Replaced plain `<select>` dropdowns in the **Project Routing Editor (`.asd/routing.jsonc`)** and **Custom Model Rerun (`custom`)** controls with a custom popover button + compact real-time search input (`filterModelPicker`).

### `ca879a4` — Official Claude Code `settings.json` Hook Schema Compatibility
- Updated `createClaudeHookConfig`, `isAsdManagedClaudeHook`, and `mergeClaudeSettings` in `src/adapters/claude-code.ts` and `src/adapters/installer.ts` to generate the official nested `{ matcher: "", hooks: [{ type: "command", command: "..." }] }` structure required by Claude Code.
- Automatically strips legacy flat hook entries during `asd sync` and `asd uninstall` while preserving user-defined hooks.

### `0b39793` — Per-Harness Model Discovery Modal (`2x2`), Dropdown Selectors & Debate Session Isolation
- Added a `2x2` **Available Models by Harness** modal in `asd ui` (`GET /api/models`) with click-to-copy model badges.
- Isolated standalone `asd debate` runs into dedicated `<timestamp>-debate` sessions when `--task` is omitted, preventing standalone debates from polluting active coding session history.

### `48d09a7` — Project-Scoped Routing Editor (`.asd/routing.jsonc`) & 4 Subagent Runtime Controls
- Added an in-dashboard **Routing Editor** (`GET/POST /api/routing`) that saves project-level agent and category routing overrides to `.asd/routing.jsonc`.
- Added 4 runtime control actions (`POST /api/subagent/control`) on each subagent card in `asd ui`:
  1. **`kill`**: Terminates a running subagent process tree immediately (`killProcessTree`) and cleans up its worktree.
  2. **`retry`**: Reruns the task using the same harness and model.
  3. **`fallback`**: Reruns the task using the next fallback route defined in `routing.jsonc`.
  4. **`custom`**: Reruns the task on a user-selected harness and model.

### `bec4abb` — Dashboard Session Grouping, `.asd` Persistent Memos & Subagent Log Inspection
- Grouped tasks, subagent runs, and debates by session in `asd ui` with a collapsible session selector.
- Added persistent per-session memos (`POST /api/session/memo`) saved to both SQLite (`sessions.memo`) and `.asd/sessions/<sessionId>/main.json`.
- Added an interactive modal in `asd ui` (`GET /api/subagent-log`) to inspect full `prompt.md`, `output.log`, and `DoneClaim` results for any subagent.

### `ebb4927` — 5 Core Agent Personas + 3 Difficulty Tiers & Zero-Token Debate Code Slice Injection
- Consolidated the agent roster into **5 core roles** (`planner`, `architect`, `worker`, `scout`, `critic`) and **3 difficulty tiers** (`low`, `medium`, `high`).
- Added **Zero-Token Code Slice Injection** (`--files "path:start-end"` and `--include-diff`) in `asd debate` (`src/core/debate.ts`) so debate critics evaluate ground-truth source code and `git diff HEAD` directly in the prompt without spending tool-call turns.

---

## 2. Security Audit Fixes, CLI Direct Execution & Multi-Harness Reliability

| Commit | Summary |
| :--- | :--- |
| `f9b2f4a` | **P0/P1 Audit Fixes**: Removed regex-only fake LSP fallback, hardened secret redaction and path boundary checks, and fixed sync edge cases. |
| `6375b6b` | **Non-TTY & NDJSON Fixes**: Fixed non-TTY stdin hang in CLI, unwrapped NDJSON debate verdicts, enforced internal subagents on `LIGHT` track, and synced per-harness routing models. |
| `be4ded9` | **Multi-Harness `/handoff` Skill**: Added `/handoff` (`/asd-handoff`) skill to generate `handoff.md` for seamless session continuation across Claude Code, OpenCode, Codex CLI, and Antigravity. |
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
| `2bca203` | Built-in `lsp` MCP server (`src/mcp/lsp-server.ts`) and capability-aware gap-filling MCP sync. |
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
