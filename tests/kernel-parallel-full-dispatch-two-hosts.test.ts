// Real Control Planes in two separate processes race the same batch through
// dispatchKernelParallel. Provider launch is a bounded test-owned stub.
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createKernelControlPlane } from '../src/host/kernel/control-plane-runtime.js';
import { cleanupExecutionWorkspaces, prepareExecutionWorkspaces } from '../src/host/kernel/workspace/physical-worktree.js';

const hostCode = String.raw`
import { createKernelControlPlane } from './scripts/host/kernel/control-plane-runtime.js';
import { dispatchKernelParallel } from './scripts/host/kernel/parallel-dispatcher.js';
import { runNativeHostCommand } from './dist/tests/helpers/native-host-disconnect-runner.mjs';
import { writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
const { T24_ROOT:root, T24_REPO:projectRoot, T24_RUNTIME:runtimeHome,T24_RUN:runId,T24_HOST:hostId }=process.env;
const cp=await createKernelControlPlane({projectRoot,runtimeHome});
const nativeEnabled=process.platform==='darwin'&&process.env.T24_NATIVE_FULL_DISPATCH==='1';
const oldGet=cp.getExecutableSteps.bind(cp);
cp.getExecutableSteps=async id=>{
 const selection=oldGet(id);
 if(selection.mode!=='parallel'||selection.steps.length!==2)throw new Error('two runnable steps required');
 await writeFile(path.join(root,'ready-'+hostId),JSON.stringify(selection.steps.map(s=>s.stepId)));
 for(let i=0;!existsSync(path.join(root,'go'))&&i<500;i++)await delay(10);
 if(!existsSync(path.join(root,'go')))throw new Error('entry barrier timed out');
 return selection;
};
let launches=0;
const result=await dispatchKernelParallel({
 controlPlane:cp,runId,projectRoot,runtimeHome,
 adapter:{capabilities:{surface:'codex',supportsConcurrentSessions:true,supportsIsolatedWorkingDirectory:true,supportsPerSessionEnvironment:true}},
 parentSessionId:'test-host-'+hostId,actionContext:{integrationVerification:{commandRef:'test:ok'}},
 prepareHost:async()=>({modelInput:{action:{type:'implement'}},hostDirective:{}}),
 dispatchStep:async({step,workspace})=>{
  launches++;
  await writeFile(path.join(root,'launch-'+step.stepId+'-'+hostId),'started');
  for(let i=0;!existsSync(path.join(root,'release'))&&i<500;i++)await delay(10);
  if(!existsSync(path.join(root,'release')))throw new Error('release barrier timed out');
  if(nativeEnabled){
   if(!process.env.CODEX_HOME)throw new Error('isolated CODEX_HOME is required for Mac native conformance');
   const attempt=cp.stateStore.getStepAttempts(runId,{stepId:step.stepId}).at(-1);
   if(!attempt?.attemptId)throw new Error('missing canonical Attempt before Mac native command');
   const native=await runNativeHostCommand({
    runId,attemptId:attempt.attemptId,workspaceId:workspace.workspaceId,
    workspaceRoot:workspace.workspaceRoot,reservationRoot:path.join(root,'reservations'),
    executable:process.env.T24_CODEX_EXECUTABLE||'codex',
    argv:[process.execPath,'-e',
     "const fs=require('node:fs');fs.writeFileSync('t24-native-'+process.argv[1]+'.txt','NATIVE_WORKER_PASSED\\n')",hostId],
    timeoutMs:20000,
   });
   if(native.exitCode!==0)throw new Error('Mac Native Codex command/exec returned '+String(native.exitCode));
   await writeFile(path.join(root,'native-success-'+step.stepId+'-'+hostId),'pass');
  }
  return {status:'failed',resultStatus:'failed',report:{summary:'bounded failure',changedPaths:[]}};
 },
 executeIntegrationVerification:async()=>{throw new Error('failed worker must not integrate');}
});
await writeFile(path.join(root,'result-'+hostId),JSON.stringify({hostId,launches,dispatched:result.dispatched,status:result.status,failures:result.dispatchFailures?.map(f=>f.failureCode)||[]}));
`;
const git=(cwd:string,args:string[]):string=>{const r=spawnSync('git',args,{cwd,encoding:'utf8',timeout:10000});assert.equal(r.status,0,String(r.stderr||r.error));return r.stdout.trim()};
const waitFor=async(p:()=>Promise<boolean>,label:string)=>{for(let i=0;i<400;i++){if(await p())return;await delay(15)}throw Error('T24 full dispatcher timed out: '+label)};

