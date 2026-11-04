// Real independent Host processes prove the existing post-CAS fail-closed
// recovery gate. The fixture Workers are synchronous and known finished; no
// unknown-lifetime Native Writer is restarted or retired by this test.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createKernelControlPlane } from '../src/host/kernel/control-plane-runtime.js';
import { cleanupExecutionWorkspaces } from '../src/host/kernel/workspace/physical-worktree.js';
import { runGit } from '../src/shared/git-safe.js';

const hostSource = String.raw`
import { createKernelControlPlane } from './scripts/host/kernel/control-plane-runtime.js';
import { dispatchKernelParallel } from './scripts/host/kernel/parallel-dispatcher.js';
import { executeTrustedProof } from './scripts/host/kernel/proof/proof-executor.js';
import { existsSync,readFileSync,writeFileSync,mkdirSync } from 'node:fs';
import path from 'node:path';
const {T38_ROOT:root,T38_REPO:projectRoot,T38_HOME:runtimeHome,T38_RUN:runId,T38_MODE:mode}=process.env;
const cp=await createKernelControlPlane({projectRoot,runtimeHome});
try{
 if(mode==='crash'||mode==='normal'){
  if(mode==='crash'){
   cp.settleParallelResult=async()=>{
    const revision=cp.stateStore.getRun(runId)?.mutationRevision;
    writeFileSync(path.join(root,'at-cas.json'),JSON.stringify({revision}));
    process.exit(73);
   };
  }
  const outcome=await dispatchKernelParallel({
   controlPlane:cp,runId,projectRoot,runtimeHome,parentSessionId:'t38-process-'+mode,
   adapter:{capabilities:{surface:'codex',supportsConcurrentSessions:true,supportsIsolatedWorkingDirectory:true,supportsPerSessionEnvironment:true}},
   actionContext:{integrationVerification:{commandRef:'test:ok'}},
   dispatchStep:async({step,workspace})=>{
    const name=String(step.objective).endsWith('alpha')?'alpha':'beta';
    const relative='src/'+name+'/result.txt';
    const file=path.join(workspace.workspaceRoot,relative);
    mkdirSync(path.dirname(file),{recursive:true});
    writeFileSync(file,name+'\n');
    // A physical event written once by each synchronous fixture Worker.
    const marker=path.join(root,'worker-start-'+name);
    if(existsSync(marker))throw Error('Worker restarted: '+name);
    writeFileSync(marker,'one\n');
    return {status:'passed',resultStatus:'passed',report:{summary:name+' completed',changedPaths:[relative],
     verifications:[{obligationId:name+'-proof',commandRef:'test:ok',acceptanceCoverage:['AC-'+name.toUpperCase()]},
      ...(name==='beta'?[{obligationId:'unit-test',commandRef:'test:ok',acceptanceCoverage:[]}]:[])]}};
   },
   executeIntegrationVerification:({commandRef,workspaceRoot})=>{
    const proof=executeTrustedProof({projectRoot:workspaceRoot,commandRef,
     writeScope:process.platform==='darwin'?workspaceRoot:undefined,timeoutMs:12000});
    return {status:proof.status,passed:proof.status==='passed',verificationRef:proof.evidenceRef,
     evidenceRef:proof.evidenceRef,mechanism:proof.writeContainment?.mechanism||null};
   },
  });
  writeFileSync(path.join(root,'dispatch-result.json'),JSON.stringify({status:outcome.status,
   integration:outcome.integration?.status,settled:outcome.executionResults?.length,
   failures:outcome.settlementFailures?.length,revision:cp.stateStore.getRun(runId)?.mutationRevision}));
 }else{
  const before=cp.stateStore.getRun(runId);
  const beforeAttempts=cp.stateStore.getStepAttempts(runId);
  const beforeProv=cp.stateStore.getMutationProvenance(runId);
  const steps=cp.stateStore.getRunSteps(runId);
  const executables=cp.getExecutableSteps(runId);
  let recovery=null;
  if(mode==='recover')recovery=await cp.recoverPendingDeliveryMaterialization(runId);
  const after=cp.stateStore.getRun(runId);
  const afterAttempts=cp.stateStore.getStepAttempts(runId);
  writeFileSync(path.join(root,'inspection-'+mode+'.json'),JSON.stringify({
   before:{status:before?.status,revision:before?.mutationRevision},
   after:{status:after?.status,revision:after?.mutationRevision,blockedReason:after?.blockedReason},
   attemptCountBefore:beforeAttempts.length,attemptCountAfter:afterAttempts.length,
   attemptStatuses:afterAttempts.map(a=>a.status),
   stepStates:steps.map(s=>s.state),
   executableCount:executables.steps.length,
   provenance:{revision:beforeProv?.mutationRevision,paths:beforeProv?.changedPaths},
   recovery:{status:recovery?.status,reason:recovery?.reason},
  }));
 }
}finally{await cp.close()}
`;

