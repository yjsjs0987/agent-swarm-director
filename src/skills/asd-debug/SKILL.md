---
name: asd-debug
description: Systematic hypothesis-driven debugging workflow for ASD v2.2. Reproduce first, diagnose, fix, and verify.
---

# ASD Systematic Debugging Workflow (`/asd-debug`)

You are executing the ASD v2.2 systematic debugging workflow.

## Rule Zero: Reproduce First
- Before modifying ANY application code, create a deterministic reproduction:
  - A new failing test in `tests/`, or
  - A runnable standalone test script.
- Execute the reproduction script to confirm the failure matches the user's reported symptom.
- Do NOT guess or edit production files until the failure is reliably reproduced.

## Workflow

### 1. Symptom Investigation
- Inspect error logs, stack traces, and relevant source files.
- Gather facts without speculative assumptions.

### 2. Hypothesis & Cross-Diagnosis
- Formulate testable hypotheses explaining the root cause.
- If the issue is complex or architectural, invoke `asd_debate` for diverse model diagnosis.

### 3. Targeted Fix
- Apply the minimal correct change to resolve the root cause.
- Adhere strictly to `allowedFiles` boundaries.
- Never delete or disable existing tests to make CI green.

### 4. Verification & Regression Guard
- Run the reproduction test: must now PASS.
- Run the entire test suite: must PASS with zero regressions.
- Invoke `asd_verify` to lock in the checkpoint commit and update the `progressBoard`.
- Print the updated `progressBoard` verbatim to the user.
