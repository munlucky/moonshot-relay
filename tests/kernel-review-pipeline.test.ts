import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { resolveReviewPlan, normalizeReviewVerdict, assertIndependentReview } from '../src/kernel/proof/review-pipeline.js';
import { createKernelControlPlane } from '../src/host/kernel/control-plane-runtime.js';

test('review plan separates contract and engineering stages by risk', () => {
  assert.deepEqual(resolveReviewPlan({ riskTier: 'T0' }).stages, []);
  const t1 = resolveReviewPlan({ riskTier: 'T1', behaviorChanging: true });
  assert.deepEqual(t1.stages.map((s) => s.stage), ['engineering']);
  const contractOnly = resolveReviewPlan({ riskTier: 'T0', publicContract: true });
  assert.deepEqual(contractOnly.stages.map((s) => s.stage), ['contract']);
  const t3 = resolveReviewPlan({ riskTier: 'T3', publicContract: true, behaviorChanging: true });
  assert.deepEqual(t3.stages.map((s) => s.stage), ['contract', 'engineering']);
  assert.equal(t3.independentReviewerRequired, true);
});

test('review verdict output contract is fixed and validated', () => {
  assert.throws(() => normalizeReviewVerdict({ stage: 'contract', verdict: 'ok' }), /pass \| fail/);
  assert.throws(() => normalizeReviewVerdict({ stage: 'bogus', verdict: 'pass' }), /review stage/);
  const v = normalizeReviewVerdict({ stage: 'contract', verdict: 'pass', reviewerId: 'r1', findings: ['ok'], risks: [] });
  assert.equal(v.verdict, 'pass');
  assert.deepEqual(v.findings, ['ok']);
});

test('independent review rejects a reviewer equal to the implementer', () => {
  const verdict = normalizeReviewVerdict({ stage: 'contract', verdict: 'pass', reviewerId: 'agent-1' });
  assert.throws(() => assertIndependentReview({ verdict, implementerId: 'agent-1' }), /INDEPENDENT_REVIEW_REQUIRED/);
  assert.ok(assertIndependentReview({ verdict, implementerId: 'agent-2' }));
});

test('recordReview at T3 requires an independent reviewer and records a judgment', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'krn-review-home-'));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'krn-review-proj-'));
  spawnSync('git', ['init'], { cwd: projectRoot, encoding: 'utf8' });
  await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'node -e "process.exit(0)"', lint: 'node -e "process.exit(0)"' } }));
  const cp = await createKernelControlPlane({ runtimeHome, projectRoot });
  try {
    await cp.startRun({ runId: 'r-rev', objective: 'x', taskContract: { surfaces: ['security_boundary'] } });
    const run = await cp.getRun('r-rev');
    assert.ok(run);
    assert.equal(run.proofTier, 'T3');

    await cp.transition('r-rev', 'EXECUTE');
    await cp.transition('r-rev', 'PROVE');

    // Same-identity reviewer is refused at T3.
    await assert.rejects(
      cp.recordReview('r-rev', { stage: 'contract', verdict: 'pass', reviewerId: 'impl-1' }, { implementerId: 'impl-1' }),
      /INDEPENDENT_REVIEW_REQUIRED/,
    );

    // Independent reviewer is accepted and recorded as a judgment obligation.
    const recorded = await cp.recordReview('r-rev', { stage: 'contract', verdict: 'pass', reviewerId: 'reviewer-2' }, { implementerId: 'impl-1' });
    assert.equal(recorded.review.verdict, 'pass');
    const verifications = recorded.run ? true : false;
    assert.ok(verifications);
  } finally {
    await cp.close();
    await rm(runtimeHome, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  }
});
