// K3: admission is the check between "the Kernel decided a model class" and
// "the Host actually ran something". A weaker outcome is named, never disguised
// as success.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { admissionAllowsDispatch } from '../scripts/kernel/routing/route-admission.mjs';
import { admitRoute, policyDigests, REJECTION_CODES } from '../scripts/host/kernel/route-admission.mjs';

const decisionFor = (overrides = {}) => ({
  decisionId: 'route-0123456789abcdef01234567',
  runId: 'r-1',
  role: 'implementer',
  modelClass: 'value_coding',
  permissions: 'workspace_write',
  riskTier: 'T1',
  independentContextRequired: false,
  planRevision: 1,
  ...overrides,
});

const resolutionFor = (overrides = {}) => ({
  modelClass: 'value_coding',
  surface: 'claude',
  model: 'configured-value',
  effort: 'medium',
  source: 'profile-config',
  enforcementIntent: 'enforced',
  ...overrides,
});

const FULL_HOST = { surface: 'claude', supportsSubagentModel: true, supportsSessionModelOverride: true, supportsIndependentContext: true, supportsResolvedModelIdentity: true };

const capsuleFor = (overrides = {}) => ({
  capsuleId: `capsule-${'a'.repeat(24)}`,
  role: 'implementer',
  stepId: 'step-1-1',
  permissions: { filesystem: 'workspace_write', canCommit: false, canDelegate: false },
  provenance: { capsuleDigest: `sha256:${'b'.repeat(64)}` },
  ...overrides,
});

