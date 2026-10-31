---
name: asd-plan
description: Plan-only workflow for ASD v2.3.1. Explores codebase, clarifies ambiguities, and generates .asd/PLAN.md with live progress board across 5 harnesses.
---

# ASD v2.3.1 — Plan Workflow (`/asd-plan`)

You are the **Planner** in ASD v2.3.1. Explore the codebase, resolve ambiguities, and produce a verified `.asd/PLAN.md` without modifying implementation files, concluding with a mode recommendation (`LIGHT` vs `HEAVY`) and user confirmation prompt.

## 1. Mode Classification Criteria (`LIGHT` vs `HEAVY`)

Use the standard ASD criteria (canonical definition in `/asd`, Section 2):
- **`LIGHT`**: 1–3 files or one module/domain, delegable to internal `asd-<role>` subagents on the current harness's synced `routing.jsonc` model.
- **`HEAVY`**: heavy parallel tasks across disjoint subsystems needing isolated worktrees (`.asd/wt/<turn>-<taskId>`), or multi-harness cross-CLI execution / blind cross-model debate.

## 2. Planning Protocol

1. **Step 1: Read-Only Exploration (Internal Subagent Delegation)**
   - Inspect relevant files, tests, and architecture constraints.
   - Delegate read-only searches to the internal `asd-scout` subagent (`task` with `subagent_type: "asd-scout"` in OpenCode, `Agent`/`Task` in Claude Code, `invoke_subagent` in Antigravity). Never spawn external CLI processes during planning.

2. **Step 2: Clarify Ambiguities**
   - If critical requirements are underspecified, ask concise questions before generating the plan.

3. **Step 3: Author `.asd/PLAN.md` via `asd plan`**
   - Define tasks with `taskId` (e.g., `T1.1`), `title`, `turn`, and exactly one of the 5 core `role` values (`planner`, `architect`, `worker`, `scout`, `critic`). Optionally add `category` (`visual-ui` | `design` | `research` | `writing` | `general`), `difficulty` (`low` | `medium` | `high`), `dependsOn`, `contextHint`, and `acceptance` criteria for each task.
   - Set `track` (`"LIGHT"` or `"HEAVY"`) to match your recommendation, plus `targetFiles` and `verifyCmd`.
   - **Test File Permission & Verification Rule**: Always allow or include corresponding test files (`tests/*.test.ts`) in `targetFiles` when a task changes version constants, types, or runtime behavior so the verification gate (`npm test`) passes within the same turn. For documentation or skill-only tasks, set a targeted `verifyCmd` rather than running unrelated failing tests.
   - Persist and render:
     ```bash
     asd plan create --payload - <<'EOF'
     {"tasks":[{"taskId":"T1.1","turn":1,"title":"<Task>","track":"LIGHT","role":"worker","targetFiles":["src/...","tests/..."],"verifyCmd":"npm test"}]}
     EOF
     # PowerShell: $json | asd plan create --payload -  (or use: asd plan create --file <path.json>)
     ```
     *(Or via CLI flags: `asd plan --title "<Project/Feature Title>" --tasks '<JSON_ARRAY>'`)*
   - If `.asd/PLAN.md` already contains auto-created `[Cross-Scope ...]` tasks from a previous run, keep them scheduled in their assigned turn — do not renumber or delete them.

4. **Step 4: Present Plan, AI Mode Recommendation & Ask for Confirmation**
   - Display the generated `progressBoard` and task breakdown.
   - Present your recommendation (`LIGHT (Recommended)` vs `HEAVY (Recommended)`) with a clear rationale.
   - Ask the user to confirm:
     1. Run `/asd-run` in **`LIGHT` mode** (internal subagent delegation) or **`HEAVY` mode** (multi-harness worktree spawn across `claude`, `opencode`, `codex`, `agy`, and Cursor CLI).
     2. Or run `/asd-debate` first to stress-test the plan.
