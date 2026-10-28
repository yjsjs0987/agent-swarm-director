---
name: asd-run
description: Execution & resume workflow for ASD v2.2. Synchronizes .asd/PLAN.md, dispatches tasks across turns, and renders live progress boards.
---

# ASD v2.2 — Execution & Resume Workflow (`/asd-run`)

You are executing or resuming an existing `.asd/PLAN.md` across dependency turns (waves).

## 1. Mode Classification Criteria (`LIGHT` vs `HEAVY`)

Inspect `.asd/PLAN.md` and evaluate the pending waves:
- **Recommend `LIGHT` (Single-Harness Internal Subagent Delegation)** when:
  - Pending tasks are scoped to a few files or a single module and do not require separate Git worktrees.
  - Tasks should be delegated to the current harness's internal subagents (`asd-<role>`), which automatically use the current harness's highest-priority model from `routing.jsonc` (primary or fallback).
- **Recommend `HEAVY` (Multi-Harness External CLI & Git Worktree Execution)** when:
  - A wave has multiple large, independent tasks executing concurrently that benefit from isolated Git worktrees (`.asd/wt/<taskId>`) and external harness CLIs (`claude`, `opencode`, `codex`, `agy`).

## 2. Execution Protocol

1. **Step 1: Synchronize `.asd/PLAN.md` & Assess Mode**
   - Read `.asd/PLAN.md` and sync any manual user edits into SQLite:
     ```bash
     asd plan sync_from_md
     ```
     *(Alias `asd plan --from-markdown` is also supported.)*
   - Inspect the `progressBoard` and identify the next pending `turn`.

2. **Step 2: Mandatory User Confirmation Gate (With AI Recommendation)**
   - Unless the user already explicitly specified `LIGHT` or `HEAVY` in their command, present your AI recommendation (`LIGHT (Recommended)` or `HEAVY (Recommended)`) with a brief rationale and ask the user to confirm which mode to run before dispatching.

3. **Step 3: Dispatch Current Wave (`turn = N`)**
   - **If `LIGHT` Mode is Confirmed (Internal Subagent Delegation — NO External CLI Spawning)**:
     - **STRICT PROHIBITION**: Do **NOT** pass `--mode parallel_spawn`, and do **NOT** invoke external `opencode run`, `claude -p`, `codex exec`, or `agy` CLI processes via Bash.
     - If tasks in `.asd/PLAN.md` have `track: "HEAVY"`, update them to `track: "LIGHT"` and run `asd plan --from-markdown` first so `asd dispatch` does not auto-spawn external CLIs.
     - Register task claims in SQLite:
       ```bash
       asd dispatch --turn <N> --mode claim_only
       ```
     - For each task in the wave, delegate execution to the **current harness's internal subagent tool**:
       - **OpenCode**: Use the `task` tool with `subagent_type: "asd-<agent>"` (e.g., `asd-builder`, `asd-worker`, `asd-verifier`). OpenCode will automatically run the subagent using the model synced from `routing.jsonc` into `~/.config/opencode/agent/asd-<agent>.md`.
       - **Claude Code**: Use the `Agent` / `Task` tool with `subagent_type: "asd-<agent>"`.
       - **Antigravity**: Use `invoke_subagent` with the matching role and model tier.
       - **Codex CLI**: Use native subagent delegation or execute directly within `allowedFiles`.
   - **If `HEAVY` Mode is Confirmed (Multi-Harness External CLI & Worktree Spawn)**:
     - Spawn external harness CLIs in isolated Git worktrees:
       ```bash
       asd dispatch --turn <N> --mode parallel_spawn
       ```

4. **Step 4: Gate Verification (`asd verify`)**
   - After each task (or wave) finishes, run the verification gate:
     ```bash
     asd verify --task <T-ID> --cmd "<verificationCmd>"
     ```
   - Render the updated `progressBoard` after every wave.
   - If a task enters `QUARANTINED` or fails verification, report the failure reason and wait for user instructions or invoke `/asd-debug`.
