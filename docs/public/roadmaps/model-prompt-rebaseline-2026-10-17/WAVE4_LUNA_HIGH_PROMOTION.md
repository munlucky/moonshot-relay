# Model & Prompt Rebaseline — Wave 4 Luna/high Promotion

- Wave 4 base: `main / 813f01085ffadfa2e932f4acf1832a32f9a9dcd6`
- Change owner: Codex Host model policy
- Production change: standard Codex execution changes from `gpt-5.6-luna / max` to `gpt-5.6-luna / high`.
- Prompt status: unchanged.
- Live C01 A/B status: not executed in Moonremote.
- Promotion basis: explicit operator decision to proceed past the pending live A/B prerequisite.

## 1. Scope

Wave 4 changes one production decision seam:

`src/host/kernel/codex-model-policy.ts#CODEX_EXECUTION_POLICY.standard`

Before:

```text
standard -> gpt-5.6-luna / max
```

After:

```text
standard -> gpt-5.6-luna / high
```

Planning, complex implementation, and review remain `gpt-6-astra / high`.

No prompt text, execution class, delegation rule, retry rule, risk rule, or provider capability changes in this wave.

## 2. Operator-directed promotion

Wave 3 required a live six-case C01 comparison before an evidence-based promotion. The current Moonremote environment does not expose a Codex executable, so that model-backed comparison remains unavailable.

The operator explicitly chose to proceed to Wave 4 without that live comparison.

This decision changes the rollout decision only. It does not convert missing evidence into positive evidence.

Therefore Wave 4 does **not** claim:

- measured quality improvement;
- measured token reduction;
- measured latency reduction;
- measured rework reduction;
- a passed model-backed C01 A/B gate.

The deterministic contract tests from Wave 3 remain useful for future comparisons, but they are not described as model-quality evidence.

## 3. Policy identity

Changing the default effort while keeping `kernel-codex-execution-class.v1` would make one policy revision identify two different mappings.

Wave 4 therefore advances the Codex Host policy revision to:

`kernel-codex-execution-class.v2`

The revision is defined once as `CODEX_MODEL_POLICY_REVISION` and is reused by both Kernel-owned and provider-execution policy results.

This keeps Host receipts and `executionProfileRevision` lineage attributable without adding a second policy store.

## 4. Existing explicit overrides remain valid

`max` remains a supported Codex reasoning effort.

Wave 4 only changes the **default** for the standard class. An explicit per-invocation `max` request still resolves to `max` and remains attributable through the existing `user-requested-reasoning` reason.

There is no automatic fallback from high to max and no automatic escalation based on retry, failure, or risk signals.

## 5. C01 historical baseline is preserved

The C01 corpus is a historical replay baseline. Its contract explicitly records the old prompt digest and the model/surface/effort conditions that were used with that prompt.

Therefore Wave 4 does **not** rewrite the C01 Codex baseline from `gpt-5.6-luna / max` to `gpt-5.6-luna / high`.

The corpus contract test is decoupled from the current production policy so a later policy promotion cannot silently mutate historical comparison evidence.

A future prompt-only experiment must declare its production execution condition explicitly. It must not repurpose or overwrite the historical C01 baseline.

## 6. Rollback

Rollback is intentionally simple and manual.

If representative real work shows a material quality or rework regression attributable to the new standard effort, revert only:

```text
CODEX_EXECUTION_POLICY.standard.effort
high -> max
```

and advance the policy revision again.

Do not add runtime heuristics, project-specific exceptions, retry-triggered fallbacks, or a second routing authority to mask a regression.

## 7. Complexity review

Wave 4 adds no:

- new execution class;
- model routing matrix;
- provider fallback;
- rollout service;
- feature flag;
- database or durable promotion state;
- project-specific branch;
- retry or risk escalation rule;
- prompt directive;
- new evaluation corpus;
- automatic rollback path.

The production semantic change is one existing Host-owned default plus its policy revision. All other changes are direct contracts, historical-baseline protection, and this audit record.
