# Removed Duplicate Operational Instructions

## Preset 07 result

Preset 07 removed confirmed operational micro-guidance from always-visible Kernel surfaces. It did **not** remove scope, evidence, review, completion, or Host model authority.

Removed duplicate guidance:

- fixed search and file-reading order such as "use rg first";
- fixed wait/poll durations and progress polling recipes;
- prescribed two-turn plan-reading and fixed context-budget recipes;
- repeated Kernel/Host workflow authority text in the Codex runtime profile.

The remaining authority is structural:

| Concern | Remaining authority |
|---|---|
| scope and acceptance | current Task/Work Contract |
| verification and completion | Kernel Trust Authority and canonical continuation |
| review | Kernel review receipt pipeline |
| model/provider/session | Host model and execution policy |
| process lifecycle | Host/MCP process state and returned continuation |
| context selection | Kernel context materialization |

`src/host/kernel/prompts/common-execution.ts` now contains only stable execution invariants. Dynamic scope, evidence, knowledge, and work-unit data remain in the existing structured/volatile paths.

## Historical baseline

C01 remains frozen historical evidence. Its `sourceHead`, prompt revisions, digests, model/effort conditions, and tool set are **not** rewritten when the current prompt changes. The corpus contract resolves those historical prompt sources from the recorded Git revision.

## Safety boundary

No text was removed merely to reduce bytes. The following remain authoritative and tested:

- bounded mutation scope;
- protected hard/judgment obligations;
- independent review receipts;
- exact fresh evidence and false-completion prevention;
- project/worktree/run binding;
- Host-owned model/provider execution.

## Re-audit triggers

Re-audit when the default model family, official provider guidance, tool/provider message structure, stable prompt budget, unnecessary tool/subagent rate, or completion/acceptance rate changes materially.
