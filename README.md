# Agent Swarm Director (`agent-swarm-director` / ASD v2.4.1)

**English** | [한국어](./README_ko.md) | [🖥️ ASD-Nexus (Official GUI)](https://github.com/yjsjs0987/ASD-Nexus) | [🏛️ Architecture & Code Reference](./PROJECT_STATUS.md) | [🔌 External SDK & DB Reference](./EXTERNAL_SDK_REFERENCE.md) | [📋 Patch Notes](./PATCH_NOTES.md) | [📋 패치 노트 (KR)](./PATCH_NOTES_ko.md)

> **Zero-dependency universal multi-agent orchestration harness and SDK across Claude Code, OpenCode, Codex CLI, Antigravity, and Cursor CLI.**

Agent Swarm Director (**ASD v2.4.1**) is the universal multi-harness successor to `agy-agent-swarm-director`. Built purely on native Node.js (`>=22.13.0`) TypeScript execution and `node:sqlite` (WAL mode) with **zero external npm runtime dependencies**, ASD coordinates heterogeneous AI coding harnesses under a single deterministic control plane and exposes a full Node.js SDK for external GUI/IDE integration.

> [!TIP]
> ### 🖥️ Official Desktop / Web GUI Companion — **[ASD-Nexus](https://github.com/yjsjs0987/ASD-Nexus)**
> Looking for a full visual workspace to manage 5-harness CLI sessions, inspect 4-way structured transcripts (Thinking / Tool Use / Tool Result / Assistant), stream live multi-harness turns, and promote/demote ASD sessions with one click?  
> 👉 **[Visit the official GUI project: `yjsjs0987/ASD-Nexus`](https://github.com/yjsjs0987/ASD-Nexus)**

---

> [!IMPORTANT]
> ## 🚨 [For Legacy Users ≤ v2.3.2] Automatic SQLite DB Migration Tool
>
> Starting in **ASD v2.3.3 / v2.4.0**, the per-project hash DB layout (`~/.asd/state/<12-hex-hash>/core.db`) was unified into a **single shared SQLite SSOT (`~/.asd/state/core.db`)**.
>
> If you used **ASD v2.3.2 or earlier** and want to automatically migrate all existing sessions, tasks, debates, and drivers into the new shared DB (with automatic backup and idempotent safety), download and run the official migration tool below:
>
> ### 👉 **[📥 Download ASD DB Migration Tool (Google Drive)](https://drive.google.com/drive/u/0/folders/1knUQzIY8HDzIKYkxrhsCxgorQDn_B3nU)**
>
> ```bash
> # Run migration (automatically backs up shared DB before importing)
> node asd-db-migrate.mjs
>
> # Optional: rename migrated legacy hash folders to *.migrated after completion
> node asd-db-migrate.mjs --prune
> ```

---

## Key Features

- **Zero External Dependencies (`dependencies: {}`)**: Runs directly on Node.js `>=22.13.0` native TypeScript strip-types, `node:sqlite`, and standard library modules.
- **5-Harness Universal Control Plane**:
  - **Claude Code** (`claude`, `@cc`)
  - **OpenCode** (`opencode`, `@oc`)
  - **Codex CLI** (`codex`, `@cx`)
  - **Antigravity** (`agy`, `@ag`)
  - **Cursor CLI** (`agent` / `cursor-agent`, `@cr`)
- **Single Shared SQLite SSOT (`~/.asd/state/core.db`)**:
  - Consolidates all project sessions, tasks, debates, and multi-driver leases (`session_drivers`) into a single WAL-mode SQLite database scoped by `sessions.project_root`.
- **Bidirectional CLI ↔ ASD Session Management & Streaming SDK (v2.4.0)**:
  - **Project CLI Session Discovery (`discoverProjectCliSessions`)**: Discovers all local CLI sessions executed in a project across all 5 harnesses and links them against ASD sessions.
  - **4-Way Transcript Classification (`readHarnessTranscript`)**: Parses local harness transcripts into **Thinking**, **Tool Use**, **Tool Result**, and **User/Assistant Messages** across Claude Code, Codex, OpenCode (`opencode.db`), and Antigravity (`transcript.jsonl` + automatic `transcript_full.jsonl` fallback).
  - **Real-Time Streaming Turn Execution (`runDriverTurn`)**: Streams live `thinking`, `tool_use`, `tool_result`, and `assistant` events (`onEvent`) while executing interactive turns across harnesses.
  - **Promote & Demote (`promoteCliSessionToAsd` / `demoteAsdSession` / `asd resume`)**: Seamlessly promote any standalone CLI session into an ASD-managed session or demote an ASD session back to its native interactive CLI.
- **Capability-Aware Gap-Filling MCP Sync (`asd sync`)**:
  - Automatically installs global skills (`/asd`, `/asd-plan`, `/asd-run`, `/asd-debate`, `/asd-debug`, `/handoff` / `/asd-handoff`), 5 core specialist agent personas (`planner`, `architect`, `worker`, `scout`, `critic`), safety hooks (`PreToolUse`, `Stop`, Codex `notify`, Cursor `hooks.json`), and MCP servers into global user directories without polluting project repositories.
  - **Smart Deduplication**: Skips injecting MCP tools where a harness already has native built-in support or where the user already configured the MCP server.
- **Dual-Track Execution (`LIGHT` Single-Harness vs `HEAVY` Multi-Harness)**:
  - **LIGHT Track (Current Harness Mode)**: Small tasks are handled directly by the main AI in-place; multi-agent subtasks use internal subagents within the current harness (`claim_only`), followed by automatic git checkpoint commits and instant scoped rollback on test or boundary failure.
  - **HEAVY Track (Multi-Harness Concurrent Mode)**: Spawns multiple external harnesses concurrently in isolated Git worktrees (`.asd/wt/<turn>-<taskId>`) with automatic `node_modules` junction linking/unlinking and cross-process mutex-serialized (`.asd/merge.lock`) `--no-ff` merging.
- **Blind Cross-Model Adversarial Debate (`asd debate`)**:
  - Zero-polling parallel Round 1 critique across diverse model families (`claude`, `gpt`, `gemini`, `glm`) with zero-token code slice injection (`--files`, `--diff`), followed by Round 2 binding arbitration and automatic constraint injection into task acceptance criteria.
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
# 1. Synchronize all 5 harnesses globally & automatically register 'asd' on PATH
node --no-warnings src/cli/index.ts sync

# 2. Run 'asd' directly from ANY project directory
asd doctor
asd status
asd plan get
asd dispatch --turn 1
asd verify --task T1.1 --files "src/index.ts" --summary "Implemented feature"
asd debate --topic "Architecture" --proposal "Use SQLite WAL mode"
asd resume
asd logs
asd logs T1.1
asd ui

# 3. Run the isolated verification test suite
node scripts/run-tests.mjs
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
node --no-warnings src/cli/index.ts resume
node --no-warnings src/cli/index.ts logs
node --no-warnings src/cli/index.ts ui
```

---

## In-Editor AI Skill Commands (`/asd*`, `/handoff`)

Once `asd sync` has been run, you can invoke these slash skills directly inside your AI coding chat (**Claude Code**, **OpenCode**, **Codex CLI**, **Antigravity**, or **Cursor CLI**).

> **Single Pre-Flight Briefing Rule**: Before modifying any code or spawning external harnesses, every `/asd*` skill presents **one consolidated pre-flight briefing** that:
> 1. Summarizes the planned tasks, target files, and expected impact.
> 2. Asks whether to run in **`LIGHT` Mode (Current Harness Only)** or **`HEAVY` Mode (Multi-Harness Concurrent in isolated Git worktrees)**.
> 3. Bundles any clarifying questions into that single message.

| Skill Command | Purpose | Typical Workflow & Usage |
| :--- | :--- | :--- |
| **`/asd <request>`** | **End-to-End Autonomous Workflow** | Explores the codebase, presents a single pre-flight summary & `LIGHT`/`HEAVY` mode confirmation, generates `.asd/PLAN.md`, executes tasks wave-by-wave (`asd dispatch` & `asd verify`), displays the live `progressBoard`, and writes `.asd/summary.md`. |
| **`/asd-plan <request>`** | **Planning & Decomposition Only** | Read-only exploration of the codebase, single pre-plan briefing, and creates `.asd/PLAN.md` + SQLite task breakdown without modifying application code. |
| **`/asd-run`** | **Execute / Resume `.asd/PLAN.md`** | Reverse-syncs any manual edits from `.asd/PLAN.md` (`asd plan sync_from_md`), confirms execution mode (`LIGHT` vs `HEAVY`), and runs all pending `[ ]` or escalated `[~]` tasks across turns until completion. |
| **`/asd-debug <symptom>`** | **Hypothesis-Driven Debugging** | Investigates logs/stack traces read-only, presents a single pre-fix briefing, writes a deterministic failing reproduction test first (**Rule Zero**), applies the minimal fix, and verifies zero regressions via `asd verify`. |
| **`/asd-debate <topic>`** | **Adversarial Architecture Debate** | Summarizes the design proposal and runs blind cross-model critique (`HEAVY` multi-harness or `LIGHT` single-harness), synthesizes a binding verdict (`APPROVE` / `MINOR_AMEND` / `REJECT`), and injects hard constraints into `.asd/PLAN.md`. |
| **`/handoff`** (or **`/asd-handoff`**) | **Multi-Harness Session Handoff** | Inspects conversation history, git state, `.asd/PLAN.md`, and active SQLite session/task progress (`asd status`), then generates `handoff.md` so any of the 5 harnesses can seamlessly resume work in a new session. |

### Execution Mode Comparison (`LIGHT` vs `HEAVY`)

| Mode | How Tasks Are Executed | Workspace Isolation | Best For |
| :--- | :--- | :--- | :--- |
| **`LIGHT` (Current Harness)** | Small tasks are edited directly by the main AI; larger subtasks use native subagents inside the current harness (`claim_only`). Never spawns external harness CLIs. | In-place on clean baseline with automatic per-task checkpoint commit & scoped rollback. | Daily features, bug fixes, single-harness workflows, avoiding multi-harness quota usage. |
| **`HEAVY` (Multi-Harness)** | Spawns external harness CLIs (`claude`, `opencode`, `codex`, `cursor-agent`, `agy`) in parallel according to `routing.jsonc` (`parallel_spawn`). | Dedicated Git worktree per task (`.asd/wt/<turn>-<taskId>`) + mutex-locked merge. | Large full-stack features, parallel multi-domain implementation, cross-model blind review. |

---

## CLI Commands

> **Note:** If installed with `--no-path`, replace `asd <command>` with `node --no-warnings src/cli/index.ts <command>`.

| Command (with `PATH`) | Command (without `PATH`) | Description |
| :--- | :--- | :--- |
| `asd sync [--force] [--no-path]` | `node --no-warnings src/cli/index.ts sync [--force] [--no-path]` | Synchronizes global skills, 5 core agents, hooks, missing MCP tools across all 5 harnesses, and installs the `asd` CLI shim to global `PATH`. |
| `asd plan [create\|get\|update\|sync_from_md]` | `node --no-warnings src/cli/index.ts plan [create\|get\|update\|sync_from_md]` | Creates, queries, updates, or reverse-syncs `.asd/PLAN.md` with the 4-table SQLite SSOT (`~/.asd/state/core.db`). |
| `asd dispatch [--turn <n>] [--mode <m>]` | `node --no-warnings src/cli/index.ts dispatch [--turn <n>] [--mode <m>]` | Concurrently dispatches wave tasks (`parallel_spawn` or `claim_only`) with automatic upstream `DoneClaim` context injection and zero MCP timeout limits. |
| `asd verify --task <id> [--files <csv>]` | `node --no-warnings src/cli/index.ts verify --task <id> [--files <csv>]` | Enforces `allowedFiles` boundaries, secret redaction checks, test command verification, and LIGHT commit / HEAVY worktree merge. |
| `asd debate --topic <t> --proposal <p>` | `node --no-warnings src/cli/index.ts debate --topic <t> --proposal <p>` | Executes parallel blind cross-model critiques and synthesizes binding arbiter verdicts with real-time progress streaming. |
| `asd status [--json]` | `node --no-warnings src/cli/index.ts status [--json]` | Displays the current project's SQLite session state, live TODO progress board, and any unapplied auto-stash warnings. |
| `asd resume [--session <id>] [--print]` | `node --no-warnings src/cli/index.ts resume [--session <id>] [--print]` | Demotes the active ASD session (`demoteAsdSession`) and resumes the native interactive harness CLI (`--print` outputs the command string, `--json` outputs full metadata). |
| `asd logs [taskId] [--json]` | `node --no-warnings src/cli/index.ts logs [taskId] [--json]` | Displays the most recent subagent prompt & execution log automatically, or inspects a specific task (`T1.1`, `t1.2`, etc.). |
| `asd ui [--port <num>]` | `node --no-warnings src/cli/index.ts ui [--port <num>]` | Launches a zero-dependency bilingual (Korean/English) local web dashboard (`http://127.0.0.1:3847`) with fast disk-cached model discovery (`~/.asd/state/models-cache.json`). |
| `asd doctor [--json]` | `node --no-warnings src/cli/index.ts doctor [--json]` | Runs a fast (<100ms) zero-token health check (Node version, SQLite WAL, Git repo, 5 harness CLI binary paths, synthetic `PreToolUse` security probe). |
| `asd clean [--pop] [--all]` | `node --no-warnings src/cli/index.ts clean [--pop] [--all]` | Removes leftover `.asd/wt/*` worktrees, prunes `asd/*` branches, and optionally restores auto-stashed changes (`--pop`). |
| `asd uninstall` | `node --no-warnings src/cli/index.ts uninstall` | Surgically removes all ASD-managed global hooks, TOML fences, skills, agents, `PATH` shims, and `_asdManaged` MCP entries while preserving user configs 100%. |

---

## Documentation & Reference Guides

- 🏛️ **[Architecture & Per-File/Function Code Reference (`PROJECT_STATUS.md`)](./PROJECT_STATUS.md)** — Detailed architecture overview, 2-path storage & single DB layout, and per-file/per-function documentation across the entire codebase.
- 🔌 **[External SDK & Single DB Migration Reference (`EXTERNAL_SDK_REFERENCE.md`)](./EXTERNAL_SDK_REFERENCE.md)** — Complete SDK reference for `asd-gui` and external integrations (`discoverProjectCliSessions`, `readHarnessTranscript`, `runDriverTurn`, `promoteCliSessionToAsd`, `unlinkHarnessSessionFromAsdSession`, `buildSessionDemotion`, `listKnownProjects`).
- 🤖 **[AI Agent Workflow Prompt (`AI_WORKFLOW_PROMPT.md`)](./AI_WORKFLOW_PROMPT.md)** — Copy-and-paste onboarding & rules prompt for delegating tasks to AI coding agents.
- 📋 **[Patch Notes (English)](./PATCH_NOTES.md)** | **[패치 노트 (한국어)](./PATCH_NOTES_ko.md)** — Chronological changelog from initial foundation to v2.4.0.

---

## License

[Functional Source License, Version 1.1, Apache 2.0 Future License (FSL-1.1-ALv2)](./LICENSE) © 2026 yjsjs0987
