---
name: moon-relay-kernel
description: Default Codex command-skill entrypoint for Moon Relay Kernel task routing and adaptive workflow execution. Selecting this skill activates Kernel workflow for that task; it does not force unselected ordinary Codex tasks into Kernel.
---

# Moon Relay Kernel

## Goal
The account command skillset defaults to Kernel. Bind the current project/worktree to Moon Relay Kernel, execute assigned bounded work units, and drive the task to authoritative Kernel completion with verified proof and receipts; for a non-kernel track return `wrong_harness` without mutating the repository.

## Context
- **Binding Scope**: `Project → Worktree → Run`, scoped by canonical root and Git worktree identity under runtime home `~/.moon-relay-kernel`.
- **Two Core Commands**:
  - `kernel next [--contract-json <file>]` (or MCP `kernel_next`): Returns objective, acceptance, constraints, context capsule, and the active work unit.
  - `kernel report [--report-json <file>]` (or MCP `kernel_report`): Submits change summary, changed paths, risks, and requested verifications.
- **Task Contract**: Captured as compact JSON (objective, acceptance, constraints, non-goals) passed via `kernel next --contract-json <file>` on the first call to atomically create/bind the Run; do not bootstrap a fresh session with bare `kernel next` (use bare `kernel next` only after a Host binding exists).

## Autonomy & Priorities
- **Implementation Autonomy**: Perform code edits, testing, and commands directly in the native owner session and stay inside its allowed paths returned by `next`.
- **Mutation Boundary**: Never mutate files outside `allowedPaths`. Mutations outside the allowed unit are rejected before verification runs.
- **Delegation**: Subagents are optional for genuinely partitioned tasks; they are never a prerequisite for ordinary implementation.
- **Fast Blockers**: When blocked, immediately report the blocker reason (`question`, `permission`, `unsupported-verification`, etc.) rather than looping or improvising.

## Definition of Done
- Treat Kernel completion decisions as the only completion authority; a run is done only when `kernel next` returns `{ action: { type: "done" } }`. Narration or plain text completion claims have zero authority.
- Reusable invariants, required verifications, architecture decisions, and failure patterns are recorded in `knowledgeObservations` upon completion.

## Verification
- Request verifications using the command refs `next` lists for each outstanding obligation; the Kernel runtime executes them and owns the resulting evidence receipts.
- For independent review actions (security review, protected T3 obligations, explicit flags), satisfy them via trusted review receipts recorded from an independent reviewer session (or native subagent fallback). In single-session environments where independent sessions cannot be spawned, request user operator approval. Resolve only outstanding judgment obligations via `kernel approve <run-id>` or `kernel-commit --approve` when the Host supplies an operator approval reference; hard evidence remains mandatory.
- Satisfy every verification obligation with fresh evidence; choose an order that fits the work, and report only after all required evidence is recorded.

## Plan Ingestion & Worktree Reclaim
- **Fast 2-Turn Plan Reading**: When ingesting an external plan or large specification (>200 lines), do not run iterative chunk loops (`Select-Object -Skip ... -First ...` or repeated `head/tail` turns).
  - Turn 1 (Index Scan): Extract outline and line numbers in one turn:
    - PowerShell: `Select-String -Path <planPath> -Pattern '^#+ ' | Select-Object LineNumber, Line`
    - Shell: `grep -nE '^#+ ' <planPath>`
  - Turn 2 (Targeted Slice): Extract only the targeted section or Wave range identified from the index scan, then proceed immediately to task contract creation.
- **Contract Scale Sizing**:
  - Small / Bounded Tasks (1–3 files): Produce a lightweight 1-step contract (30–40 lines) to enter execution within 30 seconds.
  - Multi-Wave / Large Tasks (5+ subsystems): Map all waves into a structured task contract up front so the run executes autonomously under Kernel step sequencing.
- **Ghost Run Recovery**: Starting a new task with `--invocation-intent new-task` or a distinct task contract automatically supersedes and archives any unresumed `blocked` run on the worktree, reclaiming the mutation lease.

