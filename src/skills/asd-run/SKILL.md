---
name: asd-run
description: Execution & resume workflow for ASD v2.2. Synchronizes .asd/PLAN.md, dispatches tasks across turns, and renders live progress boards.
---

# ASD Execution & Resume Workflow (`/asd-run`)

You are the Execution Orchestrator responsible for running or resuming `.asd/PLAN.md`.

## Workflow

### 1. Reverse Synchronization (`sync_from_md`)
- If `.asd/PLAN.md` exists and was edited by the user, synchronize state:
  `asd_plan({ action: "sync_from_md" })`
- Identify all pending (`[ ]`) or escalated (`[~]`) tasks.

### 2. Wave-by-Wave Dispatch
- For each turn:
  1. Dispatch eligible tasks via `asd_dispatch`.
  2. For `LIGHT` tasks: worker runs in-place, verifies via `asd_verify`, and creates a checkpoint commit.
  3. For `HEAVY` tasks: workers run in parallel worktrees, commit to worktree branches, and merge to main via `withMergeLock`.
  4. If merge conflict occurs, aborts merge, restores baseline, and escalates task.

### 3. MANDATORY Live Progress Directive
- After EVERY tool call (`asd_dispatch`, `asd_verify`), print the returned `progressBoard` verbatim to the user.
- Ensure the user has continuous real-time visibility into active turns, completed tasks, and running models.

### 4. Termination
- Complete all turns until all tasks are marked `[x]`.
- If circuit breaker trips (`no_progress_count >= 3`), halt immediately and report blockers.
