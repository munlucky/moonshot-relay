// A genuine Kernel SQLite Owner fence must cover each mutating integration
// phase and settlement attempt. This test does not opt the Dispatcher into
// automatic recovery or authorize use of an unknown Native Writer.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createKernelControlPlane } from '../src/host/kernel/control-plane-runtime.js';
import { executeTrustedProof } from '../src/host/kernel/proof/proof-executor.js';
import { prepareRecoveryIntegrationWorktree, prepareStepWorktree } from '../src/host/kernel/workspace/physical-worktree.js';
import { observeWorkspaceIdentity } from '../src/host/kernel/workspace/workspace-identity.js';
import { runGit } from '../src/shared/git-safe.js';

const git = (root: string, args: string[], input?: string): string => {
  const outcome = runGit(root, args, input === undefined ? {} : { input });
  assert.equal(outcome.status, 0, `git ${args.join(' ')}: ${String(outcome.stderr || outcome.error)}`);
  return String(outcome.stdout || '').trim();
};
const setup = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kernel-preproof-owner-fence-'));
  const owner = path.join(root, 'owner');
  const runtimeHome = path.join(root, 'runtime');
  await Promise.all([mkdir(owner), mkdir(runtimeHome)]);
  await writeFile(path.join(owner, 'package.json'), JSON.stringify({
    name: 'preproof-fence-fixture',
    scripts: { 'test:ok': 'node verify.cjs', 'test:long': 'node long.cjs' },
  }));
  await writeFile(path.join(owner, 'verify.cjs'),
    "const fs=require('node:fs');if(fs.readFileSync('result.txt','utf8')!=='verified\\n')process.exit(31);\n");
  await writeFile(path.join(owner, 'long.cjs'), 'setTimeout(()=>process.exit(0),1800);\n');
  git(owner, ['init', '-b', 'main']);
  git(owner, ['config', 'user.name', 'Preproof Fence Test']);
  git(owner, ['config', 'user.email', 'preproof-fence@example.invalid']);
  git(owner, ['add', '--all']); git(owner, ['commit', '-m', 'fixture']);
  const a = await createKernelControlPlane({ projectRoot: owner, runtimeHome });
  const runId = 'run-preproof-fence';
  const run = await a.startRun({ runId, objective: 'pre-cherry-pick through settlement fencing' });
  const b = await createKernelControlPlane({ projectRoot: owner, runtimeHome });
  assert.ok(run.projectId);
  const baseCommit = git(owner, ['rev-parse', 'HEAD']);
  const snapshot = {
    expectedMutationRevision: run.mutationRevision,
    expectedWorkspaceIdentity: observeWorkspaceIdentity({ projectRoot: owner }).identity,
    expectedHeadCommitSha: baseCommit,
    expectedProjectId: run.projectId,
    expectedWorktreeId: run.worktreeId,
    expectedWorkspaceId: run.workspaceId,
  };
  const prepare = () => prepareRecoveryIntegrationWorktree({
    repoRoot: owner, baseCommit, runId, projectId: run.projectId || undefined, runtimeHome,
  });
  return { root, owner, runtimeHome, a, b, runId, run, baseCommit, snapshot, prepare };
};
const release = (f: Awaited<ReturnType<typeof setup>>, owner: 'a' | 'b', fence: { lock: { workspaceId: string; fencingToken: number; sessionToken: string } }): void => {
  f[owner].releaseOwnerWorkspaceMutationFence(f.runId, {
    workspaceId: fence.lock.workspaceId,
    fencingToken: fence.lock.fencingToken,
    sessionToken: fence.lock.sessionToken,
  });
};
const denied = (f: Awaited<ReturnType<typeof setup>>, snapshot: typeof f.snapshot): void => {
  assert.throws(() => f.b.acquireOwnerWorkspaceMutationFence(f.runId, {
    ...snapshot, sessionToken: 'competing-recovery-host',
  }), (cause: unknown) => (cause as { code?: string }).code === 'delivery_mutation_fence_lost');
};
const inspectScope = (scope: string): string | undefined => process.platform === 'darwin' ? scope : undefined;

