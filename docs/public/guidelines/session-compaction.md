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

Use the existing `kernel_report` MCP tool with the optional `handoff` field at
a meaningful loop boundary. It accepts `decisions`, `rejectedApproaches` and
`remainingRisks`. An accepted report with a ready implementation step can
return `loopHandoff.status = "saved"`. The Markdown file is in the Kernel
runtime's `reports/loop-handoffs` directory. Its digest binds it to the observed
Run, Worktree, contract, cursor, workspace, knowledge revision and evidence.

An App Server client can retain its read-only conversation with
`createCodexAppServerTransport({ retainReadOnlyThreadForRun: runId })`. After
the model turn ends and the report settles, the owning Host calls
`continueKernelCodexLoop` with the saved handoff and its next turn input. The
Host controls when to request Compact. The continuation consumes the report's
existing directive. The Host compares Kernel authority again before the next
read-only turn, and includes the verified handoff in the prompt. Any file
write or report still uses the normal Kernel scope and admission.

| Surface | Automatic cleanup |
| --- | --- |
| Host-owned Codex App Server conversation | Uses `thread/compact/start`. A matching completed `contextCompaction` item and completed turn establish success. |
| Codex Desktop, interactive Codex CLI and Claude Code | Host-owned command execution and Run rebinding are unverified. The handoff can be saved while cleanup is deferred. |
| Clear | No surface has verified the required Clear and same-Run rebinding sequence. |

An active turn, unsettled attempt, mutation lock, stale workspace or corrupt
handoff blocks the continuation. An unsupported Compact RPC can leave the
same idle conversation available. Uncertain transport state defers dispatch.
The report remains the Kernel authority in each case.

With an authenticated local Codex App Server, run `npm run build`, then
`npm run build:tests`, then `npm run test:host-loop-compaction-native`. The
test uses an isolated pricing fixture and checks two Compact boundaries and
the final Kernel completion on the same Run.
