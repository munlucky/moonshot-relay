// Recovery Worktree generations are physically distinct. A stale bounded
// Proof child may keep writing its own generation; do not recycle it.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createKernelControlPlane } from '../src/host/kernel/control-plane-runtime.js';
import { executeTrustedProof } from '../src/host/kernel/proof/proof-executor.js';
import { prepareRecoveryIntegrationWorktree, cleanupExecutionWorkspaces } from '../src/host/kernel/workspace/physical-worktree.js';
import { observeWorkspaceIdentity } from '../src/host/kernel/workspace/workspace-identity.js';
import { runGit } from '../src/shared/git-safe.js';

const git = (root: string, args: string[]): string => {
  const result = runGit(root, args);
  assert.equal(result.status, 0, String(result.stderr || result.error));
  return String(result.stdout || '').trim();
};
const wait = async (done: () => boolean, reason: string): Promise<void> => {
  for (let i = 0; i < 220 && !done(); i++) await delay(25);
  assert.ok(done(), `timed out: ${reason}`);
};
const inactive = (pid: number): boolean => {
  const r = spawnSync('/bin/ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
  return r.status !== 0 || !r.stdout.trim() || r.stdout.trim().startsWith('Z');
};
const fixture = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kernel-recovery-worktrees-'));
  const owner = path.join(root, 'owner'), runtimeHome = path.join(root, 'runtime');
  await Promise.all([mkdir(owner), mkdir(runtimeHome)]);
  await writeFile(path.join(owner, 'package.json'), JSON.stringify({
    name: 'recovery-proof-fixture', scripts: { 'test:late': 'node proof.cjs' },
  }));
  // The launcher is killed by Proof timeout; the finite detached child waits
  // for a Host marker before trying writes against the second generation.
  const childCode = [
    "const fs=require('node:fs');const p=require('node:path');const base=process.cwd();",
    "fs.writeFileSync(p.join(base,'writer.pid'),String(process.pid));",
    "const tick=setInterval(()=>{if(!fs.existsSync(p.join(base,'go-late')))return;",
    "const {other,owner}=JSON.parse(fs.readFileSync(p.join(base,'targets.json'),'utf8'));",
    "fs.writeFileSync(p.join(base,'old-generation-write'),'old\\n');",
    "const attempt=(file)=>{try{fs.writeFileSync(file,'unsafe');return 'allowed';}catch(e){return e.code||String(e);}};",
    "fs.writeFileSync(p.join(base,'verdict.json'),JSON.stringify({other:attempt(p.join(other,'stale-write')),owner:attempt(p.join(owner,'stale-write'))}));",
    "clearInterval(tick);process.exit(0);},25);",
    'setTimeout(()=>process.exit(0),22000);',
  ].join('\n');
  const launcher = [
    "const fs=require('node:fs');const p=require('node:path');const {spawn}=require('node:child_process');",
    `const child=spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{detached:true,stdio:'inherit'});`,
    "child.unref();fs.writeFileSync(p.join(process.cwd(),'launched.pid'),String(child.pid));",
    'setTimeout(()=>process.exit(0),20000);',
  ].join('\n');
  await writeFile(path.join(owner, 'proof.cjs'), launcher + '\n');
  git(owner, ['init', '-b', 'main']);
  git(owner, ['config', 'user.name', 'Recovery Worktree Test']);
  git(owner, ['config', 'user.email', 'recovery@example.invalid']);
  git(owner, ['add', '--all']); git(owner, ['commit', '-m', 'base']);
  const a = await createKernelControlPlane({ projectRoot: owner, runtimeHome });
  const runId = 'recover-fresh-integration';
  const start = await a.startRun({ runId, objective: 'one isolated recovery Proof per generation' });
  const projectId = start.projectId;
  assert.ok(projectId, 'Canonical Run projectId is required for recovery Worktree allocation');
  const b = await createKernelControlPlane({ projectRoot: owner, runtimeHome });
  const baseCommit = git(owner, ['rev-parse', 'HEAD']);
  const snapshot = {
    expectedMutationRevision: start.mutationRevision,
    expectedWorkspaceIdentity: observeWorkspaceIdentity({ projectRoot: owner }).identity,
    expectedHeadCommitSha: baseCommit,
    expectedProjectId: start.projectId,
    expectedWorktreeId: start.worktreeId,
    expectedWorkspaceId: start.workspaceId,
  };
  const prepare = () => prepareRecoveryIntegrationWorktree({
    repoRoot: owner, baseCommit, runtimeHome,
    projectId, runId,
  });
  return { root, owner, runtimeHome, runId, baseCommit, projectId, snapshot, a, b, prepare };
};