test('K3-1: a value implementation with workspace write is admitted', () => {
  const admission = admitRoute({ decision: decisionFor(), resolution: resolutionFor(), capabilities: FULL_HOST, capsule: capsuleFor() });
  assert.equal(admission.decision, 'admitted');
  assert.equal(admission.rejectionCode, null);
  assert.equal(admissionAllowsDispatch(admission), true);
  assert.match(admission.admissionId, /^admission-[a-f0-9]{24}$/);
  assert.match(admission.digest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(admission.capsuleId, capsuleFor().capsuleId);
  assert.equal(admission.stepId, 'step-1-1');
  assert.equal(admission.economics.costClass, 'value');
});

test('K3-2: a T3 review on a frontier, read-only, independent session is admitted', () => {
  const admission = admitRoute({
    decision: decisionFor({ role: 'reviewer', modelClass: 'frontier_reasoning', permissions: 'read_only', riskTier: 'T3', independentContextRequired: true }),
    resolution: resolutionFor({ modelClass: 'frontier_reasoning', model: 'configured-frontier' }),
    capabilities: FULL_HOST,
    capsule: capsuleFor({ role: 'reviewer', permissions: { filesystem: 'read_only', canCommit: false, canDelegate: false } }),
  });
  assert.equal(admission.decision, 'admitted');
  assert.equal(admission.economics.costClass, 'frontier');
});

test('K3: raw decision executionClass/modelClass divergence is rejected before reviewer role rules', () => {
  const admission = admitRoute({
    decision: decisionFor({
      role: 'reviewer',
      executionClass: 'review',
      modelClass: 'value_coding',
      permissions: 'read_only',
      riskTier: 'T3',
      independentContextRequired: true,
    }),
    resolution: resolutionFor({ executionClass: 'review', modelClass: 'frontier_reasoning', model: 'configured-frontier' }),
    capabilities: FULL_HOST,
    capsule: capsuleFor({ role: 'reviewer', permissions: { filesystem: 'read_only', canCommit: false, canDelegate: false } }),
  });
  assert.equal(admission.decision, 'blocked');
  assert.equal(admission.rejectionCode, REJECTION_CODES.ROUTE_CLASS_MISMATCH);
});

test('K3: a Host resolution class that diverges from the raw decision is rejected before role rules', () => {
  const admission = admitRoute({
    decision: decisionFor({
      role: 'reviewer',
      executionClass: 'review',
      modelClass: 'frontier_reasoning',
      permissions: 'read_only',
      riskTier: 'T3',
      independentContextRequired: true,
    }),
    resolution: resolutionFor({ executionClass: 'standard', modelClass: 'value_coding', model: 'configured-value' }),
    capabilities: FULL_HOST,
    capsule: capsuleFor({ role: 'reviewer', permissions: { filesystem: 'read_only', canCommit: false, canDelegate: false } }),
  });
  assert.equal(admission.decision, 'blocked');
  assert.equal(admission.rejectionCode, REJECTION_CODES.ROUTE_CLASS_MISMATCH);
});

test('K3: explicit complex frontier escalation remains admitted when decision and Host resolution agree', () => {
  const admission = admitRoute({
    decision: decisionFor({ executionClass: 'complex_implementation', modelClass: 'frontier_reasoning' }),
    resolution: resolutionFor({ executionClass: 'complex_implementation', modelClass: 'frontier_reasoning', model: 'configured-frontier' }),
    capabilities: FULL_HOST,
    capsule: capsuleFor(),
  });
  assert.equal(admission.decision, 'admitted');
  assert.equal(admission.rejectionCode, null);
});

test('K3-3: a T3 review on the value class is blocked', () => {
  const admission = admitRoute({
    decision: decisionFor({ role: 'reviewer', modelClass: 'value_coding', permissions: 'read_only', riskTier: 'T3', independentContextRequired: true }),
    resolution: resolutionFor(),
    capabilities: FULL_HOST,
    capsule: capsuleFor({ role: 'reviewer', permissions: { filesystem: 'read_only', canCommit: false, canDelegate: false } }),
  });
  assert.equal(admission.decision, 'blocked');
  assert.equal(admission.rejectionCode, REJECTION_CODES.REVIEW_NOT_FRONTIER);
  assert.equal(admissionAllowsDispatch(admission), false);
});

test('K3-4: a T3 review on the installed Host default is blocked, not quietly advisory', () => {
  const reviewDecision = decisionFor({ role: 'reviewer', modelClass: 'frontier_reasoning', permissions: 'read_only', riskTier: 'T3', independentContextRequired: true });
  const reviewCapsule = capsuleFor({ role: 'reviewer', permissions: { filesystem: 'read_only', canCommit: false, canDelegate: false } });

  const hostDefault = admitRoute({
    decision: reviewDecision,
    resolution: resolutionFor({ modelClass: 'frontier_reasoning', model: null, source: 'host-default', enforcementIntent: 'advisory' }),
    capabilities: FULL_HOST,
    capsule: reviewCapsule,
  });
  assert.equal(hostDefault.decision, 'blocked');
  assert.equal(hostDefault.rejectionCode, REJECTION_CODES.REVIEW_NOT_ADVISORY);

  // The same host default is an honest advisory admission for ordinary work.
  const implementation = admitRoute({
    decision: decisionFor(),
    resolution: resolutionFor({ model: null, source: 'host-default', enforcementIntent: 'advisory' }),
    capabilities: FULL_HOST,
    capsule: capsuleFor(),
  });
  assert.equal(implementation.decision, 'advisory_admitted');
  assert.equal(implementation.rejectionCode, null);
  assert.equal(admissionAllowsDispatch(implementation), true);
});

test('K3: a Host that cannot provide an independent context cannot carry an independent review', () => {
  const admission = admitRoute({
    decision: decisionFor({ role: 'reviewer', modelClass: 'frontier_reasoning', permissions: 'read_only', riskTier: 'T3', independentContextRequired: true }),
    resolution: resolutionFor({ modelClass: 'frontier_reasoning' }),
    capabilities: { ...FULL_HOST, supportsIndependentContext: false },
    capsule: capsuleFor({ role: 'reviewer', permissions: { filesystem: 'read_only', canCommit: false, canDelegate: false } }),
  });
  assert.equal(admission.decision, 'blocked');
  assert.equal(admission.rejectionCode, REJECTION_CODES.REVIEW_NO_INDEPENDENT_CONTEXT);
});

test('K3: a session-only Host records an independent turn as a fallback, never as enforced', () => {
  const admission = admitRoute({
    decision: decisionFor({ modelClass: 'frontier_reasoning', independentContextRequired: true, riskTier: 'T2' }),
    resolution: resolutionFor({ modelClass: 'frontier_reasoning' }),
    capabilities: { ...FULL_HOST, supportsSubagentModel: false },
    capsule: capsuleFor(),
  });
  assert.equal(admission.decision, 'fallback_admitted');
  assert.equal(admissionAllowsDispatch(admission), true);
});

test('K3: a capsule that contradicts the route is refused', () => {
  const readOnlyRoute = decisionFor({ role: 'reviewer', permissions: 'read_only', modelClass: 'frontier_reasoning', riskTier: 'T2' });

  const writable = admitRoute({
    decision: readOnlyRoute,
    resolution: resolutionFor({ modelClass: 'frontier_reasoning' }),
    capabilities: FULL_HOST,
    capsule: capsuleFor({ role: 'reviewer', permissions: { filesystem: 'workspace_write', canCommit: false, canDelegate: false } }),
  });
  assert.equal(writable.rejectionCode, REJECTION_CODES.CAPSULE_PERMISSION_MISMATCH);

  const wrongRole = admitRoute({
    decision: readOnlyRoute,
    resolution: resolutionFor({ modelClass: 'frontier_reasoning' }),
    capabilities: FULL_HOST,
    capsule: capsuleFor(),
  });
  assert.equal(wrongRole.rejectionCode, REJECTION_CODES.CAPSULE_ROLE_MISMATCH);

  const overReaching = admitRoute({
    decision: decisionFor(),
    resolution: resolutionFor(),
    capabilities: FULL_HOST,
    capsule: capsuleFor({ permissions: { filesystem: 'workspace_write', canCommit: true, canDelegate: false } }),
  });
  assert.equal(overReaching.rejectionCode, REJECTION_CODES.CAPSULE_GRANTS_AUTHORITY);
});

test('K3-9: a Kernel-owned action is never admitted for provider dispatch', () => {
  const admission = admitRoute({
    decision: decisionFor({ role: 'kernel', modelClass: 'kernel', permissions: 'kernel_runtime' }),
    resolution: { modelClass: 'kernel', surface: 'claude', model: null, effort: null, source: 'kernel-runtime', enforcementIntent: 'not-applicable' },
    capabilities: FULL_HOST,
  });
  assert.equal(admission.decision, 'blocked');
  assert.equal(admission.rejectionCode, REJECTION_CODES.KERNEL_OWNED);
});

test('K3: a cost hard cap blocks the dispatch', () => {
  const admission = admitRoute({
    decision: decisionFor({ modelClass: 'frontier_reasoning' }),
    resolution: resolutionFor({ modelClass: 'frontier_reasoning' }),
    capabilities: FULL_HOST,
    capsule: capsuleFor(),
    economics: { maxCostUnits: 5, estimatedCostUnits: 9 },
  });
  assert.equal(admission.decision, 'blocked');
  assert.equal(admission.rejectionCode, REJECTION_CODES.COST_CAP_EXCEEDED);

  const within = admitRoute({
    decision: decisionFor(),
    resolution: resolutionFor(),
    capabilities: FULL_HOST,
    capsule: capsuleFor(),
    economics: { maxCostUnits: 10, estimatedCostUnits: 3 },
  });
  assert.equal(within.decision, 'admitted');
});

test('K3: a Host that cannot select a model at all is blocked rather than assumed', () => {
  const admission = admitRoute({
    decision: decisionFor(),
    resolution: resolutionFor(),
    capabilities: { surface: 'fable', supportsResolvedModelIdentity: true },
    capsule: capsuleFor(),
  });
  assert.equal(admission.decision, 'blocked');
  assert.equal(admission.rejectionCode, REJECTION_CODES.ADAPTER_CANNOT_SELECT_MODEL);
});

test('K3: the policy snapshot is a set of digests, never raw configuration', () => {
  const digests = policyDigests({ profiles: { claude: { value_coding: { model: 'x' } } }, capabilities: FULL_HOST });
  for (const field of ['profileDigest', 'hostCapabilityDigest', 'toolPolicyDigest', 'permissionPolicyDigest']) {
    assert.match(digests[field], /^sha256:[a-f0-9]{64}$/);
  }
  assert.equal(digests.modelPolicyRevision, 'kernel-model-policy.v1');
  assert.ok(!JSON.stringify(digests).includes('claude'), 'the snapshot carries no configuration values');
});
