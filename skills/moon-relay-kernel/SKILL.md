---
name: moon-relay-kernel
description: Default provider-neutral command-skill entrypoint for Moon Relay Kernel task routing and adaptive workflow execution. Selecting this skill activates Kernel workflow for that task; it does not force unselected ordinary tasks into Kernel.
---

# Moon Relay Kernel

## Goal
Bind the current project/worktree to Moon Relay Kernel, execute the active bounded work unit, and continue until the Kernel returns authoritative completion. For a non-kernel track return `wrong_harness` without mutating the repository.

## Entry
- `kernel next [--contract-json <file>]` or MCP `kernel_next` starts or resumes a Run and returns the current semantic contract and work unit.
- `kernel report [--report-json <file>]` or MCP `kernel_report` submits the work result and requested verifications. Consume the returned `next` continuation instead of issuing an extra advance call.
- On the first MCP call, send semantic contract data: objective, acceptance, constraints, non-goals, and known bounded mutation scope. Kernel owns internal acceptance IDs, obligation wiring, revisions, and digests.
- Omit unknown scope instead of declaring an empty allowlist. A fresh session requires an explicit contract or existing Host binding.

## Authority
- Binding authority is `Project → Worktree → Run`.
- The current Kernel action and Task/Work Contract own mutation scope, acceptance, required evidence, and completion state.
- Provider model selection, execution mechanism, delegation, session freshness, and concurrency are Host-owned.
- Do not mutate outside the current work unit or recreate Kernel/Host authority in prompt rules.

## Execution and Recovery
- Make routine implementation decisions inside the active contract.
- On unexpected failure, use the returned recovery/diagnosis state to identify whether the cause belongs to repository code, harness authority, provider execution, or the local environment. Repair the owning cause; do not create fallback completion or edit runtime DB/receipts.
- Refresh `next` only when a new canonical state is needed, then submit the actual work result through `report`.
- For broad work, declare semantic steps with bounded paths. Do not manufacture Kernel internal IDs.

## Verification and Completion
- Request only outstanding verifications exposed by the canonical continuation. Kernel executes trusted proof or reuses exact fresh evidence.
- Independent judgment obligations use trusted review receipts. If the Host cannot create the required independent session, operator approval may satisfy only eligible judgment obligations; hard evidence remains mandatory.
- Local checks may support implementation feedback, but they do not replace Kernel evidence.
- A Run is complete only when the latest canonical continuation returns `action.type = "done"`. Do not call `next` again only to reconfirm it.
- Reusable invariants, required verifications, architecture decisions, and verified failure patterns enter durable Knowledge only through the existing reviewed lifecycle.

## References
- [agent recovery](../../docs/public/guidelines/kernel-agent-recovery.md)
- [provider-neutral model routing](../../docs/public/guidelines/provider-neutral-model-routing.md)
