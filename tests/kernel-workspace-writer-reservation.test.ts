import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { readFile, readdir, mkdtemp, mkdir, rm, writeFile, link, unlink, stat } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { reserveHostWorkspaceWriter } from '../src/host/kernel/workspace-writer-reservation.js';
import { createKernelControlPlane } from '../src/host/kernel/control-plane-runtime.js';
import { prepareHostWriterAttemptWorktree, prepareStepWorktree, cleanupExecutionWorkspaces, inspectGitWorkspace } from '../src/host/kernel/workspace/physical-worktree.js';

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
};

const attemptFromAnotherHostProcess = (workspaceRoot: string, reservationRoot: string): number | null => {
  // This is the same production reservation module in a distinct OS process,
  // not a test-only reimplementation of exclusive-file creation.
  const file = import.meta.resolve('../../scripts/host/kernel/workspace-writer-reservation.js');
  const script = [
    'const { reserveHostWorkspaceWriter } = await import(process.argv[1]);',
    'try {',
    " await reserveHostWorkspaceWriter({ workspaceRoot: process.argv[2], reservationRoot: process.argv[3], runId: 'b', attemptId: 'attempt-b', workspaceId: 'workspace-b' });",
    ' process.exit(0);',
    "} catch (err) { process.exit(err?.code === 'host_writer_workspace_already_reserved' ? 29 : 28); }",
  ].join('\n');
  return spawnSync(process.execPath, ['--input-type=module', '-e', script, file, workspaceRoot, reservationRoot], {
    encoding: 'utf8', timeout: 10000,
  }).status;
};

test('Two Host processes cannot admit the same physical Workspace while the old OS Writer remains alive after Kernel TTL expiry', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'host-writer-cross-process-'));
  const workspace = path.join(temp, 'owner');
  const secondWorktree = path.join(temp, 'worker-b');
  const runtimeHome = path.join(temp, 'runtime');
  const reservationRoot = path.join(temp, 'host-reservations');
  let writer: ReturnType<typeof spawn> | null = null;
  let cp: Awaited<ReturnType<typeof createKernelControlPlane>> | null = null;
  try {
    await mkdir(workspace);
    await mkdir(reservationRoot);
    git(workspace, 'init');
    git(workspace, 'config', 'user.email', 'worker-fixture@example.invalid');
    git(workspace, 'config', 'user.name', 'Kernel Test');
    const fs = await import('node:fs/promises');
    await fs.writeFile(path.join(workspace, 'package.json'), '{"name":"worker-fixture","scripts":{"test":"node --version"}}');
    git(workspace, 'add', '--all');
    git(workspace, 'commit', '-m', 'baseline');
    git(workspace, 'worktree', 'add', '--detach', secondWorktree, 'HEAD');

    cp = await createKernelControlPlane({ runtimeHome, projectRoot: workspace });
    const runId = 'run-old-writer';
    await cp.startRun({ runId, objective: 'old Host owns writer until process settled' });
    const attempt = cp.beginAttempt(runId);
    assert.ok(attempt?.attemptId);
    const run = await cp.getRun(runId);
    assert.ok(run?.workspaceId && run.projectId);
    const first = cp.stateStore.acquireWorkspaceMutationLockV2({
      workspaceId: run.workspaceId, projectId: run.projectId, runId,
      sessionToken: 'old-host', ttlMs: 50,
    });
    assert.equal(first.acquired, true);

    const owner = await reserveHostWorkspaceWriter({
      workspaceRoot: workspace, reservationRoot, runId, attemptId: attempt.attemptId, workspaceId: run.workspaceId,
    });
    assert.equal(owner.attemptId, attempt.attemptId);
    const markers = await readdir(reservationRoot);
    assert.equal(markers.length, 1);
    const marker = await readFile(path.join(reservationRoot, markers[0]!), 'utf8');
    assert.equal(JSON.parse(marker).attemptId, attempt.attemptId);
    assert.equal((await readdir(workspace)).some(name => name.includes('writer-reservation')), false);
    const clean = spawnSync('git', ['status', '--porcelain'], { cwd: workspace, encoding: 'utf8' });
    assert.equal(clean.status, 0, clean.stderr);
    assert.equal(clean.stdout.trim(), '', 'Host reservation must not dirty the Worker Git Worktree');

    const target = path.join(workspace, 'writer.log');
    const writerScript = [
      "const fs = require('node:fs');",
      'const file = process.argv[1];',
      'let n = 0;',
      'setInterval(() => {',
      " const fd = fs.openSync(file, 'a');",
      " try { fs.writeSync(fd, String(++n) + '\\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }",
      '}, 30);',
    ].join('\n');
    writer = spawn(process.execPath, ['-e', writerScript, target], {
      cwd: workspace, stdio: 'ignore',
    });
    let count = 0;
    const deadline = Date.now() + 4000;
    while (count < 4 && Date.now() < deadline) {
      await sleep(45);
      try { count = (await readFile(target, 'utf8')).trim().split('\n').length; } catch { /* first write pending */ }
    }
    assert.ok(count >= 4, 'A must be physically writing before testing B');
    assert.equal(writer.exitCode, null);
    await sleep(120); // The existing Kernel TTL expires while Writer A survives.
    const second = cp.stateStore.acquireWorkspaceMutationLockV2({
      workspaceId: run.workspaceId, projectId: run.projectId, runId,
      sessionToken: 'new-host', ttlMs: 1000,
    });
    assert.equal(second.acquired, true, 'expired Kernel mutation lock can be reacquired');

    assert.equal(attemptFromAnotherHostProcess(workspace, reservationRoot), 29, 'Host B must be denied the same physical root');
    assert.equal(attemptFromAnotherHostProcess(path.join(workspace, '..', 'owner'), reservationRoot), 29, 'path aliases cannot bypass the guard');
    const before = (await readFile(target, 'utf8')).trim().split('\n').length;
    await sleep(120);
    assert.ok((await readFile(target, 'utf8')).trim().split('\n').length > before, 'Writer A is still writing after B denial');

    // B can only prepare a different *physical* Worktree; it cannot take over
    // the Owner or Delivery path without the pre-existing Kernel CAS.
    assert.equal(attemptFromAnotherHostProcess(secondWorktree, reservationRoot), 0);
    assert.equal(attemptFromAnotherHostProcess(secondWorktree, reservationRoot), 29, 'new Worktree also admits only once');
  } finally {
    if (writer && writer.exitCode === null) {
      writer.kill('SIGTERM');
      await Promise.race([once(writer, 'exit'), sleep(2500)]);
      if (writer.exitCode === null) {
        writer.kill('SIGKILL');
        await Promise.race([once(writer, 'exit'), sleep(1000)]);
      }
    }
    await cp?.close();
    await rm(temp, { recursive: true, force: true });
  }
});

