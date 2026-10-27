---
name: asd-debug
description: Systematic hypothesis-driven debugging workflow for ASD v2.2. Reproduce first, diagnose, fix, and verify.
---

# ASD v2.2 — Hypothesis-Driven Debugging Workflow (`/asd-debug`)

You are running a rigorous, evidence-backed debugging loop to resolve a failure or quarantined task.

## 1. Mode Classification Criteria (`LIGHT` vs `HEAVY`)

Evaluate the bug's scope to recommend `LIGHT` or `HEAVY`:
- **Recommend `LIGHT` (Single-Harness Internal Subagent Delegation)** when:
  - The bug is reproducible locally and localized to 1–3 files or a single subsystem.
  - Root-cause tracing (`asd-scout`), hypothesis critique (`asd-critic`), and minimal fix implementation (`asd-worker`) can be delegated via the current harness's native internal subagents (using the harness-matched model from `routing.jsonc`).
- **Recommend `HEAVY` (Multi-Harness External CLI Escalation)** when:
  - Repeated local hypotheses have failed (3-Strike escalation) or the bug spans complex cross-cutting concurrency/architecture boundaries requiring an external cross-harness oracle (`asd debate` via external CLI).

## 2. Debugging Protocol

1. **Step 1: Reproduce First & Gather Evidence**
   - Identify the exact failing command, stack trace, or quarantined task log in `.asd/sessions/`.
   - Delegate read-only log/codebase tracing to `asd-scout` via your harness's internal subagent tool (`task` in OpenCode, `Agent`/`Task` in Claude Code, `invoke_subagent` in Antigravity).
   - Run the reproduction test to confirm the failure deterministically before proposing any code changes.

2. **Step 2: Formulate Hypotheses & Confirm Mode with User**
   - List the top 1–3 root-cause hypotheses with file:line citations and a proposed minimal fix + regression test plan.
   - Present your AI mode recommendation (`LIGHT (Recommended)` for internal subagent fix/review vs `HEAVY` for external cross-harness escalation) and **ask for user confirmation** before modifying files.

3. **Step 3: Execute Diagnosis & Minimal Fix**
   - **If `LIGHT` Mode is Confirmed (Internal Subagent Delegation — NO External CLI Spawning)**:
     - Do **NOT** spawn external CLI processes via `asd dispatch --mode parallel_spawn` or `asd debate`.
     - Optionally consult `asd-critic` via the internal subagent tool (`task(subagent_type="asd-critic", ...)`) to stress-test the root-cause hypothesis.
     - Apply the minimal fix within `allowedFiles` (directly or by delegating to `asd-worker` via the internal subagent tool) and add a regression test.
   - **If `HEAVY` Mode is Confirmed (External Cross-Harness Escalation)**:
     - Run `asd debate` with the failure evidence and competing hypotheses to get a cross-harness diagnosis, then dispatch the verified fix.

4. **Step 4: Gate Verification (`asd verify`)**
   - Run verification via `asd verify`:
     ```bash
     asd verify --task <T-ID> --cmd "<reproduction_and_regression_test_cmd>"
     ```
   - Confirm zero regressions across the test suite, display the updated `progressBoard`, and report the result to the user.
