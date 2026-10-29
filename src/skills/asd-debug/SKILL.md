---
name: asd-debug
description: Systematic hypothesis-driven debugging workflow for ASD v2.3. Reproduce first, diagnose, fix, and verify.
---

# ASD v2.3 — Hypothesis-Driven Debugging Workflow (`/asd-debug`)

You are running a rigorous, evidence-backed debugging loop to resolve a failure or quarantined task.

## 1. Mode Classification Criteria (`LIGHT` vs `HEAVY`)

Use the standard ASD criteria (canonical definition in `/asd`, Section 2):
- **`LIGHT`**: bug reproducible locally and localized to 1–3 files or one subsystem; root-cause tracing (`asd-scout`), hypothesis critique (`asd-critic`), and minimal fix (`asd-worker`) via internal subagents on the synced `routing.jsonc` model.
- **`HEAVY`**: repeated local hypotheses failed (3-Strike escalation) or the bug spans cross-cutting concurrency/architecture boundaries requiring an external cross-harness oracle (`asd debate` via external CLIs).

## 2. Debugging Protocol

1. **Step 1: Reproduce First & Gather Evidence**
   - Identify the exact failing command, stack trace, or quarantined task log in `.asd/sessions/`.
   - Delegate read-only log/codebase tracing to `asd-scout` via your harness's internal subagent tool (`task` in OpenCode, `Agent`/`Task` in Claude Code, `invoke_subagent` in Antigravity).
   - Run the reproduction test to confirm the failure deterministically before proposing any code changes.

2. **Step 2: Formulate Hypotheses & Confirm Mode with User**
   - List the top 1–3 root-cause hypotheses with `file:line` citations and a proposed minimal fix + regression test plan.
   - Present your AI mode recommendation (`LIGHT (Recommended)` vs `HEAVY`) and **ask for user confirmation** before modifying files.

3. **Step 3: Execute Diagnosis & Minimal Fix**
   - **`LIGHT` Confirmed (Internal Subagent Delegation — NO External CLI Spawning)**:
     - Do **NOT** spawn external CLI processes via `asd dispatch --mode parallel_spawn` or `asd debate`.
     - Optionally stress-test the root-cause hypothesis with `asd-critic` via the internal subagent tool.
     - Apply the minimal fix within `allowedFiles` (directly or by delegating to `asd-worker`) and add a regression test.
   - **`HEAVY` Confirmed (External Cross-Harness Escalation)**:
     - Run `asd debate` with the failure evidence and competing hypotheses for a cross-harness diagnosis, then dispatch the verified fix.

4. **Step 4: Gate Verification (`asd verify`)**
   ```bash
   asd verify --task <T-ID> --cmd "<reproduction_and_regression_test_cmd>"
   ```
   - Confirm zero regressions across the test suite, display the updated `progressBoard` (including any `autoCreatedTasks` or `deferredCrossScopeRequests` returned by verification), and report the result to the user.
