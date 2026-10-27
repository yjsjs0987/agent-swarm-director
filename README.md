# Agent Swarm Director (`agent-swarm-director` / ASD v2.2)

**English** | [한국어](./README_ko.md)

> **Zero-dependency universal multi-agent orchestration harness across Claude Code, OpenCode, Codex CLI, and Antigravity.**

Agent Swarm Director (**ASD v2.2**) is the universal multi-harness successor to `agy-agent-swarm-director`. Built purely on native Node.js (`>=22.13.0`) TypeScript execution and `node:sqlite` (WAL mode) with **zero external npm runtime dependencies**, ASD coordinates heterogeneous AI coding harnesses under a single deterministic control plane.

---

## Key Features

- **Zero External Dependencies (`dependencies: {}`)**: Runs directly on Node.js `>=22.13.0` native TypeScript strip-types, `node:sqlite`, and standard library modules.
- **4-Harness Universal Control Plane**:
  - **Claude Code** (`claude`)
  - **OpenCode** (`opencode`)
  - **Codex CLI** (`codex`)
  - **Antigravity** (`agy`)
- **Capability-Aware Gap-Filling MCP Sync (`asd sync`)**:
  - Automatically installs global skills (`/asd`, `/asd-plan`, `/asd-run`, `/asd-debate`, `/asd-debug`), 10 specialist agent personas, safety hooks (`PreToolUse`, `Stop`), and MCP servers into global user directories without polluting project repositories.
  - **Smart Deduplication**: Skips injecting MCP tools where a harness already has native built-in support (e.g., skips `lsp` on OpenCode; skips `websearch` on Claude Code, Codex, and Antigravity) or where the user already configured the MCP server.
- **Dual-Track Workspace Isolation**:
  - **LIGHT Track**: Fast in-place execution with automatic git checkpoint commits and instant rollback on test or boundary failure.
  - **HEAVY Track**: Isolated Git worktrees (`.asd/wt/<taskId>`) with automatic `node_modules` junction linking/unlinking and mutex-serialized `--no-ff` merging.
- **Blind Cross-Model Adversarial Debate (`asd debate`)**:
  - Zero-polling parallel Round 1 critique across diverse model families (`claude`, `gpt`, `gemini`, `glm`) followed by Round 2 binding arbitration and automatic constraint injection into task acceptance criteria—executed directly via CLI to bypass 60s MCP request timeouts.
- **1ms Fail-Closed Policy Guard & Subagent Shield**:
  - Case-normalized realpath boundary enforcement blocking unauthorized edits and protected paths (`.git/`, `.asd/`, `.env*`, `*.pem`, `*.key`).
  - Subagent Shield prevents infinite stop-hook loops and blocks subagents from calling orchestration tools.

---

## Requirements

- **Node.js**: `>=22.13.0`
- **Git**: `>=2.30.0`

---

## Quick Start

### A. With Global `PATH` Registration (Default)
```bash
# 1. Synchronize harnesses globally & automatically register 'asd' on PATH
node --no-warnings src/cli/index.ts sync

# 2. Run 'asd' directly from ANY project directory
asd doctor
asd status
asd plan get
asd dispatch --turn 1
asd verify --task T1.1 --files "src/index.ts" --summary "Implemented feature"
asd debate --topic "Architecture" --proposal "Use SQLite WAL mode"
asd logs
asd logs T1.1
asd ui

# 3. Run the full verification test suite
npm test
```

### B. Without Global `PATH` Registration (`--no-path`)
```bash
# 1. Synchronize harnesses globally without modifying global PATH
node --no-warnings src/cli/index.ts sync --no-path

# 2. Run commands via Node.js directly
node --no-warnings src/cli/index.ts doctor
node --no-warnings src/cli/index.ts status
node --no-warnings src/cli/index.ts plan get
node --no-warnings src/cli/index.ts dispatch --turn 1
node --no-warnings src/cli/index.ts verify --task T1.1 --files "src/index.ts" --summary "Implemented feature"
node --no-warnings src/cli/index.ts debate --topic "Architecture" --proposal "Use SQLite WAL mode"
node --no-warnings src/cli/index.ts logs
node --no-warnings src/cli/index.ts logs T1.1
node --no-warnings src/cli/index.ts ui
```

---

## CLI Commands

> **Note:** If installed with `--no-path`, replace `asd <command>` with `node --no-warnings src/cli/index.ts <command>`.

