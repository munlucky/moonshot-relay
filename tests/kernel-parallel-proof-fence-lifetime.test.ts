// Real Kernel Owner fence and trusted Proof. These tests intentionally prove
// what the fence DOES NOT do to an escaped, finite, test-owned OS descendant.
// They do not enable automatic reconciliation or signal arbitrary processes.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createKernelControlPlane } from '../src/host/kernel/control-plane-runtime.js';
import { executeTrustedProof } from '../src/host/kernel/proof/proof-executor.js';
import { observeWorkspaceIdentity } from '../src/host/kernel/workspace/workspace-identity.js';
import { runGit } from '../src/shared/git-safe.js';

const git = (root: string, args: string[]): string => {
  const output = runGit(root, args);
  assert.equal(output.status, 0, String(output.stderr || output.error));
  return String(output.stdout || '').trim();
};
const waitFor = async (predicate: () => boolean, reason: string): Promise<void> => {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await delay(25);
  }
  assert.fail(`timed out waiting for ${reason}`);
};
const notRunning = (pid: number): boolean => {
  if (process.platform === 'win32') return false;
  const result = spawnSync('/bin/ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
  return result.status !== 0 || !result.stdout.trim() || result.stdout.trim().startsWith('Z');
};

const setup = async (orphanProof: boolean) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'w0-proof-fence-lifetime-'));
  const projectRoot = path.join(root, 'owner');
  const runtimeHome = path.join(root, 'runtime');
  const integrationRoot = path.join(root, 'integration');
  await mkdir(projectRoot); await mkdir(runtimeHome); await mkdir(integrationRoot);
  const script = orphanProof ? 'node launch.cjs' : 'node --version';
  await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({
    name: 'w0-proof-fence-fixture', scripts: { 'test:proof': script },
  }));
  if (orphanProof) {
    // The launcher and detached Writer have bounded independent lifetimes.
    // All observations/writes target a test-owned *integration* directory,
    // outside the canonical Owner Git tree and its CAS snapshot.
    const child = [
      "const fs=require('node:fs');",
      `const root=${JSON.stringify(integrationRoot)};`,
      "fs.writeFileSync(require('node:path').join(root,'writer.pid'),String(process.pid));",
      "const tick=setInterval(()=>{if(fs.existsSync(require('node:path').join(root,'release-late'))){",
      "fs.writeFileSync(require('node:path').join(root,'late-proof-write'),'late after fence replacement\\n');",
      "clearInterval(tick);process.exit(0);}},25);",
      'setTimeout(()=>process.exit(0),9000);',
    ].join('\n');
    const launch = [
      "const fs=require('node:fs');",
      "const {spawn}=require('node:child_process');",
      `const root=${JSON.stringify(integrationRoot)};`,
      "fs.writeFileSync(require('node:path').join(root,'launcher.pid'),String(process.pid));",
      `const child=spawn(process.execPath,['-e',${JSON.stringify(child)}],{detached:true,stdio:'ignore'});`,
      "child.unref();fs.writeFileSync(require('node:path').join(root,'launched.pid'),String(child.pid));",
      'setTimeout(()=>process.exit(0),4500);',
    ].join('\n');
    await writeFile(path.join(projectRoot, 'launch.cjs'), launch + '\n');
  }
  git(projectRoot, ['init', '-b', 'main']);
  git(projectRoot, ['config', 'user.name', 'Proof Fence Test']);
  git(projectRoot, ['config', 'user.email', 'proof-fence@example.invalid']);
  git(projectRoot, ['add', '--all']);
  git(projectRoot, ['commit', '-m', 'fixture']);
  const a = await createKernelControlPlane({ projectRoot, runtimeHome });
  const runId = 'run-proof-fence';
  const run = await a.startRun({ runId, objective: 'bounded Owner Proof fence' });
  const b = await createKernelControlPlane({ projectRoot, runtimeHome });
  const snapshot = {
    expectedMutationRevision: run.mutationRevision,
    expectedWorkspaceIdentity: observeWorkspaceIdentity({ projectRoot }).identity,
    expectedHeadCommitSha: git(projectRoot, ['rev-parse', 'HEAD']),
    expectedProjectId: run.projectId,
    expectedWorktreeId: run.worktreeId,
    expectedWorkspaceId: run.workspaceId,
  };
  return { root, projectRoot, runtimeHome, integrationRoot, runId, snapshot, a, b };
};

