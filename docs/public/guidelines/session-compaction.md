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
Run, Worktree, contract, cursor, workspace, knowledge revision and evidence.

An App Server Host can retain its read-only conversation with
`createCodexAppServerTransport({ retainReadOnlyThreadForRun: runId })`.
Bind that transport and the Host's `prepareTurn(next)` function through
`createMcpBridgeHandler({ codexLoop: { transport, prepareTurn } })`. Submit
the report through that handler after the active model turn ends. The
handler saves the handoff, checks the Run and cursor, requests Compact, and
dispatches the next read-only turn using the report's existing directive.
It returns the outcome in `loopContinuation`. Any file write or report
still uses the normal Kernel scope and admission.

The Host adds up to 8 KiB of UTF-8 handoff context to the next prompt.
When the handoff exceeds this limit, the excerpt puts the next work and
recent decisions first. It includes the runtime-relative path and digest
of the full Markdown file. The file retains the decision history and
Kernel evidence references. The report directive still supplies the
canonical scope.

| Surface | Automatic cleanup |
| --- | --- |
| Host-owned Codex App Server conversation | Uses `thread/compact/start`. A matching completed `contextCompaction` item and completed turn establish success. |
| Codex Desktop, interactive Codex CLI and Claude Code | Host-owned command execution and Run rebinding are unverified. The handoff can be saved while cleanup is deferred. |
| Clear | No surface has verified the required Clear and same-Run rebinding sequence. |

An active turn, unsettled attempt, mutation lock, stale workspace or corrupt
handoff blocks the continuation. A confirmed unsupported Compact RPC allows
the same idle conversation to continue. Missing or mismatched completion
evidence blocks any further turn on that connection. A follow-up turn that
fails returns `loopContinuation.status = "failed"` and the Host does not
replay it. The report remains the Kernel authority in each case.

With an authenticated local Codex App Server, run `npm run build`, then
`npm run build:tests`, then `npm run test:host-loop-compaction-native`. The
test sends three scoped pricing reports through the production MCP handler
and checks two automatic Compact boundaries and final Kernel completion on
the same Run. The fixture uses model-generated values and applies them
through the test Host.
