---
name: asd-debug
description: Systematic hypothesis-driven debugging workflow for ASD v2.2. Reproduce first, diagnose, fix, and verify.
---

# ASD Systematic Debugging Workflow (`/asd-debug`)

You are executing the ASD v2.2 systematic debugging workflow.

## Step 0: Symptom Investigation & Single Pre-Fix Briefing (MANDATORY)
1. **Read-Only Investigation**: Inspect error logs, stack traces, and relevant source files without modifying production code.
2. **Single Pre-Fix Briefing & Mode Confirmation**: Before writing/modifying any files or spawning cross-harness diagnosis, present **one consolidated briefing** to the user (unless autonomous execution was explicitly requested):
   - **Root Cause Hypothesis & Fix Plan**: Explain the suspected cause, the reproduction test to be added, and the target files to be modified.
   - **Multi-Harness Confirmation (`LIGHT` vs `HEAVY`)**:
     - Ask whether to debug using **Single-Harness (`LIGHT`)** (main AI directly or internal subagents within the current harness) or **Multi-Harness (`HEAVY`)** (using `asd debate` across external harnesses / multi-harness workers).
   - **Clarifying Questions (if any)**: Bundle any questions about reproduction steps or environment into this same single message.

## Rule Zero: Reproduce First
- Before modifying ANY application code, create a deterministic reproduction:
  - A new failing test in `tests/`, or
  - A runnable standalone test script.
- Execute the reproduction script to confirm the failure matches the user's reported symptom.
- Do NOT guess or edit production files until the failure is reliably reproduced.

## Workflow

### 1. Hypothesis & Cross-Diagnosis
- Formulate testable hypotheses explaining the root cause.
- If the issue is complex and the user opted for cross-model diagnosis, run `asd debate --topic "<topic>" --proposal "<hypothesis>"` via terminal CLI (add `--harness <currentHarness>` if staying within a single harness).

### 2. Targeted Fix
- Apply the minimal correct change to resolve the root cause (directly in-place by main AI for small fixes, or via internal subagent / `asd dispatch` according to the selected mode).
- Adhere strictly to `allowedFiles` boundaries.
- Never delete or disable existing tests to make CI green.

### 3. Verification & Regression Guard
- Run the reproduction test: must now PASS.
- Run the entire test suite: must PASS with zero regressions.
- Run `asd verify --task <taskId> --files "<changedFiles>" --summary "<fix summary>"` to lock in the checkpoint commit and update the `progressBoard`.
- Print the updated `progressBoard` verbatim to the user.
