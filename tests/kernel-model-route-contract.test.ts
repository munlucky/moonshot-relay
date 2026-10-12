import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { normalizeModelRouteDecision } from '../src/contracts/model-route.js';
import { resolveModelRoute } from '../src/host/kernel/model-routing.js';

const base = { runId: 'r-contract', actionKind: 'implement', riskTier: 'T1', obligationId: 'default' };

test('stagnation outranks retry escalation and forces a frontier replan', () => {
  const stagnant = resolveModelRoute({ ...base, stagnant: true, retryCount: 5 });
  assert.equal(stagnant.actionKind, 'replan');
  assert.equal(stagnant.modelClass, 'frontier_reasoning');
  assert.deepEqual([...stagnant.reasonCodes], ['STAGNATION_REPLAN']);
});

test('two retries escalate implementation to frontier; one retry stays on value', () => {
  assert.equal(resolveModelRoute({ ...base, retryCount: 1 }).modelClass, 'value_coding');
  const escalated = resolveModelRoute({ ...base, retryCount: 2 });
  assert.equal(escalated.modelClass, 'frontier_reasoning');
  assert.equal(escalated.actionKind, 'implement');
  assert.deepEqual([...escalated.reasonCodes], ['RETRY_ESCALATION']);
});

test('a failing protected obligation escalates to frontier debugging', () => {
  const decision = resolveModelRoute({ ...base, protectedObligationFailed: true });
  assert.equal(decision.actionKind, 'debug');
  assert.equal(decision.modelClass, 'frontier_reasoning');
});

test('plan invalidity and architecture deviation both replan on frontier', () => {
  assert.deepEqual([...resolveModelRoute({ ...base, planInvalid: true }).reasonCodes], ['PLAN_INVALID_REPLAN']);
  assert.deepEqual([...resolveModelRoute({ ...base, architectureDeviation: true }).reasonCodes], ['ARCHITECTURE_DEVIATION_REPLAN']);
});

test('T3 implementation stays on value coding but its review demands an independent context', () => {
  const implement = resolveModelRoute({ ...base, riskTier: 'T3' });
  assert.equal(implement.modelClass, 'value_coding');
  assert.equal(implement.independentContextRequired, false);
  const review = resolveModelRoute({ ...base, actionKind: 'review_engineering', riskTier: 'T3' });
  assert.equal(review.modelClass, 'frontier_reasoning');
  assert.equal(review.independentContextRequired, true);
  assert.ok(review.reasonCodes.includes('INDEPENDENT_REVIEW_REQUIRED'));
  const t1Review = resolveModelRoute({ ...base, actionKind: 'review_contract', riskTier: 'T1' });
  assert.equal(t1Review.independentContextRequired, false);
});

test('Kernel route carries provider-neutral work shape and rejects provider fields', () => {
  const standard = resolveModelRoute({ ...base, actionKind: 'implement' });
  assert.deepEqual(standard.workProfile, {
    executionClass: 'standard',
    complexity: 'standard',
    repeatedFailure: false,
    independentContextRequired: false,
    parallelizable: false,
  });
  const routine = resolveModelRoute({ ...base, workProfile: { complexity: 'routine-batch', parallelizable: true } });
  assert.ok(routine.workProfile);
  assert.equal(routine.workProfile.complexity, 'routine');
  assert.ok(routine.workProfile);
  assert.equal(routine.workProfile.parallelizable, true);
  assert.throws(() => resolveModelRoute({ ...base, workProfile: { complexity: 'standard', model: 'gpt-5.6-luna' } }), /must not carry provider field/);
});

test('build stagnation never reroutes a read-only review turn into a planner turn', () => {
  const review = resolveModelRoute({
    runId: 'r-review-after-stagnation',
    actionKind: 'review_engineering',
    riskTier: 'T3',
    stagnant: true,
    retryCount: 9,
  });
  assert.equal(review.actionKind, 'review_engineering');
  assert.equal(review.role, 'reviewer');
  assert.equal(review.permissions, 'read_only');
});

test('an escalation is not demoted inside the same plan revision and obligation', () => {
  const locked = { ...base, currentPlanRevision: 3, escalatedObligations: [{ planRevision: 3, obligationId: 'default' }] };
  assert.equal(resolveModelRoute(locked).modelClass, 'frontier_reasoning');
  assert.deepEqual([...resolveModelRoute(locked).reasonCodes], ['ESCALATION_LOCKED']);
  // A replan produces a new plan revision, which may return to value coding.
  const afterReplan = resolveModelRoute({ ...locked, currentPlanRevision: 4 });
  assert.equal(afterReplan.modelClass, 'value_coding');
});

test('invalid actions and provider-shaped fields fail closed', () => {
  assert.throws(() => resolveModelRoute({ ...base, actionKind: 'vibe' }), /actionKind must be one of/);
  assert.throws(() => normalizeModelRouteDecision({ ...resolveModelRoute(base), apiKey: 'sk-live' }), /must not carry host\/provider field/);
  assert.throws(() => normalizeModelRouteDecision({ ...resolveModelRoute(base), resolvedModel: 'some-model' }), /must not carry host\/provider field/);
  assert.throws(() => normalizeModelRouteDecision({ ...resolveModelRoute(base), reasonCodes: [] }), /at least one reason code/);
  assert.throws(() => normalizeModelRouteDecision({ ...resolveModelRoute(base), modelClass: 'super_model' }), /modelClass must be one of/);
});

test('resolved decisions satisfy the published route schema shape', async () => {
  const schema = JSON.parse(await readFile(new URL('../schemas/kernel.model-route.schema.json', import.meta.url), 'utf8'));
  const decision = resolveModelRoute(base);
  assert.equal(schema.additionalProperties, false);
  for (const field of schema.required) assert.ok(field in decision, field);
  for (const field of Object.keys(decision)) assert.ok(schema.properties[field], `schema is missing ${field}`);
  assert.match(decision.decisionId, new RegExp(schema.properties.decisionId.pattern));
  assert.equal(decision.policyRevision, 'kernel-model-routing.v1');
});
