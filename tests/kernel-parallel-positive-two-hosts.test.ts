// Real two-process Host collision with successful Workers and trusted proof.
// The test uses only an ephemeral Git/Kernel Runtime, never user Codex sessions.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createKernelControlPlane } from '../src/host/kernel/control-plane-runtime.js';
import { prepareExecutionWorkspaces, prepareRecoveryIntegrationWorktree, cleanupExecutionWorkspaces } from '../src/host/kernel/workspace/physical-worktree.js';
import { observeWorkspaceIdentity } from '../src/host/kernel/workspace/workspace-identity.js';
import { readCanonicalParallelWorkerReceipts } from '../src/host/kernel/workspace/canonical-worker-receipts.js';
import { verifyCanonicalParallelRecoveryCandidate } from '../src/host/kernel/parallel-dispatcher.js';
import { executeTrustedProof } from '../src/host/kernel/proof/proof-executor.js';

const hostCode = String.raw`
import { createKernelControlPlane } from './scripts/host/kernel/control-plane-runtime.js';
import { dispatchKernelParallel } from './scripts/host/kernel/parallel-dispatcher.js';
import { runNativeHostCommand } from './dist/tests/helpers/native-host-disconnect-runner.mjs';
import { mkdir,writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
const {P_ROOT:root,P_REPO:projectRoot,P_RUNTIME:runtimeHome,P_RUN:runId,P_HOST:hostId,P_MODE:mode}=process.env;
const cp=await createKernelControlPlane({projectRoot,runtimeHome});
const nativeEnabled=process.platform==='darwin'&&process.env.T24_NATIVE_POSITIVE==='1';
const beforeGet=cp.getExecutableSteps.bind(cp);
const wait=async(name)=>{for(let i=0;i<500;i++){if(existsSync(path.join(root,name)))return;await delay(10)}throw Error('barrier timeout '+name)};
cp.getExecutableSteps=async id=>{
 const selection=beforeGet(id);
 if(selection.mode!=='parallel'||selection.steps.length!==2)throw Error('missing parallel steps');
 await writeFile(path.join(root,'ready-'+hostId),JSON.stringify(selection.steps.map(s=>s.stepId)));
 await wait('go');return selection;
};
const original=cp.bindStepAttempt.bind(cp);
let claimed=0;
cp.bindStepAttempt=async (...args)=>{
 const step=cp.getRunSteps(runId).find(s=>s.stepId===args[1]);
 if(!step)throw Error('step missing');
 if(mode==='one-owner'){
  if(hostId==='B')await wait('all-claimed-A');
  const result=await original(...args);
  if(hostId==='A'&&++claimed===2)await writeFile(path.join(root,'all-claimed-A'),'claimed');
  return result;
 }
 const own=(hostId==='A'&&step.sequence===1)||(hostId==='B'&&step.sequence===2);
 if(!own)await wait('own-claim-'+(hostId==='A'?'B':'A'));
 const result=await original(...args);
 if(own)await writeFile(path.join(root,'own-claim-'+hostId),'claimed');
 return result;
};
let starts=0;
const result=await dispatchKernelParallel({
 controlPlane:cp,runId,projectRoot,runtimeHome,parentSessionId:'positive-host-'+hostId,
 adapter:{capabilities:{surface:'codex',supportsConcurrentSessions:true,supportsIsolatedWorkingDirectory:true,supportsPerSessionEnvironment:true}},
 actionContext:{integrationVerification:{commandRef:'test:ok'}},
 dispatchStep:async({step,workspace})=>{
  const name=step.sequence===1?'alpha':'beta';
  const relative='src/'+name+'/result.txt';
  if(!nativeEnabled){
   await mkdir(path.dirname(path.join(workspace.workspaceRoot,relative)),{recursive:true});
   await writeFile(path.join(workspace.workspaceRoot,relative),name+'\n');
  }
  starts++;
  await writeFile(path.join(root,'launched-'+name+'-'+hostId),'launched');
  await wait('release');
  if(mode==='split-weak-proof'&&hostId==='B')await wait('result-A');
  if(nativeEnabled){
   if(!process.env.CODEX_HOME)throw Error('isolated CODEX_HOME required for native positive test');
   const attempt=cp.stateStore.getStepAttempts(runId,{stepId:step.stepId}).at(-1);
   if(!attempt?.attemptId)throw Error('missing canonical Attempt');
   const perAttemptHome=path.join(root,'isolated-codex-home-'+attempt.attemptId);
   await mkdir(perAttemptHome,{recursive:true});
   const native=await runNativeHostCommand({
    runId,attemptId:attempt.attemptId,workspaceId:workspace.workspaceId,
    workspaceRoot:workspace.workspaceRoot,reservationRoot:path.join(root,'reservations'),
    executable:process.env.T24_CODEX_EXECUTABLE||'codex',
    env:{...process.env,CODEX_HOME:perAttemptHome},
    argv:[process.execPath,'-e',
     "const fs=require('node:fs');const p=require('node:path');fs.mkdirSync(p.dirname(process.argv[1]),{recursive:true});fs.writeFileSync(process.argv[1],process.argv[2]+'\\n')",
     relative,name],timeoutMs:20000,
   });
   if(native.exitCode!==0)throw Error('Native command/exec exit '+String(native.exitCode));
   await writeFile(path.join(root,'native-'+name+'-'+hostId),'pass');
  }
  return {status:'passed',resultStatus:'passed',report:{summary:name+' worker',changedPaths:[relative],verifications:[
   {obligationId:name+'-proof',commandRef:'test:ok',acceptanceCoverage:['AC-'+name.toUpperCase()]},
   ...(name==='beta'?[{obligationId:'unit-test',commandRef:'test:ok',acceptanceCoverage:[]}]:[]),
  ]}};
 }
});
await writeFile(path.join(root,'result-'+hostId),JSON.stringify({hostId,starts,status:result.status,
 dispatched:result.dispatched,integration:result.integration?.status,failures:result.dispatchFailures,
 workerErrors:result.workerResults?.map(entry=>entry.status==='fulfilled'
  ? (entry.value?.result?.errorSummary||entry.value?.failureCode||null)
  : String(entry.reason)),
 settlements:result.executionResults?.length,deliveryRevision:result.deliveryMutation?.mutationRevision||null,
 cleanup:result.cleanup}));
`;
// Two fresh recovery Host processes, competing for the existing Owner fence.
// Neither Host is authorized to restart a Worker or mutate its Worktree.
const recoveryFenceHost = String.raw`
import { createKernelControlPlane } from './scripts/host/kernel/control-plane-runtime.js';
import { writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
const {P_ROOT:root,P_REPO:projectRoot,P_RUNTIME:runtimeHome,P_RUN:runId,P_HOST:hostId}=process.env;
const cp=await createKernelControlPlane({projectRoot,runtimeHome});
try {
 const run=await cp.getRun(runId);
 const head=spawnSync('git',['rev-parse','HEAD'],{cwd:projectRoot,encoding:'utf8'});
 if(!run||run.mutationRevision!==0||head.status!==0)throw Error('invalid recovery snapshot');
 const snapshot={expectedMutationRevision:run.mutationRevision,
  expectedWorkspaceIdentity:run.currentWorkspaceIdentity,expectedHeadCommitSha:head.stdout.trim(),
  expectedProjectId:run.projectId,expectedWorktreeId:run.worktreeId,expectedWorkspaceId:run.workspaceId};
 await writeFile(path.join(root,'fence-ready-'+hostId),'ready');
 for(let i=0;i<500&&!existsSync(path.join(root,'fence-go'));i++)await delay(10);
 if(!existsSync(path.join(root,'fence-go')))throw Error('barrier timeout');
 let outcome;
 try{
  const fence=cp.acquireOwnerWorkspaceMutationFence(runId,{...snapshot,sessionToken:'recovery-'+hostId});
  outcome={status:'acquired',token:fence.lock.fencingToken,sessionToken:fence.lock.sessionToken};
  await writeFile(path.join(root,'fence-held-'+hostId),'held');
  const peerDone=path.join(root,'fence-done-'+(hostId==='A'?'B':'A'));
  for(let i=0;i<500&&!existsSync(peerDone);i++)await delay(10);
  if(!existsSync(peerDone))throw Error('peer did not complete contention');
  cp.releaseOwnerWorkspaceMutationFence(runId,{workspaceId:fence.lock.workspaceId,
   fencingToken:fence.lock.fencingToken,sessionToken:fence.lock.sessionToken});
 }catch(error){
  if(error.code!=='delivery_mutation_fence_lost')throw error;
  outcome={status:'denied',code:error.code};
 }
 await writeFile(path.join(root,'fence-result-'+hostId),JSON.stringify(outcome));
 await writeFile(path.join(root,'fence-done-'+hostId),'done');
}finally{await cp.close()}
`;
const competeRecoveryFences=async(root:string,projectRoot:string,runtimeHome:string,runId:string)=>{
 const children:ChildProcessWithoutNullStreams[]=[];
 const launch=(id:string)=>{
  const child=spawn(process.execPath,['--input-type=module','-e',recoveryFenceHost],{
   cwd:process.cwd(),env:{...process.env,P_ROOT:root,P_REPO:projectRoot,P_RUNTIME:runtimeHome,P_RUN:runId,P_HOST:id},
   stdio:['pipe','pipe','pipe'],
  });children.push(child);
  return new Promise<{status:string;token?:number;sessionToken?:string;code?:string}>((resolve,reject)=>{
   let stderr='';child.stderr.on('data',chunk=>stderr+=String(chunk));child.stdout.resume();
   child.on('error',reject);child.on('exit',async code=>{
    if(code!==0)return reject(Error('recovery fence Host '+id+' exit '+code+' '+stderr));
    try{resolve(JSON.parse(await readFile(path.join(root,'fence-result-'+id),'utf8')))}catch(error){reject(error)}
   });
  });
 };
 try{
  const a=launch('A'),b=launch('B');
  await waitFor(async()=>existsSync(path.join(root,'fence-ready-A'))&&existsSync(path.join(root,'fence-ready-B')),'both recovery Hosts ready');
  await writeFile(path.join(root,'fence-go'),'go');
  const results=await Promise.all([a,b]);
  assert.equal(results.filter(x=>x.status==='acquired').length,1,JSON.stringify(results));
  assert.equal(results.filter(x=>x.code==='delivery_mutation_fence_lost').length,1,JSON.stringify(results));
  assert.equal((await readdir(root)).filter(x=>x.startsWith('fence-held-')).length,1);
  return results.find(x=>x.status==='acquired')!;
 }finally{
  for(const child of children)if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
  await Promise.all(children.map(child=>new Promise<void>(resolve=>{
   if(child.exitCode!==null||child.signalCode!==null)return resolve();child.once('exit',resolve);
  })));
 }
};

