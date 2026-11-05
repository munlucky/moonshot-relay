// Real independent Host processes prove the existing post-CAS fail-closed
// recovery gate. The fixture Workers are synchronous and known finished; no
// unknown-lifetime Native Writer is restarted or retired by this test.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createKernelControlPlane } from '../src/host/kernel/control-plane-runtime.js';
import { dispatchKernelParallel } from '../src/host/kernel/parallel-dispatcher.js';
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
 if(mode==='crash'||mode==='normal'||mode==='guarded'||mode==='guarded-crash'){
  if(mode==='crash'||mode==='guarded-crash'){
   cp.settleParallelResult=async()=>{
    const revision=cp.stateStore.getRun(runId)?.mutationRevision;
    writeFileSync(path.join(root,'at-cas.json'),JSON.stringify({revision}));
    process.exit(73);
   };
  }
  if(mode==='guarded'){
   const original=cp.settleParallelResult.bind(cp);
   cp.settleParallelResult=async(...args)=>{
    const current=cp.stateStore.getRun(runId);
    const lock=cp.stateStore.getWorkspaceMutationLockV2(current.workspaceId);
    if(!lock||lock.holderRunId!==runId||!lock.fencingToken)throw Error('T41_FENCE_NOT_HELD_DURING_SETTLEMENT');
    const marker=path.join(root,'guarded-held-at-settlement');
    if(existsSync(marker) && readFileSync(marker,'utf8')!==String(lock.fencingToken)){
     throw Error('T41_OWNER_FENCE_EPOCH_CHANGED_BETWEEN_REPORTS');
    }
    writeFileSync(marker,String(lock.fencingToken));
    return original(...args);
   };
  }
  const outcome=await dispatchKernelParallel({
   guardedIntegration:mode.startsWith('guarded'),
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
   ...(!mode.startsWith('guarded') ? {executeIntegrationVerification:({commandRef,workspaceRoot})=>{
    const proof=executeTrustedProof({projectRoot:workspaceRoot,commandRef,
     writeScope:process.platform==='darwin'?workspaceRoot:undefined,timeoutMs:12000});
    return {status:proof.status,passed:proof.status==='passed',verificationRef:proof.evidenceRef,
     evidenceRef:proof.evidenceRef,mechanism:proof.writeContainment?.mechanism||null};
   }} : {}),
  });
  writeFileSync(path.join(root,'dispatch-result.json'),JSON.stringify({status:outcome.status,
   integration:outcome.integration?.status,settled:outcome.executionResults?.length,
   verificationMechanism:outcome.integration?.verification?.execution?.writeContainment?.mechanism||null,
   failures:outcome.settlementFailures?.length,revision:cp.stateStore.getRun(runId)?.mutationRevision}));
 }else{
  const before=cp.stateStore.getRun(runId);
  const heldFence=before?.workspaceId?cp.stateStore.getWorkspaceMutationLockV2(before.workspaceId):null;
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
   heldFence:{token:heldFence?.fencingToken||0,runId:heldFence?.holderRunId||null},
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
const setup = async ({ checkProofIsolation = false } = {}) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 't38-two-host-cas-'));
  const projectRoot = path.join(root, 'owner');
  const runtimeHome = path.join(root, 'runtime');
  await Promise.all([mkdir(projectRoot), mkdir(runtimeHome)]);
  if (checkProofIsolation) {
    const sentinel = path.join(root, 'protected-proof-target.txt');
    await writeFile(sentinel, 'protected\n');
    await writeFile(path.join(projectRoot, 'verify.cjs'), [
      "const fs = require('node:fs');",
      "if (!['alpha','beta'].every(name => fs.existsSync('src/' + name + '/result.txt'))) return;",
      `try { fs.writeFileSync(${JSON.stringify(sentinel)}, 'escaped'); }`,
      "catch (error) { if (['EACCES','EPERM'].includes(error.code)) return; throw error; }",
      "throw new Error('Proof wrote outside its worktree');",
    ].join('\n'));
  }
  await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({
    name: 't38-two-host-cas-fixture',
    scripts: { 'test:ok': checkProofIsolation ? 'node verify.cjs' : 'node --version' },
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

for (const mode of ['crash', 'normal', 'guarded', 'guarded-crash'] as const) {
  test(`T38/T41 independent Hosts: ${mode}`, {
    skip: mode.startsWith('guarded') && process.platform !== 'darwin' && 'requires macOS scoped OS write containment',
    timeout: 95000,
  }, async () => {
    const f = await setup({ checkProofIsolation: mode === 'guarded' });
    let safe = false;
    try {
      const first = host(mode, f.root, f.projectRoot, f.runtimeHome, f.runId);
      if (mode === 'crash' || mode === 'guarded-crash') {
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
      if (mode === 'crash' || mode === 'guarded-crash') {
        assert.equal(isRecord(state.recovery).status, 'blocked');
        assert.equal(isRecord(state.after).status, 'blocked');
        assert.equal(isRecord(state.after).blockedReason, 'delivery_materialization_recovery_required');
        assert.deepEqual(state.attemptStatuses, ['started', 'started']);
        if(mode==='guarded-crash'){
          assert.equal(isRecord(state.heldFence).runId,f.runId);
          assert.ok(Number(isRecord(state.heldFence).token)>0);
        }
      } else {
        assert.equal(isRecord(state.recovery).status, 'none');
        assert.deepEqual(state.attemptStatuses, ['passed', 'passed']);
        const sent = isRecord(JSON.parse(await readFile(path.join(f.root, 'dispatch-result.json'), 'utf8')));
        assert.equal(sent.status, 'passed', JSON.stringify(sent));
        assert.equal(sent.settled, 2);
        if(mode==='guarded'){
          assert.ok(existsSync(path.join(f.root,'guarded-held-at-settlement')));
          assert.equal(await readFile(path.join(f.root, 'protected-proof-target.txt'), 'utf8'), 'protected\n');
          assert.equal(sent.verificationMechanism,'macos-seatbelt');
        }
      }
      if(mode.startsWith('guarded')){
        assert.match(git(f.projectRoot,['worktree','list','--porcelain']),/host-recovery-integration-worktrees/u);
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
      if (mode === 'guarded') {
        const completed = cp.stateStore.getRun(f.runId);
        assert.equal(completed?.status, 'completed');
        assert.ok(completed?.workspaceId);
        assert.equal(cp.stateStore.getWorkspaceMutationLockV2(completed.workspaceId), null,
          'terminal settlement must retire the guarded Owner fence exactly once');
      }
      await cp.close();
      // No Native/async Writers were ever launched by the test, so its own
      // temporary Git Worktrees are safe to remove after all Hosts exited.
      await cleanupExecutionWorkspaces({
        runtimeHome: f.runtimeHome, projectId: f.projectId,
        runId: f.runId, repoRoot: f.projectRoot, retain: false,
      });
      // T36 intentionally retains recovery generations by default. These
      // fixture Workers and their Proof command are known synchronous and
      // terminated, so test-owned generations may now be retired explicitly.
      const all = git(f.projectRoot, ['worktree', 'list', '--porcelain']);
      const testRoot = realpathSync(f.root);
      const ownerRoot = realpathSync(f.projectRoot);
      for(const line of all.split('\n')){
        if(!line.startsWith('worktree '))continue;
        // Git records canonical macOS /private/var even when mkdtemp returns
        // /var. Do not resolve an already-removed Step worktree: its Git
        // metadata may outlive the physical directory until prune.
        const root=path.resolve(line.slice('worktree '.length).trim());
        if(root===ownerRoot)continue;
        assert.ok(root.startsWith(testRoot+path.sep), 'never clean another Git worktree');
        if(existsSync(root))git(f.projectRoot, ['worktree', 'remove', '--force', root]);
      }
      git(f.projectRoot, ['worktree', 'prune', '--expire', 'now']);
      safe = true;
    } finally {
      if (safe) await rm(f.root, { recursive: true, force: true });
      else console.warn('Retained uncertain T38 two-Host fixture:', f.root);
    }
  });
}

// A guarded request must refuse unsupported Host OS rather than silently
// using the previous uncontained proof or a sequential provider fallback.
test('T41 explicit guarded integration refuses unsupported OS before Writer admission', {
  skip: process.platform === 'darwin' && 'Darwin provides the real OS-scoped guarded path',
}, async () => {
  const f = await setup();
  const cp = await createKernelControlPlane({ projectRoot: f.projectRoot, runtimeHome: f.runtimeHome });
  try {
    const result = await dispatchKernelParallel({
      controlPlane: cp, runId: f.runId, projectRoot: f.projectRoot, runtimeHome: f.runtimeHome,
      guardedIntegration: true,
      adapter: { capabilities: { surface: 'codex', supportsConcurrentSessions: true,
        supportsIsolatedWorkingDirectory: true, supportsPerSessionEnvironment: true } },
    });
    assert.ok(result && typeof result === 'object');
    const response = result as Record<string, unknown>;
    assert.equal(response.status, 'failed');
    assert.equal(response.failureCode, 'guarded_integration_os_proof_unavailable');
    assert.equal(response.dispatched, false);
    assert.equal(cp.stateStore.getStepAttempts(f.runId).length, 0);
    assert.equal(cp.stateStore.getRun(f.runId)?.mutationRevision, 0);
    assert.equal(existsSync(path.join(f.root, 'worker-start-alpha')), false);
    assert.equal(existsSync(path.join(f.root, 'worker-start-beta')), false);
  } finally {
    await cp.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
