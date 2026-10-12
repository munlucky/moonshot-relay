// K0 completion authority: the gate re-derives the review lineage itself. A
// judgment verification that does not point at a live, matching Review Receipt
// cannot satisfy a protected or T3 obligation, however it got recorded.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createKernelControlPlane } from '../src/host/kernel/control-plane-runtime.js';
import { openKernelStateStore } from '../src/kernel/state-store.js';
import { hashSessionId } from '../src/contracts/model-execution.js';
import { digestOfPaths, reviewEvidenceRef } from '../src/kernel/proof/review-receipt.js';

const IMPLEMENTER = hashSessionId('completion-implementer');
const REVIEWER = hashSessionId('completion-reviewer');

const setup = async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'krn-rrc-home-'));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'krn-rrc-proj-'));
  spawnSync('git', ['init'], { cwd: projectRoot, encoding: 'utf8' });
  await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({
    name: 'rrc-fixture',
    version: '0.0.1',
    scripts: { 'test:ok': 'node -e "process.exit(0)"', lint: 'node -e "process.exit(0)"' },
  }, null, 2));
  await writeFile(path.join(projectRoot, 'app.mjs'), 'export const v = 0;\n');
  return { runtimeHome, projectRoot };
};

const cleanup = async ({ runtimeHome, projectRoot }: { runtimeHome: string; projectRoot: string }) => {
  await rm(runtimeHome, { recursive: true, force: true });
  await rm(projectRoot, { recursive: true, force: true });
};

const mutate = (projectRoot: string, value: number) => writeFile(path.join(projectRoot, 'app.mjs'), `export const v = ${value};\n`);

