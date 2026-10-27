---
name: asd-run
description: Execution & resume workflow for ASD v2.2. Synchronizes .asd/PLAN.md, dispatches tasks across turns, and renders live progress boards.
---

# ASD Execution & Resume Workflow (`/asd-run`)

You are the Execution Orchestrator responsible for running or resuming `.asd/PLAN.md`.

## Workflow

### 0. Single Pre-Execution Briefing & Mode Confirmation (MANDATORY)
- Before dispatching tasks or modifying any code, inspect `.asd/PLAN.md` (`asd plan sync_from_md`) and present **one consolidated briefing** to the user (unless autonomous execution was explicitly requested):
  1. **Pending Tasks Summary**: List the pending (`[ ]`) or escalated (`[~]`) tasks and target files to be executed.
  2. **Multi-Harness Confirmation (`LIGHT` vs `HEAVY`)**:
     - Confirm whether to execute using:
       - **`LIGHT` (Current Harness Only)**: Small tasks handled directly by the main AI in-place; multi-agent tasks handled via internal subagents within the current harness (`asd dispatch --turn <N> --mode claim_only`).
       - **`HEAVY` (Multi-Harness Concurrent)**: Spawn external harnesses concurrently in isolated worktrees (`asd dispatch --turn <N> --mode parallel_spawn`).
  3. **Questions (if any)**: Ask any final execution questions in this same single message.

### 1. Reverse Synchronization (`sync_from_md`)
- If `.asd/PLAN.md` exists and was edited by the user, synchronize state via terminal CLI:
  ```bash
  asd plan sync_from_md
  ```
- Identify all pending (`[ ]`) or escalated (`[~]`) tasks.

### 2. Wave-by-Wave Dispatch (via `asd dispatch` & `asd verify` CLI)
- Run `asd` CLI commands directly in the terminal to avoid MCP 60s request timeouts:
  1. Dispatch eligible tasks for the current turn:
     ```bash
     asd dispatch --turn <N>
     ```
     - **`LIGHT` tasks** automatically default to `claim_only` on the current harness: handle small tasks directly in the main AI (or delegate to native host subagents for larger tasks), then verify via:
       ```bash
       asd verify --task <taskId> --files "<file1,file2>" --summary "<summary>"
       ```
     - **`HEAVY` tasks** run in parallel worktrees across multiple harnesses, commit to worktree branches, and merge to main via `withMergeLock`. (If the user requested single-harness execution for all tasks, pass `--mode claim_only` or `--harness <currentHarness>`).
  2. If merge conflict occurs, aborts merge, restores baseline, and escalates task.

### 3. MANDATORY Live Progress Directive
- After EVERY tool/CLI call (`asd dispatch`, `asd verify`), print the returned `progressBoard` verbatim to the user.
- Ensure the user has continuous real-time visibility into active turns, completed tasks, and running models.

### 4. Termination
- Complete all turns until all tasks are marked `[x]`.
- If circuit breaker trips (`no_progress_count >= 3`), halt immediately and report blockers.
