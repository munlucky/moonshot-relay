// K3-5/6: configuration can move between the admission and the dispatch. A
// changed model profile means the class may now resolve elsewhere (recompute);
// a changed permission or tool policy is a boundary change (refuse).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { admitRoute, policyDigests, REJECTION_CODES, revalidateAdmissionAtDispatch } from '../scripts/host/kernel/route-admission.mjs';
import { currentHostPolicies, revalidateBeforeDispatch } from '../scripts/host/kernel/admission-revalidator.mjs';

const HOST = { surface: 'claude', supportsSubagentModel: true, supportsSessionModelOverride: true, supportsIndependentContext: true, supportsResolvedModelIdentity: true };

const admissionAt = (policies) => admitRoute({
  decision: {
    decisionId: 'route-0123456789abcdef01234567',
    runId: 'r-1',
    role: 'implementer',
    modelClass: 'value_coding',
    permissions: 'workspace_write',
    riskTier: 'T1',
    independentContextRequired: false,
  },
  resolution: { modelClass: 'value_coding', surface: 'claude', model: 'configured-value', source: 'profile-config', enforcementIntent: 'enforced' },
  capabilities: HOST,
  policies,
});

const BASE_PROFILES = { claude: { value_coding: { model: 'configured-value' } } };
const BASE = policyDigests({ profiles: BASE_PROFILES, capabilities: HOST, toolPolicy: { fs: 'workspace' }, permissionPolicy: { network: 'inherited' } });

test('K3: an unchanged configuration revalidates and dispatches', () => {
  const admission = admissionAt(BASE);
  const result = revalidateAdmissionAtDispatch({ admission, policies: BASE });
  assert.equal(result.valid, true);
  assert.deepEqual(result.drift, []);
});

test('K3-5: a model profile changed after the decision forces a redecision', () => {
  const admission = admissionAt(BASE);
  const moved = policyDigests({
    profiles: { claude: { value_coding: { model: 'someone-changed-this' } } },
    capabilities: HOST,
    toolPolicy: { fs: 'workspace' },
    permissionPolicy: { network: 'inherited' },
  });
  const result = revalidateAdmissionAtDispatch({ admission, policies: moved });
  assert.equal(result.valid, false);
  assert.equal(result.decision, 'redecision_required');
  assert.equal(result.rejectionCode, REJECTION_CODES.PROFILE_DRIFT);
  assert.equal(result.drift[0].field, 'profileDigest');
});

test('K3-6: a permission policy changed after the decision blocks outright', () => {
  const admission = admissionAt(BASE);
  const widened = policyDigests({
    profiles: BASE_PROFILES,
    capabilities: HOST,
    toolPolicy: { fs: 'workspace' },
    permissionPolicy: { network: 'unrestricted' },
  });
  const result = revalidateAdmissionAtDispatch({ admission, policies: widened });
  assert.equal(result.valid, false);
  assert.equal(result.decision, 'blocked');
  assert.equal(result.rejectionCode, REJECTION_CODES.PERMISSION_POLICY_DRIFT);
});

test('K3: a boundary change outranks a profile change when both moved', () => {
  const admission = admissionAt(BASE);
  const both = policyDigests({
    profiles: { claude: { value_coding: { model: 'other' } } },
    capabilities: HOST,
    toolPolicy: { fs: 'anything' },
    permissionPolicy: { network: 'unrestricted' },
  });
  const result = revalidateAdmissionAtDispatch({ admission, policies: both });
  assert.equal(result.decision, 'blocked');
  assert.ok([REJECTION_CODES.PERMISSION_POLICY_DRIFT, REJECTION_CODES.TOOL_POLICY_DRIFT].includes(result.rejectionCode));
  assert.equal(result.drift.length, 3);
});

test('K3: host capability changes force a redecision rather than an assumption', () => {
  const admission = admissionAt(BASE);
  const degraded = policyDigests({
    profiles: BASE_PROFILES,
    capabilities: { ...HOST, supportsIndependentContext: false },
    toolPolicy: { fs: 'workspace' },
    permissionPolicy: { network: 'inherited' },
  });
  const result = revalidateAdmissionAtDispatch({ admission, policies: degraded });
  assert.equal(result.decision, 'redecision_required');
  assert.equal(result.rejectionCode, REJECTION_CODES.CAPABILITY_DRIFT);
});

test('K3: a missing admission is never treated as permission to dispatch', () => {
  const result = revalidateAdmissionAtDispatch({ admission: null, policies: BASE });
  assert.equal(result.valid, false);
  assert.equal(result.rejectionCode, 'admission-missing');
});

test('K3: the Host revalidator reads the live registry and capabilities', () => {
  const registry = { profiles: BASE_PROFILES };
  const admission = admissionAt(currentHostPolicies({ registry, capabilities: HOST, toolPolicy: { fs: 'workspace' }, permissionPolicy: { network: 'inherited' } }));
  assert.equal(revalidateBeforeDispatch({ admission, registry, capabilities: HOST, toolPolicy: { fs: 'workspace' }, permissionPolicy: { network: 'inherited' } }).valid, true);

  // The operator edits the profile between the admission and the dispatch.
  const edited = { profiles: { claude: { value_coding: { model: 'edited' } } } };
  const drifted = revalidateBeforeDispatch({ admission, registry: edited, capabilities: HOST, toolPolicy: { fs: 'workspace' }, permissionPolicy: { network: 'inherited' } });
  assert.equal(drifted.valid, false);
  assert.equal(drifted.decision, 'redecision_required');
});
