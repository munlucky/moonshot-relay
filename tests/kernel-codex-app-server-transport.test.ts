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
import { runHostOwnedWritableAttempt, startHostOwnedWritableAttempt } from '../src/host/kernel/host-owned-writable-attempt.js';
import { createHostWorkerSessions } from '../src/host/kernel/host-worker-sessions.js';
import { prepareHostWriterAttemptWorktree, snapshotHostWorkerPatch } from '../src/host/kernel/workspace/physical-worktree.js';
import { reserveHostWorkspaceWriter } from '../src/host/kernel/workspace-writer-reservation.js';
import { verifyHostOwnedWorkerCandidate, settleHostOwnedWorkerCandidate } from '../src/host/kernel/parallel-dispatcher.js';
import { CODEX_WORKER_OUTPUT_SCHEMA } from '../src/host/kernel/adapters/codex.js';
import { executeTrustedProof } from '../src/host/kernel/proof/proof-executor.js';
import { assertTestRecord } from './helpers/assert-value.js';

const fakeServer = String.raw`
const readline = require('node:readline');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
let serial = 0;
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
const input = readline.createInterface({ input: process.stdin });
if (process.env.TEST_MODE === 'ignore-term' || process.env.TEST_MODE === 'stall-initialize-ignore-term') {
  process.on('SIGTERM', () => fs.writeFileSync(path.join(process.env.TEST_PID_DIR,'term-observed'),'yes'));
  fs.writeFileSync(path.join(process.env.TEST_PID_DIR,'app-server.pid'),String(process.pid));
  // Bounded test-owned process; never kill an arbitrary PID read from a file.
  setTimeout(() => process.exit(0), 15000);
}
input.on('line', (line) => {
  const message = JSON.parse(line);
  const id = message.id;
  if (message.method === 'initialize') {
    if (process.env.TEST_MODE !== 'stall-initialize' && process.env.TEST_MODE !== 'stall-initialize-ignore-term') send({ id, result: { userAgent: 'fixture' } });
  } else if (message.method === 'config/read') {
    send({ id, result: process.env.TEST_MODE === 'tool-config-missing' ? {} : { config: {
      mcp_servers: { external: { command: 'must-not-inherit' } },
      apps: { external: { enabled: true } }, plugins: { external: { enabled: true } },
    } } });
  } else if (message.method === 'thread/start') {
    if (process.env.TEST_MODE?.startsWith('no-tools')) {
      const c = message.params.config;
      if (c.features.shell_tool !== false || c.features.apps !== false || c.features.multi_agent !== false
        || c.mcp_servers.external.enabled !== false || c.apps.external.enabled !== false
        || c.plugins.external.enabled !== false || c.web_search !== 'disabled'
        || JSON.stringify(c).includes('must-not-inherit')) throw Error('missing no-tools configuration');
    }
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
    if (process.env.TEST_MODE === 'completion-before-start-ack' && serial === 1) {
      process.stdout.write([
        { method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed' } } },
        { id, result: { turn: { id: turnId, status: 'completed' } } },
      ].map(message => JSON.stringify(message)).join('\n') + '\n');
      return;
    }
    if (process.env.TEST_MODE === 'writable' || process.env.TEST_MODE?.startsWith('writable-report')) {
      fs.writeFileSync(path.join(message.params.cwd, 'mock-writer-started.txt'), process.env.TEST_WRITER_CONTENT || 'started');
    }
    const reportEvent = (thread, itemId = 'final-report', text = process.env.TEST_REPORT_TEXT) => ({
      method: 'item/completed', params: { threadId: thread, turnId,
        item: { type: 'agentMessage', id: itemId, phase: 'final_answer', text: text || JSON.stringify({
          status: 'completed', summary: 'Actual fixture Worker report',
          changedPaths: ['mock-writer-started.txt'], risks: [],
          verifications: [{ obligationId: 'default', commandRef: 'test:fixture', acceptanceCoverage: ['AC-1'] }],
          requestedVerifications: [], judgments: [], knowledgeObservations: [], blocker: null,
        }) } },
    });
    if (process.env.TEST_MODE?.includes('report')) {
      if (!message.params.outputSchema || message.params.outputSchema.additionalProperties !== false) throw Error('missing output schema');
      send(reportEvent('other-thread', 'forged-report', '{"status":"completed"}'));
      send({ method: 'item/completed', params: { threadId, turnId,
        item: { type: 'agentMessage', id: 'commentary', phase: 'commentary', text: 'Not a report' } } });
      send(reportEvent(threadId)); // Before the turn/start ACK.
      if (process.env.TEST_MODE === 'writable-report-ambiguous') send(reportEvent(threadId, 'different-report'));
      else send(reportEvent(threadId)); // Exact event replay is harmless.
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
    if (process.env.TEST_MODE === 'approval-request') {
      // Server request and client turn/start may independently use the same
      // ID. A request must never be mistaken for the successful Turn ACK.
      send({ id, method: 'item/commandExecution/requestApproval',
        params: { threadId, turnId, command: 'fixture-approval-request' } });
      send({ id, result: { turn: { id: turnId, status: 'inProgress' } } });
      return;
    }
    if (process.env.TEST_MODE === 'stall-turn' || process.env.TEST_MODE === 'writable-stall-turn'
      || (process.env.TEST_MODE === 'completion-without-interrupt-ack' && serial === 1)) {
      send({ id, result: { turn: { id: turnId, status: 'inProgress' } } });
      return;
    }
    // A real App Server may stream items before turn/start ACK.
    if (process.env.TEST_MODE !== 'no-tools-late') send({ method: 'item/started', params: { threadId, turnId, item: { type: 'commandExecution', id: 'cmd-' + serial, processId: 1454, command: 'fixture raw command', output: 'fixture private output', owner: { attemptId: 'forged' } } } });
    send({ method: 'item/started', params: { threadId: 'other-thread', turnId, item: { type: 'commandExecution', id: 'wrong-thread', processId: 4 } } });
    send({ id, result: { turn: { id: turnId, status: 'inProgress' } } });
    setTimeout(() => {
      if (process.env.TEST_MODE !== 'no-tools-late') send({ method: 'item/completed', params: { threadId, turnId, item: { type: 'commandExecution', id: 'cmd-' + serial, processId: 1454 } } });
      // Turn lifecycle notifications identify the Turn by turn.id, unlike
      // item notifications which include params.turnId.
      send({ method: 'turn/completed', params: { threadId, turn: { id: 'wrong-turn', status: 'interrupted' } } });
      send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed' } } });
      if (process.env.TEST_MODE === 'no-tools-late') send({ method: 'item/completed', params: {
        threadId, turnId, item: { type: 'commandExecution', id: 'late' } } });
      if (process.env.TEST_MODE?.includes('report')) send(reportEvent(threadId, 'late-report', '{"status":"failed"}'));
    }, process.env.TEST_MODE === 'completion-without-interrupt-ack' ? 1500 : 25);
  } else if (message.method === 'turn/interrupt') {
    if (process.env.TEST_MODE === 'completion-before-start-ack') {
      fs.writeFileSync(path.join(process.env.TEST_PID_DIR, 'late-interrupt'), message.params.turnId);
    }
    if (process.env.TEST_MODE === 'completion-without-interrupt-ack') {
      const { threadId, turnId } = message.params;
      send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed' } } });
      return;
    }
    if (process.env.TEST_MODE === 'stall-turn' || process.env.TEST_MODE === 'writable-stall-turn') {
      send({ id, result: {} });
      send({ method: 'turn/completed', params: {
        threadId: message.params.threadId,
        turn: { id: message.params.turnId, status: 'interrupted' },
      } });
    } else {
      send({ id, error: { code: -1, message: 'turn not interruptible' } });
    }
  }
});
`;