const git=(cwd:string,args:string[]):string=>{const r=spawnSync('git',args,{cwd,encoding:'utf8',timeout:10000});assert.equal(r.status,0,String(r.stderr||r.error));return r.stdout.trim()};
const waitFor=async(f:()=>Promise<boolean>,reason:string)=>{for(let i=0;i<400;i++){if(await f())return;await delay(15)}throw Error('T24 positive contention timeout '+reason)};

// T42-B2 controlled fixture only. The two old Host processes exited and
// their Workers were synchronous file writes with no detached descendants.
// This proves Kernel's existing CAS/Report behavior, NOT Native Writer exit.
const settleFiniteHistoricalFixture = async (
 projectRoot:string,runtimeHome:string,runId:string,
 crashAfterOwnerCas=false, recoveryMode:'normal'|'dual'|'ttl'='normal',
):Promise<void>=>{
 const cp=await createKernelControlPlane({projectRoot,runtimeHome});
 let fence:ReturnType<typeof cp.acquireOwnerWorkspaceMutationFence>|null=null;
 let proofFenceDeadline:string|null=null;
 try{
  if(recoveryMode==='dual'){
   await writeFile(path.join(process.env.T42_RECOVERY_ROOT!,'recover-ready-A'),'ready');
   await waitFor(async()=>existsSync(path.join(process.env.T42_RECOVERY_ROOT!,'recover-go')),'recovery start barrier');
  }
  const readback=readCanonicalParallelWorkerReceipts({controlPlane:cp,runId,projectRoot,runtimeHome});
  assert.equal(readback.status,'ready');
  if(readback.status!=='ready')return;
  assert.equal(readback.writerExitVerified,false);
  assert.equal(readback.deliveryAuthorized,false);
  const run=(await cp.getRun(runId))!;
  const ownerBase=git(projectRoot,['rev-parse','HEAD']);
  const snapshot={expectedMutationRevision:run.mutationRevision,
   expectedWorkspaceIdentity:run.currentWorkspaceIdentity!,
   expectedHeadCommitSha:ownerBase,expectedProjectId:run.projectId!,
   expectedWorktreeId:run.worktreeId!,expectedWorkspaceId:run.workspaceId!};
  fence=cp.acquireOwnerWorkspaceMutationFence(runId,{
   ...snapshot,sessionToken:recoveryMode==='normal'?undefined:'historical-owner-A',
   ...(recoveryMode==='ttl'?{ttlMs:5000}:{}),
  });
  if(recoveryMode==='dual'){
   const root=process.env.T42_RECOVERY_ROOT!;
   await writeFile(path.join(root,'recover-fenced-A'),'held');
   await waitFor(async()=>existsSync(path.join(root,'recover-denied-B')),'competing Host rejected before first cherry-pick');
  }
  const receipts=readCanonicalParallelWorkerReceipts({controlPlane:cp,runId,projectRoot,runtimeHome});
  assert.deepEqual(receipts,readback,'retired fixture results cannot drift under the Owner fence');
  const integration=await prepareRecoveryIntegrationWorktree({
   repoRoot:projectRoot,baseCommit:ownerBase,runtimeHome,runId,projectId:run.projectId!,
  });
  const registered=cp.registerExecutionWorkspace(runId,integration.workspaceRoot);
  assert.ok(registered.workspaceId);
  const steps=cp.getRunSteps(runId);
  for(const item of [...readback.receipts].sort((a,b)=>
    (steps.find(s=>s.stepId===a.stepId)?.sequence??0)-(steps.find(s=>s.stepId===b.stepId)?.sequence??0))){
   const renewal=cp.renewOwnerWorkspaceMutationFence(runId,{...snapshot,
    workspaceId:fence.lock.workspaceId,fencingToken:fence.lock.fencingToken,
    sessionToken:fence.lock.sessionToken,
    ...(recoveryMode==='ttl'?{ttlMs:5000}:{})});
   assert.equal(renewal.lock?.fencingToken,fence.lock.fencingToken);
   if(recoveryMode==='ttl')proofFenceDeadline=renewal.lock.expiresAt;
   git(integration.workspaceRoot,['cherry-pick','--no-commit',item.resultCommitSha]);
  }
  const staged=git(integration.workspaceRoot,['diff','--name-only','--cached']).split('\n').filter(Boolean).sort();
  assert.deepEqual(staged,['src/alpha/result.txt','src/beta/result.txt']);
  const patch=spawnSync('git',['diff','--cached','--binary',ownerBase],{
   cwd:integration.workspaceRoot,encoding:'utf8',timeout:10000,
  });
  assert.equal(patch.status,0,String(patch.stderr||patch.error));
  if(recoveryMode==='dual'){
   await writeFile(path.join(process.env.T42_RECOVERY_ROOT!,'recover-proof-A'),'entered');
  }
  if(recoveryMode==='ttl'){
   assert.ok(proofFenceDeadline);
   // Proof's child environment is intentionally allowlisted by production.
   // Test control therefore uses a file inside the scoped integration root.
   await writeFile(path.join(integration.workspaceRoot,'.t42-proof-enable'),'enabled');
   await writeFile(path.join(process.env.T42_RECOVERY_ROOT!,'ttl-proof.json'),JSON.stringify({
    integrationRoot:integration.workspaceRoot,expiresAt:proofFenceDeadline,
    fencingToken:fence.lock.fencingToken,
   }));
  }
  const proof=executeTrustedProof({
   projectRoot:integration.workspaceRoot,commandRef:'test:ok',
   ...(process.platform==='darwin'?{writeScope:integration.workspaceRoot}:{}),
  });
  assert.equal(proof.status,'passed');
  if(process.platform==='darwin')assert.equal(proof.writeContainment?.mechanism,'macos-seatbelt');
  assert.equal(git(integration.workspaceRoot,['diff','--name-only','--cached']).split('\n').filter(Boolean).sort().join(','),staged.join(','));
  const afterPatch=spawnSync('git',['diff','--cached','--binary',ownerBase],{
   cwd:integration.workspaceRoot,encoding:'utf8',timeout:10000,
  });
  assert.equal(afterPatch.status,0);
  assert.equal(afterPatch.stdout,patch.stdout,'trusted proof must not change Delivery bytes');
  if(recoveryMode==='ttl'){
   assert.ok(proofFenceDeadline&&Date.parse(proofFenceDeadline)<=Date.now(),
    'the original Owner fence must expire while scoped Proof is running');
   const staleCredentials={
    ...snapshot,workspaceId:fence.lock.workspaceId,fencingToken:fence.lock.fencingToken,
    sessionToken:fence.lock.sessionToken,
   };
   const lost=(cause:unknown)=>(cause as {code?:string}).code==='delivery_mutation_fence_lost';
   assert.throws(()=>cp.renewOwnerWorkspaceMutationFence(runId,staleCredentials),lost);
   const identity=observeWorkspaceIdentity({projectRoot:integration.workspaceRoot}).identity;
   const digest='sha256:'+createHash('sha256').update(patch.stdout).digest('hex');
   assert.throws(()=>cp.assertOwnerWorkspaceMutationReady(runId,{
    ...staleCredentials,integrationWorkspaceIdentity:identity,changedPaths:staged,patchDigest:digest,
   }),lost,'the old owner must not start applying its patch after Fence expiration');
   assert.throws(()=>cp.recordOwnerWorkspaceMutation(runId,{
    ...staleCredentials,integrationWorkspaceIdentity:identity,changedPaths:staged,patchDigest:digest,
   }),lost,'stale Epoch must not perform Owner CAS or authorize Report settlement');
   await writeFile(path.join(process.env.T42_RECOVERY_ROOT!,'ttl-stale-rejected'),JSON.stringify({
    originalEpoch:fence.lock.fencingToken,proofStatus:proof.status,
    containment:proof.writeContainment?.mechanism??null,
    revision:(await cp.getRun(runId))?.mutationRevision,
   }));
   return;
  }
  const integrationWorkspaceIdentity=observeWorkspaceIdentity({projectRoot:integration.workspaceRoot}).identity;
  const patchDigest='sha256:'+createHash('sha256').update(patch.stdout).digest('hex');
  const renewed=cp.renewOwnerWorkspaceMutationFence(runId,{...snapshot,
   workspaceId:fence.lock.workspaceId,fencingToken:fence.lock.fencingToken,
   sessionToken:fence.lock.sessionToken});
  assert.ok(renewed.lock);
  cp.assertOwnerWorkspaceMutationReady(runId,{...snapshot,
   expectedWorkspaceId:fence.lock.workspaceId,
   fencingToken:fence.lock.fencingToken,sessionToken:fence.lock.sessionToken,
   integrationWorkspaceIdentity,changedPaths:staged,patchDigest});
  const checked=spawnSync('git',['apply','--check','--binary','-'],{
   cwd:projectRoot,input:patch.stdout,encoding:'utf8',timeout:10000,
  });
  assert.equal(checked.status,0,String(checked.stderr||checked.error));
  const applied=spawnSync('git',['apply','--binary','-'],{
   cwd:projectRoot,input:patch.stdout,encoding:'utf8',timeout:10000,
  });
  assert.equal(applied.status,0,String(applied.stderr||applied.error));
  const mutation=cp.recordOwnerWorkspaceMutation(runId,{...snapshot,
   fencingToken:fence.lock.fencingToken,sessionToken:fence.lock.sessionToken,
   integrationWorkspaceIdentity,changedPaths:staged,patchDigest});
  assert.equal(mutation.mutationRevision,Number(run.mutationRevision)+1);
  assert.equal((await cp.getRun(runId))?.mutationRevision,Number(run.mutationRevision)+1);
  if(recoveryMode==='dual')await writeFile(
   path.join(process.env.T42_RECOVERY_ROOT!,'recover-cas-A'),String(mutation.mutationRevision));
  if(crashAfterOwnerCas){
   // Actual recovery Host exits after the committed Owner CAS, before reports.
   const marker=process.env.T42_RECOVERY_MARKER;
   assert.ok(marker);
   await writeFile(marker,JSON.stringify({
    mutationRevision:mutation.mutationRevision,
    attemptStatuses:cp.stateStore.getStepAttempts(runId).map(a=>a.status),
    fencingToken:fence.lock.fencingToken,
   }));
   process.exit(73);
  }
  const settled:string[]=[];
  for(const receipt of readback.receipts){
   const attempt=cp.stateStore.getStepAttempts(runId,{stepId:receipt.stepId})[0]!;
   const updated=await cp.getRun(runId);
   const lease=cp.renewOwnerWorkspaceMutationFence(runId,{
    ...snapshot,expectedMutationRevision:updated?.mutationRevision,
    expectedWorkspaceIdentity:observeWorkspaceIdentity({projectRoot}).identity,
    workspaceId:fence.lock.workspaceId,fencingToken:fence.lock.fencingToken,
    sessionToken:fence.lock.sessionToken,phase:'post-commit',
   });
   assert.equal(lease.lock?.fencingToken,fence.lock.fencingToken);
   const report=await cp.settleParallelResult(runId,{
    ...(attempt.workerReport as Record<string,unknown>),
    stepId:receipt.stepId,attemptId:attempt.attemptId,
    capsuleId:attempt.capsuleId,workspaceId:attempt.workspaceId,
    bindingId:attempt.bindingId,actorSessionId:attempt.actorSessionId,
   },{deliveryMutation:{...mutation,snapshot},result:{
    attemptId:attempt.attemptId,executionWorkspaceId:receipt.executionWorkspaceId,
    workerWorkspaceIdentity:attempt.baseWorkspaceIdentity,
    resultWorkspaceIdentity:receipt.resultWorkspaceIdentity,
    resultCommitSha:receipt.resultCommitSha,changedPaths:receipt.changedPaths,
    patchDigest:receipt.patchDigest,workerReport:receipt.workerReport,
   }});
   assert.equal((report as {step?:{state?:string}} | null)?.step?.state,'passed',JSON.stringify(report).slice(0,1400));
   settled.push(receipt.stepId);
  }
  assert.equal(settled.length,2);
  assert.equal((await cp.getRun(runId))?.mutationRevision,Number(run.mutationRevision)+1);
  assert.equal((await cp.getRun(runId))?.status,'completed');
  assert.deepEqual(cp.getRunSteps(runId).map(s=>s.state),['passed','passed']);
  assert.equal(cp.stateStore.getStepAttempts(runId).length,2);
  assert.deepEqual(cp.stateStore.getMutationProvenance(runId)?.changedPaths,staged);
  assert.equal(cp.stateStore.getWorkspaceMutationLockV2(fence.lock.workspaceId),null,
   'terminal canonical settlement must already release the Owner fence');
  const replay=readCanonicalParallelWorkerReceipts({controlPlane:cp,runId,projectRoot,runtimeHome});
  assert.equal(replay.status,'blocked','settled Run cannot reconsume Canonical receipts');
  assert.equal(replay.status==='blocked'?replay.code:null,'canonical_run_not_pre_delivery');
  const first=readback.receipts[0]!;
  const settledAttempt=cp.stateStore.getStepAttempts(runId,{stepId:first.stepId})[0]!;
  const duplicate=await cp.settleParallelResult(runId,{
   ...(settledAttempt.workerReport as Record<string,unknown>),
   stepId:first.stepId,attemptId:first.attemptId,workspaceId:first.executionWorkspaceId,
  },{deliveryMutation:{...mutation,snapshot},result:{
   attemptId:first.attemptId,executionWorkspaceId:first.executionWorkspaceId,
   workerWorkspaceIdentity:settledAttempt.baseWorkspaceIdentity,
   resultWorkspaceIdentity:first.resultWorkspaceIdentity,
   resultCommitSha:first.resultCommitSha,changedPaths:first.changedPaths,
   patchDigest:first.patchDigest,workerReport:first.workerReport,
  }});
  assert.notEqual((duplicate as {step?:{state?:string}} | null)?.step?.state,'passed',
   'the already settled Attempt must not acquire another passed Report');
  assert.equal((await cp.getRun(runId))?.mutationRevision,Number(run.mutationRevision)+1);
  if(recoveryMode==='dual')await writeFile(path.join(process.env.T42_RECOVERY_ROOT!,'recover-settled-A'),
   JSON.stringify({reports:settled.length,revision:mutation.mutationRevision}));
 }finally{
  if(fence && cp.stateStore.getWorkspaceMutationLockV2(fence.lock.workspaceId)){
   try{cp.releaseOwnerWorkspaceMutationFence(runId,{workspaceId:fence.lock.workspaceId,
    fencingToken:fence.lock.fencingToken,sessionToken:fence.lock.sessionToken})}catch{}
  }
  await cp.close();
 }
};

