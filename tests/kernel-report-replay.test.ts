import { assertTestPresent, assertTestRecord, assertTestString } from './helpers/assert-value.js';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { test } from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createKernelControlPlane } from '../src/host/kernel/control-plane-runtime.js';
import { dispatchKernelTurn } from '../src/host/kernel/turn-dispatcher.js';
import { createClaudeAdapter } from '../src/host/kernel/adapters/claude.js';
import { createModelRegistry } from '../src/host/kernel/model-registry.js';

const childSource = String.raw`
import { readFile, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { createKernelControlPlane } from 'CONTROL_PLANE';

const [runtimeHome, projectRoot, payloadFile, resultFile, crashAfterReport] = process.argv.slice(2);
const payload = JSON.parse(await readFile(payloadFile, 'utf8'));
const cp = await createKernelControlPlane({ runtimeHome, projectRoot, holder: 'replay-child-' + process.pid });
if (crashAfterReport === '1') {
  let pendingReportResult = null;
  const finishStepAttempt = cp.stateStore.finishStepAttempt.bind(cp.stateStore);
  const finishStepAttemptWithReportResult = cp.stateStore.finishStepAttemptWithReportResult.bind(cp.stateStore);
  cp.stateStore.finishStepAttemptWithReportResult = (attemptId, finishOptions, reportResult) => {
    pendingReportResult = reportResult;
    return finishStepAttemptWithReportResult(attemptId, finishOptions, reportResult);
  };
  cp.stateStore.finishStepAttempt = (...args) => {
    const settled = finishStepAttempt(...args);
    if (pendingReportResult) {
      // Capture the exact in-memory result, then exit after the canonical
      // settlement UPDATE. The durable result journal must survive this
      // interrupted settlement so restart can replay without new proof.
      writeFileSync(resultFile, JSON.stringify(pendingReportResult));
      process.exit(0);
    }
    return settled;
  };
}
try {
  const result = await cp.report(payload.runId, payload);
  if (crashAfterReport === '1') process.exit(3);
  await writeFile(resultFile, JSON.stringify(result));
  process.stdout.write(JSON.stringify({
    status: result.status,
    idempotentReplay: result.idempotentReplay === true,
    attemptNumber: result.attemptNumber,
  }) + '\n');
} finally {
  await cp.close();
}
`;

const runChild = ({ sourceFile, runtimeHome, projectRoot, payloadFile, resultFile, crashAfterReport = false }: { sourceFile: string; runtimeHome: string; projectRoot: string; payloadFile: string; resultFile: string; crashAfterReport?: boolean }) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [sourceFile, runtimeHome, projectRoot, payloadFile, resultFile, crashAfterReport ? '1' : '0'], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('error', reject);
  child.on('close', (code) => {
    if (code !== 0) {
      if (crashAfterReport && code === 3) {
        reject(new Error('replay child returned without reaching the injected crash window'));
        return;
      }
      reject(new Error(`replay child exited ${code}: ${stderr || stdout}`));
      return;
    }
    if (crashAfterReport && !stdout.trim()) {
      resolve({ crashed: true });
      return;
    }
    try {
      resolve(JSON.parse(assertTestString(stdout.trim().split(/\r?\n/).filter(Boolean).at(-1))));
    } catch (error) {
      reject(new Error(`replay child returned invalid JSON: ${assertTestRecord(error).message}; stdout=${stdout}; stderr=${stderr}`));
    }
  });
});

