---
name: asd
description: Universal end-to-end multi-agent autonomous workflow for ASD v2.2. Plans, executes across waves, displays live progress boards, and generates final summary.
---

# ASD Autonomous Multi-Agent Workflow (`/asd`)

You are executing the end-to-end ASD v2.2 autonomous multi-agent workflow.
Follow this strict sequence:

## Step 0: Single Pre-Flight Briefing & Mode Confirmation (MANDATORY)
Before writing/modifying any files or dispatching any tasks, present **one consolidated briefing** to the user and wait for confirmation (unless the user explicitly instructed autonomous execution such as *"알아서 해줘"* / *"자동으로 끝까지 진행해"*):
1. **Work Summary**: Concisely explain what tasks will be performed, which files will be created/modified, and the expected impact.
2. **Execution Mode Question (`LIGHT` vs `HEAVY` / Multi-Harness vs Single-Harness)**:
   - Ask the user whether to proceed in:
     - **`LIGHT` Mode (Current Harness Only)**: Small tasks are handled directly by the main AI in-place; larger/parallel subtasks use internal subagents within the current harness (`claim_only`). No external harness CLIs are spawned.
     - **`HEAVY` Mode (Multi-Harness Concurrent)**: Spawns multiple external harnesses (e.g., Claude Code, OpenCode, Codex) concurrently in isolated Git worktrees (`.asd/wt/`).
3. **Clarifying Questions (if any)**: Bundle any requirements questions into this same single message. Do NOT ask multiple separate rounds of questions.

## Step 1: Planning & Decomposition (`asd plan`)
1. If the architecture or approach was ambiguous and the user requested cross-model validation, run `asd debate --topic "<topic>" --proposal "<proposal>"` (append `--harness <currentHarness>` if the user chose single-harness mode).
2. Run `asd plan create --payload '{"tasks":[...]}'` via terminal CLI with:
   - `action`: `"create"`
   - `tasks`: array of decomposed tasks with explicit `turn` (1, 2, ...), `track` (`LIGHT` for current-harness execution, `HEAVY` for multi-harness worktree execution), `role`, `category`, `difficulty`, `targetFiles`, `verifyCmd`, and `acceptance`.
3. Print the returned `progressBoard` verbatim and confirm `.asd/PLAN.md`.

## Step 2: Live Progress & Wave Execution (`asd dispatch` & `asd verify`)
1. Execute turn-by-turn and wave-by-wave via terminal CLI (`asd dispatch --turn <N>`, `asd verify --task <id> ...`) so long-running subagents never hit MCP 60s timeouts:
   - **For `LIGHT` track tasks (Current Harness Mode)**:
     - `asd dispatch --turn <N>` automatically claims `LIGHT` tasks in `claim_only` mode on the current harness.
     - Small tasks: modify files directly in-place by the main AI, then run `asd verify --task <id> --files "<file1,file2>" --summary "<summary>"`.
     - Multi-agent tasks within `LIGHT`: delegate to the current harness's native subagents, then run `asd verify`.
   - **For `HEAVY` track tasks (Multi-Harness Mode)**:
     - `asd dispatch --turn <N> --mode parallel_spawn` spawns multiple external harnesses in isolated git worktrees (`.asd/wt/<turn>-<taskId>`), verifies them, and merges into main.
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
