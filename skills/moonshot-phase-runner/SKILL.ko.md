---
name: moonshot-phase-runner
description: Use for large, phase-based, or long-running implementation work that should run from a prepared plan package.
policyClauseIds:
  - moonshot-phase-runner.policy.use-when
  - moonshot-phase-runner.policy.routing
  - moonshot-phase-runner.policy.hard-stops
  - moonshot-phase-runner.policy.output-contract
policyDigest: 86145bafac456b4ecf67a41ba8f6fe11e5548bcaa707edb58afa9067fe2cbdc0
triggers:
  - "phase runner"
  - "run phase"
  - "execute phase"
  - "agent loop"
deepReferences:
  - references/compatibility-contract.md
  - references/control-plane.md
  - references/execution-modes.md
  - references/closeout-gates.md
---

# Moonshot Phase Runner

## 사용 시점

Use for a prepared multi-phase or long-running plan package that must continue across phase attempts.

## 다른 경로

Use `moonshot-orchestrator` for one bounded implementation objective; use `product-orchestrator` or `moonshot-architecture` while definition or architecture is still missing.

## 역할

Own the public control-plane entrypoint for phase-based work. Resolve the active plan directory, validate the package, seed or reconcile `phase-status.yaml`, choose the in-session/forked-agent execution route, and keep the run moving until the full plan directory is complete or a concrete blocker is recorded.

## 중단 조건

- Treat a general start request such as "작업시작", "start work", "run this plan", or a plan directory plus master plan as full-plan execution intent. Do not narrow it to Phase 01, a waiver phase, or a preparation slice unless the operator explicitly says a single phase only, for example "Phase 01만" or "only phase 01".
- Do not treat a completed phase as plan completion while `phase-status.yaml` still has actionable phases.
- Do not treat `phase-status.yaml`, verifier JSON, QA report, scorecard, handoff, or child chat output as clean-finish authority when runtime-state completion authority is available. Use `scripts/runtime-state.mjs assess-completion` and require an accepted DB decision.
- Treat `runtime-state.sqlite` as the authority for blocker state, resume reconstruction, run status, and whole-plan completion decisions; `phase-status.yaml` is only a phase cursor projection.
- Do not execute a phase plan derived from an architecture package when selected ADRs, traceability rows, owners, or verification signals are missing from the phase metadata.
- Do not dispatch a phase with `architecture.required=true` when `ARCHITECTURE_HANDOFF.json` is missing, blocked, or lacks selected verification signals.
- Do not stop the whole plan just because a completed phase produced review findings, failed eval evidence, or a non-accepted completion decision. Record the blocker as carry-forward evidence, keep the final completion gate closed, and continue the next actionable independent phase.
- Do not assume phases are parallelizable from prose alone. Parallel execution requires validated plan graph metadata with dependencies satisfied and non-overlapping write sets.
- Do not write live `.claude/**` or `.codex/**` adoption targets before the plan's designated controlled adoption phase.
- Do not mutate live account-root, `.claude/**`, or `.codex/**` runtime profiles until the Operational Adoption Closeout gate passes from source evidence. Live adoption is a separate controlled step after harness-lab, package, eval, doctor, and runtime-surface parity evidence.
- Do not use `agent-loop.mjs`, `moonshot-phase-dispatch.mjs`, or delegated-terminal adapters as the default execution path. They are legacy/headless compatibility adapters only.
- Do not return final success until the in-session coordinator, fresh verifier evidence, scorecard, and repository closeout evidence agree.
- Do not repeat full matrices per edit or reopen frozen source identity for advisory findings; use focused tests and reopen only for P0, security/data-integrity, authority, mandatory-execution, or proven broad regression blockers.

## 절차

일반 시작 요청의 전체 plan 실행 의도를 Phase 01로 임의 축소하지 않습니다.