for (const named of [true, false]) test(`S-03/S-04: direct ${named ? 'named' : 'unnamed'} report replays across cursor advance and restart`, async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'direct-replay-home-'));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'direct-replay-project-'));
  let cp;
  try {
    await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({ scripts: { test: 'node -p 1' } }));
    cp = await createKernelControlPlane({ runtimeHome, projectRoot });
    const runId = 'direct-replay';
    await cp.startRun({ runId, objective: 'two direct work reports', taskContract: { complex: true, acceptance: ['works'], steps: [
      { stepId: 'first', objective: 'first', allowedPaths: ['package.json'], acceptanceIds: ['AC-1'] },
      { stepId: 'second', objective: 'second', allowedPaths: ['package.json'], acceptanceIds: ['AC-1'] },
    ] } });
    const payload = { summary: 'first delivery', ...(named ? { stepId: 'first' } : {}) };
    const first = await cp.report(runId, payload);
    assert.equal(assertTestRecord(assertTestRecord(assertTestPresent(first)).step).state, 'passed');
    assert.ok(assertTestRecord(assertTestPresent(first)).reportKey);
    const count = cp.stateStore.getStepAttempts(runId).length;
    assert.equal(assertTestPresent(cp.getCurrentStep(runId)).stepId, 'second');
    assert.deepEqual(await cp.report(runId, payload), { ...JSON.parse(JSON.stringify(first)), idempotentReplay: true });
    await cp.close();
    cp = await createKernelControlPlane({ runtimeHome, projectRoot });
    assert.deepEqual(await cp.report(runId, payload), { ...JSON.parse(JSON.stringify(first)), idempotentReplay: true });
    assert.equal(cp.stateStore.getStepAttempts(runId).length, count);
    assert.equal(assertTestPresent(cp.getCurrentStep(runId)).stepId, 'second');
    const conflict = await cp.report(runId, { ...payload, reportKey: assertTestString(assertTestRecord(assertTestPresent(first)).reportKey), summary: 'different payload' });
    assert.equal(assertTestPresent(conflict).status, 'report-conflict');
    assert.equal(assertTestPresent(conflict).errorCode, 'REPORT_OPERATION_PAYLOAD_CONFLICT');
    assert.equal(cp.stateStore.getStepAttempts(runId).length, count);
  } finally { await cp?.close(); await rm(runtimeHome, { recursive: true, force: true }); await rm(projectRoot, { recursive: true, force: true }); }
});

test('pre-bound Host Step Attempt owns durable report replay across restart', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-report-replay-home-'));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'kernel-report-replay-project-'));
  const coordinationRoot = await mkdtemp(path.join(os.tmpdir(), 'kernel-report-replay-coordination-'));
  const childFile = path.join(coordinationRoot, 'replay-child.mjs');
  const payloadFile = path.join(coordinationRoot, 'report.json');
  let cp: TestControlPlane | null = null;
  try {
    spawnSync('git', ['init'], { cwd: projectRoot, encoding: 'utf8' });
    await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({
      name: 'report-replay-fixture',
      scripts: { lint: 'node -e "process.exit(0)"' },
    }));
    await writeFile(path.join(projectRoot, 'app.mjs'), 'export const value = 0;\n');
    let child = childSource;
    child = child.replace('CONTROL_PLANE', pathToFileURL(path.join(process.cwd(), 'scripts/host/kernel/control-plane-runtime.js')).href);
    await writeFile(childFile, child);

    cp = await createKernelControlPlane({ runtimeHome, projectRoot, holder: 'parent' });
    const runId = 'canonical-report-replay';
    await assertTestPresent(cp).startRun({
      runId,
      objective: 'persist the canonical report result',
      taskContract: { acceptance: [], allowedPaths: ['app.mjs'] },
    });
    const adapter = createClaudeAdapter({
      launch: async ({ invocation }) => ({ resolvedModel: assertTestRecord(invocation).model, sessionId: 'pre-bound-host' }),
    });
    const turn = await dispatchKernelTurn({
      controlPlane: cp,
      runId,
      adapter,
      registry: createModelRegistry({
        surface: 'claude',
        env: { MOON_RELAY_KERNEL_MODEL_FRONTIER: 'frontier', MOON_RELAY_KERNEL_MODEL_VALUE: 'value' },
      }),
      actionContext: { executionMode: 'native-subagent', delegationRequested: true },
    });
    assert.equal(turn.dispatched, true);

    const preBoundAttempt = assertTestPresent(cp).stateStore.getStepAttempts(runId).at(-1);
    assert.ok(preBoundAttempt?.attemptId, 'Host dispatch must pre-bind a canonical string attemptId');
    assert.notEqual(String(preBoundAttempt.attemptId), String(preBoundAttempt.id), 'legacy numeric row id must not be the canonical attempt id');
    await writeFile(path.join(projectRoot, 'app.mjs'), 'export const value = 1;\n');
    const payload = {
      runId,
      summary: 'persisted canonical report',
      capsuleId: assertTestPresent(turn.executionCapsule).capsuleId,
      stepId: assertTestPresent(turn.executionCapsule).stepId,
      attemptId: preBoundAttempt.attemptId,
      changedPaths: ['app.mjs'],
    };
    const expectedCanonicalAttemptCount = assertTestPresent(cp).stateStore.getStepAttempts(runId).length;
    const expectedVerificationCount = assertTestPresent(cp).stateStore.getVerifications(runId).length;
    await writeFile(payloadFile, JSON.stringify(payload));
    const firstResultFile = path.join(coordinationRoot, 'first-result.json');
    const replayResultFile = path.join(coordinationRoot, 'replay-result.json');
    await assertTestPresent(cp).close();
    cp = null;

    const firstChild = await runChild({
      sourceFile: childFile,
      runtimeHome,
      projectRoot,
      payloadFile,
      resultFile: firstResultFile,
      crashAfterReport: true,
    });
    const originalResult = JSON.parse(await readFile(firstResultFile, 'utf8'));
    assert.equal(assertTestRecord(firstChild).crashed, true);
    assert.equal(originalResult.status, 'completed');
    assert.equal(originalResult.attemptNumber, preBoundAttempt.attemptNumber);

    const recoveryCp = await createKernelControlPlane({ runtimeHome, projectRoot, holder: 'recovery-parent' });
    try {
      assert.equal(recoveryCp.stateStore.getStepAttempts(runId).length, expectedCanonicalAttemptCount);
      assert.equal(recoveryCp.stateStore.getVerifications(runId).length, expectedVerificationCount + 1);
      const stored = recoveryCp.stateStore.getStepAttemptByAttemptId(preBoundAttempt.attemptId, { runId });
      assert.match(assertTestPresent(stored).reportKey || '', /^report-op-[a-f0-9]{64}$/);
      assert.match(assertTestPresent(stored).reportPayloadDigest || '', /^[a-f0-9]{64}$/);
      assert.deepEqual(assertTestPresent(stored).reportResult, originalResult);

      const replay = await runChild({ sourceFile: childFile, runtimeHome, projectRoot, payloadFile, resultFile: replayResultFile });
      const replayResult = JSON.parse(await readFile(replayResultFile, 'utf8'));
      const { idempotentReplay, ...replayedPublicResult } = replayResult;
      assert.equal(idempotentReplay, true);
      assert.deepEqual(replayedPublicResult, originalResult, 'restart replay must return the exact committed report result');
      assert.deepEqual(assertTestPresent(recoveryCp.stateStore.getStepAttemptByAttemptId(preBoundAttempt.attemptId, { runId })).reportResult, originalResult);
      assert.equal(recoveryCp.stateStore.getStepAttempts(runId).length, expectedCanonicalAttemptCount, 'replay must not create a new canonical attempt');
      assert.equal(recoveryCp.stateStore.getVerifications(runId).length, expectedVerificationCount + 1, 'replay must not execute new proof');
    } finally {
      await recoveryCp.close();
    }
  } finally {
    if (cp) await assertTestPresent(cp).close();
    await rm(runtimeHome, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
    await rm(coordinationRoot, { recursive: true, force: true });
  }
});

