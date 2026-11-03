import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCodexAppServerTransport } from '../src/host/kernel/codex-app-server-transport.js';
import { type NativeExecutionObservation } from '../src/host/kernel/adapter-dispatch.js';
import { createKernelControlPlane } from '../src/host/kernel/control-plane-runtime.js';

const fakeServer = String.raw`
const readline = require('node:readline');
let serial = 0;
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
const input = readline.createInterface({ input: process.stdin });
input.on('line', (line) => {
  const message = JSON.parse(line);
  const id = message.id;
  if (message.method === 'initialize') {
    if (process.env.TEST_MODE !== 'stall-initialize') send({ id, result: { userAgent: 'fixture' } });
  } else if (message.method === 'thread/start') {
    if (message.params.sandbox !== 'read-only' || message.params.approvalPolicy !== 'never') {
      send({ id, error: { code: -1, message: 'unsafe launch' } });
    } else {
      send({ id, result: { thread: { id: 'thr-' + (++serial) } } });
    }
  } else if (message.method === 'turn/start') {
    if (process.env.TEST_MODE === 'disconnect') process.exit(0);
    const threadId = message.params.threadId;
    const turnId = 'turn-' + serial;
    if (message.params.sandboxPolicy?.type !== 'readOnly' || !message.params.model || !message.params.effort) {
      send({ id, error: { code: -1, message: 'unsafe turn' } });
      return;
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
  fn: (input: { workspace: string; alternative: string; server: string }) => Promise<T>,
): Promise<T> => {
  const root = await mkdtemp(path.join(tmpdir(), 'codex-app-server-fixture-'));
  try {
    const workspace = path.join(root, 'first');
    const alternative = path.join(root, 'second');
    const server = path.join(root, 'mock-app-server.cjs');
    await mkdir(workspace);
    await mkdir(alternative);
    await writeFile(server, fakeServer);
    return await fn({ workspace, alternative, server });
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
