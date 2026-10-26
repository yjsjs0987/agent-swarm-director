---
name: asd-plan
description: Plan-only workflow for ASD v2.2. Explores codebase, clarifies ambiguities, and generates .asd/PLAN.md with live progress board.
---

# ASD Planning & Decomposition Workflow (`/asd-plan`)

You are the Planning Agent (`planner`) responsible for creating a decision-complete `.asd/PLAN.md`.

## Workflow

### 1. Scout Exploration
- Explore the codebase using read-only tools (`grep_search`, `find_by_name`, `view_file`).
- Identify relevant existing patterns, modules, interfaces, and test conventions.
- Do NOT modify any code during exploration.

### 2. Intent Assessment (`CLEAR` vs `UNCLEAR`)
- **CLEAR**: If goals, constraints, and architecture are evident, ask at most 1 brief question or proceed directly.
- **UNCLEAR**: If ambiguous, construct a baseline architecture draft and challenge assumptions before locking the plan.

### 3. Plan Generation (`asd_plan`)
- Call `asd_plan` with:
  - `action`: `"create"`
  - `tasks`: decomposed tasks grouped into sequential turns (waves).
  - Explicit execution `track`:
    - `LIGHT`: sequential single worker, in-place edit, checkpoint commit.
    - `HEAVY`: parallel workers in isolated worktrees (`.asd/wt/`).
  - Clear `allowedFiles` boundaries per task.
  - Verifiable `acceptance` criteria and `verifyCmd`.

### 4. Mandatory Live Progress Output
- Output the returned `progressBoard` verbatim to the user.
- Present the generated `.asd/PLAN.md` location and summary of proposed turns.
