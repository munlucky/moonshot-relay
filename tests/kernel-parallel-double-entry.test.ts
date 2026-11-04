// Two independent Host processes must not start two providers for one ready
// canonical Step. All repositories, DBs and launch markers belong to this test.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createKernelControlPlane } from '../src/host/kernel/control-plane-runtime.js';

const childCode = String.raw`
import { createKernelControlPlane } from './scripts/host/kernel/control-plane-runtime.js';
import { dispatchKernelStep } from './scripts/host/kernel/parallel-dispatcher.js';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
const { T24_ROOT, T24_RUN_ID, T24_HOST_ID, T24_PROJECT, T24_RUNTIME, T24_STEP }=process.env;
const cp=await createKernelControlPlane({projectRoot:T24_PROJECT,runtimeHome:T24_RUNTIME});
const step=cp.getRunSteps(T24_RUN_ID).find(s=>s.stepId===T24_STEP);
if (!step || step.state!=='ready') throw new Error('T24 step not initially ready');
await writeFile(path.join(T24_ROOT,'ready-'+T24_HOST_ID), 'ready');
for(let n=0;!existsSync(path.join(T24_ROOT,'go')) && n<500;n++) await delay(10);
if(!existsSync(path.join(T24_ROOT,'go'))) throw new Error('barrier timeout');
let launched=false,code=null;
try {
 await dispatchKernelStep({
   controlPlane:cp,runId:T24_RUN_ID,step,
   workspace:{workspaceRoot:T24_PROJECT,workspaceId:'t24-workspace-'+T24_HOST_ID,baseWorkspaceIdentity:'t24-fixture'},
   adapter:{capabilities:{}},hostCapabilities:{},parentSessionId:T24_HOST_ID,
   prepareHost:async()=>({modelInput:{action:{type:'implement'}},hostDirective:{}}),
   dispatchStep:async()=>{
     launched=true;
     await writeFile(path.join(T24_ROOT,'launch-'+T24_HOST_ID), 'launched');
     return {status:'failed',resultStatus:'failed'};
   },
   deferReport:true,
 });
} catch (error) { code=error?.code || error?.message || String(error); }
console.log(JSON.stringify({host:T24_HOST_ID,launched,code}));
`;

const git = (cwd: string, args: string[]) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, String(result.stderr || result.error));
};
const waitFor = async (predicate: () => Promise<boolean>, name: string) => {
  for (let n = 0; n < 400; n++) {
    if (await predicate()) return;
    await delay(15);
  }
  throw new Error(`T24 barrier timeout: ${name}`);
};

