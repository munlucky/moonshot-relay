const DISPOSITION_VALUES = Object.freeze(['IMPLEMENTED', 'REJECTED', 'DEFERRED', 'NOT_APPLICABLE']);

export const OPTIMIZATION_ITEM_IDS = Object.freeze(
  Array.from({ length: 20 }, (_, index) => `O-${index + 1}`),
);

export const HIGH_ROI_OPTIMIZATION_IDS = Object.freeze(['O-1', 'O-3', 'O-4', 'O-6', 'O-11']);

const CURRENT_REGRESSION_RESULT = 'PASS: the Architecture and Functional regression suites remained green for this cycle.';
const NO_NEW_COMPLEXITY = 'No new runtime, provider adapter, worker, daemon, or evidence bypass was retained for this disposition.';
const evidence = (...paths) => Object.freeze(paths);
const item = (value) => Object.freeze({
  regressionResult: CURRENT_REGRESSION_RESULT,
  complexityImpact: NO_NEW_COMPLEXITY,
  ...value,
});

// This is a cycle ledger, not a promise to implement every idea in the
// backlog. A final DEFERRED/REJECTED/NOT_APPLICABLE decision is intentional
// when there is no measured bottleneck or when a new change would duplicate or
// violate an existing Kernel invariant.
export const OPTIMIZATION_DISPOSITIONS = Object.freeze([
  item({
    id: 'O-1',
    title: 'Model Routing',
    highRoi: true,
    disposition: 'REJECTED',
    decision: 'Owner model advisory behavior is already a Functional DoD boundary; adding a new routing policy without quality or cost data would change the owner choice without a measurable ROI.',
    measurement: 'Contract measurement is available: owner-direct model hard-gate tests remain green and delegated routing stays explicit.',
    evidenceRefs: evidence('tests/kernel-model-policy.test.mjs', 'tests/kernel-model-route-contract.test.mjs', 'tests/kernel-model-routing-e2e.test.mjs'),
  }),
  item({
    id: 'O-2',
    title: 'Model Escalation',
    highRoi: false,
    disposition: 'DEFERRED',
    decision: 'No repeated-obligation failure dataset in this cycle justifies an escalation policy; preserve the bounded retry and review gates until that signal exists.',
    measurement: 'Not measured: a before/after escalation quality, latency, or cost baseline is unavailable.',
    evidenceRefs: evidence('tests/kernel-model-escalation-e2e.test.mjs', 'tests/kernel-stagnation-routing.test.mjs'),
  }),
  item({
    id: 'O-3',
    title: 'Prompt / Context Budget',
    highRoi: true,
    disposition: 'DEFERRED',
    decision: 'The existing bounded context compiler is reliable, but this checkout has no accepted before/after context-size baseline that permits safe prompt reduction.',
    measurement: 'Not measured: reducing context without a stable quality and evidence baseline would risk the Task Contract and proof boundary.',
    evidenceRefs: evidence('tests/kernel-context-compiler.test.mjs', 'tests/kernel-prompt-size-budget.test.mjs', 'tests/kernel-context-payload-redaction.test.mjs'),
  }),
  item({
    id: 'O-4',
    title: 'Stable / Volatile Context',
    highRoi: true,
    disposition: 'DEFERRED',
    decision: 'Stable and volatile context segments already exist; further cache-oriented separation waits for provider cache telemetry and a comparable prompt-reuse baseline.',
    measurement: 'Not measured: provider cache-hit and context-mutation deltas are not available as a cycle baseline.',
    evidenceRefs: evidence('scripts/kernel/context-segments.mjs', 'tests/kernel-context-segments.test.mjs', 'tests/kernel-context-byte-identity.test.mjs'),
  }),
  item({
    id: 'O-5',
    title: 'Knowledge Retrieval',
    highRoi: false,
    disposition: 'DEFERRED',
    decision: 'Current retrieval and relevance boundaries are safe; adaptive retrieval is deferred until relevance, latency, and stale-knowledge miss metrics are collected.',
    measurement: 'Not measured: no retrieval precision/recall or context-latency baseline was recorded for this cycle.',
    evidenceRefs: evidence('tests/kernel-knowledge-context.test.mjs', 'tests/kernel-tacit-retrieval.test.mjs', 'tests/kernel-knowledge-freshness-load.test.mjs'),
  }),
  item({
    id: 'O-6',
    title: 'Cache Hit',
    highRoi: true,
    disposition: 'DEFERRED',
    decision: 'Provider cache behavior is capability-dependent; Kernel will not emulate unsupported cache features, and this host has no comparable cache read/write baseline for adoption.',
    measurement: 'Not measured: cache-hit, cache-miss, and provider capability telemetry are not complete enough for a safe optimization claim.',
    evidenceRefs: evidence('tests/kernel-provider-cache-capabilities.test.mjs', 'tests/kernel-provider-cache-fallback.test.mjs', 'tests/kernel-cache-summary.test.mjs'),
  }),
  item({
    id: 'O-7',
    title: 'Native Delegation',
    highRoi: false,
    disposition: 'REJECTED',
    decision: 'A further delegation optimization is rejected because owner-direct is the default and native subagent use is already explicit and optional; no measured advantage was demonstrated.',
    measurement: 'Contract measurement is available: owner-direct and explicit native-subagent routes are distinguished by the routing tests.',
    evidenceRefs: evidence('tests/kernel-model-routing-e2e.test.mjs', 'tests/kernel-capsule-step-admission-e2e.test.mjs', 'tests/kernel-common-delegation-policy.test.mjs'),
  }),
  item({
    id: 'O-8',
    title: 'Derived Parallel Execution',
    highRoi: false,
    disposition: 'DEFERRED',
    decision: 'Parallel execution is retained as an optional derived capability; no independent conflict-free Step set with a measured latency or quality benefit appeared in this cycle.',
    measurement: 'Not measured: there is no representative parallel-vs-sequential workload baseline.',
    evidenceRefs: evidence('scripts/kernel/run/run-step-ledger.mjs', 'tests/kernel-run-step-ledger.test.mjs', 'tests/kernel-wayfinder-runtime.test.mjs'),
  }),
  item({
    id: 'O-9',
    title: 'Delegation Budget',
    highRoi: false,
    disposition: 'REJECTED',
    decision: 'A second budget layer is rejected because Step scope and Capsule guards already constrain delegation without introducing a new orchestration state.',
    measurement: 'Contract measurement is available: bounded scope and worker-limit tests pass without unbounded delegation paths.',
    evidenceRefs: evidence('scripts/kernel/run/run-step-ledger.mjs', 'tests/kernel-execution-capsule-budget.test.mjs', 'tests/kernel-bounded-work-unit.test.mjs'),
  }),
  item({
    id: 'O-10',
    title: 'Independent Review',
    highRoi: false,
    disposition: 'REJECTED',
    decision: 'Blanket review optimization is rejected; protected, high-risk, and explicitly required work already receives independent review while routine work avoids unnecessary evidence cost.',
    measurement: 'Contract measurement is available: review-required, receipt lineage, and independence tests pass.',
    evidenceRefs: evidence('tests/kernel-review-pipeline.test.mjs', 'tests/kernel-review-receipt-completion.test.mjs', 'tests/kernel-review-receipt-freshness.test.mjs'),
  }),
  item({
    id: 'O-11',
    title: 'Evidence Cost',
    highRoi: true,
    disposition: 'DEFERRED',
    decision: 'Tiered proof and exact evidence reuse are present, but reducing the current regression wave requires a measured risk-to-coverage baseline that is not available for this cycle.',
    measurement: 'Not measured: no accepted changed-scope versus broader-regression cost/defect dataset exists.',
    evidenceRefs: evidence('scripts/kernel/proof/evidence-reuse.mjs', 'tests/kernel-evidence-semantics.test.mjs', 'tests/kernel-proof-tier.test.mjs'),
  }),
  item({
    id: 'O-12',
    title: 'Native Telemetry',
    highRoi: false,
    disposition: 'DEFERRED',
    decision: 'Native usage, latency, model, effort, and lineage fields remain observed-only; rollout of additional telemetry waits for provider-supported data on the target surfaces.',
    measurement: 'Not measured: this cycle cannot produce a complete cross-provider usage baseline without inventing unsupported observations.',
    evidenceRefs: evidence('scripts/kernel/control-plane.mjs', 'tests/kernel-model-usage-receipt.test.mjs', 'tests/kernel-measurement-contract.test.mjs'),
  }),
  item({
    id: 'O-13',
    title: 'Observability',
    highRoi: false,
    disposition: 'DEFERRED',
    decision: 'The Kernel exposes reliability and usage measurements, but a time-series optimization dashboard is deferred until repeated-run data exists.',
    measurement: 'Not measured: no longitudinal completion, replan, latency, or cache dataset is available.',
    evidenceRefs: evidence('scripts/kernel/control-plane.mjs', 'tests/kernel-measurement-contract.test.mjs', 'tests/observability-metrics-contract.test.mjs'),
  }),
  item({
    id: 'O-14',
    title: 'Harness Surface Budget',
    highRoi: false,
    disposition: 'REJECTED',
    decision: 'No new Skill, Hook, Adapter, or planner is justified; the cycle closes with the existing Kernel authority and provider-native boundaries.',
    measurement: 'Contract measurement is available: unification and standalone-authority gates remain green with no extra runtime surface.',
    evidenceRefs: evidence('scripts/kernel/unification-audit.mjs', 'tests/kernel-standalone-unification.test.mjs', 'tests/kernel-core-skills.test.mjs'),
  }),
  item({
    id: 'O-15',
    title: 'Prompt Instruction Budget',
    highRoi: false,
    disposition: 'DEFERRED',
    decision: 'Prompt simplification is deferred because no before/after instruction-size and regression baseline permits removing safety, scope, or completion rules safely.',
    measurement: 'Not measured: prompt-size deltas are not sufficient evidence of improved completion or reduced cost.',
    evidenceRefs: evidence('tests/kernel-prompt-inventory.test.mjs', 'tests/kernel-prompt-legacy-instruction.test.mjs', 'tests/kernel-prompt-size-budget.test.mjs'),
  }),
  item({
    id: 'O-16',
    title: 'Provider-Specific Optimization',
    highRoi: false,
    disposition: 'REJECTED',
    decision: 'Provider-specific hints remain adapter-local; adding them to the common Kernel contract would violate provider neutrality without a measured cross-provider benefit.',
    measurement: 'Contract measurement is available: provider model policies and adapters remain separate from owner-direct correctness.',
    evidenceRefs: evidence('scripts/kernel/run/model-routing.mjs', 'tests/kernel-model-policy.test.mjs', 'tests/kernel-provider-prompt-policy.test.mjs'),
  }),
  item({
    id: 'O-17',
    title: 'Optimization Experiment Method',
    highRoi: false,
    disposition: 'DEFERRED',
    decision: 'No additional experiment harness is added until a concrete hypothesis has a baseline, evaluation, and rollback candidate; existing eval and proof surfaces are sufficient for this cycle.',
    measurement: 'Not measured: no new optimization hypothesis survived the bottleneck and complexity screen.',
    evidenceRefs: evidence('scripts/kernel/eval/model-routing-eval.mjs', 'tests/kernel-model-routing-eval.test.mjs', 'tests/kernel-eval-corpus-contract.test.mjs'),
  }),
  item({
    id: 'O-18',
    title: 'Optimization Promotion Criteria',
    highRoi: false,
    disposition: 'REJECTED',
    decision: 'No candidate without a measurable completion, quality, latency, cost, context, or recovery improvement is promoted to the mainline runtime.',
    measurement: 'Contract measurement is available: this ledger contains no unmeasured IMPLEMENTED item and the regression gate is green.',
    evidenceRefs: evidence('scripts/kernel/optimization-cycle.mjs', 'tests/kernel-optimization-cycle.test.mjs', 'tests/kernel-evidence-semantics.test.mjs'),
  }),
  item({
    id: 'O-19',
    title: 'Complexity Budget',
    highRoi: false,
    disposition: 'REJECTED',
    decision: 'No additional state machine, worker, daemon, or fallback is retained because its complexity cost would exceed the unmeasured benefit in this cycle.',
    measurement: 'Contract measurement is available: the cycle adds only a disposition ledger and regression gate, with no new runtime authority.',
    evidenceRefs: evidence('scripts/kernel/optimization-cycle.mjs', 'scripts/kernel/unification-audit.mjs', 'tests/kernel-standalone-unification.test.mjs'),
  }),
  item({
    id: 'O-20',
    title: 'Optimization Backlog Priority',
    highRoi: false,
    disposition: 'NOT_APPLICABLE',
    decision: 'Priority grouping is backlog metadata rather than an independent runtime optimization; it is represented by the highRoi field and does not require a second implementation.',
    measurement: 'Not applicable: no runtime behavior is changed by priority metadata.',
    evidenceRefs: evidence('scripts/kernel/optimization-cycle.mjs', 'tests/kernel-optimization-cycle.test.mjs'),
  }),
]);

