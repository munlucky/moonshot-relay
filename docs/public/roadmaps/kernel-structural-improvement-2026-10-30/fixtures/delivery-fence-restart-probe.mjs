// W0-only diagnostic fixture. Never use an account runtime or a production repository.
// Run: node docs/public/roadmaps/kernel-structural-improvement-2026-10-30/fixtures/delivery-fence-restart-probe.mjs c06|c08
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createKernelControlPlane } from '../../../../../scripts/host/kernel/control-plane-runtime.js';
import { dispatchKernelParallel } from '../../../../../scripts/host/kernel/parallel-dispatcher.js';
import { runGit } from '../../../../../scripts/lib/git-safe.js';
import { cleanupExecutionWorkspaces } from '../../../../../scripts/host/kernel/workspace/physical-worktree.js';

const scenario = process.argv[2];
if (!['c06', 'c08'].includes(scenario)) throw new Error('Select c06 or c08');
const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'w0-delivery-project-'));
const runtimeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'w0-delivery-runtime-'));
const runId = `run-w0-${scenario}-fixture`;
const capabilities = {
  surface: 'codex', supportsConcurrentSessions: true,
  supportsIsolatedWorkingDirectory: true, supportsPerSessionEnvironment: true,
};
let controlPlane;
let projectId;
try {
  runGit(projectRoot, ['init', '-b', 'main']);
  runGit(projectRoot, ['config', 'user.name', 'Kernel W0 Fixture']);
  runGit(projectRoot, ['config', 'user.email', 'w0-fixture@example.invalid']);
  await fs.mkdir(path.join(projectRoot, 'src'), { recursive: true });
  await fs.writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({
    name: 'w0-fencing-fixture', scripts: { 'test:ok': 'node --version' },
  }));
  await fs.writeFile(path.join(projectRoot, 'src/base.txt'), 'base\n');
  runGit(projectRoot, ['add', '--all']);
  runGit(projectRoot, ['commit', '-m', 'W0 isolated fixture']);

  const acceptance = ['alpha', 'beta'].map(name => ({
    id: `AC-${name.toUpperCase()}`,
    acceptance: `${name} result exists`,
    evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test:ok'], obligationId: `${name}-proof` },
  }));
  const taskContract = {
    riskTier: 'T1', acceptance,
    requiredObligations: ['alpha-proof', 'beta-proof'],
    requiredVerifications: ['alpha', 'beta'].map(name => ({ obligationId: `${name}-proof`, commandRefs: ['test:ok'] })),
    steps: ['alpha', 'beta'].map(name => ({
      objective: `materialize ${name}`, allowedPaths: [`src/${name}/**`],
      acceptanceIds: [`AC-${name.toUpperCase()}`], obligationIds: [`${name}-proof`], dependsOn: [],
    })),
  };
  controlPlane = await createKernelControlPlane({ runtimeHome, projectRoot });
  projectId = (await controlPlane.startRun({ runId, objective: 'W0 Delivery fault isolation', taskContract })).projectId;
  let faultCount = 0;
  if (scenario === 'c06') {
    const originalRenew = controlPlane.renewOwnerWorkspaceMutationFence.bind(controlPlane);
    controlPlane.renewOwnerWorkspaceMutationFence = async (...args) => {
      faultCount++;
      const db = new DatabaseSync(path.join(runtimeHome, 'state/runtime-state.sqlite'));
      try {
        const result = db.prepare('UPDATE workspace_mutation_locks_v2 SET expires_at=? WHERE holder_run_id=?')
          .run('2000-01-01T00:00:00.000Z', runId);
        assert.equal(result.changes, 1, 'exactly one isolated owner lease must expire');
      } finally { db.close(); }
      return originalRenew(...args);
    };
  } else {
    controlPlane.recordOwnerWorkspaceMutation = async () => {
      faultCount++;
      throw Object.assign(new Error('simulated owner CAS persistence failure after patch'), { code: 'SIMULATED_SQLITE_FAILURE' });
    };
    controlPlane.blockDeliveryMaterialization = async () => {
      faultCount++;
      throw Object.assign(new Error('simulated durable block persistence failure'), { code: 'SIMULATED_SQLITE_FAILURE' });
    };
  }

  let dispatchStatus;
  try {
    const result = await dispatchKernelParallel({
      controlPlane, runId, adapter: { capabilities }, projectRoot, runtimeHome,
      parentSessionId: 'w0-parent', actionContext: { integrationVerification: { commandRef: 'test:ok' } },
      dispatchStep: async ({ step, workspace }) => {
        const name = step.objective.endsWith('alpha') ? 'alpha' : 'beta';
        const rel = `src/${name}/result.txt`;
        await fs.mkdir(path.dirname(path.join(workspace.workspaceRoot, rel)), { recursive: true });
        await fs.writeFile(path.join(workspace.workspaceRoot, rel), `${name}\n`);
        return {
          status: 'passed', resultStatus: 'passed',
          report: {
            summary: `${name} complete`, changedPaths: [rel],
            verifications: [{ obligationId: `${name}-proof`, commandRef: 'test:ok', acceptanceCoverage: [`AC-${name.toUpperCase()}`] }],
          },
        };
      },
      executeIntegrationVerification: async () => ({ status: 'passed', passed: true, evidenceRef: 'evidence://w0-fixture' }),
    });
    dispatchStatus = result?.status;
  } catch (error) {
    dispatchStatus = `threw:${error?.code || 'unknown'}`;
  }
  const bytes = {};
  for (const name of ['alpha', 'beta']) {
    try { bytes[name] = await fs.readFile(path.join(projectRoot, 'src', name, 'result.txt'), 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') bytes[name] = null; else throw error; }
  }
  const gitStatus = String(runGit(projectRoot, ['status', '--porcelain']).stdout).trim();
  const before = controlPlane.stateStore.getRun(runId);
  await controlPlane.close();
  controlPlane = await createKernelControlPlane({ runtimeHome, projectRoot });
  const recovery = await controlPlane.recoverPendingDeliveryMaterialization(runId);
  const after = controlPlane.stateStore.getRun(runId);
  const result = {
    scenario, faultCount, dispatchStatus, bytes, gitStatus,
    before: { status: before.status, mutationRevision: before.mutationRevision },
    recovery: { status: recovery.status, reason: recovery.reason || null },
    after: { status: after.status, mutationRevision: after.mutationRevision, blockedReason: after.blockedReason || null },
  };
  if (scenario === 'c06') {
    assert.equal(faultCount, 1);
    assert.equal(bytes.alpha, null);
    assert.equal(bytes.beta, null);
    assert.equal(gitStatus, '');
    assert.equal(after.mutationRevision, 0);
    assert.equal(after.status, 'active');
  } else {
    assert.equal(faultCount, 2);
    assert.equal(bytes.alpha, 'alpha\n');
    assert.equal(bytes.beta, 'beta\n');
    assert.notEqual(gitStatus, '');
    assert.equal(before.status, 'active');
    assert.equal(before.mutationRevision, 0);
    assert.equal(recovery.status, 'blocked');
    assert.equal(after.status, 'blocked');
    assert.equal(after.blockedReason, 'delivery_materialization_recovery_required');
    assert.equal(after.mutationRevision, 0);
  }
  console.log('W0_ISOLATED_PROBE_PASS', JSON.stringify(result));
} finally {
  if (controlPlane) await controlPlane.close().catch(() => {});
  if (projectId) await cleanupExecutionWorkspaces({ runtimeHome, projectId, runId, repoRoot: projectRoot, retain: false }).catch(() => {});
  await fs.rm(runtimeHome, { recursive: true, force: true });
  await fs.rm(projectRoot, { recursive: true, force: true });
}