1. Resolve and validate the plan graph, cursor, execution root, run identity, and lease authority.
2. Do not infer parallelism; require validated dependencies and disjoint write sets.
3. Build a minimal phase brief with scope, selected architecture evidence, policy anchors, and applicable spec-test obligations.
3.1. Include `docs/public/guidelines/minimal-correct-implementation.md` as a mandatory implementation-shape constraint, `docs/public/guidelines/skill-readiness-policy.md` as evidence that is not a public runtime surface change, and `docs/public/guidelines/untrusted-content-boundary.md`.
4. Require ready handoff metadata and attach only its compact prompt block.
4.1. For an architecture package, carry selected ADR, traceability, owner, verification signal, `architecture.required`, and `ARCHITECTURE_HANDOFF.promptBlock`; reject a blocked handoff.
5. Coordinate fresh implementation and review agents in-session; legacy terminal adapters remain explicit compatibility paths.
6. Collect fresh verifier and scorecard evidence, reconcile the cursor, and continue every actionable phase.
6.1. Escalate focused-to-full: batch focused remediation, freeze source identity, then run one required full matrix; rerun only after a blocker changes that identity.
7. Keep rejected evidence as carry-forward blockers; only accepted runtime-state authority closes the whole plan.
7.1. Do not stop the whole plan just because a completed phase produced review findings. Record carry-forward evidence and continue to the next independent actionable phase. Only the final whole-plan completion claim requires `assess-completion` to return `accepted`.
8. Before adoption, run the complete closeout in `references/closeout-gates.md`, then verify installed parity and requested Git closeout.

## 출력 계약

- Plan resolution and active phase source.
- Execution mode and any explicit legacy fallback reason.
- Runtime capability evidence when a tool/fork/browser path is missing.
- Review evidence for code-changing phases.
- Plan graph validation evidence or explicit markdown-compatible mode evidence.
- Minimality decision evidence: lower-rung reuse/skip/new-surface choice from `docs/public/guidelines/minimal-correct-implementation.md`.
- Agent operating policy evidence: source-backed retrieval for volatile facts, assumption/blocker disposition, untrusted content disposition, context relevance, artifact routing, skill readiness, and cumulative-risk carry-forward when encountered.
- Fresh verifier verdict and scorecard agreement.
- Verification escalation: focused commands, frozen source identity, final full-gate commands, and any blocker that required a rerun.
- Spec-Test Obligation validator evidence when plan artifacts contain `REQ-*`, `SCN-*`, or UAT-critical items; missing validator output at phase closeout or completion claim is `spec_test_obligation_result_missing`, and failures such as `spec_test_obligation_missing`, `tdd_red_evidence_missing`, `tdd_green_evidence_missing`, `required_spec_test_not_run`, `critical_scenario_smoke_only`, and `duplicate_spec_test_obligation` block clean finish.
- Coordinator closeout evidence and phase closeout result.
- Operational Adoption Closeout evidence before any live account-root/profile sync: independent completion audit, independent operational adoption audit, `node scripts/doctor.mjs check --json`, `node scripts/skills-audit.mjs audit --lock skills.lock.json --runtime-surface package/runtime-surface.json --json`, `npm run test:lab`, `npm run test:package`, `npm run test:eval`, `npm test`, and `node package/build-package.mjs --runtime all --dry-run --json`.
- Live adoption evidence, when performed: `node bin/moonshot-relay.mjs install --runtime all --json`, installed doctor with explicit `--repo-root`, `--lock`, and `--runtime-surface` paths under `${MOONSHOT_RELAY_HOME:-~/.moonshot-relay}`, and installer JSON `profileSurfaceParity` with `profileSurfaceParity[runtime=codex].extraCanonicalCount=0`.
- Enforce Final Git Closeout evidence before any whole-plan success return.

## References

- `references/control-plane.md`: state authority, phase discovery, and parent evidence collection.
- `references/execution-modes.md`: forked-agent primary path and legacy delegated-terminal boundary.
- `references/closeout-gates.md`: review, verification, finalizer, and repository closeout rules.

## Project Knowledge Context Contract

Before creating any phase attempt prompt, call the staged `knowledge-context-build.mjs` helper with `stage=execute` and attach only `projectKnowledgeContext.promptBlock` plus status-only metadata.

Required metadata surface:
- `status`, `strictness`, `stage`, `blocking`, `unavailableCount`, and `knowledgeRevision`.
- Do not put raw MemoryGraph records, KG edges, ontology dumps, logs, transcripts, or secret-like strings into phase prompts, attempt manifests, workflow evidence, QA reports, scorecards, or handoffs.
- Helper unavailable in advisory mode degrades to `status=degraded_read` and continues. Helper unavailable in strict memory mode is represented as blocking metadata before dispatch.
