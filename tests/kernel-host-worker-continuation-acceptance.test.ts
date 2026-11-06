import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { createKernelControlPlane } from '../src/host/kernel/control-plane-runtime.js';
import { createHostWorkerSessions } from '../src/host/kernel/host-worker-sessions.js';
import { createLocalWorkerControl } from '../src/host/kernel/local-worker-control.js';
import { executeTrustedProof } from '../src/host/kernel/proof/proof-executor.js';
import { createMcpBridgeHandler } from '../src/kernel/bridge/mcp.js';
import { assertTestRecord, assertTestString } from './helpers/assert-value.js';

// This finite App Server fixture is the only Writer. It never spawns another
// process. The test observes its OS exit before admitting each candidate.
const appServer = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { log, names, obligations } = JSON.parse(process.argv[2]);
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, method, params } = JSON.parse(line);
  if (method === 'initialize') return send({ id, result: { userAgent: 'finite-fixture' } });
  if (method === 'thread/start') return send({ id, result: { thread: { id: 'fixture-thread' } } });
  if (method !== 'turn/start') return;
  const { cwd } = params;
  const step = names.findIndex((name) => !fs.existsSync(path.join(cwd, name)));
  if (step === -1) throw Error('unexpected extra Worker');
  const attempts = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : [];
  const incorrect = step === 1 && !attempts.some((entry) => entry.step === step);
  fs.writeFileSync(path.join(cwd, names[step]), incorrect ? 'incorrect' : 'accepted');
  fs.appendFileSync(log, JSON.stringify({ step, pid: process.pid, cwd }) + '\n');
  const threadId = params.threadId;
  const turnId = 'fixture-turn';
  send({ id, result: { turn: { id: turnId, status: 'inProgress' } } });
  send({ method: 'item/completed', params: { threadId, turnId, item: {
    type: 'agentMessage', id: 'worker-report', phase: 'final_answer', text: JSON.stringify({
      status: 'completed', summary: 'Write ' + names[step], changedPaths: [names[step]],
      verifications: [{ obligationId: obligations[step], commandRef: 'test:fixture', acceptanceCoverage: ['AC-' + (step + 1)] }],
      risks: [], requestedVerifications: [], judgments: [], knowledgeObservations: [], blocker: null,
    }),
  } } });
  send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed' } } });
});
`;

const runLocalAcceptance = async (scenario: 'complete' | 'recover' | 'ambiguous') => {
  const interruptSettlement = scenario === 'recover';
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'kernel-local-host-chain-')));
  const projectRoot = path.join(root, 'owner');
  const runtimeHome = path.join(root, 'runtime');
  const server = path.join(root, 'finite-app-server.cjs');
  const log = path.join(root, 'workers.jsonl');
  const names = ['first.txt', 'second.txt', 'third.txt'];
  const obligations = names.map((_, i) => 'proof-' + (i + 1));
  const runId = 'run-local-host-acceptance';
  const workerLaunches = async () => (await readFile(log, 'utf8')).trim().split('\n').map(line => {
    const entry = assertTestRecord(JSON.parse(line));
    assert.equal(typeof entry.cwd, 'string');
    assert.equal(typeof entry.pid, 'number');
    return { cwd: String(entry.cwd), pid: Number(entry.pid), step: Number(entry.step) };
  });
  let cp: Awaited<ReturnType<typeof createKernelControlPlane>> | null = null;
  try {
    await mkdir(projectRoot);
    await mkdir(runtimeHome);
    await writeFile(server, appServer);
    await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({
      name: 'local-host-chain',
      scripts: { 'test:fixture': 'node proof.cjs first.txt third.txt', 'test:content': 'node proof.cjs second.txt' },
    }));
    await writeFile(path.join(projectRoot, 'proof.cjs'), `
