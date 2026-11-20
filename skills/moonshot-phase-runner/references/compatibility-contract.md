# Compatibility Contract Reference

Machine-readable compatibility anchors. Load only for compatibility audit.

## Default Paths

- `.claude/**`
- `.codex/**`
- `docs/implementation/<plan-slug>/`
- `.moonshot-relay/docs/phase-status.yaml`
- `scripts/project-identity.mjs`
- `docs/public/guidelines/minimal-correct-implementation.md`
- `${MOONSHOT_RELAY_HOME:-~/.moonshot-relay}`
- `references/control-plane.md`
- `references/execution-modes.md`
- `references/closeout-gates.md`

## Hard Stops

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
- Optional `--allow-parallel` only when the operator intentionally wants more than one active run for the same goal.
- Active status file: `.moonshot-relay/docs/phase-status.yaml`, used as a phase cursor projection only.
- Execution route: `in-session-coordinator` by default. `delegated-terminal` is legacy compatibility only and requires an explicit legacy maintenance reason.
- Default execution artifacts are written under the project-scoped account-root execution namespace resolved by `scripts/project-identity.mjs`, separated by projectId, worktree, branch, plan slug, and runId. Pass `--execution-root` only when an explicit alternate root is required.
- Do not put raw MemoryGraph records, KG edges, ontology dumps, logs, transcripts, or secret-like strings into phase prompts, attempt manifests, workflow evidence, QA reports, scorecards, or handoffs.
