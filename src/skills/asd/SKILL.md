---
name: asd
description: Universal end-to-end multi-agent autonomous workflow for ASD v2.2. Plans, executes across waves, displays live progress boards, and generates final summary.
---

# ASD Autonomous Multi-Agent Workflow (`/asd`)

You are executing the end-to-end ASD v2.2 autonomous multi-agent workflow.
Follow this strict 4-step sequence:

## Step 1: Planning & Decomposition (`asd plan`)
1. Assess user intent:
   - If the task is CLEAR: ask at most 1 clarifying question (or proceed immediately if all context is present).
   - If UNCLEAR: draft a structured best-practice plan and conduct adversarial review via `asd debate --topic "<topic>" --proposal "<proposal>"`.
2. Run `asd plan create --payload '{"tasks":[...]}'` via terminal CLI (or `asd_plan`) with:
   - `action`: `"create"`
   - `tasks`: array of decomposed tasks with explicit `turn` (1, 2, ...), `track` (`LIGHT` for sequential single-file/single-domain edits, `HEAVY` for concurrent multi-file edits), `role`, `category`, `difficulty`, `targetFiles`, `verifyCmd`, and `acceptance`.
3. Check the returned `progressBoard` and `.asd/PLAN.md`.

## Step 2: Live Progress & Wave Execution (`asd dispatch` & `asd verify`)
1. Execute turn-by-turn and wave-by-wave via terminal CLI (`asd dispatch --turn <N>`, `asd verify --task <id> ...`) so long-running subagents never hit MCP 60s timeouts:
   - For `LIGHT` track tasks: in-place modification by single worker on clean baseline, followed by `asd verify`. Checkpoint commit is automatically created upon pass.
   - For `HEAVY` track tasks: parallel workers isolated in git worktrees (`.asd/wt/<turn>-<taskId>`), concurrent execution, followed by `asd verify` and automated merge.
2. **MANDATORY LIVE PROGRESS DIRECTIVE**:
   - After EVERY subagent or wave completion, print the returned `progressBoard` verbatim to the user so they can watch live progress.
   - Never suppress or summarize the `progressBoard` block.

## Step 3: Failure Recovery & Circuit Breaker
- If a task verification fails:
  - Attempt 1: automated rollback to clean baseline and retry.
  - Attempt 2: second retry with captured failure context.
  - Attempt 3: escalation to architect role (`@cx` or highest tier).
  - If `no_progress_count >= 3`, circuit breaker halts execution to protect repository state.

## Step 4: Verification & Summary (`summary.md`)
1. Verify the overall repository state: tests pass, lint is clean, git diff is clean.
2. Render final `summary.md` detailing completed tasks, changed files, test results, and any escalated decisions.