test('A failed or unknown old Host cannot silently clear a single-use Workspace reservation', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'host-writer-unknown-'));
  try {
    const workspaceRoot = path.join(root, 'workspace');
    const reservationRoot = path.join(root, 'host-reservations');
    await mkdir(workspaceRoot);
    await mkdir(reservationRoot);
    const input = { workspaceRoot, reservationRoot, runId: 'r', attemptId: 'a', workspaceId: 'w' };
    await reserveHostWorkspaceWriter(input);
    assert.equal(attemptFromAnotherHostProcess(workspaceRoot, reservationRoot), 29, 'Host restart must observe the old reservation');
    await assert.rejects(reserveHostWorkspaceWriter(input), { code: 'host_writer_workspace_already_reserved' });
    await assert.rejects(reserveHostWorkspaceWriter({ ...input, attemptId: '' }), {
      code: 'host_writer_reservation_identity_missing',
    });
    // No release or TTL expiry API exists; only disposing the verified-safe,
    // isolated Worktree may remove the marker.
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test('A failed Kernel Attempt keeps its live OS Writer isolated while the next Attempt gets a distinct Worktree', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'host-attempt-worktrees-'));
  const repoRoot = path.join(root, 'owner');
  const runtimeHome = path.join(root, 'runtime');
  const reservationRoot = path.join(root, 'host-reservations');
  let cp: Awaited<ReturnType<typeof createKernelControlPlane>> | null = null;
  let writer: ReturnType<typeof spawn> | null = null;
  const worktrees: string[] = [];
  try {
    await mkdir(repoRoot);
    await mkdir(reservationRoot);
    git(repoRoot, 'init');
    git(repoRoot, 'config', 'user.name', 'Attempt Fixture');
    git(repoRoot, 'config', 'user.email', 'attempt@example.invalid');
    await writeFile(path.join(repoRoot, 'package.json'), '{"name":"attempt-fixture"}');
    git(repoRoot, 'add', '--all');
    git(repoRoot, 'commit', '-m', 'baseline');
    const baseCommit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).stdout.trim();
    const runId = 'run-attempt-isolation';
    cp = await createKernelControlPlane({ runtimeHome, projectRoot: repoRoot });
    await cp.startRun({ runId, objective: 'isolate physical attempts during retry' });
    const run = await cp.getRun(runId);
    const a = cp.beginAttempt(runId);
    assert.ok(run?.projectId && run.workspaceId && a?.attemptId && a.stepId);
    const args = { repoRoot, runtimeHome, baseCommit, projectId: run.projectId, runId, stepId: a.stepId };
    const wa = await prepareHostWriterAttemptWorktree({ ...args, attemptId: a.attemptId });
    worktrees.push(wa.workspaceRoot);
    assert.equal(wa.reused, false);
    const resumed = await prepareHostWriterAttemptWorktree({ ...args, attemptId: a.attemptId });
    assert.equal(resumed.workspaceRoot, wa.workspaceRoot);
    assert.equal(resumed.reused, true, 'same Attempt reuses only its own Worktree');
    await reserveHostWorkspaceWriter({
      workspaceRoot: wa.workspaceRoot, reservationRoot, runId, attemptId: a.attemptId, workspaceId: run.workspaceId,
    });
    assert.equal(attemptFromAnotherHostProcess(wa.workspaceRoot, reservationRoot), 29, 'same Attempt does not spawn a second Writer');

    const log = path.join(wa.workspaceRoot, 'writer-a.log');
    const script = "const fs=require('node:fs');let n=0;setInterval(()=>fs.appendFileSync(process.argv[1],String(++n)+'\\n'),25)";
    writer = spawn(process.execPath, ['-e', script, log], { cwd: wa.workspaceRoot, stdio: 'ignore' });
    let count = 0;
    const deadline = Date.now() + 4000;
    while (count < 3 && Date.now() < deadline) {
      await sleep(35);
      try { count = (await readFile(log, 'utf8')).trim().split('\n').length; } catch { /* first write pending */ }
    }
    assert.ok(count >= 3, 'A must be physically writing');
    cp.failStepAttempt(runId, a.stepId, { code: 'writer_exit_unknown' });
    assert.equal(cp.stateStore.getStepAttempts(runId)[0]?.status, 'failed');
    assert.equal(writer.exitCode, null, 'Kernel failure does not stop the OS writer');

    const b = cp.beginAttempt(runId, { stepId: a.stepId, retryReason: 'writer_exit_unknown' });
    assert.ok(b?.attemptId && b.attemptId !== a.attemptId);
    const wb = await prepareHostWriterAttemptWorktree({ ...args, attemptId: b.attemptId });
    worktrees.push(wb.workspaceRoot);
    assert.equal(wb.reused, false);
    assert.notEqual(wb.workspaceRoot, wa.workspaceRoot);
    assert.equal(attemptFromAnotherHostProcess(wb.workspaceRoot, reservationRoot), 0);
    await writeFile(path.join(wb.workspaceRoot, 'result-b.txt'), 'B:only\n');
    const before = (await readFile(log, 'utf8')).trim().split('\n').length;
    await sleep(140);
    assert.ok((await readFile(log, 'utf8')).trim().split('\n').length > before);
    assert.equal((await readdir(repoRoot)).some(x => x === 'writer-a.log' || x === 'result-b.txt'), false);

    await prepareStepWorktree(args);
    await cleanupExecutionWorkspaces({ ...args, retain: false });
    assert.ok((await readFile(log, 'utf8')).length > 0);
    assert.equal(await readFile(path.join(wb.workspaceRoot, 'result-b.txt'), 'utf8'), 'B:only\n');
  } finally {
    if (writer && writer.exitCode === null && writer.signalCode === null) {
      writer.kill('SIGTERM');
      await Promise.race([once(writer, 'exit'), sleep(2000)]);
      if (writer.exitCode === null && writer.signalCode === null) {
        writer.kill('SIGKILL');
        await Promise.race([once(writer, 'exit'), sleep(1000)]);
      }
    }
    // Test-only teardown after Writer A has exited; no product release API.
    for (const workspace of worktrees.reverse()) {
      const result = spawnSync('git', ['worktree', 'remove', '--force', workspace], {
        cwd: repoRoot, encoding: 'utf8', timeout: 10000,
      });
      assert.equal(result.status, 0, result.stderr);
    }
    await cp?.close();
    await rm(root, { recursive: true, force: true });
  }
});


