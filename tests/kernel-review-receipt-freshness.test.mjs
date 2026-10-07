import { decideTestModelRoute } from './helpers/kernel-host-test-api.mjs';
// K0 freshness: a Review Receipt is bound to the workspace identity and the
// mutation revision it reviewed. Change the workspace after the review and the
// review goes stale instead of quietly completing the run.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createKernelControlPlane } from '../scripts/kernel/control-plane.mjs';
import { hashSessionId } from '../scripts/kernel/run/model-route-contract.mjs';
import { digestOfEvidence, digestOfPaths, evaluateReviewReceipt } from '../scripts/kernel/proof/review-receipt.mjs';

const IMPLEMENTER = hashSessionId('freshness-implementer');
const REVIEWER = hashSessionId('freshness-reviewer');

const setup = async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'krn-rrf-home-'));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'krn-rrf-proj-'));
  spawnSync('git', ['init'], { cwd: projectRoot, encoding: 'utf8' });
  await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({
    name: 'rrf-fixture',
    version: '0.0.1',
    scripts: { 'test:ok': 'node -e "process.exit(0)"', lint: 'node -e "process.exit(0)"', 'lint:fail': 'node -e "process.exit(1)"' },
  }, null, 2));
  await writeFile(path.join(projectRoot, 'app.mjs'), 'export const v = 0;\n');
  return { runtimeHome, projectRoot };
};

const cleanup = async ({ runtimeHome, projectRoot }) => {
  await rm(runtimeHome, { recursive: true, force: true });
  await rm(projectRoot, { recursive: true, force: true });
};

const mutate = (projectRoot, value) => writeFile(path.join(projectRoot, 'app.mjs'), `export const v = ${value};\n`);

const routeAndRun = async (cp, runId, actionKind, actorSessionId) => {
  const decision = await decideTestModelRoute(cp, runId, { actionKind, obligationId: 'default' });
  const receipt = await cp.recordModelUsage(runId, {
    decisionId: decision.decisionId,
    runId,
    hostSurface: 'claude',
    actorSessionId,
    resolvedModel: 'configured-model',
    enforcementStatus: 'enforced',
    resultStatus: 'completed',
  });
  return { decision, receipt };
};

