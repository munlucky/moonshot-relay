# Model & Prompt Rebaseline — Wave 2 Host Compatibility

- Baseline: `main / 1a2bcd66b9d3eb752d32ac8e2e2c9cdcffc183af`
- Scope: only compatibility gaps proven by Wave 1.
- Non-goal: add a provider API/CLI implementation because a model feature exists.

## 1. Production Claude surface

The production lifecycle bridge currently creates the Claude adapter without a delegated launcher:

```text
Host lifecycle
→ createClaudeAdapter({})
→ owner-direct Claude surface
```

Therefore the current production surface cannot honestly claim launcher-dependent controls merely because the Claude provider can support them.

Wave 2 keeps `CLAUDE_CAPABILITIES` as the provider feature set, but derives the active adapter capabilities from the connected execution surface.

Without a launcher, the active Claude adapter now reports the following as unavailable:

- delegated subagent model override
- resolved/actual model identity observation
- usage token observation
- explicit prompt-cache control/observation
- cache read/write token observation
- independent child context

Provider-managed owner-session continuation remains supported.

This means an owner-direct path is not treated as proof that a requested model was enforced. A receipt built for that surface is explicit `unsupported`, not a silent or advisory model-enforcement claim.

## 2. No new Claude launcher

Wave 2 does not add a Claude CLI or API launcher.

There is no current production consumer requiring such an implementation, and adding one would introduce a new provider execution path before a real workload demonstrates the need.

If a launcher is connected later, the existing adapter can expose the capabilities that the launcher actually supports and can report explicit observed model/effort telemetry.

## 3. Claude effort policy revision

Codex already carried its model-policy revision through the Host recommendation path. Claude effort selection already had its own revision:

`kernel-claude-effort.v1`

but that revision was dropped before the prompt envelope.

Wave 2 carries that existing revision into Host envelope metadata. It does not add a second policy source or change any effort default.

## 4. Derived execution profile revision

New Host usage receipts include a deterministic:

`executionProfileRevision`

with the format:

```text
host-execution-profile.v1:sha256:<digest>
```

The digest is derived from existing Host facts only:

- execution surface
- provider-neutral route policy revision
- provider model/effort policy revision
- subagent model-control capability
- session model-override capability
- actual model-identity observation capability
- usage observation capability
- session continuation capability
- independent-context capability

This is not a capability registry. It has no storage, refresh loop, discovery API, or runtime authority.

Model and effort identity remain separate receipt fields. Prompt identity remains represented by the existing prompt/cache digests. The profile revision therefore does not duplicate model IDs or prompt content inside the hash contract.

## 5. Backward compatibility

`kernel.model-usage` remains schema version 1.

The schema recognizes `executionProfileRevision`, but legacy v1 receipt payloads may omit it. Normalization maps an absent legacy value to `null`.

New receipts created by the Host always populate the derived revision.

This avoids forcing a migration of historical receipt payloads merely to support Wave 3 comparison.

## 6. Unsupported and unknown rules

Wave 2 keeps the fail-closed rules from Wave 1:

- a missing active-surface capability is not inferred from provider capability;
- requested model/effort is not treated as actual model/effort;
- a missing launcher does not trigger another transport automatically;
- no automatic model fallback is introduced;
- no runtime Models API refresh is introduced.

## 7. Complexity review

Wave 2 adds no:

- Kernel workflow stage
- Kernel public command
- durable authority
- production DB/table
- capability refresh service
- model fallback graph
- provider-specific model ID in Kernel or generic Host policy
- project-specific branch

The only durable contract extension is one optional receipt field whose value is derived from existing Host state.

## 8. Wave 3 readiness

Wave 3 can use the existing Host dispatch result and receipt to bind a run to:

- requested/resolved/observed model and effort
- active execution-surface capability profile
- route/model policy revisions
- prompt prefix/input digests
- session lineage and available usage data

A Claude owner-direct run whose actual model/effort remains unobservable can still validate behavior, but it must not be used as a valid model-A-versus-model-B quality comparison.

No production model or effort default was changed in Wave 2.
