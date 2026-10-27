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
- **Dual-Track Execution (`LIGHT` Single-Harness vs `HEAVY` Multi-Harness)**:
  - **LIGHT Track (Current Harness Mode)**: Small tasks are handled directly by the main AI in-place; multi-agent subtasks use internal subagents within the current harness (`claim_only`), followed by automatic git checkpoint commits and instant rollback on test or boundary failure.
  - **HEAVY Track (Multi-Harness Concurrent Mode)**: Spawns multiple external harnesses (Claude Code, OpenCode, Codex) concurrently in isolated Git worktrees (`.asd/wt/<turn>-<taskId>`) with automatic `node_modules` junction linking/unlinking and mutex-serialized `--no-ff` merging.
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

## In-Editor AI Skill Commands (`/asd*`)

Once `asd sync` has been run, you can invoke these 5 slash skills directly inside your AI coding chat (**Claude Code**, **OpenCode**, **Codex CLI**, or **Antigravity**).

> **Single Pre-Flight Briefing Rule**: Before modifying any code or spawning external harnesses, every `/asd*` skill presents **one consolidated pre-flight briefing** that:
> 1. Summarizes the planned tasks, target files, and expected impact.
> 2. Asks whether to run in **`LIGHT` Mode (Current Harness Only — main AI directly for small tasks or internal subagents within the current harness)** or **`HEAVY` Mode (Multi-Harness Concurrent — parallel execution across external harnesses in isolated Git worktrees)**.
> 3. Bundles any clarifying questions into that single message.

| Skill Command | Purpose | Typical Workflow & Usage |
| :--- | :--- | :--- |
| **`/asd <request>`** | **End-to-End Autonomous Workflow** | Explores the codebase, presents a single pre-flight summary & `LIGHT`/`HEAVY` mode confirmation, generates `.asd/PLAN.md`, executes tasks wave-by-wave (`asd dispatch` & `asd verify`), displays the live `progressBoard`, and writes `.asd/summary.md`. |
| **`/asd-plan <request>`** | **Planning & Decomposition Only** | Read-only exploration of the codebase, single pre-plan briefing (asking `LIGHT` vs `HEAVY` preference and any clarifying questions), and creates `.asd/PLAN.md` + SQLite task breakdown without modifying application code. You can review or edit `.asd/PLAN.md` before running `/asd-run`. |
| **`/asd-run`** | **Execute / Resume `.asd/PLAN.md`** | Reverse-syncs any manual edits from `.asd/PLAN.md` (`asd plan sync_from_md`), confirms execution mode (`LIGHT` vs `HEAVY`), and runs all pending `[ ]` or escalated `[~]` tasks across turns until completion. |
| **`/asd-debug <symptom>`** | **Hypothesis-Driven Debugging** | Investigates logs/stack traces read-only, presents a single pre-fix briefing (root-cause hypothesis, reproduction plan, and `LIGHT` vs `HEAVY` selection), writes a deterministic failing reproduction test first (**Rule Zero**), applies the minimal fix, and verifies zero regressions via `asd verify`. |
| **`/asd-debate <topic>`** | **Adversarial Architecture Debate** | Summarizes the design proposal and asks whether to run across **multiple harnesses** (`HEAVY` blind cross-model critique across Claude, GPT, GLM, Gemini) or **single harness** (`LIGHT` via `--harness <current>`), synthesizes a binding verdict (`APPROVE` / `MINOR_AMEND` / `REJECT`), and injects hard constraints into `.asd/PLAN.md`. |

### Execution Mode Comparison (`LIGHT` vs `HEAVY`)

| Mode | How Tasks Are Executed | Workspace Isolation | Best For |
| :--- | :--- | :--- | :--- |
| **`LIGHT` (Current Harness)** | Small tasks are edited directly by the main AI; larger subtasks use native subagents inside the current harness (`claim_only`). Never spawns external harness CLIs. | In-place on clean baseline with automatic per-task checkpoint commit & rollback. | Daily features, bug fixes, single-harness workflows, avoiding multi-harness quota usage. |
| **`HEAVY` (Multi-Harness)** | Spawns external harness CLIs (`claude`, `opencode`, `codex`) in parallel according to `routing.jsonc` (`parallel_spawn`). | Dedicated Git worktree per task (`.asd/wt/<turn>-<taskId>`) + mutex-locked merge. | Large full-stack features, parallel multi-domain implementation, cross-model blind review. |

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