test('an acquired Owner fence rejects a second Control Plane during trusted Proof', async () => {
  const f = await setup(false);
  try {
    const first = f.a.acquireOwnerWorkspaceMutationFence(f.runId, {
      ...f.snapshot, sessionToken: 'proof-host-A', ttlMs: 10000,
    });
    assert.throws(() => f.b.acquireOwnerWorkspaceMutationFence(f.runId, {
      ...f.snapshot, sessionToken: 'proof-host-B',
    }), (e: unknown) => (e as { code?: string }).code === 'delivery_mutation_fence_lost');
    const proof = executeTrustedProof({ projectRoot: f.projectRoot, commandRef: 'test:proof' });
    assert.equal(proof.status, 'passed');
    assert.equal(proof.timedOut, false);
    const renewed = f.a.renewOwnerWorkspaceMutationFence(f.runId, {
      ...f.snapshot, workspaceId: first.lock.workspaceId,
      fencingToken: first.lock.fencingToken, sessionToken: first.lock.sessionToken,
    });
    assert.ok(renewed.lock, 'completed Proof must retain its fenced owner');
    assert.equal(renewed.lock.fencingToken, first.lock.fencingToken);
    assert.throws(() => f.b.acquireOwnerWorkspaceMutationFence(f.runId, {
      ...f.snapshot, sessionToken: 'proof-host-B',
    }), (e: unknown) => (e as { code?: string }).code === 'delivery_mutation_fence_lost');
    f.a.releaseOwnerWorkspaceMutationFence(f.runId, {
      workspaceId: first.lock.workspaceId,
      fencingToken: first.lock.fencingToken, sessionToken: first.lock.sessionToken,
    });
    assert.equal((await f.b.getRun(f.runId))?.mutationRevision, 0);
  } finally {
    await f.a.close(); await f.b.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test('expired pre-Proof fence cannot contain an escaped trusted Proof descendant', {
  skip: process.platform === 'win32' && 'POSIX detached descendant observation',
  timeout: 20000,
}, async () => {
  const f = await setup(true);
  let safeToRemove = false;
  try {
    const first = f.a.acquireOwnerWorkspaceMutationFence(f.runId, {
      ...f.snapshot, sessionToken: 'stale-proof-host', ttlMs: 2000,
    });
    const proof = executeTrustedProof({ projectRoot: f.projectRoot, commandRef: 'test:proof', timeoutMs: 1000 });
    assert.equal(proof.status, 'failed');
    assert.equal(proof.timedOut, true);
    assert.ok(existsSync(path.join(f.integrationRoot, 'launched.pid')), 'detached writer started');
    assert.equal(existsSync(path.join(f.integrationRoot, 'late-proof-write')), false);
    const writerPid = Number(await readFile(path.join(f.integrationRoot, 'writer.pid'), 'utf8'));
    const launcherPid = Number(await readFile(path.join(f.integrationRoot, 'launcher.pid'), 'utf8'));
    assert.ok(Number.isSafeInteger(writerPid) && writerPid > 0);
    assert.ok(Number.isSafeInteger(launcherPid) && launcherPid > 0);
    await waitFor(() => Date.parse(first.lock.expiresAt || '') <= Date.now(), 'first fence expiry');
    const replacement = f.b.acquireOwnerWorkspaceMutationFence(f.runId, {
      ...f.snapshot, sessionToken: 'replacement-proof-host', ttlMs: 10000,
    });
    assert.ok(replacement.lock.fencingToken > first.lock.fencingToken);
    assert.throws(() => f.a.renewOwnerWorkspaceMutationFence(f.runId, {
      ...f.snapshot, workspaceId: first.lock.workspaceId,
      fencingToken: first.lock.fencingToken, sessionToken: first.lock.sessionToken,
    }), (e: unknown) => (e as { code?: string }).code === 'delivery_mutation_fence_lost');
    assert.equal(existsSync(path.join(f.integrationRoot, 'late-proof-write')), false);
    await writeFile(path.join(f.integrationRoot, 'release-late'), 'go');
    await waitFor(() => existsSync(path.join(f.integrationRoot, 'late-proof-write')), 'orphan Proof write after lease replacement');
    assert.equal(await readFile(path.join(f.integrationRoot, 'late-proof-write'), 'utf8'), 'late after fence replacement\n');
    assert.equal((await f.b.getRun(f.runId))?.mutationRevision, 0);
    const renewal = f.b.renewOwnerWorkspaceMutationFence(f.runId, {
      ...f.snapshot, workspaceId: replacement.lock.workspaceId,
      fencingToken: replacement.lock.fencingToken, sessionToken: replacement.lock.sessionToken,
    });
    assert.ok(renewal.lock, 'replacement is still the valid Kernel owner');
    assert.equal(renewal.lock.fencingToken, replacement.lock.fencingToken,
      'new Kernel owner does not revoke escaped OS proof write authority');
    f.b.releaseOwnerWorkspaceMutationFence(f.runId, {
      workspaceId: replacement.lock.workspaceId,
      fencingToken: replacement.lock.fencingToken, sessionToken: replacement.lock.sessionToken,
    });
    await waitFor(() => notRunning(writerPid) && notRunning(launcherPid), 'bounded test-owned proof processes to exit');
    safeToRemove = true;
  } finally {
    await f.a.close(); await f.b.close();
    if (safeToRemove) await rm(f.root, { recursive: true, force: true });
    else console.warn('Preserved unknown-lifetime proof fixture:', f.root);
  }
});