const fs = require('node:fs');
for (const name of process.argv.slice(2)) {
  if (fs.existsSync(name) && fs.readFileSync(name, 'utf8') !== 'accepted') process.exit(19);
}
`);
    for (const args of [
      ['init'], ['add', '--all'],
      ['-c', 'user.name=Kernel fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'trusted manifest'],
    ]) {
      const result = spawnSync('git', args, { cwd: projectRoot, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
    }
    const smoke = executeTrustedProof({ projectRoot, writeScope: projectRoot, commandRef: 'test:fixture' });
    assert.ok(smoke.writeContainment, 'Acceptance requires the product Proof write boundary');
    cp = await createKernelControlPlane({ projectRoot, runtimeHome });
    const taskContract = {
      objective: 'Complete three independent changes via the local Host',
      complex: true,
      acceptance: [
        ...names.map((name, i) => ({
          acceptance: i === 1 ? 'Keep the other files valid during the second Step' : 'Write accepted content in ' + name,
          evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test:fixture'], obligationId: obligations[i] },
        })),
        { acceptance: 'Write accepted content in second.txt',
          evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test:content'], obligationId: 'second-content' } },
      ],
      steps: names.map((name, i) => ({
        objective: 'Write ' + name, allowedPaths: [name],
        acceptanceIds: ['AC-' + (i + 1), ...(i === 1 ? ['AC-4'] : [])],
        obligationIds: [obligations[i], ...(i === 1 ? ['second-content'] : [])],
      })),
    } satisfies NonNullable<Parameters<typeof cp.startRun>[0]>['taskContract'];
    await cp.startRun({ runId, objective: taskContract.objective, taskContract });
    const steps = cp.getRunSteps(runId);
    assert.equal(steps.length, 3);
    const retired = new Set<string>();
    let firstStepInvocations = 0;
    let checkpointInterrupted = false;
    let reportResponseLost = false;
    let hostResponseLost = false;
    let firstStepCompletedAt: string | null = null;
    const input = { projectRoot, runtimeHome, runId, model: 'fixture-model', effort: 'high' };
    const hostOptions: NonNullable<Parameters<typeof createHostWorkerSessions>[0]> = {
      transportOptions: { executable: process.execPath, args: [server, JSON.stringify({ log, names, obligations })] },
      withWriterExcluded: async (candidate, operation) => {
        const worker = (await workerLaunches()).find(entry => entry.cwd === candidate.workspaceRoot);
        assert.ok(worker);
        assert.throws(() => process.kill(worker.pid, 0), { code: 'ESRCH' });
        assert.ok(!retired.has(candidate.attemptId) || (interruptSettlement && worker.step === 0),
          'duplicate settlement');
        retired.add(candidate.attemptId);
        if (scenario === 'complete') {
          await operation();
          if (worker.step === 0) {
            const reopened = await host.startLocal(input);
            assert.equal(reopened.attemptId, candidate.attemptId);
            const bridge = createMcpBridgeHandler({ runtimeHome, hostWorkerSessions: host });
            const reply = assertTestRecord(await bridge({
              jsonrpc: '2.0', id: 1, method: 'tools/call',
              params: { name: 'kernel_next', arguments: {
                workspaceRoot: projectRoot, runId, contractJson: taskContract,
                worker: { action: 'start', model: input.model, effort: input.effort },
              } },
            }));
            const result = assertTestRecord(reply.result);
            assert.equal(result.isError, false);
            assert.ok(Array.isArray(result.content));
            const retry = assertTestRecord(JSON.parse(String(assertTestRecord(result.content[0]).text)));
            assert.equal(retry.status, 'host-worker-attached');
            assert.equal(assertTestRecord(retry.hostWorker).attemptId, candidate.attemptId);
            assert.equal(retry.action, undefined);
            assert.equal(retry.next, undefined);
            await assert.rejects(competingHost.startLocal(input),
              { code: 'host_worker_previous_attempt_unreconciled' });
            assert.equal((await workerLaunches()).length, 1);
          }
          return;
        }
        const plane = candidate.controlPlane;
        const ready = plane.assertOwnerWorkspaceMutationReady;
        const mutate = plane.recordOwnerWorkspaceMutation;
        const settle = plane.settleParallelResult;
        const persistReport = plane.stateStore.setStepAttemptReportResult;
        if (scenario === 'ambiguous') {
          plane.recordOwnerWorkspaceMutation = () => { throw new Error('interrupted after Git apply and before CAS'); };
        } else if (worker.step === 0) {
          firstStepInvocations += 1;
          if (firstStepInvocations === 1) {
            plane.assertOwnerWorkspaceMutationReady = () => { throw new Error('interrupted before Owner apply'); };
          }
          if (firstStepInvocations === 2) {
            plane.recordOwnerWorkspaceMutation = (...args) => {
              mutate.apply(plane, args);
              throw new Error('Owner CAS response lost after commit');
            };
            plane.settleParallelResult = async (...args) => {
              if (args[2]?.guardedProofRoot) throw new Error('interrupted before Report');
              return settle.apply(plane, args);
            };
          }
          if (firstStepInvocations === 3) {
            plane.stateStore.setStepAttemptReportResult = () => {
              const step = plane.stateStore.getRunStep(runId, candidate.stepId);
              assert.equal(step?.state, 'passed');
              assert.ok(step?.completedAt);
              firstStepCompletedAt = step.completedAt;
              checkpointInterrupted = true;
              throw new Error('interrupted after Step passed and before Report result');
            };
            plane.settleParallelResult = async (...args) => {
              if (checkpointInterrupted) throw new Error('Host stopped before it could recover the Report');
              return settle.apply(plane, args);
            };
          }
        }
        if (worker.step === 2) {
          plane.settleParallelResult = async (...args) => {
            const outcome = await settle.apply(plane, args);
            if (!reportResponseLost && assertTestRecord(outcome).status === 'completed') {
              reportResponseLost = true;
              throw new Error('Report response lost after persistence');
            }
            return outcome;
          };
        }
        try {
          const checkpointRetry = worker.step === 0 && firstStepInvocations === 4;
          const proofCount = checkpointRetry ? plane.stateStore.getVerificationHistory(runId).length : null;
          await operation();
          if (checkpointRetry) {
            assert.equal(plane.stateStore.getVerificationHistory(runId).length, proofCount);
            assert.equal((await plane.getRun(runId))?.mutationRevision, 1);
            if (!hostResponseLost) {
              hostResponseLost = true;
              throw new Error('Host result lost after Canonical Report persistence');
            }
          }
        } finally {
          plane.assertOwnerWorkspaceMutationReady = ready;
          plane.recordOwnerWorkspaceMutation = mutate;
          plane.settleParallelResult = settle;
          plane.stateStore.setStepAttemptReportResult = persistReport;
        }
      },
    };
    const host = createHostWorkerSessions(hostOptions);
    const competingHost = createHostWorkerSessions(hostOptions);
    const control = createLocalWorkerControl({ projectRoot, runtimeHome, hostWorkerSessions: host });
    const localStart = async (action: 'start' | 'resume') => {
      const result = await control({ action, runId, model: input.model, effort: input.effort });
      assert.equal(result.status, 'host-worker-attached', JSON.stringify(result));
      const worker = assertTestRecord(result.hostWorker);
      return { attemptId: assertTestString(worker.attemptId), stepId: assertTestString(worker.stepId) };
    };
    const started = await Promise.all([localStart('start'), localStart('start')]);
    assert.equal(started[0].attemptId, started[1].attemptId);
    if (scenario !== 'complete') {
      for (const [index, revision] of (interruptSettlement ? [0, 1, 1, 1] : [0]).entries()) {
        let blocked = false;
        const retryDeadline = Date.now() + 30_000;
        while (Date.now() < retryDeadline) {
          const view = await host.status(projectRoot, runtimeHome, runId);
          if (view?.settlement?.status === 'blocked') { blocked = true; break; }
          await sleep(100);
        }
        assert.ok(blocked, 'interrupted settlement must return control');
        assert.equal((await cp.getRun(runId))?.mutationRevision, revision);
        const attempts: Array<{ reportResult: unknown }> = cp.stateStore.getStepAttempts(runId);
        assert.equal(attempts.length, 1);
        if (index === 3) assert.ok(attempts[0].reportResult);
        else assert.equal(attempts[0].reportResult, null);
        if (index === 2) {
          assert.equal(checkpointInterrupted, true);
          assert.equal(cp.getPendingHostWorkerDelivery(runId, started[0].attemptId)?.reportCheckpointPending, true);
        }
        assert.equal((await workerLaunches()).length, 1);
        if (scenario === 'ambiguous') {
          assert.equal((await cp.getRun(runId))?.status, 'blocked');
          assert.equal(cp.stateStore.getMutationProvenance(runId), null);
          assert.equal(await readFile(path.join(projectRoot, names[0]), 'utf8'), 'accepted');
          await assert.rejects(host.startLocal(input));
          assert.equal(cp.getHostRoutingSnapshot(runId).stepAttempts.length, 1);
          assert.equal((await workerLaunches()).length, 1);
          return;
        }
        if (revision === 0) {
          await assert.rejects(readFile(path.join(projectRoot, names[0]), 'utf8'), { code: 'ENOENT' });
        } else {
          assert.equal(await readFile(path.join(projectRoot, names[0]), 'utf8'), 'accepted');
        }
        const resumed = await localStart('resume');
        if (index === 3) assert.equal(resumed.stepId, steps[1].stepId);
        else assert.equal(resumed.attemptId, started[0].attemptId);
      }
    }
    const deadline = Date.now() + 150_000;
    while (Date.now() < deadline) {
      const run = await cp.getRun(runId);
      const view = await host.status(projectRoot, runtimeHome, runId);
      if (run?.status === 'completed' && view?.settlement?.status === 'settled') break;
      assert.equal(view?.continuationFailure, null, JSON.stringify(view));
      assert.notEqual(view?.settlement?.status, 'blocked', JSON.stringify(view));
      assert.notEqual(view?.preflight?.status, 'blocked', JSON.stringify(view));
      await sleep(100);
    }
    const run = await cp.getRun(runId);
    assert.equal(run?.status, 'completed');
    assert.equal(run?.mutationRevision, 3);
    assert.deepEqual((await workerLaunches()).map(entry => entry.step), [0, 1, 1, 2]);
    assert.equal(retired.size, 4);
    if (interruptSettlement) {
      assert.equal(firstStepInvocations, 4);
      assert.equal(checkpointInterrupted, true);
      assert.equal(cp.stateStore.getRunStep(runId, steps[0].stepId)?.completedAt, firstStepCompletedAt);
      assert.equal(reportResponseLost, true);
      assert.equal(hostResponseLost, true);
    }
    const attempts = cp.getHostRoutingSnapshot(runId).stepAttempts;
    const failed = attempts.filter(attempt => attempt.status === 'failed');
    const passed = attempts.filter(attempt => attempt.status === 'passed');
    assert.equal(attempts.length, 4);
    assert.equal(failed.length, 1);
    assert.equal(failed[0].stepId, steps[1].stepId);
    assert.equal(failed[0].failureCategory, 'host-worker-candidate-proof');
    assert.equal(failed[0].reportResult, null);
    assert.ok(failed[0].failureReasons.some(reason => typeof reason === 'string' && reason.includes('test:content')));
    assert.equal(passed.length, 3);
    assert.ok(passed.every(attempt => attempt.reportKey && attempt.reportResult));
    assert.equal(new Set(passed.map(attempt => attempt.reportKey)).size, 3);
    const finalReport = assertTestRecord(passed.find(attempt => attempt.stepId === steps[2].stepId)?.reportResult);
    assert.equal(assertTestRecord(assertTestRecord(finalReport.next).action).type, 'done');
    for (const name of names) assert.equal(await readFile(path.join(projectRoot, name), 'utf8'), 'accepted');
    const verifications = cp.stateStore.getVerificationHistory(runId);
    for (const [i, obligationId] of obligations.slice(0, 2).entries()) {
      const passes = verifications.filter(proof => proof.obligationId === obligationId && proof.status === 'passed');
      assert.ok(passes.some(proof => proof.verifiedMutationRevision === i + 1));
      assert.ok(passes.some(proof => proof.verifiedMutationRevision === 3 && proof.reuseOfVerificationId === null));
    }
    const next = assertTestRecord(await cp.next(runId));
    assert.equal(assertTestRecord(next.action).type, 'done');
  } finally {
    await cp?.close();
    await rm(root, { recursive: true, force: true });
  }
};

test('A2-2 A3-1 A3-2: local Host Worker settles three Steps, repairs one candidate and refreshes stale Proof',
  { timeout: 240_000 }, () => runLocalAcceptance('complete'));

test('A2-3: local Host Worker recovers before apply, after CAS, after Step pass and after Report without a duplicate Writer',
  { timeout: 240_000 }, () => runLocalAcceptance('recover'));

test('A2-3: local Host blocks ambiguous Git apply without CAS and retains the original Attempt',
  { timeout: 90_000 }, () => runLocalAcceptance('ambiguous'));