test('one real Owner fence covers first cherry-pick, scoped Proof, CAS, and attempted canonical settlement', {
  timeout: 30000,
}, async () => {
  const f = await setup();
  let safe = false;
  try {
    // Fence FIRST; nobody else may enter a delivery Worktree before the first
    // Git cherry-pick even when its Worker result is already complete.
    const fence = f.a.acquireOwnerWorkspaceMutationFence(f.runId, {
      ...f.snapshot, sessionToken: 'integration-owner-A', ttlMs: 23000,
    });
    const integration = await f.prepare();
    const worker = await prepareStepWorktree({
      repoRoot: f.owner, baseCommit: f.baseCommit, runId: f.runId,
      projectId: f.run.projectId || undefined, runtimeHome: f.runtimeHome, stepId: 'step-result',
    });
    await writeFile(path.join(worker.workspaceRoot, 'result.txt'), 'verified\n');
    git(worker.workspaceRoot, ['add', '--all']);
    git(worker.workspaceRoot, ['-c', 'user.name=Proof Test', '-c', 'user.email=proof@example.invalid', 'commit', '-m', 'worker result']);
    const workerCommit = git(worker.workspaceRoot, ['rev-parse', 'HEAD']);
    denied(f, f.snapshot);
    git(integration.workspaceRoot, ['cherry-pick', '--no-commit', workerCommit]);
    assert.ok(existsSync(path.join(integration.workspaceRoot, 'result.txt')));
    denied(f, f.snapshot);
    const renewed = f.a.renewOwnerWorkspaceMutationFence(f.runId, {
      ...f.snapshot, workspaceId: fence.lock.workspaceId,
      fencingToken: fence.lock.fencingToken, sessionToken: fence.lock.sessionToken,
      ttlMs: 23000,
    });
    assert.ok(renewed.lock);
    const proof = executeTrustedProof({
      projectRoot: integration.workspaceRoot, commandRef: 'test:ok',
      timeoutMs: 12000, writeScope: inspectScope(integration.workspaceRoot),
    });
    assert.equal(proof.status, 'passed', proof.errorSummary || 'trusted integration verification failed');
    if (process.platform === 'darwin') assert.equal(proof.writeContainment?.mechanism, 'macos-seatbelt');
    else assert.equal(proof.writeContainment, undefined);
    denied(f, f.snapshot);
    const beforeDelivery = f.a.renewOwnerWorkspaceMutationFence(f.runId, {
      ...f.snapshot, workspaceId: fence.lock.workspaceId,
      fencingToken: fence.lock.fencingToken, sessionToken: fence.lock.sessionToken,
      ttlMs: 23000,
    });
    assert.ok(beforeDelivery.lock);
    const patchResult = runGit(integration.workspaceRoot, ['diff', '--cached', '--binary', f.baseCommit]);
    assert.equal(patchResult.status, 0);
    const patch = String(patchResult.stdout || '');
    assert.ok(patch.includes('result.txt'));
    const integrationIdentity = observeWorkspaceIdentity({ projectRoot: integration.workspaceRoot }).identity;
    const patchDigest = `sha256:${createHash('sha256').update(patch).digest('hex')}`;
    git(f.owner, ['apply', '--check', '--binary', '-'], patch);
    f.a.assertOwnerWorkspaceMutationReady(f.runId, {
      ...f.snapshot, fencingToken: fence.lock.fencingToken,
      sessionToken: fence.lock.sessionToken,
      integrationWorkspaceIdentity: integrationIdentity,
      changedPaths: ['result.txt'], patchDigest,
    });
    git(f.owner, ['apply', '--binary', '-'], patch);
    const updatedIdentity = observeWorkspaceIdentity({ projectRoot: f.owner }).identity;
    const committed = f.a.recordOwnerWorkspaceMutation(f.runId, {
      ...f.snapshot, fencingToken: fence.lock.fencingToken,
      sessionToken: fence.lock.sessionToken,
      integrationWorkspaceIdentity: updatedIdentity,
      changedPaths: ['result.txt'], patchDigest,
    });
    assert.equal(committed.status, 'applied');
    assert.equal(committed.mutationRevision, 1);
    assert.equal((await f.b.getRun(f.runId))?.mutationRevision, 1);
    const freshSnapshot = { ...f.snapshot, expectedMutationRevision: 1, expectedWorkspaceIdentity: updatedIdentity };
    denied(f, freshSnapshot);
    // Invalid/absent worker receipt must NEVER become canonical success merely
    // because CAS was committed; report settlement remains a separate gate.
    const settlement = await f.a.settleParallelResult(f.runId, {}, {
      deliveryMutation: committed,
      result: null,
    });
    assert.ok(settlement);
    assert.equal(settlement.status, 'evidence-rejected', 'missing worker evidence must not settle a canonical Step');
    denied(f, freshSnapshot);
    release(f, 'a', fence);
    assert.equal(f.a.stateStore.getWorkspaceMutationLockV2(f.run.workspaceId || ''), null);
    // Known proof is synchronous with no child; all worktrees are test-owned.
    git(f.owner, ['worktree', 'remove', '--force', worker.workspaceRoot]);
    git(f.owner, ['worktree', 'remove', '--force', integration.workspaceRoot]);
    safe = true;
  } finally {
    await f.a.close(); await f.b.close();
    if (safe) await rm(f.root, { recursive: true, force: true });
    else console.warn('Preserved uncertain pre-proof fence fixture:', f.root);
  }
});