test('same report operation rejects a different payload without replaying side effects', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-report-conflict-home-'));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'kernel-report-conflict-project-'));
  let cp: TestControlPlane | null = null;
  try {
    spawnSync('git', ['init'], { cwd: projectRoot, encoding: 'utf8' });
    await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({
      name: 'report-conflict-fixture',
      scripts: { lint: 'node -e "process.exit(0)"' },
    }));
    await writeFile(path.join(projectRoot, 'app.mjs'), 'export const value = 0;\n');
    cp = await createKernelControlPlane({ runtimeHome, projectRoot, holder: 'conflict-parent' });
    const runId = 'canonical-report-conflict';
    await assertTestPresent(cp).startRun({
      runId,
      objective: 'reject changed payload on one report operation',
      taskContract: { acceptance: [], allowedPaths: ['app.mjs'] },
    });
    const adapter = createClaudeAdapter({
      launch: async ({ invocation }) => ({ resolvedModel: assertTestRecord(invocation).model, sessionId: 'conflict-host' }),
    });
    const turn = await dispatchKernelTurn({
      controlPlane: cp,
      runId,
      adapter,
      registry: createModelRegistry({
        surface: 'claude',
        env: { MOON_RELAY_KERNEL_MODEL_FRONTIER: 'frontier', MOON_RELAY_KERNEL_MODEL_VALUE: 'value' },
      }),
      actionContext: { executionMode: 'native-subagent', delegationRequested: true },
    });
    const attempt = assertTestPresent(cp).stateStore.getStepAttempts(runId).at(-1);
    await writeFile(path.join(projectRoot, 'app.mjs'), 'export const value = 1;\n');
    const first = await assertTestPresent(cp).report(runId, {
      summary: 'stable payload',
      capsuleId: assertTestPresent(turn.executionCapsule).capsuleId,
      stepId: assertTestPresent(turn.executionCapsule).stepId,
      attemptId: assertTestPresent(attempt).attemptId,
      changedPaths: ['app.mjs'],
    });
    assert.equal(assertTestPresent(first).status, 'completed');
    const beforeVerifications = assertTestPresent(cp).stateStore.getVerifications(runId).length;
    const conflict = await assertTestPresent(cp).report(runId, {
      summary: 'changed payload',
      capsuleId: assertTestPresent(turn.executionCapsule).capsuleId,
      stepId: assertTestPresent(turn.executionCapsule).stepId,
      attemptId: assertTestPresent(attempt).attemptId,
      changedPaths: ['app.mjs'],
    });
    assert.equal(assertTestPresent(conflict).status, 'report-conflict');
    assert.equal(assertTestPresent(conflict).errorCode, 'REPORT_OPERATION_PAYLOAD_CONFLICT');
    assert.equal(assertTestPresent(cp).stateStore.getVerifications(runId).length, beforeVerifications);
  } finally {
    if (cp) await assertTestPresent(cp).close();
    await rm(runtimeHome, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  }
});