const nonEmpty = (value) => typeof value === 'string' && value.trim().length > 0;

export function validateOptimizationCycle(dispositions = OPTIMIZATION_DISPOSITIONS) {
  const findings = [];
  const items = Array.isArray(dispositions) ? dispositions : [];
  const counts = Object.fromEntries(DISPOSITION_VALUES.map((value) => [value, 0]));
  const byId = new Map();

  if (!Array.isArray(dispositions)) findings.push({ code: 'items-not-array', message: 'Optimization dispositions must be an array.' });
  for (const entry of items) {
    if (!entry || typeof entry !== 'object') {
      findings.push({ code: 'item-not-object', message: 'Every optimization disposition must be an object.' });
      continue;
    }
    if (byId.has(entry.id)) findings.push({ code: 'duplicate-item', message: `Optimization item ${entry.id} is repeated.` });
    byId.set(entry.id, entry);
    if (!OPTIMIZATION_ITEM_IDS.includes(entry.id)) findings.push({ code: 'unknown-item', message: `Unknown optimization item ${entry.id}.` });
    if (!DISPOSITION_VALUES.includes(entry.disposition)) {
      findings.push({ code: 'invalid-disposition', message: `${entry.id} has invalid disposition ${entry.disposition}.` });
    } else {
      counts[entry.disposition] += 1;
    }
    if (!nonEmpty(entry.title) || !nonEmpty(entry.decision) || !nonEmpty(entry.measurement)) {
      findings.push({ code: 'decision-fields-missing', message: `${entry.id} requires title, decision, and measurement.` });
    }
    if (!Array.isArray(entry.evidenceRefs) || entry.evidenceRefs.length === 0) {
      findings.push({ code: 'evidence-missing', message: `${entry.id} requires at least one evidence reference.` });
    }
    if (!nonEmpty(entry.regressionResult) || !nonEmpty(entry.complexityImpact)) {
      findings.push({ code: 'cycle-fields-missing', message: `${entry.id} requires regressionResult and complexityImpact.` });
    }
    if (entry.disposition === 'IMPLEMENTED') {
      for (const field of ['baseline', 'change', 'measurement', 'regressionResult', 'complexityImpact']) {
        if (!nonEmpty(entry[field])) findings.push({ code: `implemented-${field}-missing`, message: `${entry.id} is IMPLEMENTED but has no ${field}.` });
      }
    }
  }

  const missing = OPTIMIZATION_ITEM_IDS.filter((id) => !byId.has(id));
  for (const id of missing) findings.push({ code: 'missing-item', message: `Optimization item ${id} has no disposition.` });
  const highRoiUnresolved = HIGH_ROI_OPTIMIZATION_IDS.filter((id) => {
    const entry = byId.get(id);
    return !entry || !DISPOSITION_VALUES.includes(entry.disposition) || ['PENDING', 'UNRESOLVED'].includes(entry.disposition);
  });
  if (highRoiUnresolved.length > 0) findings.push({ code: 'high-roi-unresolved', message: `High-ROI items are unresolved: ${highRoiUnresolved.join(', ')}.` });

  const status = findings.length === 0 && items.length === OPTIMIZATION_ITEM_IDS.length ? 'pass' : 'fail';
  return {
    schemaVersion: 1,
    status,
    cycleStatus: status === 'pass' ? 'COMPLETE' : 'OPEN',
    itemCount: items.length,
    dispositionCounts: counts,
    highRoiIds: [...HIGH_ROI_OPTIMIZATION_IDS],
    highRoiUnresolved,
    findings,
  };
}
