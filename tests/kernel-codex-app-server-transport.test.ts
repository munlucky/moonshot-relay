import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCodexAppServerTransport } from '../src/host/kernel/codex-app-server-transport.js';
import { type NativeExecutionObservation } from '../src/host/kernel/adapter-dispatch.js';
import { createKernelControlPlane } from '../src/host/kernel/control-plane-runtime.js';
import { runHostOwnedWritableAttempt } from '../src/host/kernel/host-owned-writable-attempt.js';
import { prepareHostWriterAttemptWorktree } from '../src/host/kernel/workspace/physical-worktree.js';
import { reserveHostWorkspaceWriter } from '../src/host/kernel/workspace-writer-reservation.js';

const fakeServer = String.raw`
const readline = require('node:readline');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
let serial = 0;
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
const input = readline.createInterface({ input: process.stdin });
input.on('line', (line) => {
  const message = JSON.parse(line);
  const id = message.id;
  if (message.method === 'initialize') {
    if (process.env.TEST_MODE !== 'stall-initialize') send({ id, result: { userAgent: 'fixture' } });
  } else if (message.method === 'thread/start') {
    const expectedSandbox = process.env.TEST_MODE?.startsWith('writable') ? 'workspace-write' : 'read-only';
    if (message.params.sandbox !== expectedSandbox || message.params.approvalPolicy !== 'never') {
      send({ id, error: { code: -1, message: 'unsafe launch' } });
    } else {
      send({ id, result: { thread: { id: 'thr-' + (++serial) } } });
    }
  } else if (message.method === 'turn/start') {
    if (process.env.TEST_MODE === 'disconnect' || process.env.TEST_MODE === 'writable-disconnect') process.exit(0);
    const threadId = message.params.threadId;
    const turnId = 'turn-' + serial;
    const policy = message.params.sandboxPolicy;
    const workspaceWrite = process.env.TEST_MODE?.startsWith('writable');
    const allowed = workspaceWrite
      ? policy?.type === 'workspaceWrite'
        && policy?.networkAccess === false
        && policy?.excludeSlashTmp === true
        && policy?.excludeTmpdirEnvVar === true
        && Array.isArray(policy?.writableRoots)
        && policy.writableRoots.length === 1
        && policy.writableRoots[0] === message.params.cwd
      : policy?.type === 'readOnly';
    if (!allowed || !message.params.model || !message.params.effort) {
      send({ id, error: { code: -1, message: 'unsafe turn' } });
      return;
    }
    if (process.env.TEST_MODE === 'writable') {
      fs.writeFileSync(path.join(message.params.cwd, 'mock-writer-started.txt'), 'started');
    }
    if (process.env.TEST_MODE === 'writable-detached-descendant') {
      // Real OS child with its own process group. The fake server completes
      // its Turn while this bounded Writer continues independently.
      const script = [
        "const fs=require('node:fs');",
        "fs.writeFileSync(process.argv[2],String(process.pid));",
        'let n=0;',
        "const timer=setInterval(()=>{const fd=fs.openSync(process.argv[1],'a');try{fs.writeSync(fd,String(++n)+'\\n');fs.fsyncSync(fd)}finally{fs.closeSync(fd)}if(n>=105){clearInterval(timer);process.exit(0)}},25);",
      ].join('');
      const child = spawn(process.execPath, [
        '-e', script,
        path.join(message.params.cwd, 'detached-writer.log'),
        path.join(message.params.cwd, 'detached-writer.pid'),
      ], { cwd: message.params.cwd, stdio: 'ignore', detached: true });
      child.unref();
    }
    if (process.env.TEST_MODE === 'stall-turn') {
      send({ id, result: { turn: { id: turnId, status: 'inProgress' } } });
      return;
    }
    // A real App Server may stream items before turn/start ACK.
    send({ method: 'item/started', params: { threadId, turnId, item: { type: 'commandExecution', id: 'cmd-' + serial, processId: 1454, command: 'fixture raw command', output: 'fixture private output', owner: { attemptId: 'forged' } } } });
    send({ method: 'item/started', params: { threadId: 'other-thread', turnId, item: { type: 'commandExecution', id: 'wrong-thread', processId: 4 } } });
    send({ id, result: { turn: { id: turnId, status: 'inProgress' } } });
    setTimeout(() => {
      send({ method: 'item/completed', params: { threadId, turnId, item: { type: 'commandExecution', id: 'cmd-' + serial, processId: 1454 } } });
      // Turn lifecycle notifications identify the Turn by turn.id, unlike
      // item notifications which include params.turnId.
      send({ method: 'turn/completed', params: { threadId, turn: { id: 'wrong-turn', status: 'interrupted' } } });
      send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed' } } });
    }, 25);
  }
});
`;

