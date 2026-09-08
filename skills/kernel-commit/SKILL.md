---
name: kernel-commit
description: Safely commit explicit Git changes and optionally close out Kernel project knowledge.
user-invocable: true
---

# Kernel Commit

## Goal
Execute a safe, governed Git commit (and optional remote push) for an accepted Kernel run while enforcing staging deny-lists and recording verifiable Git receipts.

## Context
- **Command**: `node scripts/kernel/standalone/kernel-commit.mjs [--message "..."] [--push] [--approve] [--reason "..."] [--operator-approval-ref <host-ref>] [--json]`
- **Alternative Entrypoint**: `node bin/kernel-commit.mjs [--message "..."] [--push] [--approve] [--reason "..."] [--json]`
- **Provenance Binding**: Resolves project identity and verifies run completion provenance.
- **Message Format**: Derives subject from objective or user prompt; appends bounded task-context body (run/project ID, mutation revisions, verification summary, changed paths). See [references/commit-message.md](references/commit-message.md).

## Autonomy & Priorities
- **Operator Approval**: When the user explicitly requests to approve and commit (e.g., "승인할테니 커밋해줘", "수동 승인하고 커밋해", "approve and commit"), pass `--approve` only with a Host-issued `--operator-approval-ref <host-ref>` (or `MOON_RELAY_KERNEL_OPERATOR_APPROVAL_REF`). This approves only declared, currently outstanding judgment obligations (such as `security-review`) with an `operator_approved` ReviewReceipt and may auto-finalize when all hard evidence is already fresh.
- **Hard Evidence Boundary**: Operator approval never substitutes for executable hard evidence. If tests, lint, build, or another hard obligation is stale or failing, run the bound verification instead of attempting an approval override.
- **Staging Fencing**: Explicitly stages only declared changed paths. Never stages runtime state, provider sessions, receipts, Code Index, or protected paths.
- **Knowledge Closeout**: `--memory-review` previews candidates. Without explicit `--approval-ref`, Git commit never auto-promotes unapproved Project Knowledge.

## Definition of Done
- Git commit created with authoritative hash and receipt recorded.
- If `--push` is specified, remote parity verified against upstream branch.

## Verification
- Run `git status -s` and inspect git log to ensure only expected paths were committed and working tree is clean.