test('recovery always creates new Git integration Worktrees untouched by normal batch cleanup', async () => {
  const f = await fixture();
  let cleaned = false;
  try {
    const fence = f.a.acquireOwnerWorkspaceMutationFence(f.runId, {
      ...f.snapshot, sessionToken: 'recovery-A', ttlMs: 10000,
    });
    const first = await f.prepare();
    assert.throws(() => f.b.acquireOwnerWorkspaceMutationFence(f.runId, {
      ...f.snapshot, sessionToken: 'recovery-B',
    }), (error: unknown) => (error as { code?: string }).code === 'delivery_mutation_fence_lost');
    f.a.releaseOwnerWorkspaceMutationFence(f.runId, {
      workspaceId: fence.lock.workspaceId,
      fencingToken: fence.lock.fencingToken, sessionToken: fence.lock.sessionToken,
    });
    const replacement = f.b.acquireOwnerWorkspaceMutationFence(f.runId, {
      ...f.snapshot, sessionToken: 'recovery-B', ttlMs: 10000,
    });
    const second = await f.prepare();
    assert.notEqual(first.workspaceRoot, second.workspaceRoot);
    assert.equal(first.reused, false); assert.equal(second.reused, false);
    assert.equal(first.baseCommitSha, f.baseCommit); assert.equal(second.baseCommitSha, f.baseCommit);
    assert.ok(existsSync(first.workspaceRoot) && existsSync(second.workspaceRoot));
    const oldMarker = path.join(first.workspaceRoot, 'old-generation-write');
    await writeFile(oldMarker, 'old\n');
    await cleanupExecutionWorkspaces({
      runtimeHome: f.runtimeHome, projectId: f.projectId, runId: f.runId,
      repoRoot: f.owner, retain: false,
    });
    assert.equal(await readFile(oldMarker, 'utf8'), 'old\n');
    assert.equal(git(second.workspaceRoot, ['status', '--porcelain']), '');
    assert.equal((await f.b.getRun(f.runId))?.mutationRevision, 0);
    f.b.releaseOwnerWorkspaceMutationFence(f.runId, {
      workspaceId: replacement.lock.workspaceId,
      fencingToken: replacement.lock.fencingToken, sessionToken: replacement.lock.sessionToken,
    });
    // This fixture created no Writer. Both known idle Worktrees can be retired.
    git(f.owner, ['worktree', 'remove', '--force', first.workspaceRoot]);
    git(f.owner, ['worktree', 'remove', '--force', second.workspaceRoot]);
    cleaned = true;
  } finally {
    await f.a.close(); await f.b.close();
    if (cleaned) await rm(f.root, { recursive: true, force: true });
    else console.warn('Preserved unverified recovery Worktree fixture:', f.root);
  }
});

test('stale OS-scoped Proof child cannot modify the next recovery Git Worktree after fence expiry', {
  skip: process.platform !== 'darwin' && 'requires actual macOS OS file-write containment',
  timeout: 36000,
}, async () => {
  const f = await fixture();
  let safe = false;
  try {
    const firstFence = f.a.acquireOwnerWorkspaceMutationFence(f.runId, {
      ...f.snapshot, sessionToken: 'old-owner', ttlMs: 9000,
    });
    const first = await f.prepare();
    const proof = executeTrustedProof({
      projectRoot: first.workspaceRoot, commandRef: 'test:late',
      writeScope: first.workspaceRoot, timeoutMs: 5500,
    });
    assert.equal(proof.status, 'failed');
    assert.equal(proof.timedOut, true);
    await wait(() => existsSync(path.join(first.workspaceRoot, 'launched.pid')), 'detached Proof process started');
    const pid = Number(await readFile(path.join(first.workspaceRoot, 'launched.pid'), 'utf8'));
    assert.ok(Number.isSafeInteger(pid) && pid > 0);
    await wait(() => Date.parse(firstFence.lock.expiresAt || '') <= Date.now(), 'first owner fence expired');
    const nextFence = f.b.acquireOwnerWorkspaceMutationFence(f.runId, {
      ...f.snapshot, sessionToken: 'new-owner', ttlMs: 10000,
    });
    assert.ok(nextFence.lock.fencingToken > firstFence.lock.fencingToken);
    const second = await f.prepare();
    assert.notEqual(first.workspaceRoot, second.workspaceRoot);
    await writeFile(path.join(first.workspaceRoot, 'targets.json'), JSON.stringify({
      other: second.workspaceRoot, owner: f.owner,
    }));
    await writeFile(path.join(first.workspaceRoot, 'go-late'), 'go');
    await wait(() => existsSync(path.join(first.workspaceRoot, 'verdict.json')), 'stale Proof child finished bounded late write');
    const verdict: { other: string; owner: string } = JSON.parse(await readFile(path.join(first.workspaceRoot, 'verdict.json'), 'utf8'));
    assert.deepEqual(verdict, { other: 'EPERM', owner: 'EPERM' });
    assert.equal(await readFile(path.join(first.workspaceRoot, 'old-generation-write'), 'utf8'), 'old\n');
    assert.equal(existsSync(path.join(second.workspaceRoot, 'stale-write')), false);
    assert.equal(existsSync(path.join(f.owner, 'stale-write')), false);
    assert.equal((await f.b.getRun(f.runId))?.mutationRevision, 0);
    assert.throws(() => f.a.renewOwnerWorkspaceMutationFence(f.runId, {
      ...f.snapshot, workspaceId: firstFence.lock.workspaceId,
      fencingToken: firstFence.lock.fencingToken, sessionToken: firstFence.lock.sessionToken,
    }), (error: unknown) => (error as { code?: string }).code === 'delivery_mutation_fence_lost');
    const renewal = f.b.renewOwnerWorkspaceMutationFence(f.runId, {
      ...f.snapshot, workspaceId: nextFence.lock.workspaceId,
      fencingToken: nextFence.lock.fencingToken, sessionToken: nextFence.lock.sessionToken,
    });
    assert.ok(renewal.lock);
    f.b.releaseOwnerWorkspaceMutationFence(f.runId, {
      workspaceId: nextFence.lock.workspaceId,
      fencingToken: nextFence.lock.fencingToken, sessionToken: nextFence.lock.sessionToken,
    });
    for (let i = 0; i < 120 && !inactive(pid); i++) await delay(35);
    assert.ok(inactive(pid), 'finite test writer must physically finish before Worktree removal');
    git(f.owner, ['worktree', 'remove', '--force', first.workspaceRoot]);
    git(f.owner, ['worktree', 'remove', '--force', second.workspaceRoot]);
    safe = true;
  } finally {
    await f.a.close(); await f.b.close();
    if (safe) await rm(f.root, { recursive: true, force: true });
    else console.warn('Preserved unknown-lifetime scoped proof fixture:', f.root);
  }
});