test('Host Writer Attempt Worktrees cannot be placed inside the Owner repository', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'host-attempt-overlap-'));
  const repoRoot = path.join(root, 'owner');
  const runtimeHome = path.join(repoRoot, 'host-runtime');
  try {
    await mkdir(repoRoot);
    git(repoRoot, 'init');
    git(repoRoot, 'config', 'user.name', 'Attempt Fixture');
    git(repoRoot, 'config', 'user.email', 'attempt@example.invalid');
    await writeFile(path.join(repoRoot, 'package.json'), '{"name":"overlap-fixture"}');
    git(repoRoot, 'add', '--all');
    git(repoRoot, 'commit', '-m', 'baseline');
    await mkdir(runtimeHome);
    const baseCommit = spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot, encoding: 'utf8',
    }).stdout.trim();
    await assert.rejects(
      prepareHostWriterAttemptWorktree({
        repoRoot, runtimeHome, baseCommit, runId: 'run', stepId: 'step',
        attemptId: 'attempt', projectId: 'project',
      }),
      { code: 'WORKTREE_HOST_WRITER_OWNER_OVERLAP' },
    );
    assert.deepEqual(await readdir(runtimeHome), [], 'rejected allocation creates no Writer Worktree');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


// T45: Git cleanliness proves bytes/index, not ownership of the underlying
// inode. This is a deliberately negative trust-boundary probe. The already
// shipped Native Writer reservation remains single-use and automatic Native
// recovery must not be enabled based on a clean same-Attempt Worktree alone.
test('T45 clean reused Native Worktree can conceal a pre-existing Owner hardlink alias', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 't45-native-hardlink-admission-'));
  const owner = path.join(temp, 'owner');
  const runtimeHome = path.join(temp, 'runtime');
  let candidate: string | null = null;
  try {
    await mkdir(owner);
    await mkdir(runtimeHome);
    git(owner, 'init');
    git(owner, 'config', 'user.name', 'T45 Fixture');
    git(owner, 'config', 'user.email', 't45@example.invalid');
    await writeFile(path.join(owner, 'tracked.txt'), 'IDENTICAL_BASE\n');
    git(owner, 'add', '--all');
    git(owner, 'commit', '-m', 't45 baseline');
    const sha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: owner, encoding: 'utf8' }).stdout.trim();
    const coords = {
      repoRoot: owner, runtimeHome, baseCommit: sha, projectId: 't45-project',
      runId: 't45-run', stepId: 't45-step', attemptId: 't45-attempt',
    };
    const initial = await prepareHostWriterAttemptWorktree(coords);
    candidate = initial.workspaceRoot;
    assert.equal(initial.reused, false);
    const ownerFile = path.join(owner, 'tracked.txt');
    const attemptFile = path.join(candidate, 'tracked.txt');
    const beforeOwner = await stat(ownerFile), beforeAttempt = await stat(attemptFile);
    assert.notEqual(beforeOwner.ino, beforeAttempt.ino, 'fresh Git checkout must materialize a distinct inode');

    // An out-of-sandbox process can replace a tracked file with an Owner
    // hardlink before the new Native Host inspects the already existing root.
    await unlink(attemptFile);
    await link(ownerFile, attemptFile);
    const aliased = await stat(attemptFile);
    assert.equal(aliased.ino, (await stat(ownerFile)).ino);
    assert.ok(aliased.nlink >= 2);
    assert.equal(inspectGitWorkspace(candidate).ready, true,
      'Git clean status cannot prove physical file ownership');
    const resumed = await prepareHostWriterAttemptWorktree(coords);
    assert.equal(resumed.reused, true,
      'same-Attempt preparation currently accepts this clean inode alias');

    // An ordinary write through that in-scope pathname mutates the Owner.
    // T44 already proved the same operation can happen within macOS Native
    // workspaceWrite when the external hardlink pre-exists.
    await writeFile(attemptFile, 'OUTSIDE_MUTATED\n');
    assert.equal(await readFile(ownerFile, 'utf8'), 'OUTSIDE_MUTATED\n');
    assert.equal(inspectGitWorkspace(candidate).ready, false,
      'post-write Git state detects drift only AFTER external mutation');
  } finally {
    if (candidate) {
      // Fixture is intentionally finite and owns no native descendants.
      const r = spawnSync('git', ['worktree', 'remove', '--force', candidate], {
        cwd: owner, encoding: 'utf8',
      });
      assert.equal(r.status, 0, r.stderr);
    }
    await rm(temp, { recursive: true, force: true });
  }
});
