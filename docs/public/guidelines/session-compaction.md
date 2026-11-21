# Session Compaction

Canonical source guideline for compacting session notes without copying raw transcripts.

Compaction should preserve objective, decisions, changed files, commands, verification results, blockers, and next steps.
Drop repeated status chatter, raw logs, secrets, and low-value command output unless needed to reproduce a failure.
Keep source-grounded facts with path references and mark stale or memory-derived facts clearly.
Prefer the runtime status read model over raw transcript replay when reconstructing active contract, latest verdict, current blocker, lineage, stale warnings, and next action.
Use `scripts/context-state.mjs compact --json` or the library equivalent for long-running phase handoff compaction.
Compaction may omit raw event history and repeated chatter, but it must not lose objective, phase, current blocker, lineage, assumptions, evidence, changed files, open risks, or next action.
Rehydration should use `scripts/context-state.mjs rehydrate --json` to produce a phase brief from the compact DB-derived state, not from a copied transcript.
A compacted handoff must let the next run continue without redoing broad discovery.

## Kernel loop handoff

The Host can save a handoff from a settled `kernel_report` with a ready
implementation step. For a connected Host loop, the report summary is enough.
The optional `handoff` field adds `decisions`, `rejectedApproaches` and
`remainingRisks`. It also requests a handoff on other MCP connections.
A successful save returns `loopHandoff.status = "saved"`. The Markdown file is in the Kernel
runtime's `reports/loop-handoffs` directory. Its digest binds it to the observed
Run, Worktree, contract, cursor and workspace. The file includes evidence
references from the time of the save.

An App Server Host can bind a read-only conversation to a Run with
`createCodexAppServerTransport({ retainReadOnlyThreadForRun: runId })`.
Give `createMcpBridgeHandler({ codexLoop })` the transport and the Host's
`prepareTurn(next)` function. Use `runKernelCodexLoopTurn` with the same
Host for the first turn. Once the report and current turn settle, the Host
starts a fresh ephemeral read-only Thread on the same transport. It uses
the existing Run, Worktree, owner and `report.next`. This transition calls
Compact zero times. File changes still require Kernel scope and admission.

An idle Host receives the follow-up outcome in `loopContinuation`.
A report submitted inside a turn returns `host_turn_settling` so that turn
can finish. The Host receives the follow-up outcome through its
`onContinuation({ runId, stepId, result })` callback. Use that callback to
receive the next model output or its failure. Without a callback, the
handler returns `host_continuation_observer_required` and starts no turn.
An interrupted, failed or unconfirmed current turn also prevents automatic
continuation. A report replay does not start another turn for the same directive.

The Host adds up to 8 KiB of UTF-8 handoff context to the next prompt.
When the handoff exceeds this limit, the excerpt puts the next work and
recent decisions first. It includes the runtime-relative path and digest
of the full Markdown file. The file retains the decision history and
Kernel evidence references. The report directive still supplies the
canonical scope.

An unsettled Writer attempt, mutation lock or stale workspace blocks
continuation. If the handoff is unavailable or corrupt, the Host uses the
current Kernel directive. A failed or unconfirmed follow-up produces a
failure outcome. The Host does not replay that start. The settled report
remains authoritative.

Codex Desktop, interactive Codex CLI and Claude Code can save the handoff.
Use the normal Run discovery and resume flow on those surfaces.

Run `npm run build`, `npm run build:tests` and `npm run test:host-worker-handoff`
to check the fixture. It verifies three Work Units and three Threads in one
Run, zero automatic Compact calls, and the Host's recovery boundaries.
With an authenticated local Codex App Server, the optional
`npm run test:host-loop-compaction-native` checks an explicitly requested
Compact and a subsequent turn in the same Thread.
