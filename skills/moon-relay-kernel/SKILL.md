---
name: moon-relay-kernel
description: Default provider-neutral command-skill entrypoint for Moon Relay Kernel task routing and adaptive workflow execution. Selecting this skill activates Kernel workflow for that task; it does not force unselected ordinary tasks into Kernel.
---

# Moon Relay Kernel

## Goal
The account command skillset defaults to Kernel. Bind the current project/worktree to Moon Relay Kernel, execute assigned bounded work units, and drive the task to authoritative Kernel completion with verified proof and receipts; for a non-kernel track return `wrong_harness` without mutating the repository.

## Context
- **Binding Scope**: `Project → Worktree → Run`, scoped by canonical root and Git worktree identity under runtime home `~/.moon-relay-kernel`.
- **Two Core Commands**:
  - `kernel next [--contract-json <file>]` (or MCP `kernel_next`): Starts, re-enters, or explicitly refreshes the Run and returns objective, acceptance, constraints, context capsule, and the active work unit.
  - `kernel report [--report-json <file>]` (or MCP `kernel_report`): Submits the work result, risks, and requested verifications, then returns the canonical continuation in `next`. After a normal report, consume that returned continuation directly instead of issuing an immediate `kernel next` only to advance. In an owner-direct Git workspace, omit `changedPaths` unless making an explicit claim; Kernel derives the authoritative delta. Non-Git reports must supply `changedPaths`, and isolated worker receipts keep their required path provenance.
- **Task Contract**: On MCP, pass semantic `contractJson` directly on the first `kernel_next`: objective, acceptance statements, constraints, non-goals, and a bounded mutation scope when it is known. The Kernel assigns acceptance IDs, obligation wiring, digest, and revision; do not author those internal identifiers. The CLI keeps `kernel next --contract-json <file>` for CLI callers. Do not copy an objective into acceptance, and omit unknown scope instead of sending `allowedPaths: []` as a claim; do not bootstrap a fresh session with bare `kernel next` (use bare `kernel next` only after a Host binding exists).

## Autonomy & Priorities
- **Host Execution Policy**: Execute each model-owned work unit according to the active provider Host policy. A Host may use owner-direct execution or require an isolated child; the public Kernel skill does not override that provider boundary.
- **Mutation Boundary**: Never mutate files outside `allowedPaths`. Mutations outside the allowed unit are rejected before verification runs.
- **Delegation**: Delegation mode, freshness, nesting, and concurrency are Host-owned. Follow the active provider profile rather than inventing a second workflow.
- **Agent Recovery**: Treat unexpected conditions as diagnostic work. Use the failure's `recovery` capsule or `kernel next [run-id] --diagnose --json` to observe Run/worktree/owner authority and investigate the responsible source and environment. Host-managed surfaces preserve the previous diagnosis capsule across retries; the model repairs the cause but does not maintain recovery fingerprints or counters. Repair within the current work unit, refresh `next`, then submit the actual work result through `report`; Kernel settles outstanding hard obligations through trusted proof execution or exact reusable evidence. Unknown errors use the same loop; do not invent fallback completion or edit runtime DB/receipts. See [recovery guidance](../../docs/public/guidelines/kernel-agent-recovery.md).
- **Progress Bound**: Let the Host feed the previous diagnosis capsule back into recovery continuity. Three unchanged comparisons still escalate to a blocker. Use `--previous-recovery-json <file>` only when continuing diagnosis through a stateless/manual CLI process that cannot retain Host continuity. Do not repeat unchanged commands indefinitely.


## Context and Wait Budget
- Use `kernel --help` or `kernel report --help` for CLI usage; help never binds a Run or starts verification. Default CLI/MCP output is compact; request `--verbose` (MCP `verbose: true`) only for a specific diagnostic need.
- Search with `rg` first, then read the relevant function or section. Keep each tool result near 4,000 tokens or less; save long diagnostics to a file and inspect only failures or selected fields.
- Inspect `git diff --stat` first, then one relevant file or hunk per read. Do not dump the entire multi-file diff into the model context.
- For tests and report verification, use a 10–30 second initial wait and 30–60 second continuation waits supported by the tool. Avoid one-second polling; keep user progress updates within 60 seconds. Inspect completion and failures once the process exits.
- Declare directory scope as globs such as `scripts/kernel/**`, not `scripts/kernel/`. For broad work, supply bounded steps with an objective and explicit `allowedPaths`; do not manufacture `AC-*` or obligation IDs for those steps. Kernel keeps explicit valid bindings when supplied and conservatively settles otherwise-unclaimed goal criteria on the final Work Unit. Never invent file ownership by splitting acceptance text.

## Definition of Done
- Treat Kernel completion decisions as the only completion authority. A run is done only when the latest canonical continuation has `{ action: { type: "done" } }`; this can be the result of `kernel next` or the `next` returned by `kernel report`. Do not make an extra `kernel next` call only to reconfirm a `done` continuation. Narration or plain text completion claims have zero authority.
- Reusable invariants, required verifications, architecture decisions, and failure patterns are recorded in `knowledgeObservations` upon completion.

## Verification
- Request verifications using the command refs listed by the current canonical continuation (`kernel next` or `kernel report.next`) for each outstanding obligation; the Kernel runtime executes them and owns the resulting evidence receipts.
- For independent review actions (security review, protected T3 obligations, explicit flags), satisfy them via trusted review receipts recorded from an independent reviewer session (or native subagent fallback). In single-session environments where independent sessions cannot be spawned, request user operator approval. Resolve only outstanding judgment obligations via `kernel approve <run-id>` or `kernel-commit --approve` when the Host supplies an operator approval reference; hard evidence remains mandatory.
- Use local tests when they help implementation feedback, but do not duplicate Kernel completion proof before `report`. Submit the work result and let Kernel settle outstanding hard obligations with trusted execution or exact reusable evidence. Request a fresh execution only when the obligation is stale, flaky, or explicitly requires fresh proof.

## Plan Ingestion & Worktree Reclaim
- **Fast 2-Turn Plan Reading**: When ingesting an external plan or large specification (>200 lines), do not run iterative chunk loops (`Select-Object -Skip ... -First ...` or repeated `head/tail` turns).
  - Turn 1 (Index Scan): Extract outline and line numbers in one turn:
    - PowerShell: `Select-String -Path <planPath> -Pattern '^#+ ' | Select-Object LineNumber, Line`
    - Shell: `grep -nE '^#+ ' <planPath>`
  - Turn 2 (Targeted Slice): Extract only the targeted section or Wave range identified from the index scan, then proceed immediately to task contract creation.
- **Contract Scale Sizing**:
  - Small / Bounded Tasks: Send only the semantic contract fields needed for the goal; let Kernel create the synthetic Work Unit and internal IDs.
  - Multi-Wave / Large Tasks: Declare the needed steps with semantic objectives and bounded `allowedPaths`; let Kernel bind acceptance and obligations instead of hand-wiring internal IDs.
- **Ghost Run Recovery**: Starting a new task with `--invocation-intent new-task` or a distinct task contract automatically supersedes and archives any unresumed `blocked` run on the worktree, reclaiming the mutation lease.
