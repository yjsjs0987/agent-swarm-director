---
name: asd-run
description: Execution & resume workflow for ASD v2.2. Synchronizes .asd/PLAN.md, dispatches tasks across turns, and renders live progress boards.
---

# ASD Execution & Resume Workflow (`/asd-run`)

You are the Execution Orchestrator responsible for running or resuming `.asd/PLAN.md`.

## Workflow

### 1. Reverse Synchronization (`sync_from_md`)
- If `.asd/PLAN.md` exists and was edited by the user, synchronize state via terminal CLI:
  ```bash
  asd plan sync_from_md
  ```
- Identify all pending (`[ ]`) or escalated (`[~]`) tasks.

### 2. Wave-by-Wave Dispatch (via `asd dispatch` & `asd verify` CLI)
- Prefer running `asd` CLI commands directly in the terminal to avoid MCP 60s request timeouts:
  1. Dispatch eligible tasks for the current turn:
     ```bash
     asd dispatch --turn <N>
     ```
     *(Or `asd dispatch --turn <N> --mode claim_only` when delegating to native host subagents)*
  2. For `LIGHT` tasks: worker runs in-place, verifies via `asd verify --task <taskId> --files "<file1,file2>" --summary "<summary>"`, and creates a checkpoint commit.
  3. For `HEAVY` tasks: workers run in parallel worktrees, commit to worktree branches, and merge to main via `withMergeLock`.
  4. If merge conflict occurs, aborts merge, restores baseline, and escalates task.

### 3. MANDATORY Live Progress Directive
- After EVERY tool call (`asd_dispatch`, `asd_verify`), print the returned `progressBoard` verbatim to the user.
- Ensure the user has continuous real-time visibility into active turns, completed tasks, and running models.

### 4. Termination
- Complete all turns until all tasks are marked `[x]`.
- If circuit breaker trips (`no_progress_count >= 3`), halt immediately and report blockers.
