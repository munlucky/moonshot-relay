# Removed Legacy Instructions

## Result: nothing was removed

The Wave 1 investigation searched every Kernel prompt surface for the legacy
patterns the work guide lists (§8.2), in English and Korean:

```
always plan first / always verify / verify again / double-check
recheck before responding / review your own answer
use a subagent to verify / always delegate / ask another agent
run the full suite after every change / explain every step / report every tool call
do not think / do not reason
항상 먼저 계획 / 반드시 다시 검증 / 응답 전에 재확인 / 서브에이전트에게 검증
모든 수정 후 전체 테스트 / 작업 과정을 계속 설명 / 사고하지 마라 / 추론하지 마라
```

Surfaces searched (see `prompt-inventory.json`):

- `skills/moon-relay-kernel/SKILL.md`
- `package/profile-templates/claude/.claude/agents/kernel-{planner,implementer,reviewer}.md`
- `package/profile-templates/codex/.codex/AGENTS.md`
- `src/host/kernel/**` canonical Host prompt/policy sources
- `src/kernel/**` canonical Kernel context/knowledge sources

**No surface matched.** Every hit in the repository was in Relay-mode skills
(`skills/figma-spec-synthesizer`, `skills/vercel-react-best-practices`,
`skills/frontend-design`) that the Kernel Host does not load, which §8.1 places
out of scope. Two of those matches are domain guidance about verifying auth
inside Server Actions — unrelated to model execution policy.

The guide is explicit that only confirmed items may be removed, and that Kernel
evidence, review, and completion authority must not be mistaken for legacy
instruction. Deleting nothing is the correct outcome here, not a skipped step.

## What the wave did instead

The duplication the wave targets was not *legacy text to delete* but *common
behavior with no single home*. That gap is now closed:

| Concern | Single location |
|---|---|
| Common scope / autonomy / verification / delegation rules | `src/host/kernel/prompts/common-execution.ts` |
| Conditional planning, verification order, delegation gate | `src/host/kernel/common-model-policy.ts` |
| Claude thinking, effort, cache breakpoints, output artifacts | `src/host/kernel/prompts/claude-opus-5.ts`, `src/host/kernel/claude-effort-policy.ts` |
| Codex routing, profiles, session, fast mode, API capability gate | `src/host/kernel/prompts/codex-gpt-5p6.ts`, `src/host/kernel/codex-model-policy.ts`, `src/host/kernel/model-registry.ts`, `src/host/kernel/codex-agents-policy.ts` |
| Run/step/capsule identifiers | `src/host/kernel/prompt-envelope.ts` `control` (never in a prompt segment) |

`tests/kernel-prompt-legacy-instruction.test.ts` fails if any of the patterns
above is reintroduced into a Kernel-loaded prompt surface. C01 is the frozen
comparison baseline; C09 and C10 run provider live comparisons; C11 owns the
promotion decision. Until those gates pass, candidate prompt changes stay on
the existing shadow/off path and do not overwrite the C01 baseline.

## Re-audit triggers

Run this audit again when any of these change materially:

- the default or major model family;
- provider official prompting guidance;
- tool schema or provider message structure;
- stable prompt byte/token budget;
- unnecessary tool/subagent call rate;
- task completion or acceptance rate.

A re-audit may remove text only when the duplicate is confirmed, its remaining
authority is named, and the affected C01 rubric/eval case is identified. Scope,
security, compatibility, evidence, review, and completion authority are never
removed only to reduce prompt size.
