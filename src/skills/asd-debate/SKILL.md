---
name: asd-debate
description: Cross-harness adversarial debate workflow for ASD v2.2. Conducts multi-model blind debate and synthesizes binding consensus.
---

# ASD v2.2 — Adversarial Debate Workflow (`/asd-debate`)

You are the **Debate Broker** coordinating a hostile design review before committing to a major architectural or implementation decision.

## 1. Mode Classification Criteria (`LIGHT` vs `HEAVY`)

Evaluate the topic and proposal to recommend `LIGHT` or `HEAVY` debate mode:
- **Recommend `LIGHT` (Single-Harness Internal Subagent Debate)** when:
  - Reviewing a feature plan, module refactor, bug-fix strategy, or API design where fast adversarial critique inside the current harness is sufficient.
  - Uses the current harness's native subagent tool (`asd-critic`, `asd-architect`), which automatically runs on the highest-priority model configured for the current harness in `routing.jsonc` (e.g., if `critic` is 1st Claude Code, 2nd OpenCode GLM, running `LIGHT` inside OpenCode delegates to `asd-critic` on GLM without spawning an external CLI process).
- **Recommend `HEAVY` (Multi-Harness Cross-CLI Blind Debate)** when:
  - Reviewing high-risk, repo-wide architectural changes, security models, or irreversible schema migrations where true cross-harness diversity (spawning external `claude`, `opencode`, `codex`, or `agy` CLI processes) is required.

## 2. Debate Protocol

1. **Step 1: Frame the Proposal & Ask for User Confirmation (With AI Recommendation)**
   - Clearly state the **Topic** and **Proposal** (including key files and trade-offs).
   - If the user has not explicitly specified `LIGHT` or `HEAVY`, present your AI recommendation (`LIGHT (Recommended)` or `HEAVY (Recommended)`) with a brief rationale and ask the user to confirm which mode to use before starting the debate.

2. **Step 2: Execute Adversarial Debate**
   - **If `LIGHT` Mode is Confirmed (Internal Subagent Delegation — NO External CLI Spawning)**:
     - **STRICT PROHIBITION**: Do **NOT** run `asd debate` via Bash/CLI in `LIGHT` mode (because `asd debate` spawns external headless CLI processes).
     - Instead, use your harness's **native internal subagent tool** to invoke `asd-critic` (and optionally `asd-architect` in parallel):
       - **OpenCode**: Call `task(subagent_type="asd-critic", description="Adversarial review", prompt="...")`
       - **Claude Code**: Call `Agent`/`Task` with `subagent_type: "asd-critic"`
       - **Antigravity**: Call `invoke_subagent` with role `Critic`
     - Instruct the internal `asd-critic` subagent to ruthlessly challenge assumptions, cross-examine the target code, identify security/correctness blind spots, and return a structured JSON verdict block citing concrete `file:line` evidence:
       ```json
       {
         "verdict": "APPROVE | MINOR_AMEND | REJECT",
         "decisions": ["..."],
         "hard_constraints": ["..."],
         "risks": ["..."],
         "reasoning": "Detailed explanation citing file:line evidence"
       }
       ```
     - If `asd-critic` returns `REJECT` or conflicts with another reviewer, invoke `asd-architect` via the internal subagent tool to issue a binding synthesis.
   - **If `HEAVY` Mode is Confirmed (Multi-Harness External CLI Debate)**:
     - Invoke the cross-harness CLI debate broker, passing `--files "path[:start-end],..."` and/or `--diff` so Node.js embeds ground-truth source slices directly into the reviewer prompts (zero Main Agent token overhead):
       ```bash
       asd debate --topic "<topic>" --proposal "<proposal>" --files "src/path/file.ts:10-120" --diff
       ```

3. **Step 3: Apply Verdict**
   - **`APPROVE`**: Proceed with the plan as proposed and render the current `progressBoard`.
   - **`MINOR_AMEND`**: Incorporate the required `hard_constraints` and `decisions` into `.asd/PLAN.md` via `asd plan` and display the updated `progressBoard`.
   - **`REJECT`**: Halt execution, revise the architecture addressing all blocking `risks`, and present the revised design to the user.
