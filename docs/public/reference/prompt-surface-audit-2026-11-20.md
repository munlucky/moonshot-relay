# Moonshot Relay Prompt Surface Audit — 2026-11-20

## Scope and evidence

- Baseline: `main`, `e268bca472118f4f10394f70f9a00eefda8608c0` before this change.
- Method: review of the supplied Codex/Claude Prompt Audit findings, prior `artifacts/kernel-prompt-audit/` evidence, current canonical source, Git search, and the Host's actual prompt-dispatch call sites. Read-only inventory was followed by narrowly scoped fixes.
- Static discovery: 2,842 tracked files, 397 instruction/document candidates, 572 source/tooling code candidates, 82 canonical `skills/*/SKILL.md` files. These are *candidate counts*, not the number of instructions actually loaded into one model request.
- Runtime path: `src/host/kernel/model-capsule-view.ts` projects the six model-visible fields; `src/host/kernel/turn-dispatcher.ts`, `src/host/kernel/adapters/codex.ts`, and `src/host/kernel/adapters/claude.ts` use that projection. The standalone OpenAI/Claude renderer functions have tests, but no non-test import was found in the inspected `src/` and `scripts/` call graph. No conclusion about external consumers or package support follows from that observation.

## Applied fixes and acceptance

| Finding | Evidence | Change | Verification |
| --- | --- | --- | --- |
| Fixed Windows checkout path | `agents/harness-memory-promoter.md:16` and `.ko.md:16` | Express execution scope as the `moonshot-relay` Git worktree root; preserve all promotion approval and safety rules | New static regression test |
| Broken skill-relative Markdown links | `skills/commit-moonshot/SKILL*.md` References, `skills/session-logger/SKILL*.md` References | Correct fourteen link destinations to `../../docs/...` or `../../rules/...` in English and Korean | Resolve each Markdown target relative to its source file; new test |
| Codex profile labels generated code as source | `package/profile-templates/codex/AGENTS.md` Repository Structure versus `package/source-layout.json` | Identify `src/kernel/` and `src/host/kernel/` as canonical; identify `scripts/` as generated | Existing profile validation plus new regression test |
| Current audit inventory became stale after profile edit | `artifacts/kernel-prompt-audit/prompt-inventory.json` | Synchronize only current `AGENTS.md` bytes/lines (2,330 bytes, 51 lines) | Existing exact-byte inventory test |

## Deliberately not changed

- Prior `C01` compact prompt candidate was rejected (`keep-baseline`): historically baseline acceptance 12/12 vs candidate 11/12, with one scope violation. Continue using `buildModelVisiblePromptMessage()` in production; do not activate candidate or guidance ablation without new behavioral evidence.
- Do not remove `Kernel next/report`, bounded mutation, protected evidence, review independence, or completion authority rules based on uppercase emphasis alone. The scan found 66 candidate emphatic lines in 22 files; these are **not 66 confirmed defects**.
- Do not delete independent provider renderers without verifying external/package consumers and the actual desired provider wire interface.
- Do not add a new Prompt Audit framework, scheduled audit, Kernel stage, DB, or mandatory agent. A reusable Codex skill can be separately considered after native Codex invocation is available.
- Keep `artifacts/kernel-prompt-audit/prompt-size-before.json`, `prompt-size-after.json`, and the historical C01 decision unchanged. The live inventory is distinct from these historical records.

## Verification boundary

- Static edits and source-link resolution can be tested on the Linux Moonremote workmachine.
- Native Codex behavior, token savings, Claude model behavior, and installed profile link resolution were **not measured** in this run. The native Windows executor is unavailable and `codex` is not on the workmachine PATH.
- Success of unit/contract tests does not establish improvement in real agent task completion. Any future prompt wording changes require the existing baseline/candidate replay quality gate, with failure and scope violations counted.

## Executed checks

- `build:tests`: completed after limiting the Node heap to 560 MiB (`tests: 307` generated; this is build output, not 307 passing tests). The initial default-heap build failed at about 390 MiB with JavaScript heap OOM. No persistent memory setting was changed.
- Focused test files for active contracts, prompt inventory, Codex profile, prompt replay, memory promotion, skill lint, and capability assets: **70 tests, 69 pass, 0 fail, 1 environment skip**.
- Public skill lint: **11/11 pass**, with the original token budgets unchanged. The over-budget fixture was enlarged so that it continues to test actual rejection after guidance was shortened.
- Isolated account-root installer merge test: **1/1 pass** with a smaller child-process heap. An earlier combined test hit `ENOMEM` under the 768 MiB cgroup limit; native/account installation is not claimed.
- `skills-audit.mjs audit` using `skills.lock.json`: **pass, 0 findings** after updating only the two changed canonical skill hashes.
- `git diff --check`: pass.

## TODO — verify after actual Codex usage (deferred by user, 2026-11-20)

These are **not release gates for this documentation/link cleanup**. Do not mark completed from static tests or unrelated runs. Collect evidence from the **first relevant native user session after installation**; compare against the current baseline rather than assuming savings from wording changes.

- [ ] **Native account-root adoption:** when the Windows Moonremote host executor is available, verify source `main` revision equals the intended pushed commit, inspect existing user-home profiles without overwriting custom settings, run the existing account-root installer under the user's actual account, and confirm `installId`, `verification[]`, and `profileSurfaceParity[runtime=codex].extraCanonicalCount=0`. Run installed doctor against installed paths and record the installed revision, target home, install result, and any restore/rollback outcome. Do not substitute the Linux workmachine's `/root` home for the user's account.
- [ ] **Prompt delivery:** after an actual Codex task using the installed profile, inspect the Host/Adapter's real provider-message digest or safe redacted observation and confirm that the six fields are preserved; the runtime must still call `buildModelVisiblePromptMessage()` unless a separately approved replay changes this baseline.
- [ ] **Functional acceptance:** for that real task, record its original acceptance criteria, changed path list, focused verification command and result, Kernel evidence/receipt and completion decision. Confirm that a passing test does not conceal out-of-scope file edits or unsupported completion claims.
- [ ] **Behavior and cost:** when a comparable baseline trace is available, report success/acceptance, scope violations, failed/repeated tools, human interventions, token usage and elapsed time. Mark missing data **unmeasured**, not zero; do not declare an optimization win without a sound comparable baseline.
- [ ] **Decision:** document outcome as `keep-baseline`, `candidate-for-controlled-replay`, or `not-evaluable`, with evidence paths and observed model/effort. Do not silently deploy compact-prompt or guidance-ablation candidates rejected by the historical C01 quality gate.

**Evidence to fill in after use:** date / native runtime + account home / installed commit / installId + installed doctor / run or session ID / task + acceptance / prompt digest / evidence + completion decision / baseline comparison / final verdict.

As of 2026-11-20 the Windows native host executor reports `persistence_unavailable`. Repository commit and remote push do **not** imply account-root adoption.

## Stop rule

Close this narrowly scoped audit cleanup when source-link and profile regression tests pass and the source tree is coherent. A separate optimization experiment is justified only by a concrete production prompt defect or measurable before/after behavior; do not re-open historical `keep-baseline` findings by default.