for (const named of [true, false]) test(`report recovery resumes ${named ? 'named' : 'unnamed'} delivery after Work passed before result persistence`, async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'settlement-home-'));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'settlement-project-'));
  const coordination = await mkdtemp(path.join(os.tmpdir(), 'settlement-child-'));
  let cp;
  try {
    await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({ scripts: { test: 'node -p 1' } }));
    spawnSync('git',['init'],{cwd:projectRoot,encoding:'utf8'});
    cp = await createKernelControlPlane({ runtimeHome, projectRoot });
    const runId = 'settlement-gap';
    await cp.startRun({ runId, objective: 'recover settlement', taskContract: { complex: true, acceptance: ['works'], steps: [
      { stepId: 'first', objective: 'first', allowedPaths: ['package.json'], acceptanceIds: ['AC-1'] },
      { stepId: 'second', objective: 'second', allowedPaths: ['package.json'], acceptanceIds: ['AC-1'] },
    ] } });
    await cp.close(); cp = null;
    const sourceFile = path.join(coordination, 'child.mjs');
    const payloadFile = path.join(coordination, 'payload.json');
    const resultFile = path.join(coordination, 'result.json');
    const payload = { runId, summary: 'interrupted delivery', ...(named ? { stepId: 'first' } : {}) };
    await writeFile(payloadFile, JSON.stringify(payload));
    const moduleUrl = pathToFileURL(path.join(process.cwd(), 'scripts/host/kernel/control-plane-runtime.js')).href;
    await writeFile(sourceFile, `import {readFile} from 'node:fs/promises';
import {createKernelControlPlane} from '${moduleUrl}';
const [runtimeHome,projectRoot,payloadFile]=process.argv.slice(2);
const payload=JSON.parse(await readFile(payloadFile,'utf8'));
const cp=await createKernelControlPlane({runtimeHome,projectRoot});
const original=cp.settleStep.bind(cp);
cp.settleStep=(...args)=>{original(...args);process.exit(0);};
await cp.report(payload.runId,payload);process.exit(3);`);
    await runChild({ sourceFile, runtimeHome, projectRoot, payloadFile, resultFile, crashAfterReport: true });
    cp = await createKernelControlPlane({ runtimeHome, projectRoot });
    const pending = cp.stateStore.getStepAttempts(runId)[0];
    assert.equal(assertTestPresent(cp.stateStore.getRunStep(runId, 'first')).state, 'passed');
    assert.equal(pending.reportResult, null);
    assert.ok(pending.reportCheckpoint);
    // Simulate the dead process's lease expiry; this is not a receipt or a
    // progress write. The successor must acquire its own fencing token.
    const lease = cp.stateStore.getLease(runId);
    cp.stateStore.releaseLease(runId, {holder:assertTestPresent(lease).holder, fencingToken:assertTestPresent(lease).fencingToken});
    const proofCount = cp.stateStore.getVerificationHistory(runId).length;
    const packageFile=path.join(projectRoot,'package.json');
    const originalPackage=await readFile(packageFile,'utf8');
    await writeFile(packageFile,originalPackage+'\n');
    const stale=await cp.report(runId,{...payload,reportKey:assertTestString(pending.reportKey)});
    assert.equal(assertTestPresent(stale).errorCode,'REPORT_CHECKPOINT_STALE');
    assert.equal(cp.stateStore.getStepAttempts(runId).length,1);
    await writeFile(packageFile,originalPackage);
    const recovered = await cp.report(runId, payload);
    assert.ok(assertTestRecord(assertTestPresent(recovered)).step,JSON.stringify(recovered));
    assert.equal(assertTestRecord(assertTestRecord(assertTestPresent(recovered)).step).state, 'passed');
    assert.equal(assertTestPresent(cp.getCurrentStep(runId)).stepId, 'second');
    assert.equal(cp.stateStore.getStepAttempts(runId).length, 1);
    assert.equal(cp.stateStore.getVerificationHistory(runId).length, proofCount, 'recovery does not execute settled proof again');
    assert.deepEqual(await cp.report(runId, payload), { ...JSON.parse(JSON.stringify(recovered)), idempotentReplay: true });
  } finally { await cp?.close(); await rm(runtimeHome, {recursive:true,force:true}); await rm(projectRoot, {recursive:true,force:true}); await rm(coordination, {recursive:true,force:true}); }
});