test('T24 independent Host processes claim one canonical Step before provider spawn', { timeout: 60000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kernel-t24-two-hosts-'));
  const projectRoot = path.join(root, 'project');
  const runtimeHome = path.join(root, 'runtime');
  const runId = 't24-two-hosts';
  let cp: Awaited<ReturnType<typeof createKernelControlPlane>> | null = null;
  const children: ReturnType<typeof spawn>[] = [];
  try {
    await mkdir(projectRoot);
    git(projectRoot, ['init', '-b', 'main']);
    git(projectRoot, ['config', 'user.name', 'T24 Test']);
    git(projectRoot, ['config', 'user.email', 't24@example.invalid']);
    await writeFile(path.join(projectRoot, 'package.json'), '{"name":"t24-two-hosts","scripts":{"test:ok":"node --version"}}\n');
    git(projectRoot, ['add', '--all']);
    git(projectRoot, ['commit', '-m', 'fixture']);
    cp = await createKernelControlPlane({projectRoot,runtimeHome});
    await cp.startRun({runId,objective:'two independent Host launch admission',taskContract:{
      complex:true,riskTier:'T1',
      acceptance:[
        {id:'A',acceptance:'A',evidencePlan:{class:'hard',method:'unit-test',commandRefs:['test:ok'],obligationId:'proof-a'}},
        {id:'B',acceptance:'B',evidencePlan:{class:'hard',method:'unit-test',commandRefs:['test:ok'],obligationId:'proof-b'}},
      ],
      requiredObligations:['proof-a','proof-b'],
      requiredVerifications:[
        {obligationId:'proof-a',commandRefs:['test:ok']},
        {obligationId:'proof-b',commandRefs:['test:ok']},
      ],
      steps:[
        {objective:'A',allowedPaths:['src/a/**'],acceptanceIds:['A'],obligationIds:['proof-a'],dependsOn:[]},
        {objective:'B',allowedPaths:['src/b/**'],acceptanceIds:['B'],obligationIds:['proof-b'],dependsOn:[]},
      ],
    }});
    const batch = cp.getExecutableSteps(runId);
    assert.equal(batch.mode, 'parallel');
    const stepId = batch.steps[0]!.stepId;
    const start = (host: string) => {
      const env = {...process.env, T24_ROOT:root,T24_RUN_ID:runId,T24_HOST_ID:host,T24_PROJECT:projectRoot,T24_RUNTIME:runtimeHome,T24_STEP:stepId};
      const child=spawn(process.execPath,['--input-type=module','-e',childCode],{cwd:process.cwd(),env,stdio:['ignore','pipe','pipe']});
      children.push(child);
      return new Promise<{host:string;launched:boolean;code:string|null}>((resolve,reject)=>{
        let stdout='',stderr='';
        child.stdout.setEncoding('utf8').on('data',chunk=>stdout+=chunk);
        child.stderr.setEncoding('utf8').on('data',chunk=>stderr+=chunk);
        child.on('error',reject);
        child.on('exit',(code)=>{
          if(code!==0)return reject(new Error(`host ${host} exited ${code}: ${stderr}`));
          try{resolve(JSON.parse(stdout.trim()));}catch(error){reject(new Error(`host ${host} bad output: ${stdout}: ${String(error)}`));}
        });
      });
    };
    const first = start('A');
    const second = start('B');
    await waitFor(async()=>existsSync(path.join(root,'ready-A'))&&existsSync(path.join(root,'ready-B')),'both Hosts ready');
    await writeFile(path.join(root,'go'),'go');
    const results=await Promise.all([first,second]);
    const launched=(await readdir(root)).filter(name=>name.startsWith('launch-'));
    const attempts=cp.stateStore.getStepAttempts(runId,{stepId});
    const run=await cp.getRun(runId);
    assert.equal(launched.length,1,JSON.stringify({results,attempts:attempts.map(a=>a.attemptId)}));
    assert.equal(attempts.length,1,'one canonical attempt for the same Step');
    assert.equal(results.filter(result=>result.launched).length,1);
    assert.equal(run?.mutationRevision,0,'no Owner delivery by a stub provider');
    const winner = results.find(result => result.launched)!;
    const boundStep = cp.getRunSteps(runId).find(step => step.stepId === stepId);
    assert.equal(boundStep?.state, 'running');
    assert.equal(boundStep?.attemptCount, 1);
    assert.equal(boundStep?.executionWorkspaceId, 't24-workspace-' + winner.host,
      'loser must not overwrite the winning Host workspace identity');
    assert.equal((await readFile(path.join(root,launched[0]!),'utf8')).trim(),'launched');

    // A failure between the conditional Step claim and Attempt insertion must
    // roll back the Step change, not strand a runnable Step in running state.
    const otherStep = cp.getRunSteps(runId).find(step => step.stepId !== stepId)!;
    assert.equal(otherStep.state, 'ready');
    assert.throws(() => cp!.stateStore.recordStepAttempt(runId, {
      stepId: otherStep.stepId,
      attemptId: attempts[0]!.attemptId,
      provenanceKind: 'routed',
      claimReadyStep: true,
      planRevision: otherStep.planRevision,
      workspaceId: 't24-rollback-attempt',
    }), /UNIQUE|constraint/iu);
    const rollbackStep = cp.getRunSteps(runId).find(step => step.stepId === otherStep.stepId)!;
    assert.equal(rollbackStep.state, 'ready');
    assert.equal(rollbackStep.attemptCount, 0);
    assert.equal(rollbackStep.executionWorkspaceId, null);
    assert.equal(cp.stateStore.getStepAttempts(runId, {stepId:otherStep.stepId}).length,0);
  } finally {
    for (const child of children) if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
    await cp?.stateStore?.close?.();
    await rm(root,{recursive:true,force:true});
  }
});
