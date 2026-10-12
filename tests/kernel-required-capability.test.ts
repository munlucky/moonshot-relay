import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertRequiredHostCapabilities, RequiredHostCapabilityError } from '../src/kernel/run/required-host-capabilities.js';

test('start-time admission does not require completion-only proof execution capability', () => {
  const contract = {
    acceptance: [{ id: 'AC-1' }],
    risks: ['security'],
    requiredObligations: [],
    flags: {},
    surfaces: [],
  };
  const admitted = assertRequiredHostCapabilities(contract, { supportsProofExecution: false }, { stage: 'FRAME' });
  assert.equal(admitted.admitted, true);
  assert.deepEqual(admitted.required, {
    proofExecution: false,
    independentReviewer: false,
    readOnlyReview: false,
  });
});

test('PROVE stage admission requires proof execution capability when hard obligations exist', () => {
  const contract = {
    acceptance: [{ id: 'AC-1' }],
    risks: ['security'],
    requiredObligations: [],
    flags: {},
    surfaces: [],
  };
  const admitted = assertRequiredHostCapabilities(contract, { supportsProofExecution: true }, { stage: 'PROVE' });
  assert.equal(admitted.admitted, true);
  assert.deepEqual(admitted.required, {
    proofExecution: true,
    independentReviewer: false,
    readOnlyReview: false,
  });

  assert.throws(
    () => assertRequiredHostCapabilities(contract, { supportsProofExecution: false }, { stage: 'PROVE' }),
    (error) => error instanceof RequiredHostCapabilityError && error.code === 'REQUIRED_HOST_CAPABILITY_MISSING',
  );
});

test('PROVE stage does not require proof execution capability for judgment-only obligations', () => {
  const contract = {
    acceptance: [{
      id: 'AC-1',
      evidencePlan: { class: 'judgment', method: 'structured-judgment', obligationId: 'security-review' },
    }],
    requiredObligations: [],
  };
  const context = {
    stage: 'PROVE',
    obligations: [{ obligationId: 'security-review', evidenceClass: 'judgment', satisfiable: true }],
  };
  const admitted = assertRequiredHostCapabilities(contract, { supportsProofExecution: false }, context);
  assert.equal(admitted.admitted, true);
  assert.equal(admitted.required.proofExecution, false);
});
