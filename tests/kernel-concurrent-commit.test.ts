import { assertTestNumber, assertTestPresent, assertTestRecord, assertTestString } from './helpers/assert-value.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { spawnSync, spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createKernelControlPlane } from '../src/host/kernel/control-plane-runtime.js';

const setup = async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'krn-conc-commit-home-'));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'krn-conc-commit-proj-'));
  spawnSync('git', ['init', '-b', 'main'], { cwd: projectRoot, encoding: 'utf8' });
  spawnSync('git', ['config', 'user.name', 'Kernel Test'], { cwd: projectRoot, encoding: 'utf8' });
  spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: projectRoot, encoding: 'utf8' });
  await mkdir(path.join(projectRoot, '.moon-relay'), { recursive: true });
  await writeFile(path.join(projectRoot, '.moon-relay', 'track.yaml'), 'track: kernel\nproduct: moon-relay-kernel\n');
  await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({
    name: 'concurrent-commit-test',
    version: '0.0.1',
    scripts: { test: 'node -e "process.exit(0)"' },
  }));
  await writeFile(path.join(projectRoot, 'app.mjs'), 'export const active = true;\n');
  spawnSync('git', ['add', '.'], { cwd: projectRoot, encoding: 'utf8' });
  spawnSync('git', ['commit', '-m', 'Initial commit'], { cwd: projectRoot, encoding: 'utf8' });

  // Create two distinct git worktrees in the same repository
  const worktreeA = path.join(projectRoot, 'wt-a');
  spawnSync('git', ['worktree', 'add', worktreeA, '-b', 'branch-a'], { cwd: projectRoot, encoding: 'utf8' });
  const worktreeB = path.join(projectRoot, 'wt-b');
  spawnSync('git', ['worktree', 'add', worktreeB, '-b', 'branch-b'], { cwd: projectRoot, encoding: 'utf8' });

  return { runtimeHome, projectRoot, worktreeA, worktreeB };
};

