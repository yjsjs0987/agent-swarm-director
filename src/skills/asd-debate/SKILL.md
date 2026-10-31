---
name: asd-debate
description: Cross-harness adversarial debate workflow for ASD v2.3.1. Conducts multi-model blind debate and synthesizes binding consensus across 5 harnesses.
---

# ASD v2.3.1 — Adversarial Debate Workflow (`/asd-debate`)

You are the **Debate Broker** coordinating a hostile design review before committing to a major architectural or implementation decision.

## 1. Mode Classification Criteria (`LIGHT` vs `HEAVY`)

Use the standard ASD criteria (canonical definition in `/asd`, Section 2):
- **`LIGHT` (Internal Subagent Debate)**: fast adversarial critique inside the current harness via `asd-critic` (+ `asd-architect` for arbitration) on the synced `routing.jsonc` model — no external CLI process.
- **`HEAVY` (Multi-Harness Cross-CLI Blind Debate)**: high-risk, repo-wide architecture, security models, or irreversible schema migrations requiring true cross-harness model diversity via external CLIs (`claude`, `opencode`, `codex`, `agy`, `agent`/`cursor-agent`).

## 2. Debate Protocol

1. **Step 1: Frame the Proposal & Ask for User Confirmation (With AI Recommendation)**
   - State the **Topic** and **Proposal** (including key files and trade-offs).
   - If the user has not specified `LIGHT` or `HEAVY`, present your recommendation with a brief rationale and ask for confirmation before starting.

2. **Step 2: Execute Adversarial Debate**
   - **`LIGHT` Confirmed (Internal Subagent Delegation — NO External CLI Spawning)**:
     - **STRICT PROHIBITION**: Do **NOT** run `asd debate` via Bash/CLI in `LIGHT` mode (it spawns external headless CLI processes).
     - Use your harness's **native internal subagent tool** to invoke `asd-critic` (optionally `asd-architect` in parallel):
       - **OpenCode**: `task(subagent_type="asd-critic", description="Adversarial review", prompt="...")`
       - **Claude Code**: `Agent`/`Task` with `subagent_type: "asd-critic"`
       - **Antigravity**: `invoke_subagent` with role `critic`
       - **Codex CLI / Cursor CLI**: invoke the synced `asd-critic` persona (`~/.cursor/agents/asd-critic.md` on Cursor) or run the critique directly with your own reasoning.
     - Instruct `asd-critic` to ruthlessly challenge assumptions, cross-examine the target code, identify security/correctness blind spots, and return a structured JSON verdict citing concrete `file:line` evidence:
       ```json
       {
         "verdict": "APPROVE | MINOR_AMEND | REJECT",
         "decisions": ["..."],
         "hard_constraints": ["..."],
         "risks": ["..."],
         "reasoning": "Detailed explanation citing file:line evidence"
       }
       ```
     - If `asd-critic` returns `REJECT` or reviewers conflict, invoke `asd-architect` via the internal subagent tool to issue a binding synthesis.
   - **`HEAVY` Confirmed (Multi-Harness External CLI Debate)**:
     - Invoke the cross-harness CLI debate broker, passing `--files "path[:start-end],..."` and/or `--diff` so Node.js embeds ground-truth source slices directly into reviewer prompts (zero Main Agent token overhead):
       ```bash
       asd debate --topic "<topic>" --proposal "<proposal>" --files "src/path/file.ts:10-120" --diff
       ```

3. **Step 3: Apply Verdict**
   - **`APPROVE`**: Proceed with the plan as proposed and render the current `progressBoard`.
   - **`MINOR_AMEND`**: Incorporate the required `hard_constraints` and `decisions` into `.asd/PLAN.md` via `asd plan` and display the updated `progressBoard`.
   - **`REJECT`**: Halt execution, revise the architecture addressing all blocking `risks`, and present the revised design to the user.