test('same direct payload after a workspace repair creates a fresh Attempt and reruns proof', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'repair-payload-home-'));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'repair-payload-project-'));
  let cp;
  try {
    await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({ scripts: { test: 'node check.mjs' } }));
    await writeFile(path.join(projectRoot, 'check.mjs'), 'process.exit(1);');
    cp = await createKernelControlPlane({ runtimeHome, projectRoot });
    const runId='same-payload-repair';
    await cp.startRun({ runId, objective: 'repair proof', taskContract: { acceptance: [{acceptance:'works',evidencePlan:{class:'hard',method:'unit-test',commandRefs:['test'],obligationId:'work-test',evidenceLevel:'work'}}], allowedPaths: ['check.mjs'] } });
    await writeFile(path.join(projectRoot, 'check.mjs'), 'process.exit(2);');
    const payload={summary:'checked implementation',changedPaths:['check.mjs']};
    const failed=await cp.report(runId,payload);
    assert.equal(assertTestPresent(failed).status,'evidence-failed');
    await writeFile(path.join(projectRoot,'check.mjs'),'process.exit(0);');
    // Reuse exactly the prior report, including summary and changed paths.
    // File content changed, so this is a fresh attempt rather than delivery replay.
    const secondFailure=await cp.report(runId,payload);
    assert.notEqual(assertTestRecord(assertTestPresent(secondFailure)).idempotentReplay,true);
    assert.equal(assertTestPresent(secondFailure).status,'completed');
    assert.equal(cp.stateStore.getStepAttempts(runId).length,2);
    assert.notEqual(assertTestRecord(assertTestPresent(secondFailure)).reportKey,assertTestRecord(assertTestPresent(failed)).reportKey);
  } finally {await cp?.close();await rm(runtimeHome,{recursive:true,force:true});await rm(projectRoot,{recursive:true,force:true});}
});

