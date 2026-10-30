// W1 diagnostic fixture: isolated SQLite runtime. No production state or model-visible gate.
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {openKernelStateStore} from '../../../../../scripts/kernel/state-store.js';
import {resolveBoundInvocation} from '../../../../../scripts/kernel/run/invocation-resolver.js';
import {normalizeTaskContract} from '../../../../../scripts/kernel/task/task-contract.js';
const home=await mkdtemp(path.join(os.tmpdir(),'w1-authority-db-'));
const projectId='w1-persisted-project';const sessionId='codex:w1-replacement-session';
const names=['active','blocked','completed'];let store;
const contract=(name)=>normalizeTaskContract({objective:`persisted ${name} goal`,acceptance:[`persisted ${name} goal accepted`]});
const result=[];
const resolve=(name,taskContract=contract(name),extra={})=>resolveBoundInvocation({stateStore:store,projectId,provider:'codex',sessionId,workspaceId:`w1-ws-${name}`,taskContract,observedWorkspaceIdentity:null,...extra});
try {
 store=await openKernelStateStore({runtimeHome:home});
 for(const name of names){
  store.createRun({runId:`w1-${name}`,projectId,workspaceId:`w1-ws-${name}`,objective:`persisted ${name} goal`,sourceIdentity:`sha256:${'f'.repeat(64)}`,taskContract:contract(name)});
 }
 store.markRunBlocked('w1-blocked','question','internal');
 const before=store.getRun('w1-completed');
 store.persistCompletionDecision('w1-completed',{decision:'accepted',digest:`sha256:${'a'.repeat(64)}`,run:before,decisionPayload:{decision:'accepted'}});
 store.setFinalizationStatus('w1-completed','completed');
 // A persisted and semantically stale owner binding intentionally points at a completed Run.
 store.createSessionBinding({bindingId:'w1-old-binding',sessionId,provider:'codex',runId:'w1-completed',projectId,workspaceId:'w1-ws-completed',accessMode:'owner',status:'active'});
 assert.equal(store.getActiveOwnerBinding({projectId,sessionId})?.runId,'w1-completed');
 await Promise.resolve();store.close();store=null;
 store=await openKernelStateStore({runtimeHome:home});
 assert.deepEqual(store.listRuns({projectId}).map(r=>r.status).sort(),['active','blocked','completed']);
 assert.equal(store.getActiveOwnerBinding({projectId,sessionId})?.runId,'w1-completed');
 const active=resolve('active');assert.equal(active.mode,'resume');assert.equal(active.runId,'w1-active');
 const blocked=resolve('blocked');assert.equal(blocked.mode,'resume');assert.equal(blocked.runId,'w1-blocked');
 const done=resolve('completed');assert.equal(done.mode,'done');assert.equal(done.runId,'w1-completed');
 const successor=resolve('completed',normalizeTaskContract({objective:'independent follow-on',acceptance:['new goal'] })); assert.equal(successor.mode,'successor');assert.equal(successor.predecessorRunId,'w1-completed');
 const distinct=resolve('blocked',normalizeTaskContract({objective:'independent new goal',acceptance:['new goal accepted']}));assert.equal(distinct.mode,'create');assert.equal(store.getRun('w1-blocked').status,'blocked');
 assert.throws(()=>resolve('active',null,{explicitRunId:'w1-completed'}),e=>e.code==='run_workspace_mismatch'||e.code==='worktree_run_conflict');
 result.push({persistedRuns:3,staleSessionBindingRun:'w1-completed',active:{mode:active.mode,runId:active.runId},blocked:{mode:blocked.mode,runId:blocked.runId},completed:{mode:done.mode,runId:done.runId},newTask:{mode:successor.mode,predecessor:successor.predecessorRunId},otherBlockedTask:distinct.mode,blockedPreserved:store.getRun('w1-blocked').status});
 console.log('W1_PERSISTED_AUTHORITY_PASS',JSON.stringify(result[0]));
}finally{if(store)store.close();await rm(home,{recursive:true,force:true});}
