---
name: asd
description: Universal end-to-end multi-agent autonomous workflow for ASD v2.2. Plans, executes across waves, displays live progress boards, and generates final summary.
---

# ASD v2.2 — Universal Autonomous Workflow (`/asd`)

You are the **Director** orchestrating an end-to-end multi-agent software engineering workflow.

## 1. Mode Classification Criteria (`LIGHT` vs `HEAVY`)

Before execution or debate, evaluate the task complexity and classify it into `LIGHT` or `HEAVY`:

- **Recommend `LIGHT` (Single-Harness Internal Subagent Delegation)** when:
  - The task touches a focused scope (e.g., 1–3 files or a single module/domain) with low merge-conflict risk.
  - Work can run inside the current workspace without needing isolated Git worktrees.
  - You need fast codebase exploration (`asd-scout`), requirement analysis (`asd-analyst`), scoped implementation (`asd-worker` / `asd-builder`), or fast in-harness adversarial critique (`asd-critic`).
  - *Note*: In `LIGHT` mode, native subagents (`asd-<role>`) automatically use the current harness's highest-priority model from `routing.jsonc` (primary or fallback) synced via `asd sync`.
- **Recommend `HEAVY` (Multi-Harness External CLI & Git Worktree Execution)** when:
  - Multiple independent tasks modify different modules in parallel and require isolated Git worktrees (`.asd/wt/<taskId>`).
  - High-risk architectural or security changes require cross-harness blind debate across separate external CLI binaries (`claude`, `opencode`, `codex`, `agy`).

## 2. Execution Protocol

1. **Step 1: Context & Codebase Discovery (Internal Delegation)**
   - Inspect the repository structure and existing `.asd/PLAN.md`.
   - For non-trivial exploration, delegate internally using your harness's native subagent tool (`task` with `subagent_type: "asd-scout"` in OpenCode, `Agent`/`Task` with `asd-scout` in Claude Code, or `invoke_subagent` in Antigravity).
   - If the user request is ambiguous, ask brief, targeted clarifying questions before planning.

2. **Step 2: Generate Plan (`asd plan`) & Recommend Mode**
   - Decompose the goal into discrete tasks with:
     - `taskId` (e.g., `T1.1`, `T1.2`; `id: "T-1"` is also accepted)
     - `title`, `role` (`architect`, `builder`, `worker`, `scout`, `verifier`), `turn` (wave number >= 1)
     - `track` (`"LIGHT"` or `"HEAVY"` matching the recommended mode)
     - `targetFiles` (strict glob/path boundaries; `allowedFiles` is also accepted)
     - `verifyCmd` (automated test command; `verificationCmd` is also accepted)
   - Synchronize the plan into SQLite and `.asd/PLAN.md`:
     ```bash
     asd plan create --payload '{"tasks":[{"taskId":"T1.1","turn":1,"title":"<Task>","track":"LIGHT","role":"worker","targetFiles":["src/..."],"verifyCmd":"npm test"}]}'
     ```
     *(Or via CLI flags: `asd plan --title "<Goal>" --tasks '<JSON_ARRAY>'`)*
   - Render the initial `progressBoard` from the output.

3. **Step 3: User Confirmation Gate (Mandatory Mode Selection & AI Recommendation)**
   - Present the generated plan and your AI mode recommendation (`LIGHT (Recommended)` or `HEAVY (Recommended)`) with a 1–2 sentence rationale based on Section 1.
   - Explicitly ask the user to confirm:
     1. Whether to run an optional **Adversarial Debate** first (`LIGHT` internal critic subagent vs `HEAVY` cross-harness CLI debate, or skip).
     2. Which **Execution Mode** to use: **`LIGHT` (Internal Subagents)** or **`HEAVY` (Multi-Harness Worktree Spawn)**, highlighting your recommended choice.
   - **Wait for explicit user confirmation before proceeding to Step 4.**

4. **Step 4: Wave Execution Loop (Turn 1..N)**
   - **If User Confirmed `LIGHT` Mode (Internal Subagent Delegation — NO External CLI Spawning)**:
     - **STRICT PROHIBITION**: Do **NOT** run `asd dispatch --mode parallel_spawn`, do **NOT** run `asd debate` via CLI, and do **NOT** spawn external `opencode run`, `claude -p`, `codex exec`, or `agy` processes via Bash.
     - Ensure task `track` in `.asd/PLAN.md` is `"LIGHT"`.
     - Claim task ownership in ASD state only:
       ```bash
       asd dispatch --turn <N> --mode claim_only
       ```
     - Delegate each task in the wave using the **current harness's native internal subagent tool** so the synced `routing.jsonc` model for this harness is applied:
       - **OpenCode**: Call the `task` tool with `subagent_type: "asd-<agent>"` (e.g., `"asd-builder"`, `"asd-worker"`, `"asd-verifier"`).
       - **Claude Code**: Call the `Agent` / `Task` tool with `subagent_type: "asd-<agent>"`.
       - **Antigravity**: Call `invoke_subagent` with the corresponding role and model tier.
       - **Codex CLI**: Delegate to native subagent or execute directly within `allowedFiles`.
     - After the internal subagent completes each task, run verification:
       ```bash
       asd verify --task <T-ID> --cmd "<verificationCmd>"
       ```
   - **If User Confirmed `HEAVY` Mode (Multi-Harness External CLI & Worktree Spawn)**:
     - Dispatch the wave across external harnesses and isolated Git worktrees:
       ```bash
       asd dispatch --turn <N> --mode parallel_spawn
       ```
     - Verify each completed task:
       ```bash
       asd verify --task <T-ID> --cmd "<verificationCmd>"
       ```
   - Display the updated `progressBoard` after every wave.

5. **Step 5: Final Summary**
   - Output the final `progressBoard`, list all verified tasks and modified files, and summarize verification results.
