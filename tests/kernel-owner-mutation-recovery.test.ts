import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { runGit } from '../src/shared/git-safe.js';
import { createKernelControlPlane } from '../src/host/kernel/control-plane-runtime.js';

const fixture = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kernel-owner-mutation-'));
  const projectRoot = path.join(root, 'repo');
  const runtimeHome = path.join(root, 'runtime');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(projectRoot);
  runGit(projectRoot, ['init', '-b', 'main']);
  runGit(projectRoot, ['config', 'user.name', 'Owner Receipt Test']);
  runGit(projectRoot, ['config', 'user.email', 'owner@example.invalid']);
  await writeFile(path.join(projectRoot, 'owner.txt'), 'base\n');
  await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({ scripts: { test: 'node -p 1' } }));
  runGit(projectRoot, ['add', '--all']);
  runGit(projectRoot, ['commit', '-m', 'fixture']);
  const cp = await createKernelControlPlane({ runtimeHome, projectRoot });
  const runId = 'owner-continuity';
  await cp.startRun({ runId, objective: 'two owner edits', taskContract: {
    complex: true, acceptance: ['owner edits preserve continuity'], steps: [
      { stepId: 'first', objective: 'first', allowedPaths: ['owner.txt'], acceptanceIds: ['AC-1'] },
      { stepId: 'second', objective: 'second', allowedPaths: ['owner.txt'], acceptanceIds: ['AC-1'] },
    ],
  } });
  await writeFile(path.join(projectRoot, 'owner.txt'), 'first\n');
  const report = await cp.report(runId, { stepId: 'first', summary: 'first owner edit', changedPaths: ['owner.txt'] });
  assert.ok(report && 'step' in report && report.step);
  assert.equal(report.step.state, 'passed');
  return { root, projectRoot, runtimeHome, cp, runId, report };
};

test('settled owner report links provenance and permits the next edit after restart', async () => {
  const f = await fixture();
  let cp: Awaited<ReturnType<typeof createKernelControlPlane>> | null = f.cp;
  try {
    const attempt = cp.stateStore.getStepAttempts(f.runId).at(-1);
    assert.ok(attempt);
    assert.equal(cp.stateStore.getMutationProvenance(f.runId)?.attemptId, attempt.attemptId);
    await cp.close();
    cp = await createKernelControlPlane({ runtimeHome: f.runtimeHome, projectRoot: f.projectRoot });
    await writeFile(path.join(f.projectRoot, 'owner.txt'), 'second\n');
    const next = await cp.next(f.runId);
    assert.ok('action' in next && next.action && 'stepId' in next);
    assert.notEqual(next.action.type, 'blocked');
    assert.equal(next.stepId, 'second');
    const report = await cp.report(f.runId, { stepId: 'second', summary: 'second owner edit', changedPaths: ['owner.txt'] });
    assert.ok(report && 'step' in report && report.step);
  assert.equal(report.step.state, 'passed');
  } finally { await cp.close(); await rm(f.root, { recursive: true, force: true }); }
});

for (const mismatch of [null, 'paths', 'revision', 'routed', 'foreign-binding', 'ambiguous', 'unsettled']) {
  test(`historical owner provenance repair ${mismatch ? `rejects ${mismatch}` : 'uses the existing canonical receipt'}`, async () => {
    const f = await fixture();
    let cp: Awaited<ReturnType<typeof createKernelControlPlane>> | null = f.cp;
    try {
      const attempt = cp.stateStore.getStepAttempts(f.runId).at(-1);
      assert.ok(attempt);
      await cp.close();
      cp = null;
      const db = new DatabaseSync(path.join(f.runtimeHome, 'state', 'runtime-state.sqlite'));
      // Simulate the pre-fix persisted row, then corrupt one authority input.
      db.prepare('UPDATE mutation_provenance SET attempt_id=NULL WHERE run_id=?').run(f.runId);
      if (mismatch === 'paths') db.prepare('UPDATE run_step_attempts SET changed_paths_json=? WHERE id=?').run('["foreign.txt"]', attempt.id);
      if (mismatch === 'revision') db.prepare('UPDATE run_step_attempts SET mutation_revision=mutation_revision-1 WHERE id=?').run(attempt.id);
      if (mismatch === 'routed') db.prepare('UPDATE run_step_attempts SET provenance_kind=? WHERE id=?').run('routed', attempt.id);
      if (mismatch === 'foreign-binding') {
        db.prepare('UPDATE runs SET owner_binding_id=? WHERE run_id=?').run('owner-binding', f.runId);
        db.prepare('UPDATE run_step_attempts SET binding_id=? WHERE id=?').run('foreign-binding', attempt.id);
      }
      if (mismatch === 'unsettled') db.prepare('UPDATE run_step_attempts SET report_result_json=NULL WHERE id=?').run(attempt.id);
      if (mismatch === 'ambiguous') {
        const columns = db.prepare('PRAGMA table_info(run_step_attempts)').all().map((row) => row.name).filter((name) => name !== 'id');
        const expressions = columns.map((name) => name === 'attempt_id' ? "'other-attempt'" : name === 'report_key' ? "'other-report'" : name === 'attempt_number' ? 'attempt_number+1' : name);
        db.prepare(`INSERT INTO run_step_attempts(${columns.join(',')}) SELECT ${expressions.join(',')} FROM run_step_attempts WHERE id=?`).run(attempt.id);
        assert.ok(attempt.reportResult && typeof attempt.reportResult === 'object' && !Array.isArray(attempt.reportResult));
        db.prepare('UPDATE run_step_attempts SET report_result_json=? WHERE attempt_id=?').run(JSON.stringify({ ...attempt.reportResult, reportKey: 'other-report' }), 'other-attempt');
      }
      db.close();
      cp = await createKernelControlPlane({ runtimeHome: f.runtimeHome, projectRoot: f.projectRoot });
      await writeFile(path.join(f.projectRoot, 'owner.txt'), 'second\n');
      const recovery = await cp.recoverPendingDeliveryMaterialization(f.runId);
      if (mismatch) {
        assert.equal(recovery.status, 'blocked');
        assert.equal(cp.stateStore.getMutationProvenance(f.runId)?.attemptId, null);
      } else {
        assert.equal(recovery.status, 'none');
        assert.equal(cp.stateStore.getMutationProvenance(f.runId)?.attemptId, attempt.attemptId);
        assert.equal(cp.stateStore.getStepAttempts(f.runId).length, 1);
      }
    } finally { await cp?.close(); await rm(f.root, { recursive: true, force: true }); }
  });
}
