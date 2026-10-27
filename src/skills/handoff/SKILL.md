---
name: handoff
description: Multi-harness session handoff skill for ASD v2.2. Summarizes conversation history, SQLite session/task state, progressBoard, and multi-harness routing context into handoff.md for seamless continuation across Claude Code, OpenCode, Codex CLI, and Antigravity.
---

# ASD Multi-Harness Session Handoff (`/handoff`, `/asd-handoff`)

You are generating a structured, high-signal session handoff document (`handoff.md`) so the user or another AI coding harness (**Claude Code**, **OpenCode**, **Codex CLI**, or **Antigravity**) can seamlessly resume work in a new session without losing context.

## Workflow

### Step 1: Gather Current Project & Multi-Harness State (Read-Only)
Before writing `handoff.md`, inspect the live repository and ASD state:
1. Run `asd status` (or `node --no-warnings src/cli/index.ts status`) to inspect the active SQLite session, `progressBoard` (`### 📊 ASD TODO 진행 현황`), and any unapplied auto-stash warnings.
2. Check `.asd/PLAN.md` and `.asd/sessions/` (if present) for active or pending tasks (`[ ]`), escalated tasks (`[~]`), completed tasks (`[x]`), and subagent logs.
3. Run `git status --short` and `git log -n 5 --oneline` to capture current branch, recent commits, and any uncommitted or untracked files.

### Step 2: Write `handoff.md` in the Exact Standard Format
Write (or overwrite) `handoff.md` in the project root (`<projectRoot>/handoff.md`) using the exact section structure below. Keep every bullet concise, factual, and verifiable:

```markdown
HANDOFF CONTEXT
===============

USER REQUESTS (AS-IS)
---------------------
- <List the user's chronological requests from the session verbatim (as-is)>

GOAL
----
<1-2 sentences describing the overarching objective to continue or maintain in the next session across any ASD harness>

WORK COMPLETED
--------------
- <Detailed bullet points of code changes, CLI commands run, architecture updates, tests verified, and commits pushed>

CURRENT STATE
-------------
- <Current Git branch, HEAD commit SHA, and sync status with origin>
- <Test suite status (e.g., X/X passing tests)>
- <Multi-harness sync status (`asd sync`) across Claude Code, OpenCode, Codex CLI, and Antigravity>
- <Active ASD session ID, execution mode (`LIGHT` single-harness vs `HEAVY` multi-harness worktree), and `progressBoard` summary if a session is active>
- <Modified or untracked local files in workspace root>

PENDING TASKS
-------------
- <Remaining tasks from `.asd/PLAN.md` or user requests, or "None pending; all requested tasks are complete.">

KEY FILES
---------
- <path/to/file> - <1-line description of role and recent changes>

IMPORTANT DECISIONS
-------------------
- <Key architectural, routing (`LIGHT` vs `HEAVY`), fallback, or implementation decisions made during the session>

EXPLICIT CONSTRAINTS
--------------------
- <User-defined rules (e.g., pre-confirmation rules, error-handling rules) and technical invariants (e.g., zero external dependencies, Node >=22.13.0 erasable TypeScript)>

CONTEXT FOR CONTINUATION
------------------------
- <Actionable commands and tips for resuming in the same or a different harness (e.g., checking `.asd/PLAN.md`, running `/asd-run`, `asd status`, `asd logs`, or `asd sync --force`)>
```

### Step 3: Present Summary to User
- Confirm that `handoff.md` has been saved at `<projectRoot>/handoff.md`.
- Print the current `progressBoard` (if an active ASD session exists) and a brief summary of the handoff state.