| Command (with `PATH`) | Command (without `PATH`) | Description |
| :--- | :--- | :--- |
| `asd sync [--force] [--no-path]` | `node --no-warnings src/cli/index.ts sync [--force] [--no-path]` | Synchronizes global skills, 10 agents, hooks, missing MCP tools, and installs the `asd` CLI shim to global `PATH` (`--no-path` skips `PATH` shim installation). |
| `asd plan [create\|get\|update\|sync_from_md]` | `node --no-warnings src/cli/index.ts plan [create\|get\|update\|sync_from_md]` | Creates, queries, updates, or reverse-syncs `.asd/PLAN.md` with the 3-table SQLite SSOT (`sessions`, `tasks`, `debates`). |
| `asd dispatch [--turn <n>] [--mode <m>]` | `node --no-warnings src/cli/index.ts dispatch [--turn <n>] [--mode <m>]` | Concurrently dispatches wave tasks (`parallel_spawn` or `claim_only`) with automatic upstream `DoneClaim` context injection and zero MCP timeout limits. |
| `asd verify --task <id> [--files <csv>]` | `node --no-warnings src/cli/index.ts verify --task <id> [--files <csv>]` | Enforces `allowedFiles` boundaries, secret redaction checks, test command verification, and LIGHT commit / HEAVY worktree merge. |
| `asd debate --topic <t> --proposal <p>` | `node --no-warnings src/cli/index.ts debate --topic <t> --proposal <p>` | Executes parallel blind cross-model critiques and synthesizes binding arbiter verdicts with real-time progress streaming. |
| `asd status [--json]` | `node --no-warnings src/cli/index.ts status [--json]` | Displays the current project's SQLite session state, live TODO progress board, and any unapplied auto-stash warnings. |
| `asd logs [taskId] [--json]` | `node --no-warnings src/cli/index.ts logs [taskId] [--json]` | Displays the most recent subagent prompt & execution log automatically, or inspects a specific task (`T1.1`, `t1.2`, etc.). |
| `asd ui [--port <num>]` | `node --no-warnings src/cli/index.ts ui [--port <num>]` | Launches a zero-dependency bilingual (Korean/English) local web dashboard (`http://127.0.0.1:3847`) with live task cards, subagent logs, and debate verdicts. |
| `asd doctor [--json]` | `node --no-warnings src/cli/index.ts doctor [--json]` | Runs a fast (<100ms) zero-token health check (Node version, SQLite WAL, Git repo, harness CLI binary paths & headless support, synthetic `PreToolUse` security probe). |
| `asd clean [--pop] [--all]` | `node --no-warnings src/cli/index.ts clean [--pop] [--all]` | Removes leftover `.asd/wt/*` worktrees, prunes `asd/*` branches, and optionally restores auto-stashed changes (`--pop`). |
| `asd uninstall` | `node --no-warnings src/cli/index.ts uninstall` | Surgically removes all ASD-managed global hooks, TOML fences, skills, agents, `PATH` shims, and `_asdManaged` MCP entries while preserving user configs 100%. |

---

## Built-in Code Intelligence & Gap-Filling MCP Servers

All long-running orchestration actions (`plan`, `dispatch`, `verify`, `debate`) run directly via the `asd` CLI to eliminate 60-second MCP RPC timeouts (`-32001`). For fast read-only lookups, `asd sync` automatically fills in only the MCP servers missing from each harness:

### 1. `lsp` (`src/mcp/lsp-server.ts`)
Automatically provided to harnesses without native CLI LSP (skipped on OpenCode, which has native LSP):
- `lsp_diagnostics`: Structured static type and syntax diagnostics (`tsc`, `node --check`, conflict marker detection).
- `lsp_symbols`: Symbol declaration extraction (`function`, `class`, `interface`, `type`, `variable`, `struct`).
- `lsp_definition`: Exact symbol definition lookup (`file`, `line`, `column`).
- `lsp_references`: Project-wide symbol reference search (`file`, `line`, `column`, `isDefinition`).

### 2. Gap-Filling Knowledge MCPs (`presets/default-mcp.jsonc`)
- `context7` (`https://mcp.context7.com/mcp`): Up-to-date official library and framework documentation lookup.
- `grep_app` (`https://mcp.grep.app/mcp`): Fast regex and code search across public GitHub repositories.
- `websearch` (`https://mcp.exa.ai/mcp`): Real-time Exa web search (automatically skipped on harnesses with native web search such as Claude Code, Codex, and Antigravity).

---

## License

[Functional Source License, Version 1.1, Apache 2.0 Future License (FSL-1.1-ALv2)](./LICENSE) © 2026 yjsjs0987