const verifyFinalizationCheckpoint = async (gitCrashStage: string | null) => {
  const runtimeHome=await mkdtemp(path.join(os.tmpdir(),'final-report-home-'));
  const projectRoot=await mkdtemp(path.join(os.tmpdir(),'final-report-project-'));
  const coordination=await mkdtemp(path.join(os.tmpdir(),'final-report-child-'));
  let cp;
  try {
    await writeFile(path.join(projectRoot,'package.json'),JSON.stringify({scripts:{test:'node -p 1'}}));
    const git=(...args: string[])=>{const r=spawnSync('git',args,{cwd:projectRoot,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
    if(gitCrashStage){git('init','-b','main');git('config','user.name','Checkpoint Fixture');git('config','user.email','checkpoint@example.invalid');await writeFile(path.join(projectRoot,'app.mjs'),'export const v=1;');git('add','.');git('commit','-m','fixture');}
    cp=await createKernelControlPlane({runtimeHome,projectRoot});
    const runId='final-report-gap';
    await cp.startRun({runId,objective:'recover completed operation',taskContract:{acceptance:['works'],allowedPaths:['package.json','app.mjs']}});
    if(gitCrashStage)await writeFile(path.join(projectRoot,'app.mjs'),'export const v=2;');
    await cp.close();cp=null;
    const sourceFile=path.join(coordination,'child.mjs'),payloadFile=path.join(coordination,'payload.json'),resultFile=path.join(coordination,'result.json');
    const payload={runId,summary:'final delivery',...(gitCrashStage?{changedPaths:['app.mjs'],gitCloseoutRequest:{requested:true,mode:'commit',approvalReceipt:'fixture-explicit-approval'}}:{})};
    await writeFile(payloadFile,JSON.stringify(payload));
    const moduleUrl=pathToFileURL(path.join(process.cwd(),'scripts/host/kernel/control-plane-runtime.js')).href;
    await writeFile(sourceFile,`import {readFile} from 'node:fs/promises';
import {createKernelControlPlane} from '${moduleUrl}';
const [runtimeHome,projectRoot,payloadFile]=process.argv.slice(2);
const payload=JSON.parse(await readFile(payloadFile,'utf8'));
const cp=await createKernelControlPlane({runtimeHome,projectRoot});
${gitCrashStage === 'commit_created' ? `const record=cp.stateStore.recordGitCloseoutReceipt.bind(cp.stateStore);cp.stateStore.recordGitCloseoutReceipt=(...args)=>{const r=record(...args);if(args[1].status==='commit_created')process.exit(0);return r;};` : 'cp.stateStore.setStepAttemptReportResult=()=>process.exit(0);'}
await cp.report(payload.runId,payload);process.exit(3);`);
    await runChild({sourceFile,runtimeHome,projectRoot,payloadFile,resultFile,crashAfterReport:true});
    cp=await createKernelControlPlane({runtimeHome,projectRoot});
    assert.equal(assertTestPresent((await cp.getRun(runId))).status,'completed');
    const gitReceipt=gitCrashStage?cp.stateStore.getGitCloseoutReceipt(runId):null;
    if(gitCrashStage){assert.equal(assertTestPresent(gitReceipt).status,gitCrashStage);assert.equal(git('rev-parse','HEAD'),assertTestPresent(gitReceipt).commitSha);assert.equal(git('rev-list','--count','HEAD'),'2');}
    const pending=cp.stateStore.getStepAttempts(runId)[0];
    assert.equal(pending.reportResult,null);
    if(gitCrashStage)assertTestRecord(payload).reportKey=pending.reportKey;
    const lease=cp.stateStore.getLease(runId);cp.stateStore.releaseLease(runId,{holder:assertTestPresent(lease).holder,fencingToken:assertTestPresent(lease).fencingToken});
    const count=cp.stateStore.getVerificationHistory(runId).length;
    if(gitCrashStage){
      // Reject changes to content, the index, and HEAD even though a trusted
      // commit receipt exists. Restore the exact authorized state each time.
      await writeFile(path.join(projectRoot,'app.mjs'),'external mutation');
      assert.equal(assertTestPresent((await cp.report(runId,payload))).errorCode,'REPORT_CHECKPOINT_STALE');
      git('add','app.mjs');
      assert.equal(assertTestPresent((await cp.report(runId,payload))).errorCode,'REPORT_CHECKPOINT_STALE');
      git('reset','--hard',assertTestPresent(assertTestPresent(gitReceipt).commitSha));
      git('commit','--allow-empty','-m','external HEAD');
      assert.equal(assertTestPresent((await cp.report(runId,payload))).errorCode,'REPORT_CHECKPOINT_STALE');
      git('reset','--hard',assertTestPresent(assertTestPresent(gitReceipt).commitSha));
    }
    const recovered=await cp.report(runId,payload);
    assert.equal(assertTestPresent(recovered).status,'completed',JSON.stringify(recovered));
    if(gitCrashStage){assert.equal(git('rev-parse','HEAD'),assertTestPresent(gitReceipt).commitSha);assert.equal(git('rev-list','--count','HEAD'),'2');}
    assert.ok(cp.stateStore.getStepAttempts(runId)[0].reportResult);
    assert.equal(cp.stateStore.getVerificationHistory(runId).length,count);
    assert.equal(cp.stateStore.getStepAttempts(runId).length,1);
    assert.equal(assertTestRecord(assertTestRecord((await cp.next(runId))).action).type,'done');
    assert.deepEqual(await cp.report(runId,payload),{...JSON.parse(JSON.stringify(recovered)),idempotentReplay:true});
  } finally {await cp?.close();await rm(runtimeHome,{recursive:true,force:true});await rm(projectRoot,{recursive:true,force:true});await rm(coordination,{recursive:true,force:true});}
 };
test('report recovery finishes the same operation after finalization before result persistence', () => verifyFinalizationCheckpoint(null));
test('Git report checkpoint reuses a completed closeout after process restart and rejects external drift', () => verifyFinalizationCheckpoint('completed'));
test('Git report checkpoint resumes after commit creation without another commit or proof', () => verifyFinalizationCheckpoint('commit_created'));


type TestControlPlane = Awaited<ReturnType<typeof import("../src/host/kernel/control-plane-runtime.js").createKernelControlPlane>>;
