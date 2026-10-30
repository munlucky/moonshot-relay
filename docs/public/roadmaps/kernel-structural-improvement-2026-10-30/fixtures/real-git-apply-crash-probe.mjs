// W0 diagnostic, isolated in a temporary Git repository. Not a production execution gate.
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createKernelControlPlane} from '../../../../../scripts/host/kernel/control-plane-runtime.js';
import {observeWorkspaceIdentity} from '../../../../../scripts/host/kernel/workspace/workspace-identity.js';

const dir = await fsp.mkdtemp(path.join(os.tmpdir(),'w0-git-crash-'));
const repo = path.join(dir,'project'), runtime = path.join(dir,'runtime');
const N=3000, runId='run-w0-real-apply-crash';
let cp;
let output={};
try {
  await fsp.mkdir(path.join(repo,'src'),{recursive:true});
  const g=(args,opts={})=>{const r=spawnSync('git',args,{cwd:repo,encoding:'utf8',timeout:6000,...opts}); assert.equal(r.status,0,String(r.stderr)); return String(r.stdout).trim()};
  g(['init','-b','main']);g(['config','user.name','W0 Probe']);g(['config','user.email','w0@test.invalid']);
  await fsp.writeFile(path.join(repo,'package.json'),JSON.stringify({name:'w0-probe',scripts:{'test:ok':'node --version'}}));
  await fsp.writeFile(path.join(repo,'src','base.txt'),'base\n');g(['add','--all']);g(['commit','-m','fixture']);
  cp=await createKernelControlPlane({runtimeHome:runtime,projectRoot:repo});
  const contract={steps:[{objective:'materialize files',allowedPaths:['src/files/**'],acceptanceIds:['AC-FILES'],obligationIds:['proof'],dependsOn:[]}],acceptance:[{id:'AC-FILES',acceptance:'files',evidencePlan:{class:'hard',method:'unit-test',commandRefs:['test:ok'],obligationId:'proof'}}],requiredObligations:['proof'],requiredVerifications:[{obligationId:'proof',commandRefs:['test:ok']}]};
  await cp.startRun({runId,objective:'W0 genuine interrupted git apply',taskContract:contract});
  const run=cp.stateStore.getRun(runId), step=cp.stateStore.getRunSteps(runId)[0];
  const identity=observeWorkspaceIdentity({projectRoot:repo}).identity;
  const attempt=cp.bindStepAttempt(runId,step.stepId,{actorSessionId:'w0-worker',workspaceId:'w0-worker-repo',baseWorkspaceIdentity:identity,workspaceIdentity:identity,capsuleId:'w0-capsule',bindingId:'w0-binding'});
  cp.stateStore.recordStepResult(runId,step.stepId,{attemptId:attempt.attemptId,executionWorkspaceId:attempt.workspaceId,mutationRevision:run.mutationRevision,resultWorkspaceIdentity:`sha256:${'b'.repeat(64)}`,resultCommitSha:`sha256:${'c'.repeat(64)}`,changedPaths:['src/files/000000.txt'],patchDigest:`sha256:${'d'.repeat(64)}`,workerReport:{summary:'persisted worker receipt before Delivery crash',verifications:[]},recordMutationProvenance:false});
  cp.failStepAttempt(runId,step.stepId,{code:'simulated_child_termination'});
  const patch=Array.from({length:N},(_,i)=>{const f=`src/files/${String(i).padStart(6,'0')}.txt`; return `diff --git a/${f} b/${f}\nnew file mode 100644\n--- /dev/null\n+++ b/${f}\n@@ -0,0 +1 @@\n+file-${i}\n`;}).join('');
  const tmpPatch=path.join(dir,'patch.diff');await fsp.writeFile(tmpPatch,patch);
  g(['apply','--check','--binary',tmpPatch]);
  const child=spawn('git',['apply','--binary',tmpPatch],{cwd:repo,stdio:'ignore'});
  const first=path.join(repo,'src/files/000000.txt');
  let found=false, exited=false;
  const exitPromise=new Promise((resolve,reject)=>{child.once('exit',(code,signal)=>{exited=true;resolve({code,signal});});child.once('error',reject);});
  const time=Date.now();
  while(Date.now()-time<9000 && !exited){
    if(fs.existsSync(first)){found=true;break;}
    await new Promise(resolve=>setTimeout(resolve,2));
  }
  if(found && !exited)child.kill('SIGKILL');
  const childEnd=await Promise.race([exitPromise,new Promise(resolve=>setTimeout(()=>resolve({timeout:true}),7000))]);
  const files=await fsp.readdir(path.join(repo,'src/files')).catch(()=>[]);
  const before=cp.stateStore.getRun(runId);
  output={found,exitedAtSignal:exited,childEnd,created:files.length,expected:N,runStatusBefore:before.status,revisionBefore:before.mutationRevision,gitStatus:g(['status','--porcelain']).slice(0,140)};
  await cp.close();cp=null;
  cp=await createKernelControlPlane({runtimeHome:runtime,projectRoot:repo});
  const recovered=await cp.recoverPendingDeliveryMaterialization(runId);
  const after=cp.stateStore.getRun(runId);
  output={...output,recoveryStatus:recovered.status,recoveryReason:recovered.reason||null,runStatusAfter:after.status,revisionAfter:after.mutationRevision,filesAfter:(await fsp.readdir(path.join(repo,'src/files')).catch(()=>[])).length};
  console.log('CRASH_PROBE',JSON.stringify(output));
  assert.ok(found,'git apply did not materialize any bytes');
  assert.equal(childEnd.signal,'SIGKILL','only our isolated git apply child may be terminated');
  assert.ok(files.length>0 && files.length<N,'must actually interrupt mid-apply');
  assert.equal(recovered.status,'blocked');assert.equal(after.status,'blocked');assert.equal(after.mutationRevision,0);assert.equal(output.filesAfter,files.length);
  console.log('CRASH_PROBE_PASS');
} finally {
  if(cp)await cp.close().catch(()=>{});
  await fsp.rm(dir,{recursive:true,force:true});
}
