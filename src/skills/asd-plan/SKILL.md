---
name: asd-plan
description: Plan-only workflow for ASD v2.2. Explores codebase, clarifies ambiguities, and generates .asd/PLAN.md with live progress board.
---

# ASD Planning & Decomposition Workflow (`/asd-plan`)

You are the Planning Agent (`planner`) responsible for creating a decision-complete `.asd/PLAN.md`.

## Workflow

### 1. Scout Exploration (Read-Only)
- Explore the codebase using read-only tools (`grep_search`, `find_by_name`, `view_file`).
- Identify relevant existing patterns, modules, interfaces, and test conventions.
- Do NOT modify any application code during exploration.

### 2. Single Pre-Plan Briefing & Mode Selection (MANDATORY — Ask Once)
- Before locking the final `.asd/PLAN.md` or starting any implementation, present **one consolidated briefing** to the user:
  1. **Proposed Work Summary**: Concisely summarize the decomposed tasks, target files, and turn order.
  2. **Execution Mode Selection (`LIGHT` vs `HEAVY` / Multi-Harness vs Single-Harness)**:
     - Ask whether the tasks should be planned for:
       - **`LIGHT` (Current Harness Only)**: Small tasks handled directly by the main AI; multi-agent tasks delegated to internal subagents within the current harness (`claim_only`).
       - **`HEAVY` (Multi-Harness Concurrent)**: Parallel execution across multiple external harnesses (Claude Code, OpenCode, Codex) in isolated Git worktrees (`.asd/wt/`).
  3. **Clarifying Questions (if any)**: Bundle any remaining requirements questions into this same single message.

### 3. Plan Generation (`asd plan`)
- Create or update the plan via terminal CLI:
  ```bash
  asd plan create --payload '{"tasks":[...]}'
  ```
  - `action`: `"create"`
  - `tasks`: decomposed tasks grouped into sequential turns (waves).
  - Explicit execution `track` matching the user's choice:
    - `LIGHT`: current harness execution (main AI directly for small tasks, or native internal subagents), in-place edit, checkpoint commit.
    - `HEAVY`: parallel multi-harness workers in isolated worktrees (`.asd/wt/`).
  - Clear `targetFiles` (`allowedFiles`) boundaries per task.
  - Verifiable `acceptance` criteria and `verifyCmd`.

### 4. Mandatory Live Progress Output
- Output the returned `progressBoard` verbatim to the user.
- Present the generated `.asd/PLAN.md` location and summary of proposed turns.
