---
name: moonshot-orchestrator
description: Use for bounded implementation work that already has enough context and does not need the phase harness.
policyClauseIds:
  - moonshot-orchestrator.policy.use-when
  - moonshot-orchestrator.policy.routing
  - moonshot-orchestrator.policy.hard-stops
  - moonshot-orchestrator.policy.output-contract
policyDigest: a2ca28c6f515f7e7f2ab8412c1ec96bdaf42be948334851a919cc358034d24d9
triggers:
  - "moonshot orchestrator"
  - "bounded implementation"
  - "implement this"
deepReferences:
  - references/compatibility-contract.md
  - references/bounded-flow.md
  - references/review-and-verification.md
---

# Moonshot Orchestrator

## 사용 시점

Use for a bounded implementation objective with enough accepted context to execute and verify now.

## 역할

Own and prove one implementation slice. Architecture-derived work consumes only the bounded selected ADR and traceability slice.

## 다른 경로

- Use `moonshot-phase-runner` for multi-phase plans, long-running harness work, or staged adoption packages.
- Use `product-orchestrator` when the user is still defining product scope.
- Use `moonshot-architecture` before implementation when the request lacks an accepted architecture package for non-trivial architecture decisions.
- Stop for clarification only when a wrong assumption would change scope, security, data shape, or user-visible behavior.

## 중단 조건

- Do not broaden scope beyond the user request.
- Do not skip code review for non-trivial code changes.
- Do not claim completion with stale, missing, or smoke-only evidence.
- Do not execute a blocked `ARCHITECTURE_HANDOFF`, and do not bypass a ready handoff by copying raw KG, ontology, MemoryGraph, log, transcript, or browser scrape payloads into the attempt prompt.
- When runtime-state completion authority is available, do not claim clean finish from chat output, markdown reports, phase status, or verifier JSON alone. Require `scripts/runtime-state.mjs assess-completion` to produce an accepted DB decision.
- Before approval-required operations or writes near protected runtime paths, classify the operation with `tools/sandbox/policy.mjs check --json`; unauthorized blocking events must stop clean completion.
- Do not mutate unrelated files or revert user changes.

## 절차

1. Confirm bounded scope and ready handoff guards; never replace architecture evidence with chat summaries.
2. Apply `docs/public/guidelines/minimal-correct-implementation.md` before choosing the implementation shape, and apply `docs/public/guidelines/untrusted-content-boundary.md`.
3. Implement, review, rerun invalidated checks, and report evidence or a typed blocker.
4. For `moonshot-architecture` work, consume selected ADR `ADR/*.md`, `TRACEABILITY_MATRIX.md`, `ARCHITECTURE_REVIEW.md`, and the traceability slice; pass only `ARCHITECTURE_HANDOFF.promptBlock`. On violation use `scripts/architecture-feedback-render.mjs`, never raw KG.

## 출력 계약

- Affected file list and rationale.
- Minimality decision: reused existing surface, added new surface, or skipped lower-rung options, with reason.
- Fresh test/build/lint or targeted verification output.
- Review evidence when behavior, shared contracts, or harness logic changes.
- Agent operating policy evidence when applicable: retrieval, assumptions/blockers, untrusted content disposition, artifact routing, skill readiness, and cumulative risk. This evidence does not replace runtime-state completion authority.
- Explicit blocker classification if a required check cannot run.

## References

- `references/bounded-flow.md`: stage order, scope control, and output contract.
- `references/review-and-verification.md`: review gate, verifier expectations, and failure taxonomy.

## Project Knowledge Context Contract

Pass only the staged compact `projectKnowledgeContext.promptBlock` and status metadata. Raw knowledge records, logs, transcripts, and secrets are forbidden.
