---
name: kernel-commit
description: Safely commit explicit Git changes and optionally close out Kernel project knowledge.
user-invocable: true
---

# Kernel Commit

## Goal
Execute a safe, governed Git commit (and optional remote push) for an accepted Kernel run while enforcing staging deny-lists and recording verifiable Git receipts.

## Context
- **Command**: `node scripts/kernel/standalone/kernel-commit.mjs --message-file <utf8-file> [--push] [--approve] [--reason "..."] [--operator-approval-ref <host-ref>] [--json]`
- **Alternative Entrypoint**: `node bin/kernel-commit.mjs --message-file <utf8-file> [--push] [--approve] [--reason "..."] [--json]`
- **Provenance Binding**: Resolves project identity and verifies run completion provenance.
- **Message Format**: Review the actual commit diff and write its problem, resulting behavior, and relevant verification as a subject and body in a UTF-8 file. The authored body leads; Kernel adds compact provenance. See [references/commit-message.md](references/commit-message.md).

## Describe the Change

- Before committing, inspect the selected/staged diff and compare the message with the full implementation scope. A final run named verification, admission, link cleanup, or commit/push may cover only closeout; its objective and ACs do not describe the entire patch.
- For an implementation commit, explain what changed and why, followed by verification and material limitations. Do not replace this explanation with execution IDs, receipt fields, approval checks, or a file list. Scale detail to the change; a small fix may need only one sentence.
- Write real newlines to the message file and pass `--message-file`; do not put multiline text into shell interpolation. Do not combine it with `--message`. File input requires a subject and nonempty body. Legacy title-only input remains available for existing automated callers, not the default for this skill.
- When asked to correct a published message, follow the message-only amendment procedure in the reference. Preserve its tree and parents and use a lease bound to the observed remote hash; do not create a new implementation run merely to change prose.

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
- Confirm the stored message explains the implemented behavior before reporting completion; successful receipt creation alone does not establish message quality.
