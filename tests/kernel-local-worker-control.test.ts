import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { createKernelControlPlane } from '../src/host/kernel/control-plane-runtime.js';
import { createHostWorkerSessions } from '../src/host/kernel/host-worker-sessions.js';
import { createLocalWorkerControl, startLocalWorkerControl } from '../src/host/kernel/local-worker-control.js';
import { assertTestRecord } from './helpers/assert-value.js';

const fixture = async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kernel-local-control-'));
  const projectRoot = path.join(root, 'owner');
  const runtimeHome = path.join(root, 'runtime');
  await mkdir(projectRoot);
  await mkdir(runtimeHome);
  await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({ scripts: { test: 'node --version' } }));
  await writeFile(path.join(projectRoot, 'README.md'), 'initial\n');
  for (const args of [['init', '--quiet'], ['add', '.'],
    ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'initial']]) {
    const result = spawnSync('git', args, { cwd: projectRoot, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  const cp = await createKernelControlPlane({ projectRoot, runtimeHome, env: {} });
  const runId = 'run-local-control';
  await cp.startRun({ runId, objective: 'update README',
    taskContract: { acceptance: ['README updated'], allowedPaths: ['README.md'] } });
  return { root, projectRoot, runtimeHome, runId, cp };
};

test('local control rejects unsupported or malformed starts without preparing a Step', async () => {
  const f = await fixture();
  try {
    const control = createLocalWorkerControl({ ...f, env: {} });
    const before = f.cp.getCurrentStep(f.runId);
    const capabilities = await control({ action: 'capabilities' });
    assert.equal(capabilities.status, 'unsupported');
    assert.equal(capabilities.writableStart, false);
    assert.equal((await control({ action: 'start', runId: f.runId })).failureCode, 'host_worker_start_fields_missing');
    const denied = await control({ action: 'start', runId: f.runId, model: 'fixture', effort: 'high' });
    assert.equal(denied.status, 'unsupported');
    assert.equal(denied.failureCode, 'host_worker_native_isolation_unverified');
    assert.deepEqual(f.cp.getCurrentStep(f.runId), before);
    assert.equal(f.cp.getHostRoutingSnapshot(f.runId).stepAttempts.length, 0);
    const observed = await control({ action: 'attach', runId: f.runId });
    assert.equal(observed.status, 'attached');
    assert.equal(observed.liveWorker, null);
    assert.equal(assertTestRecord(observed.canonical).status, 'active');
  } finally { await f.cp.close(); await rm(f.root, { recursive: true, force: true }); }
});

test('local Main replacement reuses the owning Host Attempt and cancels only its original Turn', async () => {
  const f = await fixture();
  const server = path.join(f.root, 'server.cjs');
  await writeFile(server, String.raw`
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') send({ id: m.id, result: { userAgent: 'fixture' } });
  if (m.method === 'thread/start') send({ id: m.id, result: { thread: { id: 'local-thread' } } });
  if (m.method === 'turn/start') send({ id: m.id, result: { turn: { id: 'local-turn', status: 'inProgress' } } });
  if (m.method === 'turn/interrupt') {
    send({ id: m.id, result: {} });
    send({ method: 'turn/completed', params: { threadId: m.params.threadId,
      turn: { id: m.params.turnId, status: 'interrupted' } } });
  }
});
`);
  // This lifecycle fixture never authorizes Owner delivery. It is interrupted
  // before producing a result; the configured Host boundary always denies.
  const sessions = createHostWorkerSessions({ env: {},
    transportOptions: { executable: process.execPath, args: [server], requestTimeoutMs: 1500 },
    withWriterExcluded: async () => { throw new Error('fixture has no delivery authority'); },
  });
  const options = { projectRoot: f.projectRoot, runtimeHome: f.runtimeHome, env: {}, hostWorkerSessions: sessions };
  const connect = () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const host = startLocalWorkerControl({ ...options, stdin, stdout });
    return {
      call: (request: Record<string, unknown>) => new Promise<Record<string, unknown>>((resolve, reject) => {
        stdout.once('data', data => {
          try { resolve(assertTestRecord(JSON.parse(data.toString('utf8')))); } catch (error) { reject(error); }
        });
        stdin.write(JSON.stringify({ id: 1, runId: f.runId, ...request }) + '\n');
      }),
      close() { host.close(); stdin.destroy(); stdout.destroy(); },
    };
  };
  let attemptId: string | null = null;
  const first = connect();
  let second: ReturnType<typeof connect> | null = null;
  try {
    const started = await first.call({ action: 'start', model: 'fixture', effort: 'high' });
    assert.equal(started.status, 'host-worker-attached');
    attemptId = String(assertTestRecord(started.hostWorker).attemptId);
    first.close();
    second = connect();
    const attached = await second.call({ action: 'attach' });
    assert.equal(assertTestRecord(attached.liveWorker).attemptId, attemptId);
    const retried = await second.call({ action: 'resume', model: 'fixture', effort: 'high' });
    assert.equal(assertTestRecord(retried.hostWorker).attemptId, attemptId);
    assert.equal(retried.next, undefined);
    assert.equal(f.cp.getHostRoutingSnapshot(f.runId).stepAttempts.length, 1);
    const wrong = await second.call({ action: 'interrupt', attemptId: 'other-attempt' });
    assert.equal(assertTestRecord(wrong.hostWorkerSignal).status, 'not-attached');
    const conflicting = createLocalWorkerControl({ ...options, env: { MOON_RELAY_KERNEL_RUN_ID: 'other-run' } });
    assert.equal((await conflicting({ action: 'attach', runId: f.runId })).failureCode, 'run_binding_conflict');
    const canceled = await second.call({ action: 'interrupt', attemptId });
    assert.ok(['queued', 'requested'].includes(String(assertTestRecord(canceled.hostWorkerSignal).status)));
    let live = await sessions.status(f.projectRoot, f.runtimeHome, f.runId);
    for (let n = 0; n < 100 && live?.turnStatus === 'pending'; n++) {
      await sleep(20);
      live = await sessions.status(f.projectRoot, f.runtimeHome, f.runId);
    }
    assert.equal(live?.completedTurn?.threadId, 'local-thread');
    assert.equal(live?.completedTurn?.turnId, 'local-turn');
    assert.equal(live?.turnStatus, 'interrupted');
    assert.equal(live?.deliveryAuthorized, false);
    assert.equal((await f.cp.getRun(f.runId))?.mutationRevision, 0);
  } finally {
    first.close(); second?.close();
    if (attemptId) await sessions.interrupt(f.projectRoot, f.runtimeHome, f.runId, attemptId);
    await f.cp.close(); await rm(f.root, { recursive: true, force: true });
  }
});
