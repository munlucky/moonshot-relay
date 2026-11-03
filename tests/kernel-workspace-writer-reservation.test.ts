import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { readFile, readdir, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { reserveHostWorkspaceWriter } from '../src/host/kernel/workspace-writer-reservation.js';
import { createKernelControlPlane } from '../src/host/kernel/control-plane-runtime.js';

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
