import { decideTestModelRoute } from './helpers/kernel-host-test-api.mjs';
// K4 §9: the new tables are added, never swapped in. A run that started before
// the ledger, the capsule, and the admission existed keeps working: it gets a
// recovery cursor at its current state, and its old receipts stay readable.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createKernelControlPlane } from '../scripts/kernel/control-plane.mjs';
import { openKernelStateStore } from '../scripts/kernel/state-store.mjs';
import { hashSessionId } from '../scripts/kernel/run/model-route-contract.mjs';

const setup = async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'krn-mig-home-'));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'krn-mig-proj-'));
  spawnSync('git', ['init'], { cwd: projectRoot, encoding: 'utf8' });
  await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({
    name: 'mig-fixture', version: '0.0.1', scripts: { 'test:ok': 'node -e "process.exit(0)"' },
  }, null, 2));
  await writeFile(path.join(projectRoot, 'app.mjs'), 'export const v = 0;\n');
  return { runtimeHome, projectRoot };
};

const cleanup = async ({ runtimeHome, projectRoot }) => {
  await rm(runtimeHome, { recursive: true, force: true });
  await rm(projectRoot, { recursive: true, force: true });
};

test('K4: a cancelled plan leaves no cursor rather than inventing one', async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  try {
    await cp.startRun({ runId: 'r-legacy', objective: 'Fix it', taskContract: { acceptance: ['works'] } });

    // Remove the ledger the way a pre-K2 database would simply not have it.
    const store = await openKernelStateStore({ runtimeHome: fixture.runtimeHome });
    try {
      store.getRunSteps('r-legacy').forEach((step) => store.updateRunStep('r-legacy', step.stepId, { state: 'cancelled' }));
    } finally {
      store.close();
    }
    // A cancelled plan is not a missing one; the cursor simply has nothing to do.
    assert.equal(cp.getCurrentStep('r-legacy'), null);
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});

test('K4: an in-flight legacy run resumes at its current state with a migration-marked step', async () => {
  const fixture = await setup();
  // Build a run, then delete its steps directly to emulate a pre-K2 row set.
  const cp = await createKernelControlPlane(fixture);
  let dbPath;
  try {
    await cp.startRun({
      runId: 'r-inflight',
      objective: 'Fix it',
      taskContract: {
        acceptance: [{ acceptance: 'works', evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test:ok'], obligationId: 'default' } }],
      },
    });
    dbPath = (await openKernelStateStore({ runtimeHome: fixture.runtimeHome })).dbPath;
  } finally {
    await cp.close();
  }

  const { default: Database } = await import('better-sqlite3');
  const raw = new Database(dbPath);
  raw.prepare('DELETE FROM run_steps WHERE run_id=?').run('r-inflight');
  raw.close();

  const resumed = await createKernelControlPlane(fixture);
  try {
    const current = resumed.getCurrentStep('r-inflight');
    assert.ok(current, 'a legacy run is given a cursor rather than left without one');
    assert.equal(current.synthetic, true);
    assert.equal(current.migrationOrigin, 'legacy-run');
    assert.equal(current.objective, 'Fix it');

    // And it completes through the ordinary loop.
    await writeFile(path.join(fixture.projectRoot, 'app.mjs'), 'export const v = 1;\n');
    const reported = await resumed.report('r-inflight', {
      summary: 'fix',
      changedPaths: ['app.mjs'],
      verifications: [{ obligationId: 'default', commandRef: 'test:ok', acceptanceCoverage: ['works'] }],
    });
    assert.equal(reported.status, 'completed');
    assert.equal(reported.step.state, 'passed');
  } finally {
    await resumed.close();
    await cleanup(fixture);
  }
});

test('K4: a usage receipt written before capsules and admissions existed stays valid', async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  try {
    await cp.startRun({ runId: 'r-oldreceipt', objective: 'x', taskContract: { acceptance: ['works'] } });
    const decision = await decideTestModelRoute(cp, 'r-oldreceipt', { actionKind: 'implement', obligationId: 'default' });
    // No capsuleId, no admissionId: exactly what a pre-K1/K3 Host filed.
    const receipt = await cp.recordModelUsage('r-oldreceipt', {
      decisionId: decision.decisionId,
      runId: 'r-oldreceipt',
      hostSurface: 'claude',
      actorSessionId: hashSessionId('legacy-session'),
      resolvedModel: 'configured-model',
      enforcementStatus: 'enforced',
      resultStatus: 'completed',
    });
    assert.equal(receipt.capsuleId, null);
    assert.equal(receipt.admissionId, null);
    assert.equal(receipt.stepId, null);

    const store = await openKernelStateStore({ runtimeHome: fixture.runtimeHome });
    try {
      const [stored] = store.listModelUsageReceipts('r-oldreceipt');
      assert.equal(stored.receiptId, receipt.receiptId);
      assert.equal(stored.capsuleDigest, null, 'a legacy turn is never claimed to have had a capsule');
    } finally {
      store.close();
    }

    // Routing measurement still counts it.
    assert.equal(cp.modelRoutingSummary('r-oldreceipt').enforcedTurns, 1);
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});

test('K4: opening an existing database twice adds the new tables without touching run data', async () => {
  const fixture = await setup();
  const first = await createKernelControlPlane(fixture);
  try {
    await first.startRun({ runId: 'r-schema', objective: 'x', taskContract: { acceptance: ['works'] } });
  } finally {
    await first.close();
  }

  const store = await openKernelStateStore({ runtimeHome: fixture.runtimeHome });
  try {
    const run = store.getRun('r-schema');
    assert.equal(run.objective, 'x');
    assert.equal(run.planRevision, 1);
    // Every K0-K3 table is present and empty for this run rather than absent.
    assert.deepEqual(store.listReviewReceipts('r-schema'), []);
    assert.deepEqual(store.listRouteAdmissions('r-schema'), []);
    assert.deepEqual(store.listExecutionCapsules('r-schema'), []);
    assert.equal(store.getRunSteps('r-schema').length, 1);
  } finally {
    store.close();
    await cleanup(fixture);
  }
});
