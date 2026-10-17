# Model & Prompt Rebaseline — Wave 1 Execution Baseline

- Baseline branch: `main`
- Baseline commit: `a8b180b1c763d99d97e1d604e49e8a75e92aea85`
- Wave purpose: observe the production execution path before changing model, effort, or prompt policy.
- Decision rule: do not add a runtime subsystem for information that can remain a Host observation or an offline evaluation artifact.

## 1. Production execution path

The active production path is:

```text
Kernel next / route decision
→ Host turn dispatcher
→ Host execution-class / model policy
→ Host model registry and route admission
→ provider adapter
→ launcher or owner-direct handoff
→ provider/session observation
→ model usage receipt
```

The Kernel owns the provider-neutral work and trust contracts. Provider model IDs, effort, session handling, prompt assembly, and provider telemetry remain Host concerns.

The Codex default mapping currently lives in one Host policy:
`src/host/kernel/codex-model-policy.ts`.

The provider-neutral route policy lives in:
`kernel/model-policy.yaml`.

No model default is changed in Wave 1. The existing policy is the baseline, not a defect assumption.

## 2. Legacy GPT-5.6 routing asset classification

The inspected legacy files are not production runtime authorities.

| Asset | Classification | Current consumers | Wave 1 decision |
| --- | --- | --- | --- |
| `scripts/provider-model-route-advisor.mjs` | C — evaluation/shadow | `tools/evals/provider-model-routing.mjs`, tests | keep |
| `scripts/lib/provider-model-routing.mjs` | C — evaluation/shadow | advisor, tests | keep |
| `scripts/lib/providers/codex-gpt-5-6-adapter.mjs` | C — evaluation/shadow | advisor, contract tests | keep |
| routing fixtures/schema | C — evaluation support | eval/tests | keep |

These files are also listed in the package contract, so they are shipped even though no production runtime import was found. That packaging question is a later cleanup decision. It is not evidence of duplicate runtime authority by itself.

No inspected legacy asset qualifies as D — dead code in this Wave.

## 3. Provider control and observation boundary

### Codex

- Requested model: controllable on the delegated Host path through the invocation/session override contract.
- Requested effort: carried separately in the invocation.
- Actual model/effort: accepted only from terminal events or matching persisted Codex rollout settings.
- Missing actual observation: stays `null`; it is not reconstructed from the request.
- Session continuation: supported by the Host. Review or independent/repeated-failure work may require a fresh session.
- CLI usage tokens: not assumed available by the default capability declaration.
- Advanced Responses-API cache/tool features: not assumed available on the CLI surface.

### Claude

- Requested model and effort: passed to the launcher/subagent invocation.
- Resolved model/effort: launcher configuration/result metadata.
- Actual model/effort: accepted only from explicit observed fields or observed session/config telemetry.
- Missing actual observation: stays `null` after the Wave 1 fix.
- Session continuation: declared as supported; fresh context is used where the role/independence contract requires it.
- Usage/cache token telemetry: only recorded when the launcher reports it.

### Owner-direct sessions

An owner-direct handoff can execute work without a delegated launcher receipt. If the actual model/effort is not observable at the Host boundary, that run may validate execution behavior but must not be used as a model-A-vs-model-B quality datapoint.

## 4. Requested, resolved, and observed identity

The receipt contract keeps the three concepts separate:

```text
requestedModel / requestedEffort
resolvedModel  / resolvedEffort
observedModel  / observedEffort
enforcementStatus
```

Wave 1 found one violation in the Claude adapter: a configured/resolved effort could be copied into `observedEffort`, and a resolved model could be copied into `observedModel` when no provider observation existed.

The fix is intentionally narrow:

- Claude observation fields now come only from explicit observed telemetry.
- Missing observation stays `null`.
- A matching requested/resolved configuration without observed identity is `advisory`, not `enforced`.
- Explicit mismatches still classify as fallback/failure according to the existing receipt contract.
- No fallback model, new provider registry, or Kernel state was added.

## 5. Input snapshot observability

The current Host already exposes or can derive the following stable inputs without a new evaluation authority:

- `commonPromptRevision`
- `providerPromptRevision`
- prompt prefix digest
- tool schema digest
- stable/project/run/volatile segment digests
- Task Contract / run-stable content
- provider and surface
- requested model/effort
- observed model/effort when available
- Kernel knowledge revision/context receipt through the existing Kernel state
- workspace/source identity through existing workspace and run receipts

The prompt audit already inventories the Kernel skill and common/provider prompt sources.

The following may be provider-managed and therefore unavailable at this generic Host boundary:

- the exact owner-session `AGENTS.md` bytes after provider-native loading
- provider-internal hidden system material
- provider-managed cache state when the surface does not report it

Those values remain `unknown`; they must not be inferred.

## 6. Execution profile revision gap

There is no single composite `executionProfileRevision` in the usage receipt today.

The constituent revisions already exist, including:

- provider-neutral model policy revision
- Codex execution-class policy revision
- common prompt revision
- provider prompt revision
- tool/prefix digests

Wave 2 should decide whether a small derived Host profile revision is needed in the existing receipt. It must not become a capability registry, refresh service, or new Kernel authority.

## 7. Wave 1 decisions

1. Keep current production model defaults unchanged.
2. Keep legacy routing assets until evaluation/package ownership is decided from evidence.
3. Fix only the Claude requested/resolved-versus-observed telemetry correctness issue.
4. Do not add Models API refresh, capability auto-discovery, compaction, cache diagnostics, progress, or adaptive fallback.
5. Use the existing prompt envelope and receipts as the basis for later replay. Do not create a separate evaluation platform.

## 8. Wave 2 inputs

Wave 2 is limited to compatibility gaps proven by this baseline. Current candidates are:

- determine whether a derived Host execution profile revision is necessary for reproducible receipts;
- verify the exact Claude launcher surface can report actual model/effort for the intended model combination;
- keep unsupported/unknown capability fail-closed and explicit;
- make no model/effort default change until representative replay evidence exists.
