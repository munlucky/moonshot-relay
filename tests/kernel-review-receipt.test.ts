import { assertTestArray, assertTestPresent, assertTestRecord, assertTestString, optionalTestRecord } from './helpers/assert-value.js';
import { decideTestModelRoute } from './helpers/kernel-host-test-api.js';
// K0: a protected or T3 judgment must rest on a Review Receipt whose reviewer
// lineage the Kernel itself recorded. Two different reviewer STRINGS prove
// nothing, so that path is closed.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createKernelControlPlane } from '../src/host/kernel/control-plane-runtime.js';
import { openKernelStateStore } from '../src/kernel/state-store.js';
import { hashSessionId } from '../src/contracts/model-execution.js';
import { digestOfPaths, evaluateReviewReceipt, normalizeReviewReceipt, parseReviewEvidenceRef, reviewSubjectAdoptionEligible, reviewSubjectKey, type ReviewReceiptInput } from '../src/kernel/proof/review-receipt.js';

const IMPLEMENTER = hashSessionId('implementer-session');
const REVIEWER = hashSessionId('reviewer-session');

const persistReviewReceipt = (
  store: Awaited<ReturnType<typeof openKernelStateStore>>,
  runId: string,
  receipt: ReviewReceiptInput,
) => store.recordReviewReceipt(
  runId,
  receipt,
  { subjectKey: reviewSubjectAdoptionEligible(receipt) ? reviewSubjectKey(receipt) : null },
);

const SCRIPTS = {
  'test:ok': 'node -e "process.exit(0)"',
  lint: 'node -e "process.exit(0)"',
  noop: 'node -e "process.exit(0)"',
};

const setup = async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'krn-rr-home-'));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'krn-rr-proj-'));
  spawnSync('git', ['init'], { cwd: projectRoot, encoding: 'utf8' });
  await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({ name: 'rr-fixture', version: '0.0.1', scripts: SCRIPTS }, null, 2));
  await writeFile(path.join(projectRoot, 'app.mjs'), 'export const v = 0;\n');
  return { runtimeHome, projectRoot };
};

const cleanup = async ({ runtimeHome, projectRoot }: { runtimeHome: string; projectRoot: string }) => {
  await rm(runtimeHome, { recursive: true, force: true });
  await rm(projectRoot, { recursive: true, force: true });
};

const mutate = (projectRoot: string, value: string | number) => writeFile(path.join(projectRoot, 'app.mjs'), `export const v = ${value};\n`);

const routeAndRun = async (cp: TestControlPlane, runId: string, actionKind: string, actorSessionId: string, extra = {}) => {
  const decision = await decideTestModelRoute(cp, runId, { actionKind, obligationId: 'default' });
  const receipt = await cp.recordModelUsage(runId, {
    decisionId: decision.decisionId,
    runId,
    hostSurface: 'claude',
    actorSessionId,
    resolvedModel: 'configured-model',
    enforcementStatus: 'enforced',
    resultStatus: 'completed',
    ...extra,
  });
  return { decision, receipt };
};