if(process.env.T42_RECOVERY_HOST_MODE==='dual-winner'
 || process.env.T42_RECOVERY_HOST_MODE==='ttl-stale'){
 const projectRoot=process.env.T42_PROJECT_ROOT;
 const runtimeHome=process.env.T42_RUNTIME_HOME;
 const runId=process.env.T42_RUN_ID;
 assert.ok(projectRoot&&runtimeHome&&runId&&process.env.T42_RECOVERY_ROOT);
 await settleFiniteHistoricalFixture(projectRoot,runtimeHome,runId,false,
  process.env.T42_RECOVERY_HOST_MODE==='dual-winner'?'dual':'ttl');
 process.exit(0);
}
if(process.env.T42_RECOVERY_HOST_MODE==='dual-loser'
 || process.env.T42_RECOVERY_HOST_MODE==='ttl-new'){
 const projectRoot=process.env.T42_PROJECT_ROOT;
 const runtimeHome=process.env.T42_RUNTIME_HOME;
 const runId=process.env.T42_RUN_ID;
 const root=process.env.T42_RECOVERY_ROOT;
 assert.ok(projectRoot&&runtimeHome&&runId&&root);
 const cp=await createKernelControlPlane({projectRoot,runtimeHome});
 try{
  const readback=readCanonicalParallelWorkerReceipts({controlPlane:cp,runId,projectRoot,runtimeHome});
  assert.equal(readback.status,'ready');
  assert.equal(readback.deliveryAuthorized,false);
  const run=(await cp.getRun(runId))!;
  const ownerBase=git(projectRoot,['rev-parse','HEAD']);
  const snapshot={expectedMutationRevision:run.mutationRevision,
   expectedWorkspaceIdentity:run.currentWorkspaceIdentity!,
   expectedHeadCommitSha:ownerBase,expectedProjectId:run.projectId!,
   expectedWorktreeId:run.worktreeId!,expectedWorkspaceId:run.workspaceId!};
  if(process.env.T42_RECOVERY_HOST_MODE==='dual-loser'){
   await writeFile(path.join(root,'recover-ready-B'),'ready');
   await waitFor(async()=>existsSync(path.join(root,'recover-go')),'recovery start barrier');
   await waitFor(async()=>existsSync(path.join(root,'recover-fenced-A')),'first recovery Host holds Owner fence');
   assert.equal(existsSync(path.join(root,'recover-proof-A')),false,'contender must race before cherry-pick/Proof');
   assert.throws(()=>cp.acquireOwnerWorkspaceMutationFence(runId,{
    ...snapshot,sessionToken:'historical-owner-B',
   }),(cause:unknown)=>(cause as {code?:string}).code==='delivery_mutation_fence_lost');
   await writeFile(path.join(root,'recover-denied-B'),'denied');
  }else{
   const configPath=path.join(root,'ttl-proof.json');
   await waitFor(async()=>existsSync(configPath),'stale proof preparation');
   const config=JSON.parse(await readFile(configPath,'utf8')) as {
    integrationRoot:string;expiresAt:string;fencingToken:number;
   };
   await waitFor(async()=>existsSync(path.join(config.integrationRoot,'.t42-proof-active')),
    'scoped Proof actually started');
   assert.ok(Date.now()<Date.parse(config.expiresAt),'Proof must begin before fence expiry');
   await delay(Math.max(0,Date.parse(config.expiresAt)-Date.now()+80));
   const newer=cp.acquireOwnerWorkspaceMutationFence(runId,{
    ...snapshot,sessionToken:'historical-owner-B',ttlMs:25000,
   });
   assert.ok(newer.lock.fencingToken>config.fencingToken);
   const fresh=await prepareRecoveryIntegrationWorktree({
    repoRoot:projectRoot,baseCommit:ownerBase,runtimeHome,runId,projectId:run.projectId!,
   });
   assert.notEqual(fresh.workspaceRoot,config.integrationRoot,'recovery must never reuse stale Proof Worktree');
   await writeFile(path.join(root,'ttl-new-fenced'),JSON.stringify({
    epoch:newer.lock.fencingToken,workspaceRoot:fresh.workspaceRoot,
    previousRoot:config.integrationRoot,
   }));
   // Release the finite test Proof only after the newer Host owns its own generation.
   await writeFile(path.join(root,'ttl-unblock-proof'),'new epoch');
   await waitFor(async()=>existsSync(path.join(root,'ttl-stale-rejected')),'stale Host denied Owner CAS');
   assert.equal((await cp.getRun(runId))?.mutationRevision,0);
   cp.releaseOwnerWorkspaceMutationFence(runId,{workspaceId:newer.lock.workspaceId,
    fencingToken:newer.lock.fencingToken,sessionToken:newer.lock.sessionToken});
  }
 }finally{await cp.close()}
 process.exit(0);
}
if(process.env.T42_RECOVERY_HOST_MODE==='cas-crash'){
 const projectRoot=process.env.T42_PROJECT_ROOT;
 const runtimeHome=process.env.T42_RUNTIME_HOME;
 const runId=process.env.T42_RUN_ID;
 assert.ok(projectRoot&&runtimeHome&&runId);
 await settleFiniteHistoricalFixture(projectRoot,runtimeHome,runId,true);
 throw new Error('T42_expected_post_cas_process_exit');
}
// Independent OS recovery Host observes the post-CAS gap and invokes existing fail-closed Kernel recovery.
const inspectHistoricalCasCrashHost=[
 "import { createKernelControlPlane } from './scripts/host/kernel/control-plane-runtime.js';",
 "import { writeFileSync } from 'node:fs';",
 "const {T42_PROJECT_ROOT:projectRoot,T42_RUNTIME_HOME:runtimeHome,T42_RUN_ID:runId,T42_INSPECTION_FILE:output,T42_INSPECTION_MODE:mode}=process.env;",
 "const cp=await createKernelControlPlane({projectRoot,runtimeHome});",
 "try{",
 "const before=await cp.getRun(runId);",
 "const attemptsBefore=cp.stateStore.getStepAttempts(runId);",
 "const executableBefore=cp.getExecutableSteps(runId).steps.length;",
 "const fence=before?.workspaceId?cp.stateStore.getWorkspaceMutationLockV2(before.workspaceId):null;",
 "const recovery=mode==='recover'?await cp.recoverPendingDeliveryMaterialization(runId):null;",
 "const after=await cp.getRun(runId);",
 "const attemptsAfter=cp.stateStore.getStepAttempts(runId);",
 "writeFileSync(output,JSON.stringify({",
 "before:{status:before?.status,revision:before?.mutationRevision},",
 "recovery:{status:recovery?.status,reason:recovery?.reason},",
 "after:{status:after?.status,revision:after?.mutationRevision,blockedReason:after?.blockedReason},",
 "attemptsBefore:attemptsBefore.map(a=>a.status),",
 "attemptsAfter:attemptsAfter.map(a=>a.status),",
 "attemptCount:attemptsAfter.length,executableBefore,",
 "provenanceRevision:cp.stateStore.getMutationProvenance(runId)?.mutationRevision,",
 "heldFenceEpoch:fence?.fencingToken??null,",
 "}));",
 "}finally{await cp.close()}",
].join('\n');