test('an expired pre-Proof Fence rejects stale renewal before Owner mutation', {
  timeout: 15000,
}, async () => {
  const f = await setup();
  let safe = false;
  try {
    const original = f.a.acquireOwnerWorkspaceMutationFence(f.runId, {
      ...f.snapshot, sessionToken: 'expired-host-A', ttlMs: 1100,
    });
    const first = await f.prepare();
    const proof = executeTrustedProof({
      projectRoot: first.workspaceRoot, commandRef: 'test:long',
      timeoutMs: 9000, writeScope: inspectScope(first.workspaceRoot),
    });
    assert.equal(proof.status, 'passed');
    assert.ok(Date.parse(original.lock.expiresAt || '') <= Date.now(), 'proof crossed original Fence deadline');
    const newer = f.b.acquireOwnerWorkspaceMutationFence(f.runId, {
      ...f.snapshot, sessionToken: 'new-host-B', ttlMs: 10000,
    });
    assert.ok(newer.lock.fencingToken > original.lock.fencingToken);
    const second = await f.prepare();
    assert.notEqual(first.workspaceRoot, second.workspaceRoot);
    assert.throws(() => f.a.renewOwnerWorkspaceMutationFence(f.runId, {
      ...f.snapshot, workspaceId: original.lock.workspaceId,
      fencingToken: original.lock.fencingToken, sessionToken: original.lock.sessionToken,
    }), (cause: unknown) => (cause as { code?: string }).code === 'delivery_mutation_fence_lost');
    assert.equal((await f.b.getRun(f.runId))?.mutationRevision, 0);
    assert.equal(existsSync(path.join(f.owner, 'result.txt')), false);
    release(f, 'b', newer);
    git(f.owner, ['worktree', 'remove', '--force', first.workspaceRoot]);
    git(f.owner, ['worktree', 'remove', '--force', second.workspaceRoot]);
    safe = true;
  } finally {
    await f.a.close(); await f.b.close();
    if (safe) await rm(f.root, { recursive: true, force: true });
    else console.warn('Preserved expired Fence fixture:', f.root);
  }
});