const withFixture = async <T>(
  fn: (input: { workspace: string; alternative: string; server: string; reservationRoot: string }) => Promise<T>,
): Promise<T> => {
  const root = await mkdtemp(path.join(tmpdir(), 'codex-app-server-fixture-'));
  try {
    const workspace = path.join(root, 'first');
    const alternative = path.join(root, 'second');
    const server = path.join(root, 'mock-app-server.cjs');
    const reservationRoot = path.join(root, 'host-reservations');
    await mkdir(workspace);
    await mkdir(alternative);
    await mkdir(reservationRoot);
    await writeFile(server, fakeServer);
    return await fn({ workspace, alternative, server, reservationRoot });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const turn = (cwd: string) => ({
  cwd, prompt: 'read-only lifecycle fixture', model: 'test-model', effort: 'high',
  timeoutMs: 3000,
});

test('Host owns one App Server process, binds early and later command events, and keeps Writer exit unverified', async () => {
  await withFixture(async ({ workspace, alternative, server }) => {
    const transport = await createCodexAppServerTransport({
      executable: process.execPath, args: [server], requestTimeoutMs: 1500,
    });
    const owner = { runId: 'run-a', stepId: 'step-a', attemptId: 'attempt-a', workspaceId: 'workspace-a' };
    const seen: NativeExecutionObservation[] = [];
    try {
      const first = transport.runTurn({
        ...turn(workspace),
        executionOwner: owner,
        onNativeExecution: (observation) => { seen.push(observation); },
      });
      await assert.rejects(transport.runTurn(turn(alternative)), { code: 'codex_app_server_turn_already_running' });
      const result = await first;
      assert.equal(result.turnStatus, 'completed');
      assert.equal(result.writerExitVerified, false);
      assert.equal(result.threadId, 'thr-1');
      assert.equal(result.turnId, 'turn-1');
      assert.deepEqual(seen.map(item => item.method), ['item/started', 'item/completed']);
      assert.deepEqual(seen.map(item => item.processId), ['1454', '1454']);
      assert.ok(seen.every(item => !('command' in item) && !('output' in item) && !('osPid' in item)));
      await assert.rejects(transport.runTurn({ ...turn(alternative), executionOwner: owner }), {
        code: 'codex_app_server_observation_owner_required',
      });
      assert.ok(seen.every(item => item.attemptId === owner.attemptId && item.workspaceId === owner.workspaceId));
      assert.ok(seen.every(item => item.threadId === result.threadId && item.turnId === result.turnId));

      await assert.rejects(transport.runTurn(turn(workspace)), { code: 'codex_app_server_workspace_reuse_unverified' });
      // Distinct physical Workspace may start; this is NOT an Owner Delivery.
      const second = await transport.runTurn(turn(alternative));
      assert.equal(second.threadId, 'thr-2');
      assert.equal(second.turnStatus, 'completed');
      assert.equal(second.writerExitVerified, false);
      const alias = path.join(workspace, '..', 'first');
      await assert.rejects(transport.runTurn(turn(alias)), { code: 'codex_app_server_workspace_reuse_unverified' });
    } finally {
      const closed = await transport.close();
      assert.equal(closed.writerExitVerified, false);
      assert.equal(closed.appServerExited, true);
    }
  });
});

test('Host connection loss makes the in-flight Turn unknown without replaying it', async () => {
  await withFixture(async ({ workspace, server }) => {
    const transport = await createCodexAppServerTransport({
      executable: process.execPath, args: [server], requestTimeoutMs: 1500,
      env: { ...process.env, TEST_MODE: 'disconnect' },
    });
    try {
      await assert.rejects(transport.runTurn(turn(workspace)), { code: 'codex_app_server_connection_lost' });
      await assert.rejects(transport.runTurn(turn(workspace)), { code: 'codex_app_server_unavailable' });
    } finally {
      const close = await transport.close();
      assert.equal(close.writerExitVerified, false);
    }
  });
});

test('An unfinished Turn times out and prevents another dispatch on the same connection', async () => {
  await withFixture(async ({ workspace, alternative, server }) => {
    const transport = await createCodexAppServerTransport({
      executable: process.execPath, args: [server], requestTimeoutMs: 1500,
      env: { ...process.env, TEST_MODE: 'stall-turn' },
    });
    try {
      await assert.rejects(transport.runTurn({ ...turn(workspace), timeoutMs: 80 }), { code: 'codex_app_server_turn_timeout' });
      await assert.rejects(transport.runTurn(turn(alternative)), { code: 'codex_app_server_unavailable' });
    } finally {
      const closed = await transport.close();
      assert.equal(closed.writerExitVerified, false);
    }
  });
});

test('Initialize request timeout rejects and does not construct a reusable Host transport', async () => {
  await withFixture(async ({ server }) => {
    await assert.rejects(createCodexAppServerTransport({
      executable: process.execPath, args: [server],
      requestTimeoutMs: 120,
      env: { ...process.env, TEST_MODE: 'stall-initialize' },
    }), { code: 'codex_app_server_rpc_timeout' });
  });
});


test('A real Kernel Run/Attempt owns observed Native command handles; Turn completion cannot settle the Attempt', async () => {
  await withFixture(async ({ workspace, server }) => {
    const git = spawnSync('git', ['init'], { cwd: workspace, encoding: 'utf8' });
    assert.equal(git.status, 0, git.stderr);
    await writeFile(path.join(workspace, 'package.json'), JSON.stringify({
      name: 'isolated-host-attempt-fixture',
      scripts: { 'test:fixture': 'node --version' },
    }));
    const runId = 'run-host-owned-app-server';
    const controlPlane = await createKernelControlPlane({
      runtimeHome: path.join(path.dirname(workspace), 'kernel-state'),
      projectRoot: workspace,
    });
    let transport: Awaited<ReturnType<typeof createCodexAppServerTransport>> | null = null;
    try {
      await controlPlane.startRun({ runId, objective: 'track native read-only command identity' });
      const attempt = controlPlane.beginAttempt(runId);
      assert.ok(attempt?.attemptId);
      assert.ok(attempt.stepId);
      const run = await controlPlane.getRun(runId);
      assert.ok(run?.workspaceId);
      const owner = {
        runId,
        stepId: attempt.stepId,
        attemptId: attempt.attemptId,
        workspaceId: run.workspaceId,
      };
      const observed: NativeExecutionObservation[] = [];
      transport = await createCodexAppServerTransport({
        executable: process.execPath, args: [server], requestTimeoutMs: 1500,
      });
      const result = await transport.runTurn({
        ...turn(workspace),
        executionOwner: owner,
        onNativeExecution: event => { observed.push(event); },
      });
      assert.equal(result.turnStatus, 'completed');
      assert.equal(result.writerExitVerified, false);
      assert.equal(observed.length, 2);
      assert.deepEqual(observed.map(item => item.itemId), ['cmd-1', 'cmd-1']);
      assert.ok(observed.every(item => item.runId === runId
        && item.stepId === attempt.stepId
        && item.attemptId === attempt.attemptId
        && item.workspaceId === run.workspaceId));
      assert.ok(observed.every(item => item.threadId === result.threadId && item.turnId === result.turnId));
      const stillActive = controlPlane.stateStore.getActiveStepAttempt(runId, { stepId: attempt.stepId });
      assert.equal(stillActive?.status, 'started', 'Native event observation has no Kernel report/complete authority');
      // The process-only close result cannot be treated as a writer stop receipt.
      const closed = await transport.close();
      assert.equal(closed.writerExitVerified, false);
      assert.equal(controlPlane.stateStore.getActiveStepAttempt(runId, { stepId: attempt.stepId })?.status, 'started');
    } finally {
      await transport?.close();
      await controlPlane.close();
    }
  });
});


test('A Host observer exception poisons the Native connection instead of producing a false completion', async () => {
  await withFixture(async ({ workspace, alternative, server }) => {
    const transport = await createCodexAppServerTransport({
      executable: process.execPath, args: [server], requestTimeoutMs: 1500,
    });
    const owner = { runId: 'run-throw', stepId: 'step-throw', attemptId: 'attempt-throw', workspaceId: 'workspace-throw' };
    try {
      await assert.rejects(transport.runTurn({
        ...turn(workspace),
        executionOwner: owner,
        onNativeExecution: () => { throw new Error('host observation sink unavailable'); },
      }), { code: 'codex_app_server_observer_failed' });
      await assert.rejects(transport.runTurn(turn(alternative)), { code: 'codex_app_server_unavailable' });
    } finally {
      const closed = await transport.close();
      assert.equal(closed.writerExitVerified, false);
    }
  });
});


test('Opt-in writable Host Turn requires a protected external reservation before starting a Native RPC', async () => {
  await withFixture(async ({ workspace, alternative, server, reservationRoot }) => {
    const options = {
      executable: process.execPath, args: [server], requestTimeoutMs: 1500,
      env: { ...process.env, TEST_MODE: 'writable' },
    };
    const owner = { runId: 'run-a', stepId: 'step-a', attemptId: 'attempt-a', workspaceId: 'workspace-a' };
    const a = await createCodexAppServerTransport(options);
    const b = await createCodexAppServerTransport(options);
    const seen: NativeExecutionObservation[] = [];
    const writable = (cwd: string) => ({
      ...turn(cwd), executionOwner: owner,
      onNativeExecution: (item: NativeExecutionObservation) => { seen.push(item); },
      writableWorker: { reservationRoot },
    });
    try {
      await assert.rejects(a.runTurn({ ...turn(workspace), writableWorker: { reservationRoot } }), {
        code: 'codex_app_server_observation_owner_required',
      });
      assert.deepEqual(await readdir(reservationRoot), [], 'invalid ownership must not reserve a Workspace');

      const first = a.runTurn(writable(workspace));
      const firstResult = await first;
      assert.equal(firstResult.turnStatus, 'completed');
      assert.equal(firstResult.writerExitVerified, false);
      assert.equal(await readFile(path.join(workspace, 'mock-writer-started.txt'), 'utf8'), 'started');
      assert.ok(seen.length >= 2 && seen.every(item => item.attemptId === owner.attemptId));
      assert.equal((await readdir(reservationRoot)).length, 1);
      assert.equal((await readdir(workspace)).some(entry => entry.startsWith('writer-')), false);

      await assert.rejects(b.runTurn(writable(workspace)), {
        code: 'host_writer_workspace_already_reserved',
      });
      await assert.rejects(b.runTurn(writable(path.join(workspace, '..', 'first'))), {
        code: 'host_writer_workspace_already_reserved',
      });
      // B did not even call thread/start for a denied Workspace.
      const second = await b.runTurn(writable(alternative));
      assert.equal(second.threadId, 'thr-1');
      assert.equal(second.turnStatus, 'completed');
      assert.equal((await readdir(reservationRoot)).length, 2);

      const aClosed = await a.close();
      assert.equal(aClosed.writerExitVerified, false);
      const restartedHost = await createCodexAppServerTransport(options);
      try {
        await assert.rejects(restartedHost.runTurn(writable(workspace)), {
          code: 'host_writer_workspace_already_reserved',
        });
      } finally {
        await restartedHost.close();
      }
    } finally {
      await a.close();
      await b.close();
    }
  });
});

test('Writable admission refuses a reservation directory inside the Worker Workspace', async () => {
  await withFixture(async ({ workspace, server }) => {
    const transport = await createCodexAppServerTransport({
      executable: process.execPath, args: [server], requestTimeoutMs: 1500,
      env: { ...process.env, TEST_MODE: 'writable' },
    });
    const owner = { runId: 'run-a', stepId: 'step-a', attemptId: 'attempt-a', workspaceId: 'workspace-a' };
    try {
      await assert.rejects(transport.runTurn({
        ...turn(workspace), executionOwner: owner,
        onNativeExecution: () => undefined,
        writableWorker: { reservationRoot: workspace },
      }), { code: 'host_writer_reservation_root_inside_workspace' });
      assert.equal((await readdir(workspace)).length, 0, 'failed admission must not write into the Workspace');
    } finally {
      await transport.close();
    }
  });
});


test('A Canonical Kernel Attempt owns an opt-in writable Turn without granting Kernel completion', async () => {
  await withFixture(async ({ workspace, server, reservationRoot }) => {
    const initialized = spawnSync('git', ['init'], { cwd: workspace, encoding: 'utf8' });
    assert.equal(initialized.status, 0, initialized.stderr);
    await writeFile(path.join(workspace, 'package.json'), JSON.stringify({
      name: 'writable-attempt-fixture', scripts: { 'test:fixture': 'node --version' },
    }));
    const cp = await createKernelControlPlane({
      runtimeHome: path.join(path.dirname(workspace), 'kernel-state'),
      projectRoot: workspace,
    });
    let transport: Awaited<ReturnType<typeof createCodexAppServerTransport>> | null = null;
    try {
      const runId = 'run-isolated-writable-attempt';
      await cp.startRun({ runId, objective: 'writable test only with existing Kernel Attempt' });
      const attempt = cp.beginAttempt(runId);
      const run = await cp.getRun(runId);
      assert.ok(attempt?.attemptId && attempt.stepId && run?.workspaceId);
      const owner = {
        runId, stepId: attempt.stepId, attemptId: attempt.attemptId, workspaceId: run.workspaceId,
      };
      const seen: NativeExecutionObservation[] = [];
      transport = await createCodexAppServerTransport({
        executable: process.execPath, args: [server], requestTimeoutMs: 1500,
        env: { ...process.env, TEST_MODE: 'writable' },
      });
      const result = await transport.runTurn({
        ...turn(workspace), executionOwner: owner,
        onNativeExecution: (event) => { seen.push(event); },
        writableWorker: { reservationRoot },
      });
      assert.equal(result.turnStatus, 'completed');
      assert.equal(result.writerExitVerified, false);
      assert.equal((await readdir(reservationRoot)).length, 1);
      assert.ok(seen.length >= 2 && seen.every(event =>
        event.runId === runId && event.stepId === attempt.stepId
        && event.attemptId === attempt.attemptId && event.workspaceId === run.workspaceId));
      assert.equal(cp.stateStore.getActiveStepAttempt(runId, { stepId: attempt.stepId })?.status, 'started');
      assert.equal((await transport.close()).writerExitVerified, false);
      assert.equal(cp.stateStore.getActiveStepAttempt(runId, { stepId: attempt.stepId })?.status, 'started');
    } finally {
      await transport?.close();
      await cp.close();
    }
  });
});


test('Explicit Host-owned Writable runner binds a real Kernel Attempt and a separate physical Worktree without creating a completion Receipt', async () => {
  await withFixture(async ({ workspace, alternative, server, reservationRoot }) => {
    const git = (...args: string[]) => {
      const result = spawnSync('git', args, { cwd: workspace, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    git('init');
    git('config', 'user.name', 'Kernel Host Writer Fixture');
    git('config', 'user.email', 'host-writer@example.invalid');
    await writeFile(path.join(workspace, 'package.json'), '{"name":"host-owned-writable-fixture"}');
    git('add', '--all');
    git('commit', '-m', 'baseline');
    const baseCommit = git('rev-parse', 'HEAD');
    const runtimeHome = path.join(path.dirname(workspace), 'kernel-runtime');
    const cp = await createKernelControlPlane({ runtimeHome, projectRoot: workspace });
    const runId = 'run-canonical-host-writable';
    const ownedWorktrees: string[] = [];
    const seen: NativeExecutionObservation[] = [];
    const input = {
      controlPlane: cp,
      repoRoot: workspace,
      runtimeHome,
      reservationRoot,
      baseCommit,
      runId,
      prompt: 'fixture command only',
      model: 'test-model',
      effort: 'high',
      turnTimeoutMs: 3000,
      onNativeExecution: (item: NativeExecutionObservation) => { seen.push(item); },
      transportOptions: {
        executable: process.execPath, args: [server], requestTimeoutMs: 1500,
        env: { ...process.env, TEST_MODE: 'writable' },
      },
    };
    try {
      await cp.startRun({ runId, objective: 'canonical Host-owned writable attempt test' });
      const a = cp.beginAttempt(runId);
      assert.ok(a?.attemptId && a.stepId);
      const first = await runHostOwnedWritableAttempt({ ...input, stepId: a.stepId, attemptId: a.attemptId });
      ownedWorktrees.push(first.workspaceRoot);
      assert.equal(first.nativeTurn.turnStatus, 'completed');
      assert.equal(first.reportAuthority, 'none');
      assert.equal(first.writerExitVerified, false);
      assert.equal(first.nativeTurn.writerExitVerified, false);
      assert.notEqual(first.workspaceRoot, workspace);
      assert.equal(first.commandEvents.length, 2);
      assert.ok(first.commandEvents.every(item => item.runId === runId
        && item.attemptId === a.attemptId && item.workspaceId === first.workspaceId));
      assert.ok(seen.length === 2);
      assert.equal(cp.getAttemptById(runId, a.attemptId)?.workspaceId, first.workspaceId);
      assert.equal(cp.getAttemptById(runId, a.attemptId)?.status, 'started');
      assert.equal((await readdir(reservationRoot)).length, 1);
      assert.equal(git('status', '--porcelain'), '', 'the Owner may not be modified by a Writable Worker');

      await assert.rejects(runHostOwnedWritableAttempt({
        ...input, stepId: a.stepId, attemptId: a.attemptId,
      }), { code: 'WORKTREE_REUSE_FAILED' });
      await assert.rejects(runHostOwnedWritableAttempt({
        ...input, repoRoot: alternative, stepId: a.stepId, attemptId: a.attemptId,
      }), { code: 'host_writable_attempt_owner_mismatch' });
      await assert.rejects(runHostOwnedWritableAttempt({
        ...input, reservationRoot: workspace, stepId: a.stepId, attemptId: a.attemptId,
      }), { code: 'host_writable_attempt_reservation_owner_overlap' });

      cp.failStepAttempt(runId, a.stepId, { code: 'unknown_old_writer' });
      assert.equal(cp.getAttemptById(runId, a.attemptId)?.status, 'failed');
      await assert.rejects(runHostOwnedWritableAttempt({
        ...input, stepId: a.stepId, attemptId: a.attemptId,
      }), { code: 'host_writable_attempt_canonical_owner_missing' });
      const b = cp.beginAttempt(runId, { stepId: a.stepId, retryReason: 'unknown_old_writer' });
      assert.ok(b?.attemptId && b.attemptId !== a.attemptId);
      const second = await runHostOwnedWritableAttempt({ ...input, stepId: b.stepId, attemptId: b.attemptId });
      ownedWorktrees.push(second.workspaceRoot);
      assert.notEqual(second.workspaceRoot, first.workspaceRoot);
      assert.notEqual(second.workspaceId, first.workspaceId);
      assert.equal(second.nativeTurn.turnStatus, 'completed');
      assert.equal(second.reportAuthority, 'none');
      assert.equal(cp.getAttemptById(runId, b.attemptId)?.status, 'started');
      assert.equal(cp.getAttemptById(runId, a.attemptId)?.status, 'failed');
      assert.equal((await readdir(reservationRoot)).length, 2);
      assert.equal(await readFile(path.join(first.workspaceRoot, 'mock-writer-started.txt'), 'utf8'), 'started');
      assert.equal(await readFile(path.join(second.workspaceRoot, 'mock-writer-started.txt'), 'utf8'), 'started');
      assert.equal(git('status', '--porcelain'), '');
    } finally {
      // Test-only teardown, no real OS Writer descendants in this fake server.
      for (const root of ownedWorktrees.reverse()) {
        const removed = spawnSync('git', ['worktree', 'remove', '--force', root], {
          cwd: workspace, encoding: 'utf8', timeout: 10000,
        });
        assert.equal(removed.status, 0, removed.stderr);
      }
      await cp.close();
    }
  });
});


test('T26: disconnected Writable Turn keeps canonical Attempt unknown and rejects another Host on the same physical Workspace', async () => {
  await withFixture(async ({ workspace, server, reservationRoot }) => {
    const git = (...args: string[]) => {
      const result = spawnSync('git', args, { cwd: workspace, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    git('init');
    git('config', 'user.name', 'Host Disconnect Fixture');
    git('config', 'user.email', 'disconnect@example.invalid');
    await writeFile(path.join(workspace, 'package.json'), '{"name":"host-connection-loss-fixture"}');
    git('add', '--all');
    git('commit', '-m', 'baseline');
    const baseCommit = git('rev-parse', 'HEAD');
    const runtimeHome = path.join(path.dirname(workspace), 'kernel-runtime');
    const cp = await createKernelControlPlane({ runtimeHome, projectRoot: workspace });
    const runId = 'run-disconnected-host-writer';
    let attemptWorkspace: string | null = null;
    try {
      await cp.startRun({ runId, objective: 'connection loss must not authorize duplicate Writer' });
      const a = cp.beginAttempt(runId);
      const run = await cp.getRun(runId);
      assert.ok(a?.stepId && a.attemptId && run?.projectId && run.workspaceId);
      const input = {
        controlPlane: cp, repoRoot: workspace, runtimeHome, reservationRoot,
        baseCommit, runId, stepId: a.stepId, attemptId: a.attemptId,
        prompt: 'writable Host connection-loss fixture', model: 'test-model',
        effort: 'high', turnTimeoutMs: 2500,
      };
      const options = {
        executable: process.execPath, args: [server], requestTimeoutMs: 1200,
        env: { ...process.env, TEST_MODE: 'writable-disconnect' },
      };
      await assert.rejects(
        runHostOwnedWritableAttempt({ ...input, transportOptions: options }),
        { code: 'codex_app_server_connection_lost' },
      );
      // App Server died immediately after receiving turn/start. The Host
      // cannot know whether a descendant process is still writing.
      const recorded = cp.getAttemptById(runId, a.attemptId);
      assert.equal(recorded?.status, 'started');
      assert.ok(recorded.workspaceId && recorded.workspaceId !== run.workspaceId);
      assert.equal((await readdir(reservationRoot)).length, 1);
      const prepared = await prepareHostWriterAttemptWorktree({
        repoRoot: workspace, runtimeHome, baseCommit,
        projectId: run.projectId, runId, stepId: a.stepId, attemptId: a.attemptId,
      });
      attemptWorkspace = prepared.workspaceRoot;
      assert.equal(prepared.reused, true);
      assert.equal((await readdir(prepared.workspaceRoot)).includes('mock-writer-started.txt'), false);

      // Even though no dirty files were left by the disconnect, a restarted
      // Host must not send a second writable command for the same Attempt.
      await assert.rejects(runHostOwnedWritableAttempt({
        ...input,
        transportOptions: {
          ...options,
          env: { ...process.env, TEST_MODE: 'writable' },
        },
      }), { code: 'host_writer_workspace_already_reserved' });
      assert.equal((await readdir(reservationRoot)).length, 1);
      assert.equal(cp.getAttemptById(runId, a.attemptId)?.status, 'started');
      assert.equal(cp.getAttemptById(runId, a.attemptId)?.workspaceId, recorded.workspaceId);
      assert.equal(git('status', '--porcelain'), '', 'Owner must remain untouched by unknown Writer');
    } finally {
      // This fake server exits without spawning any Writer descendants.
      // Test-only cleanup is not evidence for production release semantics.
      if (attemptWorkspace) {
        const removed = spawnSync('git', ['worktree', 'remove', '--force', attemptWorkspace], {
          cwd: workspace, encoding: 'utf8', timeout: 10000,
        });
        assert.equal(removed.status, 0, removed.stderr);
      }
      await cp.close();
    }
  });
});


test('T27: real detached OS Writer outlives completed Native Turn and App Server; reservation and Kernel ownership never auto-release', async () => {
  await withFixture(async ({ workspace, server, reservationRoot }) => {
    const git = (...args: string[]) => {
      const r = spawnSync('git', args, { cwd: workspace, encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      return r.stdout.trim();
    };
    git('init');
    git('config', 'user.name', 'Detached Writer Fixture');
    git('config', 'user.email', 'descendant@example.invalid');
    await writeFile(path.join(workspace, 'package.json'), '{"name":"detached-writer-fixture"}');
    git('add', '--all');
    git('commit', '-m', 'baseline');
    const baseCommit = git('rev-parse', 'HEAD');
    const runtimeHome = path.join(path.dirname(workspace), 'detached-kernel-runtime');
    const cp = await createKernelControlPlane({ runtimeHome, projectRoot: workspace });
    const runId = 'run-detached-writer-survival';
    let workerRoot: string | null = null;
    const rows = async (file: string): Promise<number> => {
      try {
        const content = (await readFile(file, 'utf8')).trim();
        return content ? content.split('\n').length : 0;
      } catch { return 0; }
    };
    try {
      await cp.startRun({ runId, objective: 'prove OS descendant survives native completed Turn and server close' });
      const attempt = cp.beginAttempt(runId);
      assert.ok(attempt?.attemptId && attempt.stepId);
      const result = await runHostOwnedWritableAttempt({
        controlPlane: cp, repoRoot: workspace, runtimeHome, reservationRoot,
        baseCommit, runId, stepId: attempt.stepId, attemptId: attempt.attemptId,
        prompt: 'test bounded descendant only', model: 'test-model', effort: 'high',
        turnTimeoutMs: 2500, transportOptions: {
          executable: process.execPath, args: [server], requestTimeoutMs: 1500,
          env: { ...process.env, TEST_MODE: 'writable-detached-descendant' },
        },
      });
      workerRoot = result.workspaceRoot;
      const file = path.join(workerRoot, 'detached-writer.log');
      const pidfile = path.join(workerRoot, 'detached-writer.pid');
      assert.equal(result.nativeTurn.turnStatus, 'completed');
      assert.equal(result.writerExitVerified, false);
      assert.equal(result.reportAuthority, 'none');
      let writerPid = 0;
      for (let i = 0; i < 30 && !writerPid; i++) {
        try { writerPid = Number((await readFile(pidfile, 'utf8')).trim()); }
        catch { await sleep(30); }
      }
      assert.ok(Number.isSafeInteger(writerPid) && writerPid > 0 && writerPid !== process.pid);
      const before = await rows(file);
      await sleep(180);
      const after = await rows(file);
      assert.ok(after > before, 'detached real OS Writer continues after Host-runner has closed its App Server');
      assert.equal(cp.getAttemptById(runId, attempt.attemptId)?.status, 'started');
      assert.equal((await readdir(reservationRoot)).length, 1);
      assert.equal(git('status', '--porcelain'), '', 'detached Writer must not mutate Owner');
      await assert.rejects(reserveHostWorkspaceWriter({
        workspaceRoot: workerRoot, reservationRoot, runId,
        attemptId: attempt.attemptId,
        workspaceId: result.workspaceId,
      }), { code: 'host_writer_workspace_already_reserved' });
      // No production code invokes Worktree/marker deletion on Turn completed.
      assert.ok((await rows(file)) > 0);
      await sleep(2850); // Test-owned child has a hard, bounded 105 x 25ms lifetime.
      const stable = await rows(file);
      await sleep(130);
      assert.equal(await rows(file), stable, 'test fixture child settled its last write');
      assert.ok(stable >= after, 'the test did not silently delete still-writing data');
      assert.equal((await readdir(reservationRoot)).length, 1,
        'even settled test-only Writer does not automatically release the reservation');
    } finally {
      // This is a bounded fixture, not a general proof of descendant exit.
      // Even an early failed assertion must wait out its finite OS Writer loop
      // before deleting the disposable Worktree.
      if (workerRoot) await sleep(2950);
      if (workerRoot) {
        const removed = spawnSync('git', ['worktree', 'remove', '--force', workerRoot], {
          cwd: workspace, encoding: 'utf8', timeout: 10000,
        });
        assert.equal(removed.status, 0, removed.stderr);
      }
      await cp.close();
    }
  });
});
