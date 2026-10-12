import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildFuturesArchitectureHandoff,
  runArchitectureArtifacts,
} from '../src/application/kernel-standalone/architecture-artifacts.js';

const sha = (char: string): string => `sha256:${char.repeat(64)}`;

const readyHandoff = () => buildFuturesArchitectureHandoff({
  candidate: {
    kind: 'architecture-planning',
    affectedPaths: ['src/auth/**', 'src/contracts/auth.ts'],
  },
  reviewReceiptId: 'review-current',
  assessmentDigest: sha('a'),
  subject: {
    revision: '13',
    contentDigest: sha('b'),
  },
  currentRevision: 13,
  currentContentDigest: sha('b'),
  unresolvedRequirements: [
    'Decide the public auth boundary before implementation resumes.',
  ],
});

test('C16: reviewed Red candidate is normalized into existing architecture pre-work without implementation authority', async () => {
  const handoff = readyHandoff();
  assert.equal(handoff.status, 'ready');
  if (handoff.status !== 'ready') assert.fail('handoff must be ready');
  assert.deepEqual(handoff.affectedPaths, ['src/auth/**', 'src/contracts/auth.ts']);
  assert.deepEqual(handoff.escalationReasons, []);
  assert.equal(handoff.authority, 'prework-only');

  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'futures-architecture-'));
  try {
    await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({
      name: 'futures-architecture-fixture',
      version: '0.0.0',
    }));
    const result = await runArchitectureArtifacts({
      cwd: projectRoot,
      handoff,
      observeWorkspaceIdentity: () => ({ identity: 'fixture-workspace' }),
    });

    assert.equal(result.status, 'pass');
    if (result.status !== 'pass') assert.fail('architecture pre-work must pass');
    assert.equal(result.sourceMutation, false);
    assert.equal(result.completionDecision, null);
    assert.equal(result.authority, 'task-contract-seed-only');
    assert.deepEqual(result.taskContractSeed.acceptance, handoff.unresolvedRequirements);
    assert.ok(result.taskContractSeed.constraints.some((entry: string) => (
      entry.includes('src/auth/**') && entry.includes('src/contracts/auth.ts')
    )));
    assert.ok(result.taskContractSeed.nonGoals.some((entry: string) => (
      entry.includes('does not advance the current Work cursor')
    )));
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('C16: stale assessment identity is blocked before architecture artifacts are generated', () => {
  const handoff = buildFuturesArchitectureHandoff({
    candidate: { kind: 'architecture-planning', affectedPaths: ['src/**'] },
    reviewReceiptId: 'review-current',
    assessmentDigest: sha('a'),
    subject: { revision: '12', contentDigest: sha('b') },
    currentRevision: 13,
    currentContentDigest: sha('c'),
    unresolvedRequirements: ['Resolve current boundary'],
  });

  assert.equal(handoff.status, 'blocked');
  if (handoff.status !== 'blocked') assert.fail('stale handoff must block');
  assert.deepEqual(handoff.reasons, [
    'architecture-handoff-stale-content',
    'architecture-handoff-stale-revision',
  ]);
});

test('C16: failed bounded restore can escalate through the same pre-work handoff without widening its reviewed paths', () => {
  const handoff = buildFuturesArchitectureHandoff({
    candidate: { kind: 'bounded-restore', allowedPaths: ['src/auth/service.ts'] },
    reviewReceiptId: 'review-current',
    assessmentDigest: sha('a'),
    subject: { revision: '13', contentDigest: sha('b') },
    currentRevision: 13,
    currentContentDigest: sha('b'),
    unresolvedRequirements: ['Choose a structural fix before implementation resumes.'],
    escalationReasons: ['fresh-regression-proof-failed'],
  });

  assert.equal(handoff.status, 'ready');
  if (handoff.status !== 'ready') assert.fail('restore failure handoff must be ready');
  assert.deepEqual(handoff.affectedPaths, ['src/auth/service.ts']);
  assert.deepEqual(handoff.escalationReasons, ['fresh-regression-proof-failed']);
});

test('C16: restore escalation without a reason stays blocked', () => {
  const handoff = buildFuturesArchitectureHandoff({
    candidate: { kind: 'bounded-restore', allowedPaths: ['src/a.ts'] },
    reviewReceiptId: 'review-current',
    assessmentDigest: sha('a'),
    subject: { revision: '13', contentDigest: sha('b') },
    currentRevision: 13,
    currentContentDigest: sha('b'),
  });

  assert.equal(handoff.status, 'blocked');
  if (handoff.status !== 'blocked') assert.fail('reasonless restore escalation must block');
  assert.deepEqual(handoff.reasons, ['restore-escalation-reason-required']);
});

test('C16: missing review or non-escalation candidate cannot create a handoff', () => {
  const handoff = buildFuturesArchitectureHandoff({
    candidate: { kind: 'existing-obligations', obligationIds: ['verify-regression'] } as never,
    reviewReceiptId: '',
    assessmentDigest: 'not-a-digest',
    subject: { revision: '13', contentDigest: sha('b') },
    currentRevision: 13,
    currentContentDigest: sha('b'),
  });

  assert.equal(handoff.status, 'blocked');
  if (handoff.status !== 'blocked') assert.fail('invalid handoff must block');
  assert.deepEqual(handoff.reasons, [
    'architecture-candidate-required',
    'assessment-digest-invalid',
    'review-receipt-required',
  ]);
});
