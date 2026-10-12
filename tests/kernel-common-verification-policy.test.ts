import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveVerificationPolicy, MODEL_LOCAL_CHECKS, KERNEL_AUTHORITATIVE_EVIDENCE,
} from '../src/host/kernel/common-model-policy.js';
import { resolveClaudeCapabilityDelta } from '../src/host/kernel/claude-effort-policy.js';

test('verification runs smallest-first and reports what it ran', () => {
  const policy = resolveVerificationPolicy({});
  assert.deepEqual([...policy.order], [
    'smallest-relevant-test',
    'done-when-regression',
    'final-diff-review',
    'report-commands-and-risks',
  ]);
});

test('model-local checks and Kernel evidence are disjoint', () => {
  const overlap = MODEL_LOCAL_CHECKS.filter((check) => KERNEL_AUTHORITATIVE_EVIDENCE.some(evidence => String(evidence) === check));
  assert.deepEqual(overlap, []);
  assert.equal(resolveVerificationPolicy({}).duplicateKernelProof, false);
});

test('requested commands come from the obligations, deduplicated and ordered', () => {
  const input = {
    obligations: [
      { obligationId: 'a', allowedCommandRefs: ['test:kernel', 'test:routing'] },
      { obligationId: 'b', allowedCommandRefs: ['test:kernel'] },
    ],
  };
  const policy = resolveVerificationPolicy(input);
  assert.deepEqual([...policy.requestedCommandRefs], ['test:kernel', 'test:routing']);
});

test('an obligation with no bound commands requests nothing rather than inventing one', () => {
  const input = { obligations: [{ obligationId: 'a', allowedCommandRefs: [] }] };
  assert.deepEqual([...resolveVerificationPolicy(input).requestedCommandRefs], []);
});

test('done-when conditions are carried through to the policy', () => {
  const policy = resolveVerificationPolicy({ doneWhen: ['npm run test:kernel passes'] });
  assert.deepEqual([...policy.doneWhen], ['npm run test:kernel passes']);
});


test('Claude capability delta preserves common Kernel-authoritative verification', () => {
  const delta = resolveClaudeCapabilityDelta({
    obligations: [{ allowedCommandRefs: ['test:kernel'] }],
    doneWhen: ['test:kernel passes'],
  });
  assert.equal(delta.verification.source, 'common-verification-policy');
  assert.equal(delta.verification.duplicateKernelProof, false);
  assert.deepEqual([...delta.verification.kernelEvidence], [...KERNEL_AUTHORITATIVE_EVIDENCE]);
});