const provenT3Run = async (fixture: Awaited<ReturnType<typeof setup>>, cp: KernelControlPlane, runId: string) => {
  await cp.startRun({
    runId,
    objective: 'auth boundary',
    taskContract: {
      surfaces: ['security_boundary'],
      acceptance: [{ acceptance: 'works', evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test:ok'], obligationId: 'unit-test' } }],
    },
  });  await mutate(fixture.projectRoot, 1);
  await cp.report(runId, {
    summary: 'implemented',
    changedPaths: ['app.mjs'],
    verifications: [
      { obligationId: 'unit-test', commandRef: 'test:ok', acceptanceCoverage: ['works'] },
      { obligationId: 'static-analysis', commandRef: 'lint' },
    ],
  });
};

const statusFor = async (cp: KernelControlPlane, runId: string, obligationId: string) => {
  const completion = await cp.assessCompletion(runId);
  return {
    completion,
    entry: completion.obligationStatuses.find((item) => item.obligationId === obligationId),
  };
};

test('K0: a judgment recorded outside the review pipeline cannot satisfy a protected obligation', async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  try {
    await provenT3Run(fixture, cp, 'r-direct');
    // The bypass the K0 boundary closes: record the judgment proof directly,
    // with a plausible-looking ref that no receipt backs.
    await cp.recordProof('r-direct', {
      obligationId: 'security-review',
      status: 'passed',
      evidenceRef: 'judgment://r-direct/security-review',
      command: 'structured-judgment',
      exitCode: 0,
      evidenceDigest: `sha256:${'f'.repeat(64)}`,
      evidenceClass: 'judgment',
    });

    const { completion, entry } = await statusFor(cp, 'r-direct', 'security-review');
    assert.ok(entry && typeof entry === 'object' && 'observedEvidenceClass' in entry);
    assert.equal(entry.observedEvidenceClass, 'judgment');
    assert.ok(entry && typeof entry === 'object' && 'satisfied' in entry);
    assert.equal(entry.satisfied, false);
    assert.ok(entry && typeof entry === 'object' && 'reviewLineage' in entry);
    assert.ok(entry.reviewLineage !== null && entry.reviewLineage !== undefined);
    assert.deepEqual(entry.reviewLineage.reasons, ['review-receipt-not-referenced']);
    assert.equal(completion.decision, 'blocked');
    assert.equal(completion.readyExceptClose, false);
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});

test('K0: a judgment whose digest does not match its receipt is refused', async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  try {
    await provenT3Run(fixture, cp, 'r-digest');
    const store = await openKernelStateStore({ runtimeHome: fixture.runtimeHome });
    let receipt;
    try {
      const run = store.getRun('r-digest');
      assert.ok(run && typeof run === 'object' && 'currentWorkspaceIdentity' in run);
      assert.ok(run && typeof run === 'object' && 'mutationRevision' in run);
      receipt = store.recordReviewReceipt('r-digest', {
        runId: 'r-digest',
        obligationId: 'security-review',
        reviewStage: 'engineering',
        verdict: 'pass',
        rationale: 'reviewed',
        reviewer: {
          actorSessionId: REVIEWER,
          usageReceiptId: 'usage-0123456789abcdef01234567',
          routeDecisionId: 'route-0123456789abcdef01234567',
          modelClass: 'frontier_reasoning',
          enforcementStatus: 'enforced',
        },
        implementer: { actorSessionId: IMPLEMENTER },
        subject: {
          workspaceIdentity: run.currentWorkspaceIdentity,
          mutationRevision: run.mutationRevision,
          changedPathsDigest: digestOfPaths(['app.mjs']),
          evidenceDigest: `sha256:${'b'.repeat(64)}`,
        },
      });
    } finally {
      store.close();
    }

    // Right ref, wrong digest: the verification does not describe this receipt.
    await cp.recordProof('r-digest', {
      obligationId: 'security-review',
      status: 'passed',
      evidenceRef: reviewEvidenceRef('r-digest', receipt.receiptId),
      command: 'structured-judgment',
      exitCode: 0,
      evidenceDigest: `sha256:${'0'.repeat(63)}1`,
      evidenceClass: 'judgment',
    });

    const { entry } = await statusFor(cp, 'r-digest', 'security-review');
    assert.ok(entry && typeof entry === 'object' && 'satisfied' in entry);
    assert.equal(entry.satisfied, false);
    assert.ok(entry && typeof entry === 'object' && 'reviewLineage' in entry);
    assert.ok(entry.reviewLineage !== null && entry.reviewLineage !== undefined);
    assert.ok(entry.reviewLineage.reasons.includes('review-receipt-digest-mismatch'), JSON.stringify(entry.reviewLineage.reasons));
    // The hand-forged receipt also claims an evidence set the run never had.
    assert.ok(entry && typeof entry === 'object' && 'reviewLineage' in entry);
    assert.ok(entry.reviewLineage !== null && entry.reviewLineage !== undefined);
    assert.ok(entry.reviewLineage.reasons.includes('review-stale-evidence-set'));
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});

test('K0: a receipt for a different obligation cannot be re-pointed at a protected one', async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  try {
    await provenT3Run(fixture, cp, 'r-swap');
    const store = await openKernelStateStore({ runtimeHome: fixture.runtimeHome });
    let receipt;
    try {
      const run = store.getRun('r-swap');
      assert.ok(run && typeof run === 'object' && 'currentWorkspaceIdentity' in run);
      assert.ok(run && typeof run === 'object' && 'mutationRevision' in run);
      receipt = store.recordReviewReceipt('r-swap', {
        runId: 'r-swap',
        obligationId: 'review-contract',
        reviewStage: 'contract',
        verdict: 'pass',
        rationale: 'contract review only',
        reviewer: {
          actorSessionId: REVIEWER,
          usageReceiptId: 'usage-0123456789abcdef01234567',
          modelClass: 'frontier_reasoning',
          enforcementStatus: 'enforced',
        },
        implementer: { actorSessionId: IMPLEMENTER },
        subject: {
          workspaceIdentity: run.currentWorkspaceIdentity,
          mutationRevision: run.mutationRevision,
          changedPathsDigest: digestOfPaths(['app.mjs']),
          evidenceDigest: `sha256:${'b'.repeat(64)}`,
        },
      });
    } finally {
      store.close();
    }

    const reported = await cp.report('r-swap', {
      summary: 'reusing an unrelated review',
      implementerId: 'impl-1',
      judgments: [{ obligationId: 'security-review', verdict: 'pass', reviewerId: 'reviewer-2', rationale: 'see contract review', reviewReceiptId: receipt.receiptId }],
    });
    assert.ok(reported && typeof reported === 'object' && 'failures' in reported);
    assert.ok(reported.failures !== null && reported.failures !== undefined);
    assert.ok(typeof reported.failures[0].errorSummary === 'string');
    assert.match(reported.failures[0].errorSummary, /reviewed "review-contract" and cannot satisfy "security-review"/);

    // And if the verification were written anyway, the gate still refuses it.
    await cp.recordProof('r-swap', {
      obligationId: 'security-review',
      status: 'passed',
      evidenceRef: reviewEvidenceRef('r-swap', receipt.receiptId),
      command: 'structured-judgment',
      exitCode: 0,
      evidenceDigest: receipt.digest,
      evidenceClass: 'judgment',
    });
    const { entry } = await statusFor(cp, 'r-swap', 'security-review');
    assert.ok(entry && typeof entry === 'object' && 'satisfied' in entry);
    assert.equal(entry.satisfied, false);
    assert.ok(entry && typeof entry === 'object' && 'reviewLineage' in entry);
    assert.ok(entry.reviewLineage !== null && entry.reviewLineage !== undefined);
    assert.ok(entry.reviewLineage.reasons.includes('review-receipt-obligation-mismatch'));
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});

test('K0: an unprotected judgment obligation below T3 still accepts a direct verdict', async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  try {
    await cp.startRun({
      runId: 'r-t1-judgment',
      objective: 'x',
      taskContract: {
        behaviorChanging: true,
        acceptance: [{ acceptance: 'copy reads clearly', evidencePlan: { class: 'judgment' } }],
      },
    });
    const run = await cp.getRun('r-t1-judgment');
    assert.ok(run && typeof run === 'object' && 'proofTier' in run);
    assert.equal(run.proofTier, 'T1');
    assert.ok(run && typeof run === 'object' && 'requiredObligations' in run);
    const judgmentObligation = run.requiredObligations.find((id) => id.startsWith('judgment-'));
    assert.ok(judgmentObligation, 'a judgment evidence plan compiles into its own obligation');    await mutate(fixture.projectRoot, 1);
    const reported = await cp.report('r-t1-judgment', {
      summary: 'implemented',
      verifications: [{ obligationId: 'unit-test', commandRef: 'test:ok' }],
      judgments: [{ obligationId: judgmentObligation, verdict: 'pass', reason: 'reads clearly', acceptanceCoverage: ['AC-1'] }],
    });
    assert.ok(reported && typeof reported === 'object' && 'failures' in reported);
    assert.ok(reported.failures !== null && reported.failures !== undefined);
    assert.deepEqual(reported.failures, []);
    const { entry } = await statusFor(cp, 'r-t1-judgment', judgmentObligation);
    assert.ok(entry && typeof entry === 'object' && 'satisfied' in entry);
    assert.equal(entry.satisfied, true, 'a low-risk, unprotected judgment does not need a routed reviewer');
    assert.ok(entry && typeof entry === 'object' && 'reviewLineage' in entry);
    assert.ok(entry.reviewLineage !== null && entry.reviewLineage !== undefined);
    assert.equal(entry.reviewLineage.required, false);
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});

type KernelControlPlane = Awaited<ReturnType<typeof createKernelControlPlane>>;
