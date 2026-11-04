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
import { prepareExecutionWorkspaces, cleanupExecutionWorkspaces } from '../src/host/kernel/workspace/physical-worktree.js';
import { observeWorkspaceIdentity } from '../src/host/kernel/workspace/workspace-identity.js';

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
   const native=await runNativeHostCommand({
    runId,attemptId:attempt.attemptId,workspaceId:workspace.workspaceId,
    workspaceRoot:workspace.workspaceRoot,reservationRoot:path.join(root,'reservations'),
    executable:process.env.T24_CODEX_EXECUTABLE||'codex',
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

for(const mode of ['one-owner','split-owners','split-weak-proof'] as const){
 test(`T24 positive two-Host batch collision: ${mode}`,{timeout:60000},async()=>{
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
     assert.equal((await reopened.getRun(runId))?.mutationRevision,0,'read-only recovery must not mutate Owner');
    }finally{
     await reopened.close();
    }
    if(mode==='split-owners'){
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