const withFixture = async <T>(
  fn: (input: { workspace: string; alternative: string; server: string; reservationRoot: string }) => Promise<T>,
): Promise<T> => {
  const root = await mkdtemp(path.join(tmpdir(), 'kas-'));
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

test('Windows default Codex command launches an npm .cmd shim without a model call',
  { skip: process.platform !== 'win32' }, async () => {
    await withFixture(async ({ workspace, server }) => {
      await writeFile(path.join(workspace, 'codex.cmd'),
        `@echo off\r\n"${process.execPath}" "${server}" %*\r\n`);
      const env = { ...process.env };
      const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') || 'Path';
      env[pathKey] = workspace + path.delimiter + (env[pathKey] || '');
      const transport = await createCodexAppServerTransport({
        cwd: process.cwd(), env, requestTimeoutMs: 1500,
      });
      try {
        const result = await transport.runTurn(turn(workspace));
        assert.equal(result.turnStatus, 'completed');
        assert.equal(result.threadId, 'thr-1');
      } finally { await transport.close(); }
    });
  });

test('No-tools generation disables configured catalogs and rejects early or trailing execution events', async () => {
  for (const mode of ['no-tools', 'no-tools-late', 'tool-config-missing']) await withFixture(async ({ workspace, server }) => {
    const transport = await createCodexAppServerTransport({ executable: process.execPath, args: [server],
      env: { ...process.env, TEST_MODE: mode }, requestTimeoutMs: 1500 });
    try {
      await assert.rejects(transport.runTurn({ ...turn(workspace), toolPolicy: 'none' }), {
        code: mode === 'tool-config-missing' ? 'codex_app_server_tool_config_unavailable' : 'codex_app_server_tool_event_forbidden',
      });
      assert.equal((await transport.close()).writerExitVerified, false);
    } finally { await transport.close(); }
  });
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

test('Host observes the active Native Turn and requests one interrupt without treating ACK as Writer exit', async () => {
  await withFixture(async ({ workspace, server }) => {
    const transport = await createCodexAppServerTransport({
      executable: process.execPath, args: [server], requestTimeoutMs: 1500,
      env: { ...process.env, TEST_MODE: 'stall-turn' },
    });
    try {
      assert.equal(transport.observeTurn().turn, 'idle');
      assert.equal((await transport.interruptActiveTurn()).status, 'not-running');
      const running = transport.runTurn({ ...turn(workspace), timeoutMs: 2500 });
      let observation = transport.observeTurn();
      for (let i = 0; i < 100 && observation.turn !== 'running'; i++) {
        await sleep(10);
        observation = transport.observeTurn();
      }
      assert.equal(observation.connection, 'connected');
      assert.equal(observation.turn, 'running');
      assert.equal(observation.threadId, 'thr-1');
      assert.equal(observation.turnId, 'turn-1');
      assert.equal(observation.writerExitVerified, false);
      const signals = await Promise.all([transport.interruptActiveTurn(), transport.interruptActiveTurn()]);
      assert.deepEqual(signals, [
        { status: 'requested', writerExitVerified: false },
        { status: 'requested', writerExitVerified: false },
      ]);
      const result = await running;
      assert.equal(result.turnStatus, 'interrupted');
      assert.equal(result.writerExitVerified, false);
      assert.equal(transport.observeTurn().turn, 'idle');
      assert.equal((await transport.interruptActiveTurn()).status, 'not-running');
    } finally {
      await transport.close();
      assert.equal(transport.observeTurn().connection, 'unavailable');
      assert.equal(transport.observeTurn().turn, 'unknown');
      assert.equal((await transport.interruptActiveTurn()).status, 'unavailable');
    }
  });
});

test('Host queues an early cancel until the same Turn is addressable without claiming Writer exit', async () => {
  await withFixture(async ({ workspace, server }) => {
    const transport = await createCodexAppServerTransport({
      executable: process.execPath, args: [server], requestTimeoutMs: 1500,
      env: { ...process.env, TEST_MODE: 'stall-turn' },
    });
    try {
      const running = transport.runTurn({ ...turn(workspace), timeoutMs: 2500 });
      const first = await transport.interruptActiveTurn();
      const second = await transport.interruptActiveTurn();
      assert.deepEqual([first, second], [
        { status: 'queued', writerExitVerified: false },
        { status: 'queued', writerExitVerified: false },
      ]);
      assert.equal(transport.observeTurn().turn, 'interrupt-requested');
      const finished = await running;
      assert.equal(finished.turnStatus, 'interrupted');
      assert.equal(finished.writerExitVerified, false);
      assert.equal(transport.observeTurn().turn, 'idle');
    } finally {
      await transport.close();
    }
  });
});

test('B cancel race: a buffered terminal event wins over queued cancel for that Turn', async () => {
  await withFixture(async ({ workspace, alternative, server }) => {
    const transport = await createCodexAppServerTransport({
      executable: process.execPath, args: [server], requestTimeoutMs: 1500,
      env: { ...process.env, TEST_MODE: 'completion-before-start-ack', TEST_PID_DIR: workspace },
    });
    try {
      const running = transport.runTurn(turn(workspace));
      assert.equal((await transport.interruptActiveTurn()).status, 'queued');
      const finished = await running;
      assert.equal(finished.turnId, 'turn-1');
      assert.equal(finished.turnStatus, 'completed');
      assert.equal(finished.writerExitVerified, false);
      // The fixture processes the next thread request after any late interrupt.
      const next = await transport.runTurn(turn(alternative));
      assert.equal(next.turnId, 'turn-2');
      assert.equal(next.turnStatus, 'completed');
      await assert.rejects(readFile(path.join(workspace, 'late-interrupt')), { code: 'ENOENT' });
    } finally {
      await transport.close();
    }
  });
});

test('B cancel race: a missing interrupt ACK cannot poison a later Turn', async () => {
  await withFixture(async ({ workspace, alternative, server }) => {
    const transport = await createCodexAppServerTransport({
      executable: process.execPath, args: [server], requestTimeoutMs: 1000,
      env: { ...process.env, TEST_MODE: 'completion-without-interrupt-ack' },
    });
    try {
      const running = transport.runTurn(turn(workspace));
      for (let i = 0; i < 100 && transport.observeTurn().turn !== 'running'; i++) await sleep(10);
      assert.equal(transport.observeTurn().turnId, 'turn-1');
      const signal = transport.interruptActiveTurn();
      const finished = await running;
      assert.equal(finished.turnStatus, 'completed');
      assert.equal(finished.writerExitVerified, false);
      const next = transport.runTurn(turn(alternative));
      assert.deepEqual(await signal, { status: 'unknown', writerExitVerified: false });
      const later = await next;
      assert.equal(later.turnId, 'turn-2');
      assert.equal(later.turnStatus, 'completed');
    } finally {
      await transport.close();
    }
  });
});

test('Initialize failure retires its owned App Server even when SIGTERM is ignored', {
  skip: process.platform === 'win32' && 'POSIX signal fixture',
}, async () => {
  await withFixture(async ({ workspace, server }) => {
    await assert.rejects(createCodexAppServerTransport({
      executable: process.execPath, args: [server], requestTimeoutMs: 1200,
      env: { ...process.env, TEST_MODE: 'stall-initialize-ignore-term', TEST_PID_DIR: workspace },
    }), { code: 'codex_app_server_rpc_timeout' });
    const pid = Number(await readFile(path.join(workspace, 'app-server.pid'), 'utf8'));
    assert.ok(Number.isSafeInteger(pid) && pid > 0);
    assert.equal(await readFile(path.join(workspace, 'term-observed'), 'utf8'), 'yes');
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' },
      'rejected initialize must await owned App Server SIGKILL/exit');
  });
});

test('Repeated close waits for the same owned App Server exit without proving Writer descendants', {
  skip: process.platform === 'win32' && 'POSIX signal fixture',
}, async () => {
  await withFixture(async ({ workspace, server }) => {
    const transport = await createCodexAppServerTransport({
      executable: process.execPath, args: [server], requestTimeoutMs: 1500,
      env: { ...process.env, TEST_MODE: 'ignore-term', TEST_PID_DIR: workspace },
    });
    try {
      const pid = Number(await readFile(path.join(workspace, 'app-server.pid'), 'utf8'));
      assert.ok(Number.isSafeInteger(pid) && pid > 0);
      const results = await Promise.all([transport.close(), transport.close()]);
      assert.deepEqual(results, [
        { appServerExited: true, writerExitVerified: false },
        { appServerExited: true, writerExitVerified: false },
      ]);
      assert.equal(await readFile(path.join(workspace, 'term-observed'), 'utf8'), 'yes');
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    } finally {
      await transport.close();
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


test('Host snapshots tracked, deleted and untracked Worker changes without changing the Worker index', async () => {
  await withFixture(async ({ workspace, alternative }) => {
    const git = (...args: string[]) => {
      const result = spawnSync('git', args, { cwd: workspace, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      return String(result.stdout || '').trim();
    };
    git('init');
    git('config', 'user.name', 'Snapshot Fixture');
    git('config', 'core.autocrlf', 'false');
    git('config', 'user.email', 'snapshot@example.invalid');
    await writeFile(path.join(workspace, 'README.md'), 'before\n');
    await writeFile(path.join(workspace, 'remove.txt'), 'removed\n');
    git('add', '--all');
    git('commit', '-m', 'baseline');
    await writeFile(path.join(workspace, 'README.md'), 'after\n');
    await rm(path.join(workspace, 'remove.txt'));
    await writeFile(path.join(workspace, 'new.txt'), 'new\n');
    await writeFile(path.join(workspace, 'image.bin'), Buffer.from([0, 1, 2, 255]));
    const originalStatus = git('status', '--porcelain=v1', '--untracked-files=all');
    const originalIndex = git('ls-files', '--stage');
    const snap = await snapshotHostWorkerPatch({ workspaceRoot: workspace, runtimeHome: path.dirname(workspace) });
    assert.deepEqual(snap.changedPaths, ['README.md', 'image.bin', 'new.txt', 'remove.txt']);
    assert.match(snap.patchDigest, /^sha256:[a-f\d]{64}$/);
    assert.match(snap.resultCommitSha || '', /^[a-f\d]{40,64}$/);
    assert.equal(git('rev-parse', 'HEAD'), git('rev-list', '--parents', '-n', '1', snap.resultCommitSha!).split(' ')[1],
      'the candidate commit has the original HEAD as parent without advancing HEAD');
    assert.equal(git('show', '--format=', '--binary', snap.resultCommitSha!), snap.patch.trim());
    assert.match(snap.workspaceIdentity, /^sha256:/);
    assert.match(snap.patch, /diff --git a\/README.md b\/README.md/);
    assert.equal(git('status', '--porcelain=v1', '--untracked-files=all'), originalStatus);
    assert.equal(git('ls-files', '--stage'), originalIndex, 'worker index was not modified');
    const worktree = spawnSync('git', ['worktree', 'add', '--detach', alternative, 'HEAD'], { cwd: workspace, encoding: 'utf8' });
    assert.equal(worktree.status, 0, worktree.stderr);
    try {
      const checked = spawnSync('git', ['apply', '--check', '--binary', '-'], { cwd: alternative, input: snap.patch, encoding: 'utf8' });
      assert.equal(checked.status, 0, checked.stderr);
      const applied = spawnSync('git', ['apply', '--binary', '-'], { cwd: alternative, input: snap.patch, encoding: 'utf8' });
      assert.equal(applied.status, 0, applied.stderr);
      assert.equal(await readFile(path.join(alternative, 'README.md'), 'utf8'), 'after\n');
      assert.equal(await readFile(path.join(alternative, 'new.txt'), 'utf8'), 'new\n');
      assert.deepEqual(await readFile(path.join(alternative, 'image.bin')), Buffer.from([0, 1, 2, 255]));
      await assert.rejects(readFile(path.join(alternative, 'remove.txt')));
    } finally {
      const removed = spawnSync('git', ['worktree', 'remove', '--force', alternative], { cwd: workspace, encoding: 'utf8' });
      assert.equal(removed.status, 0, removed.stderr);
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
    await writeFile(path.join(workspace, 'package.json'), JSON.stringify({ name: 'host-owned-writable-fixture',
      scripts: { 'test:fixture': 'node --version' } }));
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
        env: { ...process.env, TEST_MODE: 'writable-report' },
      },
    };
    try {
      await cp.startRun({ runId, objective: 'canonical Host-owned writable attempt test',
        taskContract: { objective: 'write fixture', acceptance: ['fixture is written'],
          allowedPaths: ['mock-writer-started.txt'] },
      });
      const a = cp.beginAttempt(runId, { provenanceKind: 'host-owned-worker' });
      assert.ok(a?.attemptId && a.stepId);
      const active = startHostOwnedWritableAttempt({ ...input, stepId: a.stepId, attemptId: a.attemptId });
      assert.equal(active.attemptId, a.attemptId);
      assert.equal(active.observe().state, 'starting', 'Host start does not wait for the model Turn');
      assert.equal(active.observe().writerExitVerified, false);
      const first = await active.result;
      ownedWorktrees.push(first.workspaceRoot);
      assert.equal(active.observe().state, 'turn-settled');
      assert.equal(active.observe().nativeTurn?.connection, 'unavailable');
      assert.equal((await active.interrupt()).status, 'unavailable');
      assert.equal(first.nativeTurn.turnStatus, 'completed');
      assert.equal(first.reportAuthority, 'none');
      assert.equal(first.writerExitVerified, false);
      assert.equal(first.nativeTurn.writerExitVerified, false);
      assert.deepEqual(first.resultCandidate?.changedPaths, ['mock-writer-started.txt'],
        'the Host observes the Worker Git delta, not a model summary');
      assert.deepEqual(first.resultCandidate?.outsideStepScope, []);
      assert.match(first.resultCandidate?.workspaceIdentity || '', /^sha256:/);
      assert.match(first.resultCandidate?.patchDigest || '', /^sha256:[a-f\d]{64}$/);
      assert.match(first.resultCandidate?.resultCommitSha || '', /^[a-f\d]{40,64}$/);
      assert.equal(first.resultCandidate?.ownerApplyCheck, 'passed');
      assert.equal(first.resultCandidate?.deliveryAuthorized, false);
      assert.equal(first.resultCandidate?.writerExitVerified, false);
      assert.equal(first.resultHandoff.status, 'recorded', JSON.stringify(first.resultHandoff));
      assert.equal(cp.getAttemptById(runId, a.attemptId)?.resultCommitSha, first.resultCandidate?.resultCommitSha,
        'the canonical receipt records the observed candidate without granting Delivery');
      assert.equal(cp.stateStore.getMutationProvenance(runId), null,
        'candidate handoff cannot mint Owner mutation provenance');
      assert.notEqual(first.workspaceRoot, workspace);
      assert.equal(first.commandEvents.length, 2);
      assert.ok(first.commandEvents.every(item => item.runId === runId
        && item.attemptId === a.attemptId && item.workspaceId === first.workspaceId));
      assert.ok(seen.length === 2);
      assert.equal(cp.getAttemptById(runId, a.attemptId)?.workspaceId, first.workspaceId);
      assert.equal(cp.getAttemptById(runId, a.attemptId)?.status, 'started');
      assert.equal((await readdir(reservationRoot)).length, 1);
      assert.equal(git('status', '--porcelain'), '', 'the Owner may not be modified by a Writable Worker');
      const candidate = first.resultCandidate;
      assert.ok(candidate);
      // The existing integration verifier consumes this single Host-owned
      // result commit without ever mutating the Owner or settling the Step.
      const ready = await verifyHostOwnedWorkerCandidate({
        controlPlane: cp, projectRoot: workspace, runtimeHome, runId,
        stepId: a.stepId, attemptId: a.attemptId,
        workspaceId: first.workspaceId, workspaceRoot: first.workspaceRoot,
        baseWorkspaceIdentity: first.baseWorkspaceIdentity,
        resultCommitSha: candidate.resultCommitSha,
        patchDigest: candidate.patchDigest, changedPaths: candidate.changedPaths,
        resultWorkspaceIdentity: candidate.workspaceIdentity,
        commandRef: 'test:fixture',
        verificationRunner: async ({ workspaceRoot }) => {
          assert.equal(await readFile(path.join(workspaceRoot, 'mock-writer-started.txt'), 'utf8'), 'started');
          return { status: 'passed', passed: true, verificationRef: 'fixture-only' };
        },
      });
      assert.equal(ready.status, 'verified', JSON.stringify(ready));
      assert.equal(ready.writerExitVerified, false);
      assert.equal(ready.deliveryAuthorized, false);
      assert.equal(cp.stateStore.getWorkspaceMutationLockV2((await cp.getRun(runId))!.workspaceId!), null,
        'read-only preflight must release the existing Owner fence');
      assert.equal(cp.getAttemptById(runId, a.attemptId)?.status, 'started');
      assert.equal(cp.getAttemptById(runId, a.attemptId)?.resultCommitSha, candidate.resultCommitSha,
        'proof-only preflight preserves the original candidate receipt');
      assert.equal(git('status', '--porcelain'), '', 'verified candidate cannot mutate Owner');
      const refused = await verifyHostOwnedWorkerCandidate({
        controlPlane: cp, projectRoot: workspace, runtimeHome, runId,
        stepId: a.stepId, attemptId: a.attemptId,
        workspaceId: first.workspaceId, workspaceRoot: first.workspaceRoot,
        baseWorkspaceIdentity: first.baseWorkspaceIdentity,
        resultCommitSha: 'f'.repeat(40),
        patchDigest: candidate.patchDigest, changedPaths: candidate.changedPaths,
        resultWorkspaceIdentity: candidate.workspaceIdentity,
        commandRef: 'test:fixture',
        verificationRunner: async () => ({ status: 'passed', passed: true }),
      });
      assert.equal(refused.status, 'blocked', 'a forged result commit cannot be verified');
      const failedProof = await verifyHostOwnedWorkerCandidate({
        controlPlane: cp, projectRoot: workspace, runtimeHome, runId,
        stepId: a.stepId, attemptId: a.attemptId,
        workspaceId: first.workspaceId, workspaceRoot: first.workspaceRoot,
        baseWorkspaceIdentity: first.baseWorkspaceIdentity,
        resultCommitSha: candidate.resultCommitSha,
        patchDigest: candidate.patchDigest, changedPaths: candidate.changedPaths,
        resultWorkspaceIdentity: candidate.workspaceIdentity,
        commandRef: 'test:fixture',
        verificationRunner: async () => ({ status: 'failed', passed: false }),
      });
      assert.equal(failedProof.status, 'blocked', 'a failing trusted proof must not authorize Delivery');
      assert.equal(cp.getAttemptById(runId, a.attemptId)?.status, 'started');
      assert.equal(git('status', '--porcelain'), '');

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
      assert.deepEqual(second.resultCandidate?.changedPaths, ['mock-writer-started.txt']);
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


for (const [scenario, failureCode] of [
  ['missing', 'host_worker_report_missing'],
  ['malformed', 'host_worker_report_invalid'],
  ['forged-owner', 'host_worker_report_invalid'],
  ['omitted-path', 'host_worker_report_paths_mismatch'],
  ['unbound-proof', 'host_worker_report_verification_unbound'],
  ['blocked-output', 'host_worker_report_not_completed'],
  ['stale-attempt', 'host_worker_result_lineage_changed'],
  ['owner-drift', 'host_worker_result_lineage_changed'],
] as const) test(`A2-1: ${scenario} actual App Server result cannot create a canonical candidate or Report`, async () => {
  await withFixture(async ({ workspace, server, reservationRoot }) => {
    const git = (...args: string[]) => {
      const result = spawnSync('git', args, { cwd: workspace, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    git('init');
    git('config', 'user.name', 'Host Result Fixture');
    git('config', 'user.email', 'result@example.invalid');
    await writeFile(path.join(workspace, 'package.json'), JSON.stringify({ scripts: { 'test:fixture': 'node --version' } }));
    git('add', '.'); git('commit', '-m', 'baseline');
    const runtimeHome = path.join(path.dirname(workspace), 'kernel-runtime');
    const cp = await createKernelControlPlane({ runtimeHome, projectRoot: workspace });
    let workerRoot: string | null = null;
    try {
      const runId = 'negative-handoff';
      await cp.startRun({ runId, objective: 'observe candidate only', taskContract: {
        acceptance: ['fixture written'], allowedPaths: ['mock-writer-started.txt'],
      } });
      const attempt = cp.beginAttempt(runId, { provenanceKind: 'host-owned-worker' });
      assert.ok(attempt?.attemptId);
      const output: Record<string, unknown> = {
        status: 'completed', summary: 'Worker result', changedPaths: ['mock-writer-started.txt'], risks: [],
        verifications: [{ obligationId: 'default', commandRef: 'test:fixture', acceptanceCoverage: ['AC-1'] }],
        requestedVerifications: [], judgments: [], knowledgeObservations: [], blocker: null,
      };
      if (scenario === 'forged-owner') output.attemptId = 'forged';
      if (scenario === 'omitted-path') output.changedPaths = [];
      if (scenario === 'unbound-proof') output.verifications = [{ obligationId: 'default', commandRef: 'untrusted', acceptanceCoverage: ['AC-1'] }];
      if (scenario === 'blocked-output') { output.status = 'blocked'; output.blocker = 'not done'; }
      const result = await runHostOwnedWritableAttempt({
        controlPlane: cp, repoRoot: workspace, runtimeHome, reservationRoot, baseCommit: git('rev-parse', 'HEAD'),
        runId, stepId: attempt.stepId, attemptId: attempt.attemptId,
        prompt: 'bounded result fixture', model: 'test-model', effort: 'high', turnTimeoutMs: 3000,
        transportOptions: { executable: process.execPath, args: [server], requestTimeoutMs: 1500,
          env: { ...process.env, TEST_MODE: scenario === 'missing' ? 'writable' : 'writable-report',
            TEST_REPORT_TEXT: scenario === 'malformed' ? '{invalid JSON' : JSON.stringify(output) } },
        onNativeExecution: event => {
          if (event.method !== 'item/started') return;
          if (scenario === 'stale-attempt') cp.failStepAttempt(runId, attempt.stepId, { code: 'old_attempt_failed' });
          if (scenario === 'owner-drift') {
            const changed = spawnSync(process.execPath, ['-e', "require('node:fs').writeFileSync('owner-change.txt','concurrent owner edit')"], { cwd: workspace });
            assert.equal(changed.status, 0);
          }
        },
      });
      workerRoot = result.workspaceRoot;
      assert.equal(result.nativeTurn.turnStatus, 'completed');
      assert.deepEqual(result.resultHandoff, { status: 'blocked', failureCode });
      const canonical = cp.getAttemptById(runId, attempt.attemptId);
      assert.equal(canonical?.resultCommitSha, null);
      assert.equal(canonical?.workerReport, null);
      assert.equal(canonical?.reportResult, null);
      assert.equal((await cp.getRun(runId))?.mutationRevision, 0);
      assert.equal(cp.stateStore.getMutationProvenance(runId), null);
      assert.notEqual(cp.getCurrentStep(runId)?.state, 'passed');
      assert.equal(result.writerExitVerified, false);
      assert.equal(result.resultCandidate?.deliveryAuthorized, false);
      assert.equal(git('status', '--porcelain'), scenario === 'owner-drift' ? '?? owner-change.txt' : '');
    } finally {
      await cp.close();
      if (workerRoot) git('worktree', 'remove', '--force', workerRoot);
    }
  });
});

test('A2-1: two different terminal agent messages poison the transport instead of choosing a report', async () => {
  await withFixture(async ({ workspace, server, reservationRoot }) => {
    const transport = await createCodexAppServerTransport({ executable: process.execPath, args: [server],
      env: { ...process.env, TEST_MODE: 'writable-report-ambiguous' }, requestTimeoutMs: 1500 });
    try {
      await assert.rejects(transport.runTurn({ ...turn(workspace),
        executionOwner: { runId: 'run-a', stepId: 'step-a', attemptId: 'attempt-a', workspaceId: 'workspace-a' },
        onNativeExecution: () => {}, writableWorker: { reservationRoot }, outputSchema: CODEX_WORKER_OUTPUT_SCHEMA,
      }), { code: 'codex_app_server_final_message_ambiguous' });
    } finally { await transport.close(); }
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

test('G2/T14: a server-originated approval request blocks the Turn without automatic authorization', async () => {
  await withFixture(async ({ workspace, alternative, server }) => {
    const transport = await createCodexAppServerTransport({
      executable: process.execPath, args: [server], requestTimeoutMs: 1500,
      env: { ...process.env, TEST_MODE: 'approval-request' },
    });
    try {
      await assert.rejects(transport.runTurn({ ...turn(workspace), timeoutMs: 2000 }), {
        code: 'codex_app_server_unhandled_server_request',
      });
      assert.equal(transport.observeTurn().connection, 'unavailable');
      assert.equal(transport.observeTurn().writerExitVerified, false);
      await assert.rejects(transport.runTurn(turn(alternative)), {
        code: 'codex_app_server_unavailable',
      });
    } finally {
      const closed = await transport.close();
      assert.equal(closed.writerExitVerified, false);
      assert.equal(closed.appServerExited, true);
    }
  });
});

// Baseline/result and durable CAS classification. The CAS setup at the end
// exercises the Kernel boundary separately from protected Host settlement.
test('Host-owned result preserves uncommitted Owner baseline and reports only its own delta', async () => {
  await withFixture(async ({ workspace, server, reservationRoot }) => {
    const git = (...args: string[]) => {
      const result = spawnSync('git', args, { cwd: workspace, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    git('init');
    git('config', 'core.autocrlf', 'false');
    git('config', 'user.name', 'Baseline Fixture');
    git('config', 'user.email', 'baseline@example.invalid');
    await writeFile(path.join(workspace, 'prior.txt'), 'original\n');
    await writeFile(path.join(workspace, 'proof.cjs'), [
      "const f=require('node:fs');",
      "if(f.readFileSync('prior.txt','utf8')!=='prior step\\n')process.exit(1);",
      "if(f.readFileSync('mock-writer-started.txt','utf8')!=='started')process.exit(1);",
    ].join('\n'));
    await writeFile(path.join(workspace, 'package.json'), JSON.stringify({
      name: 'host-baseline-fixture', scripts: { 'test:fixture': 'node proof.cjs' },
    }));
    git('add', '--all');
    git('commit', '-m', 'initial baseline');
    const baseCommit = git('rev-parse', 'HEAD');
    await writeFile(path.join(workspace, 'prior.txt'), 'prior step\n');
    // Preserve the Owner index as well as the working bytes.
    git('add', 'prior.txt');
    await writeFile(path.join(workspace, 'foreign.txt'), 'existing user change\n');
    const beforeStatus = git('status', '--porcelain');
    const beforeIndex = git('diff', '--cached', '--binary');
    const runtimeHome = path.join(path.dirname(workspace), 'kernel-runtime');
    const cp = await createKernelControlPlane({ runtimeHome, projectRoot: workspace });
    let workerRoot: string | undefined;
    const runId = 'run-host-baseline';
    try {
      await cp.startRun({ runId, objective: 'preserve Owner baseline', taskContract: {
        acceptance: ['Worker changes only its declared file'], allowedPaths: ['mock-writer-started.txt'],
      } });
      const attempt = cp.beginAttempt(runId, { provenanceKind: 'host-owned-worker' });
      assert.ok(attempt?.attemptId);
      const result = await runHostOwnedWritableAttempt({
        controlPlane: cp, repoRoot: workspace, runtimeHome, reservationRoot, baseCommit, runId,
        stepId: attempt.stepId, attemptId: attempt.attemptId,
        prompt: 'write the one fixture file', model: 'test-model', effort: 'high',
        transportOptions: { executable: process.execPath, args: [server],
          env: { ...process.env, TEST_MODE: 'writable-report' }, requestTimeoutMs: 1500 },
      });
      workerRoot = result.workspaceRoot;
      assert.deepEqual(result.resultHandoff, { status: 'recorded', failureCode: null });
      const candidate = result.resultCandidate;
      assert.ok(candidate);
      assert.deepEqual(candidate.changedPaths, ['mock-writer-started.txt']);
      assert.deepEqual(candidate.outsideStepScope, []);
      assert.equal(await readFile(path.join(workerRoot, 'prior.txt'), 'utf8'), 'prior step\n');
      assert.equal(await readFile(path.join(workerRoot, 'foreign.txt'), 'utf8'), 'existing user change\n');
      const verified = await verifyHostOwnedWorkerCandidate({
        controlPlane: cp, projectRoot: workspace, runtimeHome, runId,
        stepId: attempt.stepId, attemptId: attempt.attemptId,
        workspaceId: result.workspaceId, workspaceRoot: workerRoot,
        baseWorkspaceIdentity: result.baseWorkspaceIdentity,
        resultCommitSha: candidate.resultCommitSha, patchDigest: candidate.patchDigest,
        changedPaths: candidate.changedPaths, resultWorkspaceIdentity: candidate.workspaceIdentity,
        commandRef: 'test:fixture',
        verificationRunner: ({ commandRef, workspaceRoot }) => {
          const proof = executeTrustedProof({ projectRoot: workspaceRoot, commandRef });
          assert.equal(proof.status, 'passed', JSON.stringify(proof));
          return { status: proof.status, passed: proof.status === 'passed', execution: proof };
        },
      });
      assert.equal(verified.status, 'verified', JSON.stringify(verified));
      assert.equal(verified.deliveryAuthorized, false);
      const deliveryInput = {
        controlPlane: cp, projectRoot: workspace, runtimeHome, runId,
        stepId: attempt.stepId, attemptId: attempt.attemptId,
        workspaceId: result.workspaceId, workspaceRoot: workerRoot,
        baseWorkspaceIdentity: result.baseWorkspaceIdentity,
        resultCommitSha: candidate.resultCommitSha, patchDigest: candidate.patchDigest,
        changedPaths: candidate.changedPaths, resultWorkspaceIdentity: candidate.workspaceIdentity,
        commandRef: 'test:fixture',
      };
      const missingBoundary = await settleHostOwnedWorkerCandidate(deliveryInput, undefined);
      assert.equal(missingBoundary.failureCode, 'host_worker_writer_exclusion_unavailable');
      const noOperation = await settleHostOwnedWorkerCandidate(deliveryInput, async () => {});
      assert.equal(noOperation.failureCode, 'host_worker_writer_exclusion_unconfirmed',
        'a callback that supplies no real exclusion operation must not mint Delivery');
      let unsafeRunnerInvoked = false;
      const override = await settleHostOwnedWorkerCandidate({
        ...deliveryInput, verificationRunner: () => {
          unsafeRunnerInvoked = true;
          throw new Error('fixture runner cannot authorize Delivery');
        },
      }, async () => { throw new Error('proof override must be rejected first'); });
      assert.equal(override.failureCode, 'host_worker_delivery_proof_override_rejected');
      assert.equal(unsafeRunnerInvoked, false);
      assert.equal(cp.stateStore.getRun(runId)?.mutationRevision, 0);
      assert.equal(cp.stateStore.getMutationProvenance(runId), null);
      assert.equal(cp.getAttemptById(runId, attempt.attemptId)?.status, 'started');
      assert.equal(git('status', '--porcelain'), beforeStatus);
      assert.equal(git('diff', '--cached', '--binary'), beforeIndex);
      assert.equal(git('rev-parse', 'HEAD'), baseCommit);
      let preCasReconciliations = 0;
      const recoveringHost = createHostWorkerSessions({
        withWriterExcluded: async (received) => {
          preCasReconciliations += 1;
          assert.equal(received.attemptId, attempt.attemptId);
          assert.equal(received.patchDigest, candidate.patchDigest);
          // Refuse the operation. Observing the same candidate is not
          // evidence that a reconnecting Host can exclude its Writer.
        },
      });
      const resumed = assertTestRecord(await recoveringHost.startLocal({
        projectRoot: workspace, runtimeHome, runId, model: 'test-model', effort: 'high',
      }));
      assert.equal(assertTestRecord(resumed.settlement).failureCode, 'host_worker_writer_exclusion_unconfirmed');
      assert.equal(preCasReconciliations, 1);
      assert.equal(cp.stateStore.getStepAttempts(runId).length, 1);
      assert.equal(cp.stateStore.getRun(runId)?.mutationRevision, 0);
      assert.equal(cp.getAttemptById(runId, attempt.attemptId)?.reportResult, null);
      assert.equal(git('status', '--porcelain'), beforeStatus);
      // An Index-only edit can leave all working bytes unchanged. The old
      // content identity must not admit that different Owner baseline.
      git('reset', '--', 'prior.txt');
      let unexpectedProofs = 0;
      const staleIndex = await verifyHostOwnedWorkerCandidate({
        controlPlane: cp, projectRoot: workspace, runtimeHome, runId,
        stepId: attempt.stepId, attemptId: attempt.attemptId,
        workspaceId: result.workspaceId, workspaceRoot: workerRoot,
        baseWorkspaceIdentity: result.baseWorkspaceIdentity,
        resultCommitSha: candidate.resultCommitSha, patchDigest: candidate.patchDigest,
        changedPaths: candidate.changedPaths, resultWorkspaceIdentity: candidate.workspaceIdentity,
        commandRef: 'test:fixture', verificationRunner: () => {
          unexpectedProofs += 1;
          throw new Error('stale Index must be rejected before Proof');
        },
      });
      assert.equal(staleIndex.status, 'blocked');
      assert.equal(staleIndex.failureCode, 'delivery_workspace_drift');
      assert.equal(unexpectedProofs, 0);
      assert.equal(cp.stateStore.getRun(runId)?.mutationRevision, 0);
      assert.equal(cp.stateStore.getMutationProvenance(runId), null);
      git('add', 'prior.txt');
      assert.equal(git('diff', '--cached', '--binary'), beforeIndex);

      // Use actual Git bytes and the real CAS to represent a process exit
      // immediately after persistence, with no Report or Proof fabricated.
      const prepared = assertTestRecord(verified.candidate);
      assert.equal(prepared.patchDigest, candidate.patchDigest);
      assert.equal(prepared.integrationWorkspaceIdentity, candidate.workspaceIdentity);
      const snapshot = {
        expectedMutationRevision: 0, expectedWorkspaceIdentity: result.baseWorkspaceIdentity,
        expectedHeadCommitSha: baseCommit, baselineAttemptId: attempt.attemptId,
      };
      const fence = await cp.acquireOwnerWorkspaceMutationFence(runId, snapshot);
      const receiptInput = {
        ...snapshot, fencingToken: fence.lock.fencingToken, sessionToken: fence.lock.sessionToken,
        integrationWorkspaceIdentity: candidate.workspaceIdentity, changedPaths: candidate.changedPaths,
        patchDigest: candidate.patchDigest,
      };
      cp.assertOwnerWorkspaceMutationReady(runId, receiptInput);
      const patch = spawnSync('git', ['show', '--format=', '--binary', candidate.resultCommitSha], {
        cwd: workerRoot, encoding: 'utf8',
      });
      assert.equal(patch.status, 0, patch.stderr);
      const apply = spawnSync('git', ['apply', '--binary', '-'], {
        cwd: workspace, encoding: 'utf8', input: patch.stdout,
      });
      assert.equal(apply.status, 0, apply.stderr);
      cp.recordOwnerWorkspaceMutation(runId, receiptInput);
      assert.equal((await cp.recoverPendingDeliveryMaterialization(runId)).status, 'in-progress');
      cp.releaseOwnerWorkspaceMutationFence(runId, fence.lock);

      const reconnect = await createKernelControlPlane({ runtimeHome, projectRoot: workspace });
      try {
        assert.equal((await reconnect.recoverPendingDeliveryMaterialization(runId)).status, 'report-pending');
        assert.equal(reconnect.getPendingHostWorkerDelivery(runId, 'other-attempt'), null);
        assert.equal(reconnect.getPendingHostWorkerDelivery(runId, attempt.attemptId)?.patchDigest, candidate.patchDigest);
        const postCommit = await reconnect.acquireOwnerWorkspaceMutationFence(runId, {
          expectedMutationRevision: 1, expectedWorkspaceIdentity: candidate.workspaceIdentity,
          expectedHeadCommitSha: baseCommit, recoveryAttemptId: attempt.attemptId,
        });
        reconnect.releaseOwnerWorkspaceMutationFence(runId, postCommit.lock);
        const pending = await reconnect.prepareNext(runId);
        assert.equal(pending.status, 'worker-reconciliation-required');
        await assert.rejects(createHostWorkerSessions().startLocal({
          projectRoot: workspace, runtimeHome, runId, model: 'test-model', effort: 'high',
        }), { code: 'host_worker_native_isolation_unverified' });
        assert.equal(reconnect.stateStore.getRun(runId)?.mutationRevision, 1);
        const attempts = reconnect.stateStore.getStepAttempts(runId);
        assert.equal(attempts.length, 1);
        assert.equal(attempts[0]?.reportResult, null);
        assert.equal(await readFile(path.join(workspace, 'mock-writer-started.txt'), 'utf8'), 'started');
        assert.equal(git('diff', '--cached', '--binary'), beforeIndex);

        await writeFile(path.join(workspace, 'mock-writer-started.txt'), 'late drift');
        assert.equal((await reconnect.recoverPendingDeliveryMaterialization(runId)).status, 'blocked');
        assert.equal(reconnect.stateStore.getRun(runId)?.mutationRevision, 1);
      } finally {
        await reconnect.close();
      }
    } finally {
      await cp.close();
      if (workerRoot) git('worktree', 'remove', '--force', workerRoot);
    }
  });
});

test('A3 repair: actual candidate Proof failure leaves Owner unchanged and Kernel selects the same Step', async () => {
  await withFixture(async ({ workspace, server, reservationRoot }) => {
    const git = (...args: string[]) => {
      const result = spawnSync('git', args, { cwd: workspace, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    git('init');
    git('config', 'core.autocrlf', 'false');
    git('config', 'user.name', 'Host Repair Fixture');
    git('config', 'user.email', 'repair@example.invalid');
    await writeFile(path.join(workspace, 'proof.cjs'),
      "if(require('node:fs').readFileSync('mock-writer-started.txt','utf8')!=='corrected')process.exit(19);");
    await writeFile(path.join(workspace, 'package.json'), JSON.stringify({
      name: 'host-repair-fixture',
      scripts: { 'test:fixture': 'node --check proof.cjs', 'test:content': 'node proof.cjs' },
    }));
    git('add', '--all');
    git('commit', '-m', 'bind content proof');
    const baseCommit = git('rev-parse', 'HEAD');
    const runtimeHome = path.join(path.dirname(workspace), 'repair-runtime');
    const cp = await createKernelControlPlane({ runtimeHome, projectRoot: workspace });
    const runId = 'run-host-proof-repair';
    const workerRoots: string[] = [];
    try {
      await cp.startRun({ runId, objective: 'deliver corrected content', taskContract: {
        acceptance: [
          { acceptance: 'Proof script parses', evidencePlan: {
            class: 'hard', method: 'unit-test', obligationId: 'default', commandRefs: ['test:fixture'],
          } },
          { acceptance: 'Worker writes corrected content', evidencePlan: {
            class: 'hard', method: 'unit-test', obligationId: 'z-content-proof',
            evidenceLevel: 'goal', commandRefs: ['test:content'],
          } },
        ],
        steps: [{ objective: 'Write corrected content', allowedPaths: ['mock-writer-started.txt'],
          acceptanceIds: ['AC-1', 'AC-2'], obligationIds: ['default', 'z-content-proof'] }],
        allowedPaths: ['mock-writer-started.txt'],
      } });
      const runWorker = async (attemptId: string, stepId: string, content: string) => {
        const result = await runHostOwnedWritableAttempt({
          controlPlane: cp, repoRoot: workspace, runtimeHome, reservationRoot, baseCommit, runId,
          stepId, attemptId, prompt: 'write the requested fixture content', model: 'test-model', effort: 'high',
          transportOptions: { executable: process.execPath, args: [server], requestTimeoutMs: 1500,
            env: { ...process.env, TEST_MODE: 'writable-report', TEST_WRITER_CONTENT: content } },
        });
        workerRoots.push(result.workspaceRoot);
        assert.equal(result.resultHandoff.status, 'recorded');
        assert.ok(result.resultCandidate);
        return result;
      };
      const original = cp.beginAttempt(runId, { provenanceKind: 'host-owned-worker' });
      assert.ok(original?.attemptId);
      const bad = await runWorker(original.attemptId, original.stepId, 'incorrect');
      assert.ok(bad.resultCandidate);
      const proofs: Array<ReturnType<typeof executeTrustedProof>> = [];
      const candidate = await verifyHostOwnedWorkerCandidate({
        controlPlane: cp, projectRoot: workspace, runtimeHome, runId,
        stepId: original.stepId, attemptId: original.attemptId,
        workspaceId: bad.workspaceId, workspaceRoot: bad.workspaceRoot,
        baseWorkspaceIdentity: bad.baseWorkspaceIdentity,
        resultCommitSha: bad.resultCandidate.resultCommitSha, patchDigest: bad.resultCandidate.patchDigest,
        changedPaths: bad.resultCandidate.changedPaths, resultWorkspaceIdentity: bad.resultCandidate.workspaceIdentity,
        verificationRunner: ({ commandRef, workspaceRoot }) => {
          const execution = executeTrustedProof({ projectRoot: workspaceRoot, commandRef,
            evidenceDir: path.join(runtimeHome, 'repair-proof-evidence') });
          proofs.push(execution);
          return { status: execution.status, passed: execution.status === 'passed', execution };
        },
      });
      assert.equal(candidate.failureCode, 'integration_verification_failed');
      assert.deepEqual(proofs.map(proof => [proof.commandRef, proof.status]),
        [['test:fixture', 'passed'], ['test:content', 'failed']]);
      // Exercise the local Kernel failure ledger with real Proof output.
      // The fixture verification path cannot authorize Native Delivery.
      const failure = proofs[1];
      assert.equal(failure.status, 'failed');
      assert.equal(failure.exitCode, 19);
      assert.equal(failure.processExited, true);
      assert.ok(failure.evidenceRef && bad.resultCandidate);
      const fence = await cp.acquireOwnerWorkspaceMutationFence(runId, {
        expectedMutationRevision: 0, expectedWorkspaceIdentity: bad.baseWorkspaceIdentity,
        expectedHeadCommitSha: baseCommit, baselineAttemptId: original.attemptId,
      });
      const input = { attemptId: original.attemptId, fencingToken: fence.lock.fencingToken,
        commandRef: failure.commandRef, evidenceRef: failure.evidenceRef,
        exitCode: failure.exitCode, candidateIdentity: bad.resultCandidate.workspaceIdentity };
      const beforeProofs = cp.stateStore.getVerificationHistory(runId);
      await assert.rejects(cp.rejectHostWorkerCandidateProof(runId, { ...input, fencingToken: fence.lock.fencingToken + 1 }),
        { code: 'host_worker_proof_failure_stale' });
      const next = await cp.rejectHostWorkerCandidateProof(runId, input);
      cp.releaseOwnerWorkspaceMutationFence(runId, fence.lock);
      const repair = assertTestRecord(assertTestRecord(next).action);
      assert.equal(repair.type, 'fix');
      assert.equal(repair.retryAttemptId, original.attemptId);
      assert.equal(assertTestRecord(repair.step).stepId, original.stepId);
      const failed = cp.getAttemptById(runId, original.attemptId);
      assert.equal(failed?.status, 'failed');
      assert.deepEqual(failed?.verificationRefs, [failure.evidenceRef]);
      assert.equal(failed?.reportResult, null);
      assert.equal(cp.stateStore.getRun(runId)?.mutationRevision, 0);
      assert.deepEqual(cp.stateStore.getVerificationHistory(runId), beforeProofs);
      assert.equal(cp.stateStore.getMutationProvenance(runId), null);
      assert.equal(git('status', '--porcelain'), '');

      const retry = cp.beginAttempt(runId, { stepId: original.stepId,
        provenanceKind: 'host-owned-worker', parentAttemptId: original.attemptId });
      assert.ok(retry?.attemptId && retry.attemptId !== original.attemptId);
      assert.equal(retry.stepId, original.stepId);
      assert.equal(retry.attemptNumber, original.attemptNumber + 1);
      const corrected = await runWorker(retry.attemptId, retry.stepId, 'corrected');
      assert.equal(executeTrustedProof({ projectRoot: corrected.workspaceRoot, commandRef: 'test:content' }).status, 'passed');
      assert.equal(git('status', '--porcelain'), '');
    } finally {
      await cp.close();
      for (const workerRoot of workerRoots) git('worktree', 'remove', '--force', workerRoot);
    }
  });
});