// A T3 run that has already produced real hard evidence for its executable
// obligations; only the protected security-review judgment is outstanding.
const provenT3Run = async (fixture: { projectRoot: string; runtimeHome: string }, cp: TestControlPlane, runId = 'r-rr') => {
  await cp.startRun({
    runId,
    objective: 'auth boundary',
    taskContract: {
      surfaces: ['security_boundary'],
      acceptance: [{ acceptance: 'works', evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test:ok'], obligationId: 'unit-test' } }],
    },
  });
  assert.equal(assertTestPresent((await cp.getRun(runId))).proofTier, 'T3');
  await mutate(fixture.projectRoot, 1);
  await routeAndRun(cp, runId, 'implement', assertTestString(IMPLEMENTER));
  const reported = await cp.report(runId, {
    summary: 'implemented',
    changedPaths: ['app.mjs'],
    verifications: [
      { obligationId: 'unit-test', commandRef: 'test:ok', acceptanceCoverage: ['works'] },
      { obligationId: 'static-analysis', commandRef: 'lint' },
    ],
  });
  assert.deepEqual(assertTestRecord(assertTestPresent(reported)).failures, []);
  assert.equal(assertTestPresent((await cp.getRun(runId))).state, 'PROVE');
  return reported;
};

// Writes a receipt row directly, as a compromised or careless caller would, so
// the completion boundary is tested rather than the happy path that built it.
const forgeReceipt = async (fixture: { projectRoot: string; runtimeHome: string }, runId: string, overrides = {}) => {
  const store = await openKernelStateStore({ runtimeHome: fixture.runtimeHome });
  try {
    const run = store.getRun(runId);
    return persistReviewReceipt(store, runId, {
      runId,
      obligationId: 'security-review',
      reviewStage: 'engineering',
      verdict: 'pass',
      rationale: 'forged lineage',
      ...overrides,
      reviewer: {
        actorSessionId: REVIEWER,
        usageReceiptId: 'usage-0123456789abcdef01234567',
        routeDecisionId: 'route-0123456789abcdef01234567',
        modelClass: 'frontier_reasoning',
        resolvedModel: 'configured-model',
        enforcementStatus: 'enforced',
        ...(assertTestRecord(overrides).reviewer || {}),
      },
      implementer: { actorSessionId: IMPLEMENTER, usageReceiptId: null, ...(assertTestRecord(overrides).implementer || {}) },
      subject: {
        workspaceIdentity: assertTestPresent(run).currentWorkspaceIdentity,
        mutationRevision: assertTestPresent(run).mutationRevision,
        changedPathsDigest: digestOfPaths(['app.mjs']),
        evidenceDigest: `sha256:${'b'.repeat(64)}`,
        ...(assertTestRecord(overrides).subject || {}),
      },
    });
  } finally {
    store.close();
  }
};

const submitJudgment = (cp: TestControlPlane, runId: string, reviewReceiptId?: string) => cp.report(runId, {
  summary: 'claiming review',
  implementerId: 'impl-1',
  judgments: [{
    obligationId: 'security-review',
    verdict: 'pass',
    reviewerId: 'reviewer-2',
    rationale: 'reviewed the auth surface',
    reviewReceiptId,
  }],
});

test('K0-1: reviewer and implementer strings alone cannot satisfy a protected judgment', async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  try {
    await provenT3Run(fixture, cp);
    const forged = await submitJudgment(cp, 'r-rr', undefined);
    assert.match(assertTestString(assertTestRecord(assertTestArray(assertTestRecord(assertTestPresent(forged)).failures)[0]).errorSummary), /requires a reviewReceiptId/);

    const completion = await cp.assessCompletion('r-rr');
    const byId = Object.fromEntries(completion.obligationStatuses.map((entry) => [entry.obligationId, entry]));
    assert.equal(byId['security-review'].satisfied, false);
    assert.equal(completion.decision, 'blocked');
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});

test('K0-1b: a receipt id the Kernel never recorded is refused', async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  try {
    await provenT3Run(fixture, cp);
    const invented = await submitJudgment(cp, 'r-rr', `review-receipt-${'a'.repeat(24)}`);
    assert.match(assertTestString(assertTestRecord(assertTestArray(assertTestRecord(assertTestPresent(invented)).failures)[0]).errorSummary), /does not exist for this run/);
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});

test('K0-2: a review performed by the implementing session is refused at T3', async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  try {
    await provenT3Run(fixture, cp);
    // Routed self-review is rejected before a receipt is ever written.
    const selfReview = await routeAndRun(cp, 'r-rr', 'review_engineering', assertTestString(IMPLEMENTER));
    await assert.rejects(
      cp.recordReview('r-rr', { stage: 'engineering', verdict: 'pass', reviewerId: 'reviewer-2' }, { implementerId: 'impl-1', reviewReceiptId: selfReview.receipt.receiptId, obligationId: 'security-review' }),
      /the reviewing session is the implementing session/,
    );

    // A receipt row asserting the same session on both sides is refused again
    // at the point of use.
    const receipt = await forgeReceipt(fixture, 'r-rr', { reviewer: { actorSessionId: IMPLEMENTER } });
    const rejected = await submitJudgment(cp, 'r-rr', receipt.receiptId);
    assert.match(assertTestString(assertTestRecord(assertTestArray(assertTestRecord(assertTestPresent(rejected)).failures)[0]).errorSummary), /review-session-not-independent/);
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});

test('K0-3: a distinct session on the value class cannot carry a T3 review', async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  try {
    await provenT3Run(fixture, cp);
    const receipt = await forgeReceipt(fixture, 'r-rr', { reviewer: { modelClass: 'value_coding' } });
    const rejected = await submitJudgment(cp, 'r-rr', receipt.receiptId);
    assert.match(assertTestString(assertTestRecord(assertTestArray(assertTestRecord(assertTestPresent(rejected)).failures)[0]).errorSummary), /review-model-class-value_coding/);
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});

test('K0-4: a distinct frontier session with an enforced receipt completes the run', async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  try {
    await provenT3Run(fixture, cp);
    const review = await routeAndRun(cp, 'r-rr', 'review_engineering', assertTestString(REVIEWER));
    assert.equal(review.decision.modelClass, 'frontier_reasoning');

    const recorded = await cp.recordReview(
      'r-rr',
      { stage: 'engineering', verdict: 'pass', reviewerId: 'reviewer-2' },
      { implementerId: 'impl-1', reviewReceiptId: review.receipt.receiptId, obligationId: 'security-review', changedPaths: ['app.mjs'], rationale: 'auth surface reviewed' },
    );
    assert.match(recorded.reviewReceipt.receiptId, /^review-receipt-[a-f0-9]{24}$/);
    assert.equal(recorded.reviewReceipt.reviewer.enforcementStatus, 'enforced');
    assert.equal(recorded.reviewReceipt.implementer.actorSessionId, IMPLEMENTER);

    // The judgment verification points at the receipt, not at a free-form ref.
    const store = await openKernelStateStore({ runtimeHome: fixture.runtimeHome });
    try {
      const verification = store.getVerifications('r-rr').find((entry) => entry.obligationId === 'security-review');
      assert.deepEqual(parseReviewEvidenceRef(assertTestPresent(verification).evidenceRef), { runId: 'r-rr', receiptId: recorded.reviewReceipt.receiptId });
      assert.equal(assertTestPresent(verification).evidenceDigest, recorded.reviewReceipt.digest);
    } finally {
      store.close();
    }

    const completion = await cp.assessCompletion('r-rr');
    const byId = Object.fromEntries(completion.obligationStatuses.map((entry) => [entry.obligationId, entry]));
    assert.equal(byId['security-review'].satisfied, true);
    assert.equal(assertTestPresent(byId['security-review'].reviewLineage).usable, true);
    assert.ok(completion.readyExceptClose, JSON.stringify(completion.gates));
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});

test('K0-4b: the report path accepts the recorded receipt and finalizes the run', async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  try {
    await provenT3Run(fixture, cp);
    const review = await routeAndRun(cp, 'r-rr', 'review_engineering', assertTestString(REVIEWER));
    const recorded = await cp.recordReview(
      'r-rr',
      { stage: 'engineering', verdict: 'pass', reviewerId: 'reviewer-2' },
      { implementerId: 'impl-1', reviewReceiptId: review.receipt.receiptId, obligationId: 'security-review' },
    );
    const reported = await submitJudgment(cp, 'r-rr', recorded.reviewReceipt.receiptId);
    assert.deepEqual(assertTestRecord(assertTestPresent(reported)).failures, []);
    assert.equal(optionalTestRecord(assertTestRecord(assertTestPresent(reported)).finalization)?.completionStatus, 'accepted');
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});

test('K0-7: advisory or unsupported routing is never independent-review evidence', async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  try {
    await provenT3Run(fixture, cp);
    for (const enforcementStatus of ['advisory', 'unsupported', 'failed']) {
      const receipt = await forgeReceipt(fixture, 'r-rr', {
        reviewStage: enforcementStatus === 'advisory' ? 'contract' : 'engineering',
        rationale: `routing ${enforcementStatus}`,
        reviewer: { enforcementStatus },
      });
      const rejected = await submitJudgment(cp, 'r-rr', receipt.receiptId);
      assert.match(assertTestString(assertTestRecord(assertTestArray(assertTestRecord(assertTestPresent(rejected)).failures)[0]).errorSummary), new RegExp(`review-routing-${enforcementStatus}`));
    }

    // An unrouted review — one the Host never dispatched — is recorded honestly
    // and can never stand as independent-review evidence.
    await cp.abandonRun('r-rr');
    await cp.startRun({ runId: 'r-t1', objective: 'x', taskContract: { behaviorChanging: true } });
    await cp.transition('r-t1', 'EXECUTE');
    await cp.transition('r-t1', 'PROVE');
    const unrouted = await cp.recordReview(
      'r-t1',
      { stage: 'contract', verdict: 'pass', reviewerId: 'reviewer-2' },
      { implementerId: 'impl-1' },
    );
    assert.equal(unrouted.reviewReceipt.reviewer.enforcementStatus, 'unrouted');
    assert.equal(evaluateReviewReceipt({ receipt: unrouted.reviewReceipt, requireTrustedEnforcement: true }).usable, false);
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});

test('K0-8: a protected judgment obligation cannot be waived', async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  try {
    await provenT3Run(fixture, cp);
    await assert.rejects(
      cp.addWaiver('r-rr', { obligationId: 'security-review', approvedBy: 'operator', reason: 'no time', approvalReceipt: 'approval://1' }),
      /PROTECTED_OBLIGATION_WAIVER_FORBIDDEN/,
    );
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});

test('K0: a review receipt is a closed record and its digest is reproducible', () => {
  const base = {
    runId: 'r-1',
    obligationId: 'security-review',
    reviewStage: 'engineering',
    verdict: 'pass',
    rationale: 'reviewed',
    reviewer: { actorSessionId: REVIEWER, usageReceiptId: 'usage-abc123def456abc123def456', modelClass: 'frontier_reasoning', enforcementStatus: 'enforced' },
    implementer: { actorSessionId: IMPLEMENTER },
    subject: {
      workspaceIdentity: `sha256:${'c'.repeat(64)}`,
      mutationRevision: 2,
      changedPathsDigest: digestOfPaths(['a.mjs']),
      evidenceDigest: `sha256:${'d'.repeat(64)}`,
    },
    createdAt: '2026-07-26T00:00:00.000Z',
  };
  const receipt = normalizeReviewReceipt(base);
  assert.equal(normalizeReviewReceipt(base).digest, receipt.digest, 'the digest is deterministic');
  assert.notEqual(normalizeReviewReceipt({ ...base, rationale: 'other' }).digest, receipt.digest);

  assert.throws(() => normalizeReviewReceipt({ ...base, reviewer: { ...base.reviewer, actorSessionId: 'reviewer-2' } }), /sha256:<hex> digest/);
  assert.throws(() => normalizeReviewReceipt({ ...base, subject: { ...base.subject, workspaceIdentity: 'HEAD' } }), /workspaceIdentity/);
  assert.throws(() => normalizeReviewReceipt({ ...base, rationale: '' }), /rationale/);
  assert.throws(() => normalizeReviewReceipt({ ...base, reviewer: { ...base.reviewer, usageReceiptId: null } }), /routed review receipt requires/);
});

test('S-11: only one Review Receipt is adopted for the same current subject while later race output is not stored', async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  try {
    await cp.startRun({ runId: 'r-review-adoption', objective: 'review adoption', taskContract: { acceptance: [] } });
    const first = await forgeReceipt(fixture, 'r-review-adoption', {
      receiptId: 'review-receipt-aaaaaaaaaaaaaaaaaaaaaaaa',
      verdict: 'pass',
      rationale: 'first reviewer result wins subject adoption',
    });
    const second = await forgeReceipt(fixture, 'r-review-adoption', {
      receiptId: 'review-receipt-bbbbbbbbbbbbbbbbbbbbbbbb',
      verdict: 'fail',
      rationale: 'late racing reviewer result must not replace adopted result',
    });

    assert.equal(second.receiptId, first.receiptId);
    assert.equal(second.verdict, first.verdict);
    const receipts = cp.stateStore.listReviewReceipts('r-review-adoption', { obligationId: 'security-review' });
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].receiptId, first.receiptId);
    assert.equal(receipts[0].verdict, 'pass');
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});

type TestControlPlane = Awaited<ReturnType<typeof import('../src/host/kernel/control-plane-runtime.js').createKernelControlPlane>>;
type TestStateStore = Awaited<ReturnType<typeof import('../src/kernel/state-store.js').openKernelStateStore>>;