test('T24 concurrent complete Parallel Dispatchers never double-start or corrupt the winning Attempt',{timeout:65000},async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'t24-full-dispatch-hosts-'));
 const nativeEnabled=process.platform==='darwin'&&process.env.T24_NATIVE_FULL_DISPATCH==='1';
 if(nativeEnabled)assert.ok(process.env.CODEX_HOME,'Mac Native test requires explicitly isolated CODEX_HOME');
 const projectRoot=path.join(root,'project'),runtimeHome=path.join(root,'runtime'),runId='t24-full-run';
 const children:ChildProcessWithoutNullStreams[]=[];
 let cp:Awaited<ReturnType<typeof createKernelControlPlane>>|null=null,projectId:string|null=null;
 let nativeSettled=false;
 try{
  await mkdir(projectRoot);if(nativeEnabled)await mkdir(path.join(root,'reservations'));git(projectRoot,['init','-b','main']);git(projectRoot,['config','user.name','T24 Fixture']);git(projectRoot,['config','user.email','t24@example.invalid']);
  await writeFile(path.join(projectRoot,'package.json'),'{"name":"t24-full","scripts":{"test:ok":"node --version"}}\n');git(projectRoot,['add','--all']);git(projectRoot,['commit','-m','fixture']);
  cp=await createKernelControlPlane({runtimeHome,projectRoot});
  const run=await cp.startRun({runId,objective:'two Host entire dispatch competition',taskContract:{complex:true,riskTier:'T1',
   acceptance:[{id:'A',acceptance:'A',evidencePlan:{class:'hard',method:'unit-test',commandRefs:['test:ok'],obligationId:'proof-a'}},{id:'B',acceptance:'B',evidencePlan:{class:'hard',method:'unit-test',commandRefs:['test:ok'],obligationId:'proof-b'}}],
   requiredObligations:['proof-a','proof-b'],requiredVerifications:[{obligationId:'proof-a',commandRefs:['test:ok']},{obligationId:'proof-b',commandRefs:['test:ok']}],
   steps:[{objective:'A',allowedPaths:['src/a/**'],acceptanceIds:['A'],obligationIds:['proof-a'],dependsOn:[]},{objective:'B',allowedPaths:['src/b/**'],acceptanceIds:['B'],obligationIds:['proof-b'],dependsOn:[]}],
  }});
  projectId=run.projectId;assert.ok(projectId);
  const steps=cp.getExecutableSteps(runId).steps;assert.equal(steps.length,2);
  const prepared=await prepareExecutionWorkspaces({repoRoot:projectRoot,runtimeHome,runId,projectId,baseCommit:git(projectRoot,['rev-parse','HEAD']),steps});
  assert.equal(prepared.steps.length,2);
  const start=(host:string):Promise<{hostId:string;launches:number;dispatched:boolean;status:string;failures:string[]}>=>{
   const env={...process.env,T24_ROOT:root,T24_REPO:projectRoot,T24_RUNTIME:runtimeHome,T24_RUN:runId,T24_HOST:host};
   const child=spawn(process.execPath,['--input-type=module','-e',hostCode],{cwd:process.cwd(),env,stdio:['pipe','pipe','pipe']});children.push(child);
   return new Promise((resolve,reject)=>{
    let stdout='',stderr='';child.stdout.on('data',v=>stdout+=v.toString());child.stderr.on('data',v=>stderr+=v.toString());child.on('error',reject);
    child.on('exit',async code=>{if(code!==0)return reject(Error('Host '+host+' failed: '+stderr+' '+stdout));try{resolve(JSON.parse(await readFile(path.join(root,'result-'+host),'utf8')))}catch(error){reject(error)}});
   });
  };
  const a=start('A'),b=start('B');
  await waitFor(async()=>existsSync(path.join(root,'ready-A'))&&existsSync(path.join(root,'ready-B')),'both Hosts read runnable batch');
  assert.equal(await readFile(path.join(root,'ready-A'),'utf8'),await readFile(path.join(root,'ready-B'),'utf8'));
  await writeFile(path.join(root,'go'),'go');
  await waitFor(async()=>(await readdir(root)).filter(n=>n.startsWith('launch-')).length>=2,'two unique launches');
  await delay(180);
  const launched=(await readdir(root)).filter(n=>n.startsWith('launch-'));
  assert.equal(launched.length,2,JSON.stringify(launched));
  for(const step of steps){
   assert.equal(launched.filter(n=>n.startsWith('launch-'+step.stepId+'-')).length,1);
   const attempts=cp.stateStore.getStepAttempts(runId,{stepId:step.stepId});assert.equal(attempts.length,1);assert.equal(attempts[0]?.status,'started','loser cannot fail live winner');
   assert.equal(cp.getRunSteps(runId).find(s=>s.stepId===step.stepId)?.state,'running');
  }
  assert.equal((await cp.getRun(runId))?.mutationRevision,0);
  await writeFile(path.join(root,'release'),'release');
  const results=await Promise.all([a,b]);
  assert.equal(results.reduce((total,r)=>total+r.launches,0),2);
  if(nativeEnabled){
   const nativeFiles=(await readdir(root)).filter(name=>name.startsWith('native-success-'));
   const reservationFiles=(await readdir(path.join(root,'reservations'))).filter(name=>name.startsWith('writer-'));
   assert.equal(nativeFiles.length,2,'exactly two genuine Mac Codex command/exec calls passed');
   assert.equal(reservationFiles.length,2,'each physical Worker has exactly one external Host writer reservation');
   for(const step of steps)assert.equal(nativeFiles.filter(name=>name.startsWith('native-success-'+step.stepId+'-')).length,1);
   const serverFiles=(await readdir(path.join(root,'reservations'))).filter(name=>name.startsWith('test-server-')&&name.endsWith('.pid'));
   assert.equal(serverFiles.length,2,'both native App Server PIDs must be observed');
   for(const serverFile of serverFiles){
    const pid=Number((await readFile(path.join(root,'reservations',serverFile),'utf8')).trim());
    assert.ok(Number.isSafeInteger(pid)&&pid>0);
    await waitFor(async()=>{
     try{process.kill(pid,0);return false}catch(error){
      if((error as NodeJS.ErrnoException).code==='ESRCH')return true;
      throw error;
     }
    },'native App Server process '+pid+' must terminate before fixture cleanup');
   }
  }
  assert.ok(results.every(r=>r.dispatched===true),'no hidden sequential fallback');
  assert.ok(results.every(r=>r.status==='failed'),'negative integration cannot deliver Owner bytes');
  assert.equal((await cp.getRun(runId))?.mutationRevision,0);
  for(const step of steps)assert.equal(cp.stateStore.getStepAttempts(runId,{stepId:step.stepId}).length,1);
  nativeSettled=true;
 }finally{
  await writeFile(path.join(root,'release'),'release').catch(()=>{});
  for(const child of children)if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
  await Promise.all(children.map(child=>new Promise<void>(resolve=>{if(child.exitCode!==null||child.signalCode!==null)return resolve();child.once('exit',()=>resolve())})));
  if(!nativeEnabled||nativeSettled){
   if(projectId)await cleanupExecutionWorkspaces({runtimeHome,projectId,runId,repoRoot:projectRoot,retain:false});
   cp?.stateStore.close();await rm(root,{recursive:true,force:true});
  }else{
   cp?.stateStore.close();
   console.warn('T24 Mac Native incomplete; retained test-owned worktrees/reservations pending OS exit proof:',root);
  }
 }
});
