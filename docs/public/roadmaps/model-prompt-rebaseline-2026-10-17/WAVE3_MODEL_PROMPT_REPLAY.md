# Model & Prompt Rebaseline — Wave 3 Replay Contract

- Wave 3 base: `main / 43bc2463dead0a30f7126a29e4d2db0d52cfd989`
- Remote implementation status: complete when the deterministic replay contract and regressions pass.
- Model-backed comparison status: `EVAL_PENDING` in Moonremote because this environment has no Codex executable.
- Production policy status: unchanged.

## 1. Reuse instead of a new evaluation platform

Wave 3 reuses the existing C01 prompt comparison contract in:

`tests/fixtures/kernel-eval/corpus.json#promptComparison`

The fixed inputs remain:

- six representative cases;
- baseline/candidate two runs each;
- ABBA order: baseline → candidate → candidate → baseline;
- the existing retry and incomplete-run budget;
- the existing quality and efficiency thresholds.

Wave 3 does not add another corpus, durable result store, CLI command, workflow stage, provider runner, or evaluation service.

The new `model-prompt-replay` module is a thin Host-tooling boundary. A live attempt follows:

```text
existing isolated case workspace
→ existing dispatchKernelTurn(...)
→ existing Host adapter
→ existing model usage receipt
→ replay attempt capture
→ baseline/candidate comparison
```

It does not call a provider on its own.

## 2. Actual execution identity is required

A run is comparison-ready only when the existing Host receipt proves all of the following:

- `enforcementStatus = enforced`;
- requested/resolved/observed model are present and equal;
- requested/resolved/observed effort are present and equal;
- `executionProfileRevision` is present;
- `promptPrefixDigest` is present.

Missing or advisory identity is `not-ready`. Requested configuration is never promoted to actual execution identity.

The replay also rejects accidental cross-arm drift. Host surface and execution-profile revision must stay equal. Model, effort, or prompt-prefix differences are allowed only when the experiment explicitly names that single intended difference.

## 3. First rebaseline experiment

The first experiment is intentionally one-dimensional.

Baseline:

- surface: Codex
- execution class: standard
- model: current production `gpt-5.6-luna`
- effort: current production `max`
- current common/provider prompt revisions
- current tool set

Candidate:

- same surface
- same execution class
- same model
- effort: `high`
- same prompt revisions
- same tool set

Therefore the experiment permits only an `effort` difference.

This candidate comes from an already-established Host-owned change seam. It is replay-only in Wave 3. `src/host/kernel/codex-model-policy.ts` remains unchanged at Luna/max.

Prompt changes are not combined with the effort experiment. If a prompt candidate is evaluated later, it must be a separate comparison that permits only the expected prompt-prefix change. This prevents a model/effort change and a prompt change from being credited to each other.

## 4. Adoption order

Wave 3 fixes the decision order required by the rebaseline plan:

1. **Quality**
   - task success and acceptance cannot regress;
   - critical authority violations must remain within the existing zero-tolerance gate for both arms;
   - scope violations, hardcoded solutions, and fallback/abstraction growth cannot increase.
2. **Regression / rework**
   - regression count cannot increase;
   - rework count cannot increase.
3. **Efficiency**
   - only after the first two gates pass;
   - use the existing C01 alternatives: at least one unnecessary action removed, or measured median token/latency improvement at the configured threshold.

A fast or cheap candidate with worse quality or more rework is rejected before efficiency is evaluated.

No aggregate synthetic quality/cost score is introduced.

## 5. Actual versus unavailable metrics

Provider usage fields are accepted only from existing Host receipts.

- `inputTokens + outputTokens` is used only when every included attempt has actual values.
- reasoning and cached tokens remain separate dimensions and are not added again.
- latency uses the existing `wallClockMs` receipt field.
- a missing metric remains unavailable and cannot prove the corresponding efficiency rule.

Evaluator observations such as correctness, hardcoding, regression, and rework are bound to an attempt but do not become Kernel authority.

## 6. Remote deterministic validation

Moonremote has no `codex` executable in the current environment. Wave 3 therefore does not create mock model-backed evidence.

The deterministic test uses the real `dispatchKernelTurn` path with an injected test provider seam only to prove that the replay helper consumes the same Host receipt contract used in production. This test is a contract regression, not a quality result.

Remote tests verify:

- real Host-dispatch receipt capture;
- fail-closed unobserved identity;
- exact six-case ABBA coverage;
- unexpected experiment drift rejection;
- quality → rework → efficiency ordering;
- no adoption when efficiency is unproven.

## 7. Local Codex evidence still required

Before Wave 4 can change a production default, run the existing six C01 cases in a Codex-capable local environment using the existing isolation rules in:

`docs/public/roadmaps/chat-moonremote-increments-2026-10-12/LOCAL_CODEX_VALIDATION.md`

Each arm must use identical case workspace seeds and tool conditions. The actual Host receipt for each run must be captured. Failed and incomplete attempts remain in the result.

Wave 4 may promote a candidate only if the live result is comparison-ready and passes quality, rework, and efficiency gates. Otherwise production remains Luna/max and the current prompt remains authoritative.

## 8. Complexity review

Wave 3 adds no:

- Kernel public command;
- Kernel workflow stage;
- Authority;
- database or durable result store;
- provider CLI/API implementation;
- provider fallback;
- model discovery/refresh service;
- new execution class;
- new corpus;
- project-specific branch;
- production model-policy default change.

The only runtime dependency of the replay helper is the existing Host dispatcher. Provider-specific model IDs exist only in the already-fixed corpus, tests, and this experiment document, not in the generic replay implementation.
