---
name: asd-run
description: Execution & resume workflow for ASD v2.3.1. Synchronizes .asd/PLAN.md, dispatches tasks across turns, handles cross-scope auto-created tasks, and renders live progress boards across 5 harnesses.
---

# ASD v2.3.1 — Execution & Resume Workflow (`/asd-run`)

You are executing or resuming an existing `.asd/PLAN.md` across dependency turns (waves) in ASD v2.3.1.

## 1. Mode Classification Criteria (`LIGHT` vs `HEAVY`)

Use the standard ASD criteria (canonical definition in `/asd`, Section 2):
- **`LIGHT`**: pending tasks scoped to a few files or one module; delegate to internal `asd-<role>` subagents on the current harness's synced `routing.jsonc` model. No external CLIs, no worktrees.
- **`HEAVY`**: multiple large independent tasks per wave benefiting from isolated worktrees (`.asd/wt/<turn>-<taskId>`) and external harness CLIs (`claude`, `opencode`, `codex`, `agy`, `agent`/`cursor-agent`).

## 2. Execution Protocol

1. **Step 1: Synchronize `.asd/PLAN.md` & Assess Mode**
   - Sync manual user edits into SQLite:
     ```bash
     asd plan sync_from_md
     ```
     *(Alias `asd plan --from-markdown` is also supported.)*
   - Inspect the `progressBoard` and identify the next pending `turn`. Auto-created `[Cross-Scope ...]` tasks scheduled for this turn are normal work — execute them like any other task.

2. **Step 2: Mandatory User Confirmation Gate (With AI Recommendation)**
   - Unless the user explicitly specified `LIGHT` or `HEAVY`, present your recommendation with a brief rationale and ask for confirmation before dispatching.

3. **Step 3: Dispatch Current Wave (`turn = N`)**
   - **`LIGHT` Confirmed (Internal Subagent Delegation — NO External CLI Spawning)**:
     - **STRICT PROHIBITION**: Do **NOT** pass `--mode parallel_spawn`, and do **NOT** invoke external `opencode run`, `claude -p`, `codex exec`, `agy`, or `cursor-agent` CLI processes via Bash.
     - If plan tasks have `track: "HEAVY"`, update them to `track: "LIGHT"` and re-run `asd plan --from-markdown` so `asd dispatch` does not auto-spawn external CLIs.
     - Register task claims in SQLite:
       ```bash
       asd dispatch --turn <N> --mode claim_only
       ```
     - For each task, delegate to the **current harness's native subagent tool**:
       - **OpenCode**: `task` tool with `subagent_type: "asd-<role>"` (e.g., `asd-worker`, `asd-scout`, `asd-critic`), run on the model synced into `~/.config/opencode/agent/asd-<role>.md`.
       - **Claude Code**: `Agent` / `Task` tool with `subagent_type: "asd-<role>"`.
       - **Antigravity**: `invoke_subagent` with the matching role and model tier.
       - **Codex CLI / Cursor CLI**: use native subagent delegation or execute directly within `allowedFiles` (Cursor personas are synced to `~/.cursor/agents/asd-<role>.md`).
   - **`HEAVY` Confirmed (Multi-Harness External CLI & Worktree Spawn)**:
     ```bash
     asd dispatch --turn <N> --mode parallel_spawn
     ```

4. **Step 4: Gate Verification (`asd verify`)**
   - After each task (or wave):
     ```bash
     asd verify --task <T-ID> --cmd "<verifyCmd>"
     ```
   - Parse the dispatch/verify output for **cross-scope results**:
     - `autoCreatedTasks`: up to **2** cross-scope requests per subagent task were auto-accepted and created as `[Cross-Scope ...]` tasks for the next turn (with the requester's changed files bundled as `dependsOn`). Render them on the `progressBoard` and run them in the next wave.
     - `deferredCrossScopeRequests`: requests over the max-2 quota, targeting protected paths, or exceeding chain depth (2), each with a `deferReason`. Surface them to the user for Main Director review — do not drop or auto-convert them.
   - If a task enters `QUARANTINED` or fails verification, report the failure reason and wait for user instructions or invoke `/asd-debug`.