const reviewedT3Run = async (fixture, cp, runId) => {
  await cp.startRun({
    runId,
    objective: 'auth boundary',
    taskContract: {
      surfaces: ['security_boundary'],
      acceptance: [{ acceptance: 'works', evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test:ok'], obligationId: 'unit-test' } }],
    },
  });
  await mutate(fixture.projectRoot, 1);
  await routeAndRun(cp, runId, 'implement', IMPLEMENTER);
  await cp.report(runId, {
    summary: 'implemented',
    changedPaths: ['app.mjs'],
    verifications: [
      { obligationId: 'unit-test', commandRef: 'test:ok', acceptanceCoverage: ['works'] },
      { obligationId: 'static-analysis', commandRef: 'lint' },
    ],
  });
  const review = await routeAndRun(cp, runId, 'review_engineering', REVIEWER);
  return cp.recordReview(
    runId,
    { stage: 'engineering', verdict: 'pass', reviewerId: 'reviewer-2' },
    { implementerId: 'impl-1', reviewReceiptId: review.receipt.receiptId, obligationId: 'security-review', changedPaths: ['app.mjs'] },
  );
};

test('K0-5: a workspace change after the review makes the review stale', async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  try {
    const recorded = await reviewedT3Run(fixture, cp, 'r-stale');
    assert.equal((await cp.assessCompletion('r-stale')).readyExceptClose, true);

    // The implementer keeps working after the review landed.
    await mutate(fixture.projectRoot, 2);
    const reported = await cp.report('r-stale', {
      summary: 'more work after review',
      implementerId: 'impl-1',
      judgments: [{
        obligationId: 'security-review',
        verdict: 'pass',
        reviewerId: 'reviewer-2',
        rationale: 'already reviewed',
        reviewReceiptId: recorded.reviewReceipt.receiptId,
      }],
    });
    assert.match(reported.failures[0].errorSummary, /review-stale-(workspace-identity|mutation-revision)/);

    const completion = await cp.assessCompletion('r-stale');
    const byId = Object.fromEntries(completion.obligationStatuses.map((entry) => [entry.obligationId, entry]));
    assert.equal(byId['security-review'].satisfied, false, 'the earlier review cannot cover a workspace it never saw');
    assert.equal(completion.decision, 'blocked');
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});

test('K0-6: a mutation revision bump alone invalidates the receipt', () => {
  const receipt = {
    runId: 'r-1',
    verdict: 'pass',
    reviewer: { actorSessionId: REVIEWER, modelClass: 'frontier_reasoning', enforcementStatus: 'enforced' },
    implementer: { actorSessionId: IMPLEMENTER },
    subject: { workspaceIdentity: `sha256:${'a'.repeat(64)}`, mutationRevision: 3, changedPathsDigest: digestOfPaths([]), evidenceDigest: `sha256:${'b'.repeat(64)}` },
  };
  const run = { runId: 'r-1', mutationRevision: 3, currentWorkspaceIdentity: `sha256:${'a'.repeat(64)}` };
  const options = { requireIndependentSession: true, requireFrontierClass: true, requireTrustedEnforcement: true };

  assert.equal(evaluateReviewReceipt({ receipt, run, ...options }).usable, true);
  assert.deepEqual(
    evaluateReviewReceipt({ receipt, run: { ...run, mutationRevision: 4 }, ...options }).reasons,
    ['review-stale-mutation-revision'],
  );
  assert.deepEqual(
    evaluateReviewReceipt({ receipt, run: { ...run, currentWorkspaceIdentity: `sha256:${'e'.repeat(64)}` }, ...options }).reasons,
    ['review-stale-workspace-identity'],
  );
  assert.deepEqual(
    evaluateReviewReceipt({ receipt: { ...receipt, verdict: 'changes-requested' }, run, ...options }).reasons,
    ['review-verdict-changes-requested'],
  );
});

test('K0-6a: sibling judgments do not stale one another while hard evidence still does', () => {
  const hard = {
    obligationId: 'unit-test',
    status: 'passed',
    evidenceClass: 'hard',
    evidenceDigest: `sha256:${'1'.repeat(64)}`,
  };
  const firstJudgment = {
    obligationId: 'judgment-ac-1',
    status: 'passed',
    evidenceClass: 'judgment',
    evidenceDigest: `sha256:${'2'.repeat(64)}`,
  };
  const secondJudgment = {
    obligationId: 'judgment-ac-2',
    status: 'passed',
    evidenceClass: 'judgment',
    evidenceDigest: `sha256:${'3'.repeat(64)}`,
  };

  const reviewedDigest = digestOfEvidence([hard, firstJudgment], { excludeObligationId: 'judgment-ac-1' });
  assert.equal(
    digestOfEvidence([hard, firstJudgment, secondJudgment], { excludeObligationId: 'judgment-ac-1' }),
    reviewedDigest,
    'a later independent judgment must not invalidate an earlier receipt',
  );
  assert.notEqual(
    digestOfEvidence([{ ...hard, evidenceDigest: `sha256:${'4'.repeat(64)}` }, firstJudgment, secondJudgment], { excludeObligationId: 'judgment-ac-1' }),
    reviewedDigest,
    'changed executable evidence must still invalidate the receipt',
  );
});

test('K0-6b: a re-review at the new workspace state restores completion', async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  try {
    await reviewedT3Run(fixture, cp, 'r-rereview');
    await mutate(fixture.projectRoot, 2);
    // Re-run the executable obligations against the new state, then review it.
    await cp.report('r-rereview', {
      summary: 'follow-up fix',
      changedPaths: ['app.mjs'],
      verifications: [
        { obligationId: 'unit-test', commandRef: 'test:ok', acceptanceCoverage: ['works'] },
        { obligationId: 'static-analysis', commandRef: 'lint' },
      ],
    });
    const secondReview = await routeAndRun(cp, 'r-rereview', 'review_engineering', REVIEWER);
    const recorded = await cp.recordReview(
      'r-rereview',
      { stage: 'engineering', verdict: 'pass', reviewerId: 'reviewer-2' },
      { implementerId: 'impl-1', reviewReceiptId: secondReview.receipt.receiptId, obligationId: 'security-review', changedPaths: ['app.mjs'] },
    );
    const run = await cp.getRun('r-rereview');
    assert.equal(recorded.reviewReceipt.subject.mutationRevision, run.mutationRevision);
    assert.equal((await cp.assessCompletion('r-rereview')).readyExceptClose, true);
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});

test('K0: evidence that changed after the review makes the receipt stale, even with no workspace change', async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  try {
    // Prove the executable obligations, but let static-analysis FAIL first, so
    // the reviewer forms a verdict against a failing evidence set.
    await cp.startRun({
      runId: 'r-evidence',
      objective: 'auth boundary',
      taskContract: {
        surfaces: ['security_boundary'],
        acceptance: [{ acceptance: 'works', evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test:ok'], obligationId: 'unit-test' } }],
      },
    });
    await mutate(fixture.projectRoot, 1);
    await routeAndRun(cp, 'r-evidence', 'implement', IMPLEMENTER);
    await cp.report('r-evidence', {
      summary: 'first pass',
      changedPaths: ['app.mjs'],
      verifications: [
        { obligationId: 'unit-test', commandRef: 'test:ok', acceptanceCoverage: ['works'] },
        { obligationId: 'static-analysis', commandRef: 'lint:fail' },
      ],
    });

    const review = await routeAndRun(cp, 'r-evidence', 'review_engineering', REVIEWER);
    const recorded = await cp.recordReview(
      'r-evidence',
      { stage: 'engineering', verdict: 'pass', reviewerId: 'reviewer-2' },
      { implementerId: 'impl-1', reviewReceiptId: review.receipt.receiptId, obligationId: 'security-review' },
    );

    // Re-run the failing check until it passes. Nothing about the workspace
    // moved, so mutation revision and workspace identity are unchanged — the
    // only thing that changed is the evidence the reviewer never saw.
    const before = await cp.getRun('r-evidence');
    await cp.report('r-evidence', {
      summary: 'rerun the analyser',
      verifications: [{ obligationId: 'static-analysis', commandRef: 'lint' }],
    });
    const after = await cp.getRun('r-evidence');
    assert.equal(after.mutationRevision, before.mutationRevision, 'the workspace did not move');
    assert.equal(after.currentWorkspaceIdentity, before.currentWorkspaceIdentity);

    const completion = await cp.assessCompletion('r-evidence');
    const entry = completion.obligationStatuses.find((item) => item.obligationId === 'security-review');
    assert.equal(entry.satisfied, false, 'a verdict formed on a different evidence set cannot complete the run');
    assert.ok(entry.reviewLineage.reasons.includes('review-stale-evidence-set'), JSON.stringify(entry.reviewLineage.reasons));

    // Re-reviewing the current evidence set restores it.
    const second = await routeAndRun(cp, 'r-evidence', 'review_engineering', REVIEWER);
    await cp.recordReview(
      'r-evidence',
      { stage: 'engineering', verdict: 'pass', reviewerId: 'reviewer-2' },
      { implementerId: 'impl-1', reviewReceiptId: second.receipt.receiptId, obligationId: 'security-review' },
    );
    const restored = await cp.assessCompletion('r-evidence');
    const restoredEntry = restored.obligationStatuses.find((item) => item.obligationId === 'security-review');
    assert.equal(restoredEntry.satisfied, true);
    // A different receipt now backs the obligation: the two describe different
    // evidence sets, which is exactly what the check is for.
    assert.notEqual(restoredEntry.reviewLineage.receiptId, recorded.reviewReceipt.receiptId);
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});
