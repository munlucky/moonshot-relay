import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  assertEvidenceBinding,
  buildCandidateIdentity,
  canonicalStringify,
  compareEvidenceBinding,
  normalizeCandidateId,
  sha256Hex,
} from '../scripts/lib/candidate-identity.js';

const candidateInput = () => ({
  task: { id: 'EDAH-REQ-02' },
  spec: { path: 'spec.yaml', revision: 1 },
  plan: { phase: '02' },
  done: { criteria: ['identity', 'receipts'] },
  source: { digest: sha256Hex('source-tree') },
  environment: { node: '22.22.0', platform: 'win32' },
  policy: { version: 'candidate-binding-v1' },
});

test('canonical serialization is stable across object key order', () => {
  assert.equal(
    canonicalStringify({ b: 2, a: { d: 4, c: [3, 2, 1] } }),
    canonicalStringify({ a: { c: [3, 2, 1], d: 4 }, b: 2 }),
  );
});

test('candidate identity is deterministic and exposes snake and camel case ids', () => {
  const first = buildCandidateIdentity(candidateInput());
  const second = buildCandidateIdentity(candidateInput());

  assert.equal(first.candidate_id, second.candidate_id);
  assert.equal(first.candidateId, first.candidate_id);
  assert.match(first.candidate_id, /^cand_[a-f0-9]{32}$/);
  assert.equal(first.dimensions.source, sha256Hex('source-tree'));
});

test('candidate identity changes when source or environment dimensions change', () => {
  const base = buildCandidateIdentity(candidateInput());
  const changedSource = buildCandidateIdentity({
    ...candidateInput(),
    source: { digest: sha256Hex('source-tree-2') },
  });
  const changedEnvironment = buildCandidateIdentity({
    ...candidateInput(),
    environment: { node: '24.0.0', platform: 'win32' },
  });

  assert.notEqual(base.candidate_id, changedSource.candidate_id);
  assert.notEqual(base.candidate_id, changedEnvironment.candidate_id);
});

test('candidate_id and candidateId interop normalizes at receipt boundary', () => {
  const candidate = buildCandidateIdentity(candidateInput());

  assert.equal(normalizeCandidateId({ candidate_id: candidate.candidate_id }), candidate.candidate_id);
  assert.equal(normalizeCandidateId({ candidateId: candidate.candidate_id }), candidate.candidate_id);
  assert.equal(normalizeCandidateId({ candidateIdentity: { candidateId: candidate.candidate_id } }), candidate.candidate_id);
});

test('stale candidate source environment or policy evidence is rejected', () => {
  const candidate = buildCandidateIdentity(candidateInput());
  const expected = {
    candidate_id: candidate.candidate_id,
    sourceDigest: candidate.dimensions.source,
    environmentDigest: candidate.dimensions.environment,
    policyDigest: candidate.dimensions.policy,
  };
  const matching = {
    candidateId: candidate.candidate_id,
    sourceDigest: candidate.dimensions.source,
    environmentDigest: candidate.dimensions.environment,
    policyDigest: candidate.dimensions.policy,
  };
  const stale = {
    ...matching,
    sourceDigest: sha256Hex('different-source'),
  };

  assert.equal(compareEvidenceBinding(expected, matching).matched, true);
  assert.equal(compareEvidenceBinding(expected, stale).matched, false);
  assert.throws(() => assertEvidenceBinding(expected, stale), /stale candidate evidence/);
});
