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
- **Blind Cross-Model Adversarial Debate (`asd_debate`)**:
  - Zero-polling parallel Round 1 critique across diverse model families (`claude`, `gpt`, `gemini`, `glm`) followed by Round 2 binding arbitration and automatic constraint injection into task acceptance criteria.
- **1ms Fail-Closed Policy Guard & Subagent Shield**:
  - Case-normalized realpath boundary enforcement blocking unauthorized edits and protected paths (`.git/`, `.asd/`, `.env*`, `*.pem`, `*.key`).
  - Subagent Shield prevents infinite stop-hook loops and blocks subagents from calling orchestration tools.

---

## Requirements

- **Node.js**: `>=22.13.0`
- **Git**: `>=2.30.0`

---

## Quick Start

```bash
# 1. Initial install: synchronize harnesses globally & automatically register 'asd' on PATH
node --no-warnings src/cli/index.ts sync
# (Optional: pass --no-path if you do not want 'asd' added to global PATH)
# node --no-warnings src/cli/index.ts sync --no-path

# 2. From now on, run 'asd' directly from ANY project directory!
asd doctor
asd status
asd logs
asd logs T1.1
asd ui

# 3. Run the full verification test suite
npm test
```

---

## CLI Commands

| Command | Description |
| :--- | :--- |
| `asd sync [--force] [--no-path]` | Synchronizes global skills, 10 agents, hooks, missing MCP tools, and installs the `asd` CLI shim to global `PATH` (use `--no-path` to skip `PATH` installation). |
| `asd status` | Displays the current project's SQLite session state, live TODO progress board, and any unapplied auto-stash warnings. |
| `asd logs [taskId] [--json]` | Displays the most recent subagent prompt & execution log automatically, or inspects a specific task (`T1.1`, `t1.2`, etc.). |
| `asd ui [--port <num>]` | Launches a zero-dependency local web dashboard (`http://127.0.0.1:3847`) with live task cards, click-to-inspect subagent logs, and debate verdicts. |
| `asd doctor [--json]` | Runs a fast (<100ms) zero-token health check (Node version, SQLite WAL, Git repo, harness CLI binary paths & headless support, synthetic `PreToolUse` security probe). |
| `asd clean [--pop]` | Removes leftover `.asd/wt/*` worktrees, prunes `asd/*` branches, and optionally restores auto-stashed changes (`--pop`). |
| `asd uninstall` | Surgically removes all ASD-managed global hooks, TOML fences, skills, agents, and MCP entries while restoring original user configs 100%. |

---

## Built-in MCP Servers & Tools

### 1. `asd-core` (`src/mcp/server.ts`)
- `asd_plan`: Create, read, update, or reverse-sync `.asd/PLAN.md` with the 3-table SQLite SSOT (`sessions`, `tasks`, `debates`).
- `asd_dispatch`: Concurrently spawn wave tasks (`parallel_spawn` or `claim_only`) with automatic upstream `DoneClaim` context injection.
- `asd_verify`: Enforce `allowedFiles` boundaries, secret redaction checks, test command verification, and LIGHT commit / HEAVY worktree merge.
- `asd_debate`: Execute parallel blind cross-model critiques and synthesize binding arbiter verdicts.

### 2. `asd-lsp` (`src/mcp/lsp-server.ts`)
Automatically provided to harnesses without native CLI LSP:
- `lsp_diagnostics`: Structured static type and syntax diagnostics (`tsc`, `node --check`, conflict marker detection).
- `lsp_symbols`: Symbol declaration extraction (`function`, `class`, `interface`, `type`, `variable`, `struct`).
- `lsp_definition`: Exact symbol definition lookup (`file`, `line`, `column`).
- `lsp_references`: Project-wide symbol reference search (`file`, `line`, `column`, `isDefinition`).

---

## License

[Functional Source License, Version 1.1, Apache 2.0 Future License (FSL-1.1-ALv2)](./LICENSE) © 2026 yjsjs0987
