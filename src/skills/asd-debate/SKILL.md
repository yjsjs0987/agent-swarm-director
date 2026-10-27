---
name: asd-debate
description: Cross-harness adversarial debate workflow for ASD v2.2. Conducts multi-model blind debate and synthesizes binding consensus.
---

# ASD Cross-Harness Adversarial Debate (`/asd-debate`)

You are orchestrating an adversarial architecture/design debate using the Core Debate Broker.

## Workflow

### 0. Single Pre-Debate Briefing & Multi-Harness Confirmation (MANDATORY)
- Before launching `asd debate` or modifying any files, present **one consolidated briefing** to the user (unless autonomous execution was explicitly requested):
  1. **Debate Topic & Proposal Summary**: Clearly state the `topic` and summarize the `proposal` or competing design options to be evaluated.
  2. **Multi-Harness Confirmation**:
     - Ask whether to run the debate across **Multiple Harnesses (`HEAVY` — default cross-model blind review across all installed harnesses)** or **Current Harness Only (`LIGHT` — single-harness review using `--harness <currentHarness>` or internal subagents)**.
  3. **Clarifying Questions (if any)**: Bundle any questions about constraints or priorities into this same single message.

### 1. Proposal & Topic Definition
- Formulate the architectural or technical decision requiring debate:
  - `topic`: Clear, concise description of the disputed design or approach.
  - `proposal`: The proposed solution or conflicting options.
  - `taskId`: Associated task ID (optional).

### 2. Blind Review Execution (Round 1 — Execute via `asd debate` CLI)
- Run the debate directly via the terminal CLI (bypasses MCP 60s request timeouts and streams real-time progress):
  - **Multi-Harness Mode**:
    ```bash
    asd debate --topic "<topic>" --proposal "<proposal>" [--task <taskId>] [--session <sessionId>]
    ```
  - **Single-Harness Mode (when user declines multi-harness usage)**:
    ```bash
    asd debate --topic "<topic>" --proposal "<proposal>" --harness <currentHarness> [--task <taskId>] [--session <sessionId>]
    ```
  *(Or write a longer proposal to `.asd/proposal.md` and pass `--proposal-file .asd/proposal.md`)*
- If unanimous consensus (`APPROVE` / `MINOR_AMEND`) is reached in Round 1, the debate terminates early with an agreed verdict.

### 3. Arbiter Resolution (Round 2)
- If disagreement (`REJECT`) persists:
  - Round 2 confronts divergent viewpoints.
  - The `arbiter` role reviews arguments, evaluates trade-offs, and issues a final binding verdict (`APPROVE`, `MINOR_AMEND`, or `REJECT`).

### 4. Injection & Live Progress
- The resulting decisions and constraints are automatically injected into `tasks.acceptance` and recorded in SQLite.
- Print the debate verdict, hard constraints, and the updated `progressBoard` verbatim to the user.
