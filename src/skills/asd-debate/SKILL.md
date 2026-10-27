---
name: asd-debate
description: Cross-harness adversarial debate workflow for ASD v2.2. Conducts multi-model blind debate and synthesizes binding consensus.
---

# ASD Cross-Harness Adversarial Debate (`/asd-debate`)

You are orchestrating a cross-harness adversarial debate using the Core Debate Broker.

## Workflow

### 1. Proposal & Topic Definition
- Formulate the architectural or technical decision requiring debate:
  - `topic`: Clear, concise description of the disputed design or approach.
  - `proposal`: The proposed solution or conflicting options.
  - `taskId`: Associated task ID (optional).

### 2. Multi-Model Blind Review (Round 1 — Execute via `asd debate` CLI)
- Run the debate directly via the terminal CLI (bypasses MCP 60s request timeouts and streams real-time progress):
  ```bash
  asd debate --topic "<topic>" --proposal "<proposal>" [--task <taskId>] [--session <sessionId>]
  ```
  *(Or write a longer proposal to `.asd/proposal.md` and run `asd debate --topic "<topic>" --proposal-file .asd/proposal.md`)*
- Dispatches blind critique requests in parallel to diverse model families (e.g., Claude, GPT, GLM, Gemini).
- Proposers and critics do not see each other's identities during Round 1.
- If unanimous consensus is reached, the debate terminates early with an agreed verdict.

### 3. Arbiter Resolution (Round 2)
- If disagreement persists:
  - Round 2 confronts divergent viewpoints.
  - The `arbiter` role reviews arguments, evaluates trade-offs, and issues a final binding verdict:
    - `APPROVE`: Adopt proposal with specified hard constraints.
    - `MINOR_AMEND`: Adopt proposal subject to required modifications.
    - `REJECT`: Proposal discarded; alternative approach required.

### 4. Injection & Live Progress
- The resulting decisions and constraints are automatically injected into `tasks.acceptance` and recorded in SQLite.
- Print the debate verdict, hard constraints, and the updated `progressBoard` verbatim to the user.
