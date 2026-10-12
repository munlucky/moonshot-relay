import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, test } from 'node:test';

import { buildCandidateIdentity, sha256Hex } from '../scripts/lib/candidate-identity.js';
import {
  assessDeliverySubmission,
  buildSubmissionReceipt,
} from '../scripts/lib/delivery-policy.mjs';
import {
  buildCommandEvidence,
  buildVerificationReceipt,
  scoreCandidate,
} from '../scripts/lib/verification-plane.mjs';

const tempRoots = [];

after(async () => {
  await Promise.all(tempRoots.map((dir) => rm(dir, { recursive: true, force: true })));
});

const sha = (value) => sha256Hex(value);
const gitSha = 'abcdef1234567890';

const receipts = () => {
  const candidate = buildCandidateIdentity({
    task: 'task',
    spec: 'spec',
    plan: 'plan',
    done: 'done',
    source: { digest: sha('source') },
    environment: { node: '22' },
    policy: { version: 'policy' },
  });
  const verification = {
    ...buildVerificationReceipt({
      candidate,
      commands: [buildCommandEvidence({ argv: ['npm', 'test'], exitCode: 0 })],
      status: 'passed',
    }),
    gitSha,
    verifiedSha: gitSha,
  };
  const score = {
    ...scoreCandidate({
      candidate,
      verification,
      hardGates: [{ id: 'unit', status: 'passed' }],
      policyVersion: 'score-policy-v1',
    }),
    gitSha,
    scoredSha: gitSha,
  };
  const review = {
    schemaVersion: 1,
    artifactId: 'REVIEW_RECEIPT',
    candidate_id: candidate.candidate_id,
    candidateId: candidate.candidate_id,
    sourceDigest: candidate.dimensions.source,
    environmentDigest: candidate.dimensions.environment,
    policyDigest: candidate.dimensions.policy,
    reviewerId: 'reviewer-a',
    bundleDigest: sha('bundle'),
    findings: [],
    gitSha,
    reviewedSha: gitSha,
  };
  return { candidate, verification, score, review };
};

test('delivery submit requires FULL score and aligned review verify score shas', () => {
  const { score, verification, review } = receipts();
  const assessment = assessDeliverySubmission({
    mode: 'pr',
    score,
    verification,
    review,
    currentSha: gitSha,
    submittedSha: gitSha,
  });
  const submission = buildSubmissionReceipt({
    mode: 'pr',
    score,
    verification,
    review,
    currentSha: gitSha,
    submittedSha: gitSha,
    createdAt: '2026-06-23T00:00:00.000Z',
  });

  assert.equal(assessment.status, 'allowed');
  assert.equal(submission.artifactId, 'SUBMISSION_RECEIPT');
  assert.equal(submission.scoreStatus, 'FULL');
  assert.equal(submission.sourceMutationAfterScore, false);
  assert.equal(submission.deliveryAllowed, true);
});

test('delivery submit blocks non-FULL score and source mutation after score', () => {
  const { score, verification, review } = receipts();
  const blocked = assessDeliverySubmission({
    score: { ...score, status: 'PARTIAL' },
    verification,
    review,
    currentSha: 'fedcba9876543210',
    submittedSha: 'fedcba9876543210',
  });

  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.sourceMutationAfterScore, true);
  assert.ok(blocked.blockers.some((blocker) => blocker.type === 'score_not_full'));
  assert.ok(blocked.blockers.some((blocker) => blocker.type === 'sha_mismatch'));
  assert.throws(() => buildSubmissionReceipt({
    score: { ...score, status: 'PARTIAL' },
    verification,
    review,
    currentSha: gitSha,
    submittedSha: gitSha,
  }), /score_not_full/);
});

test('delivery submit blocks stale candidate evidence', () => {
  const { score, verification, review } = receipts();
  const staleReview = { ...review, sourceDigest: sha('different-source') };
  const result = assessDeliverySubmission({
    score,
    verification,
    review: staleReview,
    currentSha: gitSha,
    submittedSha: gitSha,
  });

  assert.equal(result.status, 'blocked');
  assert.ok(result.blockers.some((blocker) => blocker.type === 'stale_candidate_evidence'));
});

test('delivery submit CLI writes submission receipt and blocks mismatched sha', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'moonshot-delivery-submit-'));
  tempRoots.push(tempRoot);
  const { score, verification, review } = receipts();
  const scorePath = path.join(tempRoot, 'score.json');
  const verificationPath = path.join(tempRoot, 'verification.json');
  const reviewPath = path.join(tempRoot, 'review.json');
  const outPath = path.join(tempRoot, 'submission.json');
  await writeFile(scorePath, JSON.stringify(score, null, 2));
  await writeFile(verificationPath, JSON.stringify(verification, null, 2));
  await writeFile(reviewPath, JSON.stringify(review, null, 2));

  const allowed = spawnSync(process.execPath, [
    'scripts/delivery-submit.mjs',
    'submit',
    '--score',
    scorePath,
    '--verification',
    verificationPath,
    '--review',
    reviewPath,
    '--current-sha',
    gitSha,
    '--mode',
    'release',
    '--out',
    outPath,
    '--json',
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  assert.equal(allowed.status, 0, allowed.stderr || allowed.stdout);
  const written = JSON.parse(await readFile(outPath, 'utf8'));
  assert.equal(written.mode, 'release');
  assert.equal(written.submittedSha, gitSha);

  const blocked = spawnSync(process.execPath, [
    'scripts/delivery-submit.mjs',
    'submit',
    '--score',
    scorePath,
    '--verification',
    verificationPath,
    '--current-sha',
    '0000000000000000',
    '--json',
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  assert.equal(blocked.status, 2, blocked.stderr || blocked.stdout);
  assert.equal(JSON.parse(blocked.stdout).status, 'blocked');
});

test('moonshot-relay delivery submit routes to source support script', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'moonshot-delivery-bin-'));
  tempRoots.push(tempRoot);
  const { score, verification } = receipts();
  const scorePath = path.join(tempRoot, 'score.json');
  const verificationPath = path.join(tempRoot, 'verification.json');
  await writeFile(scorePath, JSON.stringify(score, null, 2));
  await writeFile(verificationPath, JSON.stringify(verification, null, 2));

  const result = spawnSync(process.execPath, [
    'bin/moonshot-relay.mjs',
    'delivery',
    'submit',
    '--score',
    scorePath,
    '--verification',
    verificationPath,
    '--current-sha',
    gitSha,
    '--mode',
    'local',
    '--json',
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(JSON.parse(result.stdout).status, 'submitted');
});

test('submission receipt schema declares delivery anti-staleness fields', async () => {
  const schema = JSON.parse(await readFile(path.join(process.cwd(), 'schemas', 'submission-receipt.schema.json'), 'utf8'));
  for (const field of ['currentSha', 'reviewedSha', 'verifiedSha', 'scoredSha', 'sourceMutationAfterScore', 'deliveryAllowed']) {
    assert.ok(schema.required.includes(field), `${field} should be required`);
  }
});