const git = (cwd: string, args: string[]): string => {
  const r = runGit(cwd, args);
  assert.equal(r.status, 0, String(r.stderr || r.error));
  return String(r.stdout || '').trim();
};
const host = (mode: string, root: string, projectRoot: string, runtimeHome: string, runId: string) => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', hostSource], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 85000,
    env: { ...process.env, T38_ROOT: root, T38_REPO: projectRoot, T38_HOME: runtimeHome, T38_RUN: runId, T38_MODE: mode },
  });
  assert.equal(result.error, undefined, String(result.error || ''));
  return result;
};
const setup = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 't38-two-host-cas-'));
  const projectRoot = path.join(root, 'owner');
  const runtimeHome = path.join(root, 'runtime');
  await Promise.all([mkdir(projectRoot), mkdir(runtimeHome)]);
  await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({
    name: 't38-two-host-cas-fixture', scripts: { 'test:ok': 'node --version' },
  }));
  git(projectRoot, ['init', '-b', 'main']);
  git(projectRoot, ['config', 'user.name', 'T38 Host Test']);
  git(projectRoot, ['config', 'user.email', 't38@example.invalid']);
  git(projectRoot, ['add', '--all']); git(projectRoot, ['commit', '-m', 'base']);
  const cp = await createKernelControlPlane({ projectRoot, runtimeHome });
  const runId = 't38-cross-host-report';
  const started = await cp.startRun({
    runId, objective: 'two independent Hosts and no duplicate Owner Delivery',
    taskContract: {
      complex: true, riskTier: 'T1',
      acceptance: [
        { id: 'AC-ALPHA', acceptance: 'alpha is written', evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test:ok'], obligationId: 'alpha-proof' } },
        { id: 'AC-BETA', acceptance: 'beta is written', evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test:ok'], obligationId: 'beta-proof' } },
      ],
      requiredObligations: ['alpha-proof', 'beta-proof'],
      requiredVerifications: [
        { obligationId: 'alpha-proof', commandRefs: ['test:ok'] },
        { obligationId: 'beta-proof', commandRefs: ['test:ok'] },
      ],
      steps: [
        { objective: 'materialize alpha', allowedPaths: ['src/alpha/**'], acceptanceIds: ['AC-ALPHA'], obligationIds: ['alpha-proof'], dependsOn: [] },
        { objective: 'materialize beta', allowedPaths: ['src/beta/**'], acceptanceIds: ['AC-BETA'], obligationIds: ['beta-proof'], dependsOn: [] },
      ],
    },
  });
  await cp.close();
  assert.ok(started.projectId);
  return { root, projectRoot, runtimeHome, runId, projectId: started.projectId };
};
const observe = async (root: string, mode: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(path.join(root, `inspection-${mode}.json`), 'utf8')) as Record<string, unknown>;
const isRecord = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

for (const mode of ['crash', 'normal'] as const) {
  test(`T38 two independent Host processes: ${mode === 'crash' ? 'owner CAS crash blocks duplicate settlement' : 'normal Proof settles both canonical Steps once'}`, {
    timeout: 95000,
  }, async () => {
    const f = await setup();
    let safe = false;
    try {
      const first = host(mode, f.root, f.projectRoot, f.runtimeHome, f.runId);
      if (mode === 'crash') {
        assert.equal(first.status, 73, `expected intentional process exit after Owner CAS: ${first.stderr}\n${first.stdout}`);
        assert.equal(isRecord(JSON.parse(await readFile(path.join(f.root, 'at-cas.json'), 'utf8'))).revision, 1);
      } else {
        assert.equal(first.status, 0, `normal Host: ${first.stderr}\n${first.stdout}`);
      }
      assert.equal(existsSync(path.join(f.root, 'worker-start-alpha')), true);
      assert.equal(existsSync(path.join(f.root, 'worker-start-beta')), true);
      const inspect = host('recover', f.root, f.projectRoot, f.runtimeHome, f.runId);
      assert.equal(inspect.status, 0, `recovering Host: ${inspect.stderr}\n${inspect.stdout}`);
      const state = await observe(f.root, 'recover');
      assert.equal(isRecord(state.before).revision, 1);
      assert.equal(isRecord(state.after).revision, 1);
      assert.equal(state.attemptCountBefore, 2);
      assert.equal(state.attemptCountAfter, 2);
      assert.equal(state.executableCount, 0);
      if (mode === 'crash') {
        assert.equal(isRecord(state.recovery).status, 'blocked');
        assert.equal(isRecord(state.after).status, 'blocked');
        assert.equal(isRecord(state.after).blockedReason, 'delivery_materialization_recovery_required');
        assert.deepEqual(state.attemptStatuses, ['started', 'started']);
      } else {
        assert.equal(isRecord(state.recovery).status, 'none');
        assert.deepEqual(state.attemptStatuses, ['passed', 'passed']);
        const sent = isRecord(JSON.parse(await readFile(path.join(f.root, 'dispatch-result.json'), 'utf8')));
        assert.equal(sent.status, 'passed', JSON.stringify(sent));
        assert.equal(sent.settled, 2);
      }
      // A third fresh process cannot re-trigger a Worker or Owner mutation.
      const repeat = host('recheck', f.root, f.projectRoot, f.runtimeHome, f.runId);
      assert.equal(repeat.status, 0, `third Host: ${repeat.stderr}\n${repeat.stdout}`);
      const repeated = await observe(f.root, 'recheck');
      assert.equal(isRecord(repeated.after).revision, 1);
      assert.equal(repeated.attemptCountAfter, 2);
      assert.equal(repeated.executableCount, 0);
      for (const name of ['alpha', 'beta']) {
        assert.equal(await readFile(path.join(f.root, `worker-start-${name}`), 'utf8'), 'one\n');
        assert.equal(await readFile(path.join(f.projectRoot, 'src', name, 'result.txt'), 'utf8'), `${name}\n`);
      }
      const cp = await createKernelControlPlane({ projectRoot: f.projectRoot, runtimeHome: f.runtimeHome });
      assert.equal(cp.stateStore.getStepAttempts(f.runId).length, 2);
      assert.equal(cp.stateStore.getRun(f.runId)?.mutationRevision, 1);
      await cp.close();
      // No Native/async Writers were ever launched by the test, so its own
      // temporary Git Worktrees are safe to remove after all Hosts exited.
      await cleanupExecutionWorkspaces({
        runtimeHome: f.runtimeHome, projectId: f.projectId,
        runId: f.runId, repoRoot: f.projectRoot, retain: false,
      });
      safe = true;
    } finally {
      if (safe) await rm(f.root, { recursive: true, force: true });
      else console.warn('Retained uncertain T38 two-Host fixture:', f.root);
    }
  });
}
