import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createKernelControlPlane } from '../src/host/kernel/control-plane-runtime.js';

const setup = async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'krn-reconcil-home-'));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'krn-reconcil-proj-'));
  spawnSync('git', ['init'], { cwd: projectRoot, encoding: 'utf8' });
  spawnSync('git', ['config', 'user.name', 'Kernel Test'], { cwd: projectRoot, encoding: 'utf8' });
  spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: projectRoot, encoding: 'utf8' });
  await mkdir(path.join(projectRoot, '.moon-relay'), { recursive: true });
  await writeFile(path.join(projectRoot, '.moon-relay', 'track.yaml'), 'track: kernel\nproduct: moon-relay-kernel\n');
  await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({
    name: 'final-reconciliation-test',
    version: '0.0.1',
    scripts: { test: 'node -e "process.exit(0)"' },
  }));
  await writeFile(path.join(projectRoot, 'initial.mjs'), 'export const initial = true;\n');
  spawnSync('git', ['add', '.'], { cwd: projectRoot, encoding: 'utf8' });
  spawnSync('git', ['commit', '-m', 'Initial commit'], { cwd: projectRoot, encoding: 'utf8' });
  return { runtimeHome, projectRoot };
};

const cleanup = async ({ runtimeHome, projectRoot }: Awaited<ReturnType<typeof setup>>) => {
  await rm(runtimeHome, { recursive: true, force: true });
  await rm(projectRoot, { recursive: true, force: true });
};

test('Final Reconciliation: Turn 0 execution-first contract without allowedPaths binds git diff at PROVE/report', async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane(fixture);
  try {
    const runId = 'r-reconciliation-1';
    // Turn 0: Task contract starts without allowedPaths (fail-soft)
    const run = await cp.startRun({
      runId,
      objective: 'implement feature and reconcile git diff at report',
      taskContract: {
        riskTier: 'T0',
        acceptance: [{
          acceptance: 'unit test passes',
          evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test'], obligationId: 'default' },
        }],
      },
    });

    assert.equal(run.state, 'FRAME');
    const firstTurn = await cp.next(runId);
    assert.ok('action' in firstTurn && firstTurn.action);
    assert.equal(firstTurn.action.type, 'implement', 'Must proceed immediately to implementation without preflight blocking');

    await cp.transition(runId, 'EXECUTE');

    // Make an actual code change during execution
    await writeFile(path.join(fixture.projectRoot, 'initial.mjs'), 'export const initial = "reconciled";\n');

    // Report implementation change: Kernel observes git diff, runs proofs, reconciles paths, and completes closeout
    const reportResult = await cp.report(runId, {
      summary: 'reconciled initial.mjs change',
      changedPaths: ['initial.mjs'],
      gitCloseoutRequest: {
        requested: true,
        mode: 'soft',
        approvalReceipt: 'approval-reconciliation-test',
      },
      knowledgeObservations: [{
        proposedType: 'semantic_fact',
        statement: 'Reconciled actual modified file.',
        scope: ['initial.mjs'],
      }],
    });

    assert.ok(reportResult && 'finalization' in reportResult && 'failures' in reportResult);
    assert.equal(reportResult.status, 'completed', `Report status should be completed: ${JSON.stringify(reportResult.failures)}`);
    assert.ok(reportResult.finalization, 'Finalization receipt should exist');
    assert.ok(typeof reportResult.finalization === 'object' && 'completionStatus' in reportResult.finalization && 'gitCloseoutStatus' in reportResult.finalization && 'gitCloseoutReceipt' in reportResult.finalization);
    assert.equal(reportResult.finalization.completionStatus, 'accepted', 'Completion must be accepted');
    assert.equal(reportResult.finalization.gitCloseoutStatus, 'completed', 'Git closeout must be completed');
    assert.ok((typeof reportResult.finalization.gitCloseoutReceipt === 'object' && reportResult.finalization.gitCloseoutReceipt && 'commitSha' in reportResult.finalization.gitCloseoutReceipt && reportResult.finalization.gitCloseoutReceipt.commitSha), 'Must have a valid commitSha');

    // Confirm that the git commit reflects the reconciled change
    const diffCheck = spawnSync('git', ['diff', 'HEAD~1', 'HEAD', '--name-only'], {
      cwd: fixture.projectRoot,
      encoding: 'utf8',
    });
    assert.equal(diffCheck.status, 0);
    assert.match(diffCheck.stdout, /initial\.mjs/);
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});
