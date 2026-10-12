import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { buildImpactAnalysis, MIGRATION_SMOKE_OBLIGATION } from '../src/kernel/task/migration-workflow.js';
import { isProtectedObligation } from '../src/kernel/proof/protected-obligations.js';
import { createKernelControlPlane } from '../src/host/kernel/control-plane-runtime.js';

test('impact analysis requires a change seam', () => {
  const result = buildImpactAnalysis({});
  assert.ok(result.blockingFindings.some((f) => f.code === 'MISSING_CHANGE_SEAM'));
});

test('a required migration must declare rollback and a verification seam', () => {
  const missing = buildImpactAnalysis({ changeSeam: 'users table', migrationRequired: true });
  assert.ok(missing.blockingFindings.some((f) => f.code === 'MISSING_ROLLBACK'));
  assert.ok(missing.blockingFindings.some((f) => f.code === 'MISSING_VERIFICATION_SEAM'));

  const complete = buildImpactAnalysis({
    changeSeam: 'users table',
    migrationRequired: true,
    rollback: ['down migration 0007'],
    verificationSeams: ['migrate up then query'],
  });
  assert.equal(complete.blockingFindings.length, 0);
  assert.equal(complete.requiredTier, 'T3');
  assert.deepEqual(complete.requiredObligations, [MIGRATION_SMOKE_OBLIGATION]);
});

test('the migration smoke obligation is protected and cannot be waived', () => {
  assert.equal(isProtectedObligation(MIGRATION_SMOKE_OBLIGATION), true);
});

test('analyzeMigration escalates a required migration to T3 with the protected obligation', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'krn-mig-home-'));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'krn-mig-proj-'));
  spawnSync('git', ['init'], { cwd: projectRoot, encoding: 'utf8' });
  await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'node -e "process.exit(0)"', lint: 'node -e "process.exit(0)"' } }));
  const cp = await createKernelControlPlane({ runtimeHome, projectRoot });
  try {
    await cp.startRun({ runId: 'r-mig', objective: 'migrate users' });
    const res = await cp.analyzeMigration('r-mig', {
      changeSeam: 'users.email uniqueness',
      migrationRequired: true,
      rollback: ['revert unique index'],
      verificationSeams: ['apply then assert constraint'],
    });
    assert.equal(res.status, 'ready');
    assert.ok('run' in res);
    assert.equal(res.run.proofTier, 'T3');
    assert.ok(res.run.requiredObligations.includes(MIGRATION_SMOKE_OBLIGATION));

    // A waiver on the migration obligation is refused.
    await cp.transition('r-mig', 'EXECUTE');
    await cp.transition('r-mig', 'PROVE');
    await assert.rejects(
      cp.addWaiver('r-mig', { obligationId: MIGRATION_SMOKE_OBLIGATION, approvedBy: 'x', reason: 'skip', approvalReceipt: 'r://1' }),
      /PROTECTED_OBLIGATION_WAIVER_FORBIDDEN/,
    );
  } finally {
    await cp.close();
    await rm(runtimeHome, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('analyzeMigration blocks when a required migration lacks a rollback', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'krn-mig-block-home-'));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'krn-mig-block-proj-'));
  spawnSync('git', ['init'], { cwd: projectRoot, encoding: 'utf8' });
  await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'node -e "process.exit(0)"', lint: 'node -e "process.exit(0)"' } }));
  const cp = await createKernelControlPlane({ runtimeHome, projectRoot });
  try {
    await cp.startRun({ runId: 'r-mig-block', objective: 'risky migration' });
    const res = await cp.analyzeMigration('r-mig-block', { changeSeam: 'drop column', migrationRequired: true });
    assert.equal(res.status, 'blocked');
    const run = await cp.getRun('r-mig-block');
    assert.ok(run);
    assert.equal(run.status, 'blocked');
  } finally {
    await cp.close();
    await rm(runtimeHome, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  }
});