const cleanup = async ({ runtimeHome, projectRoot }: { runtimeHome: string; projectRoot: string }) => {
  await new Promise((resolve) => setTimeout(resolve, 100));
  await rm(runtimeHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
  await rm(projectRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
};

test('Concurrent Commit: Two concurrent sessions serialize OCC knowledge commit cleanly without blocking code delivery', async () => {
  const fixture = await setup();
  const cpA = await createKernelControlPlane({
    runtimeHome: fixture.runtimeHome,
    projectRoot: fixture.worktreeA,
    env: {
      ...process.env,
      MOON_RELAY_KERNEL_SESSION_ID: 'codex:session-concurrent-A',
      MOON_RELAY_KERNEL_PROVIDER: 'codex',
    },
  });

  const cpB = await createKernelControlPlane({
    runtimeHome: fixture.runtimeHome,
    projectRoot: fixture.worktreeB,
    env: {
      ...process.env,
      MOON_RELAY_KERNEL_SESSION_ID: 'codex:session-concurrent-B',
      MOON_RELAY_KERNEL_PROVIDER: 'codex',
    },
  });

  try {
    const runIdA = 'r-concurrent-session-A';
    const runIdB = 'r-concurrent-session-B';

    // Start both runs concurrently in separate sessions
    await cpA.startRun({
      runId: runIdA,
      objective: 'concurrent feature A',
      taskContract: {
        riskTier: 'T0',
        acceptance: [{
          acceptance: 'unit works A',
          evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test'], obligationId: 'default' },
        }],
        allowedPaths: ['app.mjs'],
      },
    });

    await cpB.startRun({
      runId: runIdB,
      objective: 'concurrent feature B',
      taskContract: {
        riskTier: 'T0',
        acceptance: [{
          acceptance: 'unit works B',
          evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test'], obligationId: 'default' },
        }],
        allowedPaths: ['app.mjs'],
      },
    });

    // Advance Run A through EXECUTE -> PROVE -> CLOSE
    await cpA.transition(runIdA, 'EXECUTE');
    await cpA.transition(runIdA, 'PROVE');
    await cpA.recordProof(runIdA, {
      obligationId: 'default',
      status: 'passed',
      evidenceRef: 'ev-proof-A',
      commandRef: 'test',
      command: 'node -e "process.exit(0)"',
      exitCode: 0,
      evidenceDigest: `sha256:${'a'.repeat(64)}`,
      acceptanceCoverage: ['unit works A'],
    });
    await cpA.transition(runIdA, 'CLOSE');

    // Advance Run B through EXECUTE -> PROVE -> CLOSE
    await cpB.transition(runIdB, 'EXECUTE');
    await cpB.transition(runIdB, 'PROVE');
    await cpB.recordProof(runIdB, {
      obligationId: 'default',
      status: 'passed',
      evidenceRef: 'ev-proof-B',
      commandRef: 'test',
      command: 'node -e "process.exit(0)"',
      exitCode: 0,
      evidenceDigest: `sha256:${'b'.repeat(64)}`,
      acceptanceCoverage: ['unit works B'],
    });
    await cpB.transition(runIdB, 'CLOSE');

    // Simulate accepted completion decisions
    const store = cpA.stateStore;
    const runA = store.getRun(runIdA);
    const runB = store.getRun(runIdB);
    const projectId = assertTestPresent(runA).projectId;

    store.recordCompletionDecision(runIdA, {
      decision: 'accepted',
      sourceIdentity: assertTestPresent(runA).sourceIdentity,
      mutationRevision: assertTestPresent(runA).mutationRevision,
      evidenceDigest: `sha256:${'a'.repeat(64)}`,
      decisionJson: { decision: 'accepted' },
    });

    store.recordCompletionDecision(runIdB, {
      decision: 'accepted',
      sourceIdentity: assertTestPresent(runB).sourceIdentity,
      mutationRevision: assertTestPresent(runB).mutationRevision,
      evidenceDigest: `sha256:${'b'.repeat(64)}`,
      decisionJson: { decision: 'accepted' },
    });

    // Finalize Run A and Run B concurrently via Promise.all:
    // Both start at revision 1. One wins CAS on attempt 1 (bumping revision to 2).
    // The other encounters revision conflict on attempt 1, reloads revision 2, and commits on attempt 2!
    const [receiptA, receiptB] = await Promise.all([
      cpA.finalizeRun(runIdA, {
        knowledgeObservations: [
          { proposedType: 'semantic_fact', statement: 'knowledge observation from run A' },
        ],
      }),
      cpB.finalizeRun(runIdB, {
        knowledgeObservations: [
          { proposedType: 'semantic_fact', statement: 'knowledge observation from run B' },
        ],
      }),
    ]);

    assert.equal(assertTestRecord(receiptA).completionStatus, 'accepted');
    assert.equal(assertTestRecord(receiptA).knowledgeStatus, 'committed');
    assert.equal(assertTestRecord(receiptB).completionStatus, 'accepted');
    assert.equal(assertTestRecord(receiptB).knowledgeStatus, 'committed');

    const totalAttempts = assertTestNumber(assertTestRecord(receiptA).knowledgeCommitAttempts) + assertTestNumber(assertTestRecord(receiptB).knowledgeCommitAttempts);
    assert.equal(totalAttempts, 3, 'One run must succeed on attempt 1, and the overlapping run on attempt 2 after CAS reload');
    assert.equal(store.getProjectKnowledgeRevision(assertTestString(projectId)), 3, 'Revision should be 3 after both concurrent commits');
  } finally {
    await cpA.close();
    await cpB.close();
    await cleanup(fixture);
  }
});

test('Concurrent Commit: Cross-process lock contention serializes cleanly via child processes without IDENTITY_MIGRATION_LOCKED', async () => {
  const fixture = await setup();
  try {
    const storeModule = path.resolve('scripts/kernel/knowledge/store.js').replaceAll('\\', '/');
    const workerScript = `
import { ensureKnowledgeStoreDirectories } from 'file:///${storeModule}';
const projectId = process.argv[2];
const runtimeHome = process.argv[3];
for (let i = 0; i < 5; i++) {
  await ensureKnowledgeStoreDirectories(projectId, { env: { MOON_RELAY_KERNEL_HOME: runtimeHome } });
  await new Promise((r) => setTimeout(r, 10));
}
process.exit(0);
`;
    const workerPath = path.join(fixture.runtimeHome, 'worker.mjs');
    await writeFile(workerPath, workerScript);

    const cp1 = spawn(process.execPath, [workerPath, 'proj-cross-proc', fixture.runtimeHome], { stdio: 'pipe' });
    const cp2 = spawn(process.execPath, [workerPath, 'proj-cross-proc', fixture.runtimeHome], { stdio: 'pipe' });

    const [res1, res2] = await Promise.all([
      new Promise((resolve) => {
        let err = '';
        cp1.stderr.on('data', (d) => { err += d; });
        cp1.on('close', (code) => resolve({ code, err }));
      }),
      new Promise((resolve) => {
        let err = '';
        cp2.stderr.on('data', (d) => { err += d; });
        cp2.on('close', (code) => resolve({ code, err }));
      }),
    ]);

    assert.equal(assertTestRecord(res1).code, 0, `Child process 1 failed with: ${assertTestRecord(res1).err}`);
    assert.equal(assertTestRecord(res2).code, 0, `Child process 2 failed with: ${assertTestRecord(res2).err}`);
  } finally {
    await cleanup(fixture);
  }
});

test('Wave 3: Non-blocking async lock retry handles barrier contention across processes', async () => {
  const fixture = await setup();
  try {
    const storeModule = path.resolve('scripts/kernel/knowledge/store.js').replaceAll('\\', '/');
    const projectsRoot = path.join(fixture.runtimeHome, 'state', 'projects');
    await mkdir(projectsRoot, { recursive: true });
    const barrierPath = path.join(fixture.runtimeHome, 'barrier.marker');

    // Process A: acquires lock, writes barrier file, holds lock for 300ms, then releases
    const holderScript = `
import { acquireNamespaceLockWithRetry, releaseNamespaceLock } from 'file:///${storeModule}';
import { writeFile } from 'node:fs/promises';
const projectsRoot = process.argv[2];
const barrier = process.argv[3];
const lock = await acquireNamespaceLockWithRetry(projectsRoot, 'proj-barrier');
await writeFile(barrier, 'locked');
await new Promise((r) => setTimeout(r, 300));
releaseNamespaceLock(lock);
process.exit(0);
`;
    const holderPath = path.join(fixture.runtimeHome, 'holder.mjs');
    await writeFile(holderPath, holderScript);

    const holder = spawn(process.execPath, [holderPath, projectsRoot, barrierPath], { stdio: 'pipe' });

    // Wait until holder signals it acquired the lock
    const { existsSync } = await import('node:fs');
    while (!existsSync(barrierPath)) {
      await new Promise((r) => setTimeout(r, 20));
    }

    // Now import store functions in current process and attempt to acquire lock with retry
    const { acquireNamespaceLockWithRetry, releaseNamespaceLock } = await import('../src/kernel/knowledge/store.js');
    const start = Date.now();
    // Should wait non-blockingly until holder releases, then acquire
    const lock = await acquireNamespaceLockWithRetry(projectsRoot, 'proj-barrier', { retries: 20, retryDelayMs: 50 });
    const elapsed = Date.now() - start;

    assert.ok(lock, 'Lock must be acquired after holder releases');
    assert.ok(elapsed >= 100, `Must have waited for holder, elapsed: ${elapsed}ms`);
    releaseNamespaceLock(lock);

    if (holder.exitCode === null) {
      await new Promise((resolve) => holder.on('close', resolve));
    }
  } finally {
    await cleanup(fixture);
  }
});

test('Wave 3: Lock timeout fails closed with IDENTITY_MIGRATION_LOCKED without blocking event loop', async () => {
  const fixture = await setup();
  try {
    const storeModule = path.resolve('scripts/kernel/knowledge/store.js').replaceAll('\\', '/');
    const projectsRoot = path.join(fixture.runtimeHome, 'state', 'projects');
    await mkdir(projectsRoot, { recursive: true });
    const { acquireNamespaceLockWithRetry, KernelKnowledgeStoreError } = await import('../src/kernel/knowledge/store.js');

    // External process holds lock
    const blockerScript = `
import { acquireNamespaceLockWithRetry } from 'file:///${storeModule}';
import { writeFile } from 'node:fs/promises';
const projectsRoot = process.argv[2];
const barrier = process.argv[3];
await acquireNamespaceLockWithRetry(projectsRoot, 'proj-timeout');
await writeFile(barrier, 'locked');
await new Promise((r) => setTimeout(r, 2000));
process.exit(0);
`;
    const blockerPath = path.join(fixture.runtimeHome, 'blocker.mjs');
    const blockerBarrier = path.join(fixture.runtimeHome, 'blocker.marker');
    await writeFile(blockerPath, blockerScript);

    const blocker = spawn(process.execPath, [blockerPath, projectsRoot, blockerBarrier], { stdio: 'pipe' });
    const { existsSync } = await import('node:fs');
    while (!existsSync(blockerBarrier)) {
      await new Promise((r) => setTimeout(r, 20));
    }

    let timerFired = false;
    const timer = setTimeout(() => { timerFired = true; }, 30);

    let errorThrown: unknown = null;
    try {
      await acquireNamespaceLockWithRetry(projectsRoot, 'proj-timeout', { retries: 3, retryDelayMs: 30 });
    } catch (err) {
      errorThrown = err;
    } finally {
      clearTimeout(timer);
    }

    assert.ok(errorThrown instanceof KernelKnowledgeStoreError);
    assert.equal(errorThrown.code, 'IDENTITY_MIGRATION_LOCKED');
    assert.equal(timerFired, true, 'Event loop must have ticked during retries');

    blocker.kill();
  } finally {
    await cleanup(fixture);
  }
});

test('Wave 3: Dead owner stale lock is automatically cleaned up and acquired', async () => {
  const fixture = await setup();
  try {
    const projectsRoot = path.join(fixture.runtimeHome, 'state', 'projects');
    await mkdir(projectsRoot, { recursive: true });
    const { tryAcquireNamespaceLock, releaseNamespaceLock } = await import('../src/kernel/knowledge/store.js');

    // Simulate stale lock left behind by a dead process (e.g. pid 9999999)
    const deadPid = 9999999;
    const lockPath = path.join(projectsRoot, '.kernel-namespace-lock-proj-stale');
    await writeFile(lockPath, JSON.stringify({ pid: deadPid, createdAt: new Date(Date.now() - 60000).toISOString() }));

    // Acquiring should detect dead pid, clean up stale lock, and succeed
    const lock = tryAcquireNamespaceLock(projectsRoot, 'proj-stale');
    assert.ok(lock, 'Lock should be acquired after cleaning up dead owner lock');
    assert.equal(assertTestRecord(lock).lockPath, lockPath);
    releaseNamespaceLock(lock);
  } finally {
    await cleanup(fixture);
  }
});

test('Wave 4: Same-batch duplicate candidates are deduplicated and already-committed knowledge is idempotent no-change', async () => {
  const fixture = await setup();
  const cp = await createKernelControlPlane({
    runtimeHome: fixture.runtimeHome,
    projectRoot: fixture.worktreeA,
    env: {
      ...process.env,
      MOON_RELAY_KERNEL_SESSION_ID: 'codex:session-w4',
      MOON_RELAY_KERNEL_PROVIDER: 'codex',
    },
  });

  try {
    const runId1 = 'r-w4-batch-dedup';
    await cp.startRun({
      runId: runId1,
      objective: 'w4 dedup feature',
      taskContract: {
        riskTier: 'T0',
        acceptance: [{
          acceptance: 'unit works',
          evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test'], obligationId: 'default' },
        }],
        allowedPaths: ['app.mjs'],
      },
    });

    await cp.transition(runId1, 'EXECUTE');
    await cp.transition(runId1, 'PROVE');
    await cp.recordProof(runId1, {
      obligationId: 'default',
      status: 'passed',
      evidenceRef: 'ev-w4-1',
      commandRef: 'test',
      command: 'node -e "process.exit(0)"',
      exitCode: 0,
      evidenceDigest: `sha256:${'c'.repeat(64)}`,
      acceptanceCoverage: ['unit works'],
    });
    await cp.transition(runId1, 'CLOSE');

    const store = cp.stateStore;
    const run = store.getRun(runId1);
    store.recordCompletionDecision(runId1, {
      decision: 'accepted',
      sourceIdentity: assertTestPresent(run).sourceIdentity,
      mutationRevision: assertTestPresent(run).mutationRevision,
      evidenceDigest: `sha256:${'c'.repeat(64)}`,
      decisionJson: { decision: 'accepted' },
    });

    // Finalize with 2 identical observations in the same batch
    const receipt1 = await cp.finalizeRun(runId1, {
      knowledgeObservations: [
        { proposedType: 'semantic_fact', statement: 'Database uses WAL mode', scope: ['db.sqlite'] },
        { proposedType: 'semantic_fact', statement: '  Database uses WAL mode  ', scope: ['db.sqlite'] }, // duplicate with whitespace
      ],
    });

    assert.equal(assertTestRecord(receipt1).completionStatus, 'accepted');
    assert.equal(assertTestRecord(receipt1).knowledgeStatus, 'committed');
    assert.equal(store.getProjectKnowledgeRevision(assertTestString(assertTestPresent(run).projectId)), 2, 'Revision should advance from 1 to 2');

    // Verify only 1 record was committed
    const committedRecords = store.listKnowledgeRecords({ projectId: assertTestPresent(run).projectId, statuses: ['committed'] });
    const walRecords = committedRecords.filter((r) => assertTestString(r.statement).toLowerCase().includes('database uses wal mode'));
    assert.equal(walRecords.length, 1, 'Duplicate candidate within batch must be deduplicated to exactly 1 record');

    // Now Run 2 attempts to commit the exact same knowledge
    const runId2 = 'r-w4-idempotent';
    await cp.startRun({
      runId: runId2,
      objective: 'w4 idempotent feature',
      taskContract: {
        riskTier: 'T0',
        acceptance: [{
          acceptance: 'unit works 2',
          evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test'], obligationId: 'default' },
        }],
        allowedPaths: ['app.mjs'],
      },
    });

    await cp.transition(runId2, 'EXECUTE');
    await cp.transition(runId2, 'PROVE');
    await cp.recordProof(runId2, {
      obligationId: 'default',
      status: 'passed',
      evidenceRef: 'ev-w4-2',
      commandRef: 'test',
      command: 'node -e "process.exit(0)"',
      exitCode: 0,
      evidenceDigest: `sha256:${'d'.repeat(64)}`,
      acceptanceCoverage: ['unit works 2'],
    });
    await cp.transition(runId2, 'CLOSE');

    const run2 = store.getRun(runId2);
    store.recordCompletionDecision(runId2, {
      decision: 'accepted',
      sourceIdentity: assertTestPresent(run2).sourceIdentity,
      mutationRevision: assertTestPresent(run2).mutationRevision,
      evidenceDigest: `sha256:${'d'.repeat(64)}`,
      decisionJson: { decision: 'accepted' },
    });

    const receipt2 = await cp.finalizeRun(runId2, {
      knowledgeObservations: [
        { proposedType: 'semantic_fact', statement: 'database uses wal mode', scope: ['db.sqlite'] },
      ],
    });

    assert.equal(assertTestRecord(receipt2).completionStatus, 'accepted');
    assert.equal(assertTestRecord(receipt2).knowledgeStatus, 'no_change', 'Submitting already committed knowledge should result in no_change');
    assert.equal(store.getProjectKnowledgeRevision(assertTestString(assertTestPresent(run).projectId)), 2, 'Revision should remain 2 without inflating');
  } finally {
    await cp.close();
    await cleanup(fixture);
  }
});

test('Invariant H1: Live owner lock is never stale even if older than timeout, and freshly created incomplete lock cannot be stolen', async () => {
  const fixture = await setup();
  try {
    const projectsRoot = path.join(fixture.runtimeHome, 'state', 'projects');
    await mkdir(projectsRoot, { recursive: true });
    const { clearStaleNamespaceLock } = await import('../src/kernel/knowledge/store.js');
    const fs = await import('node:fs');

    const lockPath = path.join(projectsRoot, '.kernel-namespace-lock-proj-h1');

    // Case 1: Live owner with createdAt 1 hour ago
    const oldTimestamp = new Date(Date.now() - 3600 * 1000).toISOString();
    await writeFile(lockPath, JSON.stringify({ pid: process.pid, createdAt: oldTimestamp }), 'utf8');
    const clearedLive = clearStaleNamespaceLock(lockPath, { staleTimeoutMs: 30000 });
    assert.equal(clearedLive, false, 'Live owner process must never be cleared as stale regardless of age');

    // Case 2: Fresh incomplete lock file (empty 0-bytes, age < 30s)
    await writeFile(lockPath, '', 'utf8');
    const clearedFreshIncomplete = clearStaleNamespaceLock(lockPath, { staleTimeoutMs: 30000 });
    assert.equal(clearedFreshIncomplete, false, 'Freshly created incomplete lock file must not be cleared within timeout');

    // Case 3: Dead owner process
    await writeFile(lockPath, JSON.stringify({ pid: 99999999, createdAt: new Date().toISOString() }), 'utf8');
    const clearedDead = clearStaleNamespaceLock(lockPath, { staleTimeoutMs: 30000 });
    assert.equal(clearedDead, true, 'Dead owner lock must be cleared as stale');

    // Case 4: Corrupt old lock file (> 30s)
    await writeFile(lockPath, 'invalid json', 'utf8');
    const oldTime = (Date.now() - 60000) / 1000;
    fs.utimesSync(lockPath, oldTime, oldTime);
    const clearedOldCorrupt = clearStaleNamespaceLock(lockPath, { staleTimeoutMs: 30000 });
    assert.equal(clearedOldCorrupt, true, 'Corrupt lock file older than timeout must be cleared as stale');
  } finally {
    await cleanup(fixture);
  }
});

type TestControlPlane = Awaited<ReturnType<typeof import('../src/host/kernel/control-plane-runtime.js').createKernelControlPlane>>;
type TestStateStore = Awaited<ReturnType<typeof import('../src/kernel/state-store.js').openKernelStateStore>>;