for(const mode of ['one-owner','split-owners','split-cas-crash','split-dual-recovery',
 'split-ttl-proof','split-proof-drift','split-weak-proof'] as const){
 test(`T24 positive two-Host batch collision: ${mode}`,{
  timeout:95000,
  skip: ['split-cas-crash','split-dual-recovery','split-ttl-proof','split-proof-drift'].includes(mode)
   && process.platform==='darwin' && process.env.T24_NATIVE_POSITIVE==='1'
   ? 'Native Writer descendants are not proven retired'
   : false,
 },async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'t24-positive-owner-'));
  const nativeEnabled=process.platform==='darwin'&&process.env.T24_NATIVE_POSITIVE==='1';
  if(nativeEnabled)assert.ok(process.env.CODEX_HOME,'isolated CODEX_HOME required');
  const projectRoot=path.join(root,'project'),runtimeHome=path.join(root,'runtime'),runId='t24-positive';
  let cp:Awaited<ReturnType<typeof createKernelControlPlane>>|null=null,projectId:string|null=null;
  const children:ChildProcessWithoutNullStreams[]=[];
  let nativeSettled=false;
  try{
   await mkdir(projectRoot);if(nativeEnabled)await mkdir(path.join(root,'reservations'));git(projectRoot,['init','-b','main']);git(projectRoot,['config','user.name','T24 Test']);git(projectRoot,['config','user.email','t24@example.invalid']);
   await mkdir(path.join(projectRoot,'src'));
   await writeFile(path.join(projectRoot,'package.json'),JSON.stringify({name:'t24-positive',scripts:{'test:ok':'node verify.cjs'}}));
   await writeFile(path.join(projectRoot,'verify.cjs'),mode==='split-weak-proof'
    ? 'process.exit(0);\n'
    : [
      "const fs=require('node:fs');",
      "if(!fs.existsSync('src/alpha/result.txt')||!fs.existsSync('src/beta/result.txt'))process.exit(23);",
      "if(fs.readFileSync('src/alpha/result.txt','utf8')!=='alpha\\n'||fs.readFileSync('src/beta/result.txt','utf8')!=='beta\\n')process.exit(24);",
      "if(fs.existsSync('.t42-proof-enable')){",
      "fs.writeFileSync('.t42-proof-active','active');",
      "const marker="+JSON.stringify(path.join(root,'ttl-unblock-proof'))+";const deadline=Date.now()+25000;",
      "while(!fs.existsSync(marker)&&Date.now()<deadline)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,30);",
      "if(!fs.existsSync(marker))process.exit(29);",
      "}",
      ...(mode==='split-proof-drift'?[
       "fs.writeFileSync('.t43-proof-active','started');",
       "const deadline=Date.now()+15000;",
       "while(!fs.existsSync('.t43-proof-done')&&Date.now()<deadline)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,30);",
       "if(!fs.existsSync('.t43-proof-done'))process.exit(43);",
      ]:[]),
     ].join('\n')+'\n');
   git(projectRoot,['add','--all']);git(projectRoot,['commit','-m','baseline']);
   cp=await createKernelControlPlane({runtimeHome,projectRoot});
   const started=await cp.startRun({runId,objective:'cross Host positive Worker result',taskContract:{complex:true,riskTier:'T1',
    acceptance:[{id:'AC-ALPHA',acceptance:'alpha exists',evidencePlan:{class:'hard',method:'unit-test',commandRefs:['test:ok'],obligationId:'alpha-proof'}},{id:'AC-BETA',acceptance:'beta exists',evidencePlan:{class:'hard',method:'unit-test',commandRefs:['test:ok'],obligationId:'beta-proof'}}],
    requiredObligations:['alpha-proof','beta-proof'],requiredVerifications:[{obligationId:'alpha-proof',commandRefs:['test:ok']},{obligationId:'beta-proof',commandRefs:['test:ok']}],
    steps:[{objective:'alpha',allowedPaths:['src/alpha/**'],acceptanceIds:['AC-ALPHA'],obligationIds:['alpha-proof'],dependsOn:[]},{objective:'beta',allowedPaths:['src/beta/**'],acceptanceIds:['AC-BETA'],obligationIds:['beta-proof'],dependsOn:[]}],
   }});
   projectId=started.projectId;assert.ok(projectId);
   const steps=cp.getExecutableSteps(runId).steps;assert.equal(steps.length,2);
   const prepared=await prepareExecutionWorkspaces({repoRoot:projectRoot,runtimeHome,projectId,runId,baseCommit:git(projectRoot,['rev-parse','HEAD']),steps});
   const startHost=(host:string)=>{
    const child=spawn(process.execPath,['--input-type=module','-e',hostCode],{cwd:process.cwd(),env:{...process.env,P_ROOT:root,P_REPO:projectRoot,P_RUNTIME:runtimeHome,P_RUN:runId,P_HOST:host,P_MODE:mode},stdio:['pipe','pipe','pipe']});children.push(child);
    return new Promise<Record<string,unknown>>((resolve,reject)=>{let out='',err='';child.stdout.on('data',v=>out+=String(v));child.stderr.on('data',v=>err+=String(v));child.on('error',reject);child.on('exit',async code=>{
     if(code!==0)return reject(Error('Host '+host+' exited '+code+' stderr='+err+' stdout='+out));
     try{resolve(JSON.parse(await readFile(path.join(root,'result-'+host),'utf8')))}catch(e){reject(e)}
    })});
   };
   const a=startHost('A'),b=startHost('B');
   await waitFor(async()=>existsSync(path.join(root,'ready-A'))&&existsSync(path.join(root,'ready-B')),'both ready');
   assert.equal(await readFile(path.join(root,'ready-A'),'utf8'),await readFile(path.join(root,'ready-B'),'utf8'));
   await writeFile(path.join(root,'go'),'go');
   await waitFor(async()=>(await readdir(root)).filter(x=>x.startsWith('launched-')).length===2,'two successful Worker starts');
   await delay(150);
   const launches=(await readdir(root)).filter(x=>x.startsWith('launched-'));
   assert.equal(launches.length,2);assert.equal(launches.filter(x=>x.startsWith('launched-alpha-')).length,1);assert.equal(launches.filter(x=>x.startsWith('launched-beta-')).length,1);
   for(const step of steps){const attempts=cp.stateStore.getStepAttempts(runId,{stepId:step.stepId});assert.equal(attempts.length,1);assert.equal(attempts[0]?.status,'started');}
   assert.equal((await cp.getRun(runId))?.mutationRevision,0);
   await writeFile(path.join(root,'release'),'go');
   const results=await Promise.all([a,b]);
   assert.equal(results.reduce((sum,r)=>sum+Number(r.starts),0),2);
   assert.ok(results.every(r=>r.dispatched===true));
   if(nativeEnabled){
    const files=(await readdir(root)).filter(x=>x.startsWith('native-'));
    assert.equal(files.length,2,`two real native commands, one per Step; markers=${JSON.stringify(files)} Host outcomes=${JSON.stringify(results)}`);
    assert.equal(files.filter(x=>x.startsWith('native-alpha-')).length,1);
    assert.equal(files.filter(x=>x.startsWith('native-beta-')).length,1);
    const reservations=(await readdir(path.join(root,'reservations'))).filter(x=>x.startsWith('writer-'));
    assert.equal(reservations.length,2,'one external Host reservation per real writer');
    const servers=(await readdir(path.join(root,'reservations'))).filter(x=>x.startsWith('test-server-')&&x.endsWith('.pid'));
    assert.equal(servers.length,2);
    for(const marker of servers){
     const pid=Number((await readFile(path.join(root,'reservations',marker),'utf8')).trim());
     assert.ok(Number.isSafeInteger(pid)&&pid>0);
     await waitFor(async()=>{try{process.kill(pid,0);return false}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')return true;throw error}},'native app server PID exit');
    }
    nativeSettled=true;
   }
   const run=await cp.getRun(runId);
   assert.ok(run);
   if(mode==='one-owner'){
    assert.equal(run.mutationRevision,1,JSON.stringify(results));
    assert.equal(results.filter(r=>r.status==='passed').length,1,JSON.stringify(results));
    assert.equal(results.reduce((sum,r)=>sum+Number(r.settlements||0),0),2);
    assert.equal(await readFile(path.join(projectRoot,'src/alpha/result.txt'),'utf8'),'alpha\n');
    assert.equal(await readFile(path.join(projectRoot,'src/beta/result.txt'),'utf8'),'beta\n');
    assert.ok(cp.getRunSteps(runId).every(s=>s.state==='passed'));
    assert.deepEqual(cp.stateStore.getMutationProvenance(runId)?.changedPaths,['src/alpha/result.txt','src/beta/result.txt']);
   }else{
    assert.equal(run.mutationRevision,0,'split ownership must not deliver incomplete trusted proof');
    assert.ok(results.every(r=>r.status!=='passed'),JSON.stringify(results));
    assert.ok(results.every(r=>Array.isArray(r.failures)&&r.failures.some(
      (failure:unknown)=>typeof failure==='object'&&failure!==null&&
       (failure as {failureCode?:string}).failureCode==='STEP_ATTEMPT_ALREADY_CLAIMED',
    )),'both Hosts must observe a canonical competing claim');
    assert.ok(results.every(r=>(r.cleanup as {retained?:boolean}|null)?.retained===true),
      'contended Worktrees must be retained for reconciliation');
    if(mode==='split-weak-proof')assert.ok(results.every(r=>r.integration==='failed'),
      'even a weak trusted integration command cannot bypass a competing claim');
    assert.equal(results.reduce((sum,r)=>sum+Number(r.settlements||0),0),0);
    assert.equal(existsSync(path.join(projectRoot,'src/alpha/result.txt')),false);
    assert.equal(existsSync(path.join(projectRoot,'src/beta/result.txt')),false);

    // Each Host exited with its own canonical result persisted. A different
    // Control Plane can inspect both receipts without opening another Attempt
    // or running a Worker. This is evidence for recovery, not Writer exit proof.
    const reopened=await createKernelControlPlane({projectRoot,runtimeHome});
    try{
     const retainedRun=await reopened.getRun(runId);
     assert.equal(retainedRun?.mutationRevision,0);
     assert.equal(reopened.getExecutableSteps(runId).steps.length,0,
      'restarting must not turn already claimed Steps back into new Worker launches');
     const retainedSteps=reopened.getRunSteps(runId);
     assert.equal(retainedSteps.length,2);
     for(const step of steps){
      const retainedStep=retainedSteps.find(candidate=>candidate.stepId===step.stepId);
      assert.ok(retainedStep,'restarted Control Plane must see same canonical Step');
      const attempts=reopened.stateStore.getStepAttempts(runId,{stepId:step.stepId});
      assert.equal(attempts.length,1,'recovery must not create a second Attempt');
      const attempt=attempts[0];
      assert.equal(attempt?.status,'started','Worker report remains unsettled before Owner CAS');
      assert.equal(retainedStep.resultAttemptId,attempt?.attemptId);
      assert.equal(retainedStep.resultCommitSha,attempt?.resultCommitSha);
      assert.equal(retainedStep.executionWorkspaceId,attempt?.workspaceId);
      assert.ok(attempt?.resultWorkspaceIdentity?.startsWith('sha256:'));
      assert.ok(attempt?.patchDigest?.startsWith('sha256:'));
      assert.ok(attempt?.workerReport && Array.isArray((attempt.workerReport as {verifications?:unknown}).verifications));
      const workspace=prepared.steps.find(candidate=>candidate.stepId===step.stepId);
      assert.ok(workspace,'physical Step Worktree must have stable identity');
      assert.equal(git(workspace.workspaceRoot,['rev-parse','HEAD']),attempt.resultCommitSha);
      assert.equal(git(workspace.workspaceRoot,['status','--porcelain']),'');
      assert.equal(observeWorkspaceIdentity({projectRoot:workspace.workspaceRoot}).identity,attempt.resultWorkspaceIdentity);
      const patch=spawnSync('git',['show','--format=','--binary',attempt.resultCommitSha!],{
       cwd:workspace.workspaceRoot,encoding:'utf8',timeout:10000,
      });
      assert.equal(patch.status,0,String(patch.stderr||patch.error));
      assert.equal('sha256:'+createHash('sha256').update(patch.stdout).digest('hex'),attempt.patchDigest);
      const paths=git(workspace.workspaceRoot,['diff-tree','--no-commit-id','--name-only','-r',attempt.resultCommitSha!]).split('\n').filter(Boolean);
      assert.deepEqual(paths,attempt.changedPaths);
     }
     {
      const readback=readCanonicalParallelWorkerReceipts({
       controlPlane:reopened,runId,projectRoot,runtimeHome,
      });
      assert.equal(readback.status,'ready',JSON.stringify(readback));
      assert.equal(readback.writerExitVerified,false);
      assert.equal(readback.deliveryAuthorized,false);
      if(readback.status==='ready'){
       assert.equal(readback.receipts.length,2);
       assert.deepEqual(readback.receipts.map(r=>r.stepId).sort(),steps.map(s=>s.stepId).sort());
       assert.deepEqual(readback.receipts.map(r=>r.attemptId).sort(),
        steps.flatMap(step=>reopened.stateStore.getStepAttempts(runId,{stepId:step.stepId}).map(a=>a.attemptId)).sort());
      }
      if(!nativeEnabled){
       // Negative checks mutate only test-owned fixture paths, and restore
       // them before the existing cross-Host contention checks proceed.
       const victim=prepared.steps[0]!;
       await writeFile(path.join(victim.workspaceRoot,'stale-untracked'),'stale');
       const dirty=readCanonicalParallelWorkerReceipts({controlPlane:reopened,runId,projectRoot,runtimeHome});
       assert.equal(dirty.status,'blocked');
       if(dirty.status==='blocked')assert.equal(dirty.code,'canonical_git_result_drift');
       await rm(path.join(victim.workspaceRoot,'stale-untracked'));
       const original=git(victim.workspaceRoot,['rev-parse','HEAD']);
       git(victim.workspaceRoot,['reset','--hard','HEAD~1']);
       const stale=readCanonicalParallelWorkerReceipts({controlPlane:reopened,runId,projectRoot,runtimeHome});
       assert.equal(stale.status,'blocked');
       if(stale.status==='blocked')assert.equal(stale.code,'canonical_git_result_drift');
       git(victim.workspaceRoot,['reset','--hard',original]);
       assert.equal(readCanonicalParallelWorkerReceipts({controlPlane:reopened,runId,projectRoot,runtimeHome}).status,'ready');
      }
     }
     assert.equal((await reopened.getRun(runId))?.mutationRevision,0,'read-only recovery must not mutate Owner');
    }finally{
     await reopened.close();
    }
    if(mode==='split-proof-drift'){
     // Old Host files were initially canonical. A separate bounded OS
     // process writes to its ORIGINAL Step Worktree during the new Host's
     // scoped Proof, after the earlier readback but before preflight returns.
     const victim=prepared.steps[0]!.workspaceRoot;
     const lateFile=path.join(victim,'t43-late-writer');
     const watcher=String.raw`
import fs from 'node:fs';
import path from 'node:path';
const [runtimeHome,target]=process.argv.slice(0,2);
const base=path.join(runtimeHome,'host-recovery-integration-worktrees');
const end=Date.now()+18000;
for(;;){
 if(Date.now()>end)process.exit(43);
 if(fs.existsSync(base)){
  const paths=fs.readdirSync(base,{recursive:true});
  for(const name of paths){
   if(path.basename(String(name))!=='.t43-proof-active')continue;
   const directory=path.dirname(path.join(base,String(name)));
   fs.writeFileSync(target,'LATE_WRITER');
   fs.writeFileSync(path.join(directory,'.t43-proof-done'),'done');
   process.exit(0);
  }
 }
 await new Promise(resolve=>setTimeout(resolve,20));
}
`;
     let child:ChildProcessWithoutNullStreams|null=null;
     let watch:Promise<number>|null=null;
     if(process.platform==='darwin'){
      child=spawn(process.execPath,['--input-type=module','-e',watcher,
       runtimeHome,lateFile],{cwd:process.cwd(),stdio:['pipe','pipe','pipe']});
      children.push(child);
      watch=new Promise<number>((resolve,reject)=>{
       let errors='';
       child!.stderr.on('data',chunk=>errors+=String(chunk));
       child!.stdout.resume();
       child!.on('error',reject);
       child!.on('exit',code=>code===0?resolve(code):reject(Error('T43 finite stale writer '+code+' '+errors)));
      });
     }
     const candidate=await verifyCanonicalParallelRecoveryCandidate({
      controlPlane:cp,runId,projectRoot,runtimeHome,commandRef:'test:ok',
     });
     assert.equal(candidate.status,'blocked',JSON.stringify(candidate));
     assert.equal(candidate.deliveryAuthorized,false);
     assert.equal(candidate.writerExitVerified,false);
     if(process.platform==='darwin'){
      assert.equal(candidate.failureCode,'recovery_receipt_changed_during_proof',JSON.stringify(candidate));
      assert.equal(await watch,0);
      assert.equal(await readFile(lateFile,'utf8'),'LATE_WRITER');
      const now=readCanonicalParallelWorkerReceipts({controlPlane:cp,runId,projectRoot,runtimeHome});
      assert.equal(now.status,'blocked');
      if(now.status==='blocked')assert.equal(now.code,'canonical_git_result_drift');
     }else assert.equal(candidate.failureCode,'recovery_os_write_scope_unavailable');
     assert.equal((await cp.getRun(runId))?.mutationRevision,0);
     assert.equal(cp.stateStore.getStepAttempts(runId).length,2);
     assert.deepEqual(cp.stateStore.getStepAttempts(runId).map(a=>a.status),['started','started']);
     assert.equal(cp.getExecutableSteps(runId).steps.length,0);
     assert.equal(existsSync(path.join(projectRoot,'src/alpha/result.txt')),false);
     assert.equal(existsSync(path.join(projectRoot,'src/beta/result.txt')),false);
     assert.equal(cp.stateStore.getWorkspaceMutationLockV2(run.workspaceId!),null);
     if(process.platform==='darwin')await rm(lateFile);
    }
    if(['split-owners','split-cas-crash','split-dual-recovery','split-ttl-proof'].includes(mode)){
     // This preflight reuses both persisted Worker Commit SHAs but has no
     // Delivery or Writer-retirement authority. Linux refuses before Git.
     const candidate=await verifyCanonicalParallelRecoveryCandidate({
      controlPlane:cp,runId,projectRoot,runtimeHome,commandRef:'test:ok',
     });
     assert.equal(candidate.writerExitVerified,false);
     assert.equal(candidate.deliveryAuthorized,false);
     if(process.platform==='darwin'){
      assert.equal(candidate.status,'verified',JSON.stringify(candidate));
      const proof=candidate.verification as {execution?:{writeContainment?:{mechanism?:string}}};
      assert.equal(proof.execution?.writeContainment?.mechanism,'macos-seatbelt');
      const patch=candidate.candidate as {changedPaths?:string[];patchDigest?:string;integrationWorkspaceRoot?:string};
      assert.deepEqual(patch.changedPaths,['src/alpha/result.txt','src/beta/result.txt']);
      assert.ok(patch.patchDigest?.startsWith('sha256:'));
      assert.ok(patch.integrationWorkspaceRoot?.includes('recovery'));
     }else{
      assert.equal(candidate.status,'blocked');
      assert.equal(candidate.failureCode,'recovery_os_write_scope_unavailable');
     }
     assert.equal((await cp.getRun(runId))?.mutationRevision,0);
     assert.equal(cp.stateStore.getStepAttempts(runId).length,2);
     const held=cp.stateStore.getWorkspaceMutationLockV2(run.workspaceId!);
     assert.equal(held,null,'proof-only recovery must release Owner Fence without CAS');
     const winner=await competeRecoveryFences(root,projectRoot,runtimeHome,runId);
     assert.equal((await cp.getRun(runId))?.mutationRevision,0);
     assert.equal(cp.getExecutableSteps(runId).steps.length,0);
     for(const step of steps)assert.equal(cp.stateStore.getStepAttempts(runId,{stepId:step.stepId}).length,1);
     const current=(await cp.getRun(runId))!;
     const snapshot={expectedMutationRevision:current.mutationRevision,
      expectedWorkspaceIdentity:current.currentWorkspaceIdentity!,
      expectedHeadCommitSha:git(projectRoot,['rev-parse','HEAD']),
      expectedProjectId:current.projectId!,expectedWorktreeId:current.worktreeId!,
      expectedWorkspaceId:current.workspaceId!};
     const next=cp.acquireOwnerWorkspaceMutationFence(runId,{...snapshot,sessionToken:'recovery-C'});
     assert.ok(next.lock.fencingToken>winner.token!,'fence epoch must increase after release');
     assert.throws(()=>cp!.renewOwnerWorkspaceMutationFence(runId,{...snapshot,
      workspaceId:next.lock.workspaceId,fencingToken:winner.token!,sessionToken:winner.sessionToken!}),
      (error:unknown)=>(error as {code?:string}).code==='delivery_mutation_fence_lost');
     cp.releaseOwnerWorkspaceMutationFence(runId,{workspaceId:next.lock.workspaceId,
      fencingToken:next.lock.fencingToken,sessionToken:next.lock.sessionToken});
     assert.equal((await cp.getRun(runId))?.mutationRevision,0);
     if(!nativeEnabled){
      // A changed Owner baseline invalidates even complete, still-clean
      // Step result commits. Restore exactly the test-only baseline.
      const originalOwner=git(projectRoot,['rev-parse','HEAD']);
      git(projectRoot,['commit','--allow-empty','-m','t42-stale-owner-base']);
      const oldBase=readCanonicalParallelWorkerReceipts({controlPlane:cp,runId,projectRoot,runtimeHome});
      assert.equal(oldBase.status,'blocked');
      if(oldBase.status==='blocked')assert.ok(
       ['canonical_owner_base_drift','canonical_git_result_drift'].includes(oldBase.code),
       oldBase.code,
      );
      git(projectRoot,['reset','--hard',originalOwner]);
      assert.equal(readCanonicalParallelWorkerReceipts({controlPlane:cp,runId,projectRoot,runtimeHome}).status,'ready');
      // B2 authority is exercised ONLY by synchronous exited fixture Writers.
      // Native child descendants are not covered by their App Server exit.
      if(mode==='split-dual-recovery'||mode==='split-ttl-proof'){
       // Real independent recovery Host processes execute the same persisted
       // two-Host Canonical fixture. A holds the fence before cherry-pick.
       // B either loses the contention or supersedes an expired Proof epoch.
       const recover=(kind:'dual-winner'|'dual-loser'|'ttl-stale'|'ttl-new')=>{
        const child=spawn(process.execPath,['--input-type=module','-e',
         "import('./tests/kernel-parallel-positive-two-hosts.test.mjs')"],{
         cwd:process.cwd(),env:{...process.env,T42_RECOVERY_HOST_MODE:kind,
          T42_PROJECT_ROOT:projectRoot,T42_RUNTIME_HOME:runtimeHome,T42_RUN_ID:runId,
          T42_RECOVERY_ROOT:root,
         },stdio:['pipe','pipe','pipe'],
        });
        children.push(child);
        return new Promise<void>((resolve,reject)=>{
         let stderr='',stdout='';
         child.stderr.on('data',chunk=>stderr+=String(chunk));
         child.stdout.on('data',chunk=>stdout+=String(chunk));
         child.on('error',reject);
         child.on('exit',code=>code===0?resolve():reject(Error(
          'recovery '+kind+' exit '+code+' '+stderr+' '+stdout)));
        });
       };
       const isTtl=mode==='split-ttl-proof';
       const a=recover(isTtl?'ttl-stale':'dual-winner');
       const b=recover(isTtl?'ttl-new':'dual-loser');
       if(!isTtl){
        await waitFor(async()=>existsSync(path.join(root,'recover-ready-A'))&&
         existsSync(path.join(root,'recover-ready-B')),'two OS recovery Hosts ready');
        await writeFile(path.join(root,'recover-go'),'go');
       }
       await Promise.all([a,b]);
       assert.equal(existsSync(path.join(root,'recover-denied-B')),!isTtl);
       if(isTtl){
        const proof=JSON.parse(await readFile(path.join(root,'ttl-proof.json'),'utf8')) as {
         integrationRoot:string;expiresAt:string;fencingToken:number;
        };
        const newer=JSON.parse(await readFile(path.join(root,'ttl-new-fenced'),'utf8')) as {
         epoch:number;workspaceRoot:string;previousRoot:string;
        };
        const stale=JSON.parse(await readFile(path.join(root,'ttl-stale-rejected'),'utf8')) as {
         originalEpoch:number;revision:number;proofStatus:string;containment:string|null;
        };
        assert.ok(newer.epoch>proof.fencingToken);
        assert.notEqual(newer.workspaceRoot,proof.integrationRoot);
        assert.equal(newer.previousRoot,proof.integrationRoot);
        assert.equal(stale.originalEpoch,proof.fencingToken);
        assert.equal(stale.proofStatus,'passed');
        if(process.platform==='darwin')assert.equal(stale.containment,'macos-seatbelt');
        assert.equal(stale.revision,0);
        assert.equal(existsSync(path.join(projectRoot,'src/alpha/result.txt')),false);
        assert.equal(existsSync(path.join(projectRoot,'src/beta/result.txt')),false);
        assert.equal((await cp.getRun(runId))?.mutationRevision,0);
        assert.deepEqual(cp.stateStore.getStepAttempts(runId).map(a=>a.status),['started','started']);
       }else{
        assert.equal((await readFile(path.join(root,'recover-cas-A'),'utf8')).trim(),'1');
        const settled=JSON.parse(await readFile(path.join(root,'recover-settled-A'),'utf8')) as {
         reports:number;revision:number;
        };
        assert.deepEqual(settled,{reports:2,revision:1});
        assert.ok(existsSync(path.join(root,'recover-proof-A')));
        assert.deepEqual(cp.getRunSteps(runId).map(s=>s.state),['passed','passed']);
        assert.equal(cp.stateStore.getMutationProvenance(runId)?.mutationRevision,1);
       }
      }else if(mode==='split-cas-crash'){
       const casMarker=path.join(root,'historical-cas-crashed.json');
       const crash=spawnSync(process.execPath,['--input-type=module','-e',
        "import('./tests/kernel-parallel-positive-two-hosts.test.mjs')"],{
        cwd:process.cwd(),encoding:'utf8',timeout:75000,
        env:{...process.env,T42_RECOVERY_HOST_MODE:'cas-crash',T42_PROJECT_ROOT:projectRoot,
         T42_RUNTIME_HOME:runtimeHome,T42_RUN_ID:runId,T42_RECOVERY_MARKER:casMarker},
       });
       assert.equal(crash.status,73,'actual historical recovery Host exit after Owner CAS: '+crash.stderr);
       assert.ok(existsSync(casMarker),'durable Owner CAS must precede Host process exit');
       const cas=JSON.parse(await readFile(casMarker,'utf8')) as {
        mutationRevision:number;attemptStatuses:string[];fencingToken:number;
       };
       assert.equal(cas.mutationRevision,1);
       assert.deepEqual(cas.attemptStatuses,['started','started']);
       assert.ok(cas.fencingToken>0);
       assert.equal((await cp.getRun(runId))?.mutationRevision,1);
       assert.equal(cp.stateStore.getStepAttempts(runId).length,2);
       const inspect=async(kind:'recover'|'recheck')=>{
        const output=path.join(root,'inspect-'+kind+'.json');
        const child=spawnSync(process.execPath,['--input-type=module','-e',
         inspectHistoricalCasCrashHost],{
         cwd:process.cwd(),encoding:'utf8',timeout:30000,
         env:{...process.env,T42_PROJECT_ROOT:projectRoot,
          T42_RUNTIME_HOME:runtimeHome,T42_RUN_ID:runId,
          T42_INSPECTION_FILE:output,T42_INSPECTION_MODE:kind},
        });
        assert.equal(child.status,0,'new recovery Host '+kind+' failed: '+child.stderr);
        return JSON.parse(await readFile(output,'utf8')) as Record<string,unknown>;
       };
       const recovered=await inspect('recover');
       assert.equal((recovered.before as {revision?:number}).revision,1);
       assert.equal((recovered.recovery as {status?:string}).status,'blocked',JSON.stringify(recovered));
       assert.deepEqual(recovered.attemptsBefore,['started','started']);
       assert.deepEqual(recovered.attemptsAfter,['started','started']);
       assert.equal(recovered.attemptCount,2);
       assert.equal(recovered.executableBefore,0);
       assert.equal((recovered.after as {status?:string}).status,'blocked');
       assert.equal((recovered.after as {revision?:number}).revision,1);
       assert.equal((recovered.after as {blockedReason?:string}).blockedReason,
        'delivery_materialization_recovery_required');
       const rechecked=await inspect('recheck');
       assert.equal((rechecked.after as {revision?:number}).revision,1);
       assert.equal((rechecked.after as {status?:string}).status,'blocked');
       assert.deepEqual(rechecked.attemptsAfter,['started','started']);
       assert.equal(rechecked.attemptCount,2);
       assert.equal(rechecked.executableBefore,0);
       const notReusable=readCanonicalParallelWorkerReceipts({controlPlane:cp,runId,projectRoot,runtimeHome});
       assert.equal(notReusable.status,'blocked');
      }else{
       await settleFiniteHistoricalFixture(projectRoot,runtimeHome,runId);
      }
      assert.equal((await cp.getRun(runId))?.mutationRevision,
       mode==='split-ttl-proof'?0:1);
      assert.equal(cp.stateStore.getStepAttempts(runId).length,2);
      assert.equal(cp.getExecutableSteps(runId).steps.length,0);
      if(mode!=='split-ttl-proof')for(const name of ['alpha','beta'])
       assert.equal(await readFile(path.join(projectRoot,'src',name,'result.txt'),'utf8'),name+'\n');
     }
    }
   }
  }finally{
   await writeFile(path.join(root,'release'),'go').catch(()=>{});
   for(const child of children)if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
   await Promise.all(children.map(child=>new Promise<void>(resolve=>{if(child.exitCode!==null||child.signalCode!==null)return resolve();child.once('exit',()=>resolve())})));
   if(!nativeEnabled||nativeSettled){
    if(projectId)await cleanupExecutionWorkspaces({runtimeHome,projectId,runId,repoRoot:projectRoot,retain:false});
    await cp?.close();await rm(root,{recursive:true,force:true});
   }else{
    await cp?.close();
    console.warn('Native lifecycle unproven, retained isolated workspace and reservations:',root);
   }
  }
 });
}
