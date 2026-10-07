import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {observeWorkspaceIdentity} from '../scripts/kernel/run/workspace-identity.mjs';
import {createKernelControlPlane} from '../scripts/kernel/control-plane.mjs';
import {dispatchKernelStep} from '../scripts/host/kernel/parallel-dispatcher.mjs';
import {dispatchKernelTurn,prepareParallelWorkerDispatch} from '../scripts/host/kernel/turn-dispatcher.mjs';
import {createModelRegistry} from '../scripts/host/kernel/model-registry.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCodexAdapter } from '../scripts/host/kernel/adapters/codex.mjs';
import { createClaudeAdapter } from '../scripts/host/kernel/adapters/claude.mjs';
import { createAdeAdapter } from '../scripts/host/kernel/adapters/ade.mjs';
import { createFableAdapter } from '../scripts/host/kernel/adapters/fable.mjs';
import { createGeminiAdapter } from '../scripts/host/kernel/adapters/gemini.mjs';
import { createGeminiCliLauncher, parseGeminiCliResult } from '../scripts/host/kernel/adapters/gemini-cli.mjs';
import { admitHostExecutionContract, buildHostExecutionContract } from '../scripts/kernel/run/host-execution-contract.mjs';

const implementationContract = buildHostExecutionContract({
  decision: {
    runId: 'run-host-conformance',
    decisionId: 'route-host-conformance-0001',
    actionKind: 'implement',
    role: 'implementer',
    permissions: 'workspace_write',
    executionClass: 'standard',
    independentContextRequired: false,
    workProfile: { executionClass: 'standard', parallelizable: false },
  },
  assignment: {
    executionMode: 'owner-direct',
    freshSessionRequired: false,
    delegation: { mode: 'optional', requested: false },
  },
  workUnit: { objective: 'bounded host conformance', allowedPaths: ['src/**'] },
});

const reviewContract = buildHostExecutionContract({
  decision: {
    runId: 'run-host-review',
    decisionId: 'route-host-review-0001',
    actionKind: 'review_engineering',
    role: 'reviewer',
    permissions: 'read_only',
    executionClass: 'review',
    independentContextRequired: true,
    workProfile: { executionClass: 'review', parallelizable: false, independentContextRequired: true },
  },
  assignment: {
    executionMode: 'independent-review',
    freshSessionRequired: true,
    delegation: { mode: 'required', requested: true },
  },
  workUnit: { objective: 'review bounded subject', allowedPaths: ['src/**'] },
});

test('W-14/W-15: implemented Host adapters expose the same semantic protocol without provider fields in Core', () => {
  const codex = createCodexAdapter({
    nativeLaunch: async () => ({ status: 'completed', resultStatus: 'completed' }),
  });
  const claude = createClaudeAdapter({
    launch: async () => ({ status: 'completed', resultStatus: 'completed' }),
  });
  const ade = createAdeAdapter({
    spawnAgent: async () => ({ status: 'completed', summary: 'done' }),
  });
  const generic = createFableAdapter();
  const gemini = createGeminiAdapter({
    launch: async () => ({ status: 'completed' }),
    capabilities: { workspaceWrite: true, supportsReadOnlyReview: true },
  });

  for (const adapter of [codex, claude, ade, generic, gemini]) {
    const semantic = adapter.capabilities.semantic;
    for (const key of ['freshContext', 'workspaceWrite', 'workspaceIsolation', 'parallelExecution', 'independentReview', 'modelSelection']) {
      assert.equal(typeof semantic?.[key], 'boolean', `${adapter.surface} missing semantic capability ${key}`);
    }
    assert.equal(admitHostExecutionContract(implementationContract, adapter.capabilities).decision, 'admitted');
  }

  assert.equal(admitHostExecutionContract(reviewContract, codex.capabilities).decision, 'admitted');
  assert.equal(admitHostExecutionContract(reviewContract, claude.capabilities).decision, 'admitted');
  assert.equal(admitHostExecutionContract(reviewContract, ade.capabilities).decision, 'admitted');
  assert.equal(admitHostExecutionContract(reviewContract, gemini.capabilities).decision, 'admitted');

  const genericReview = admitHostExecutionContract(reviewContract, generic.capabilities);
  assert.equal(genericReview.decision, 'blocked');
  assert.deepEqual(genericReview.missingCapabilities, ['freshContext', 'independentReview']);
});

test('Gemini validates admission before launch and never invents model/session/usage evidence', async () => {
  let calls = 0;
  const unavailable = createGeminiAdapter();
  assert.equal(admitHostExecutionContract(reviewContract, unavailable.capabilities).decision, 'blocked');
  const missing = await unavailable.dispatch({ decision: {}, hostExecutionContract: reviewContract });
  assert.equal(missing.status, 'blocked');
  const adapter = createGeminiAdapter({
    capabilities: { workspaceWrite: true },
    launch: async (request) => {
      calls++;
      assert.equal(request.freshContext, true);
      assert.equal(request.model, 'requested-model');
      return { status: 'completed', report: { summary: 'actual result' } };
    },
  });
  const review = await adapter.dispatch({ decision: { role: 'reviewer' }, hostExecutionContract: reviewContract });
  assert.equal(review.status, 'blocked');
  assert.equal(calls, 0);
  const result = await adapter.dispatch({
    decision: { role: 'implementer', permissions: 'workspace_write' },
    resolution: { model: 'requested-model' }, hostExecutionContract: implementationContract,
  });
  assert.equal(calls, 1);
  assert.equal(result.resolvedModel, null);
  assert.equal(result.actorSessionId, null);
  assert.equal(result.inputTokens, null);
  assert.deepEqual(result.report, { summary: 'actual result' });
  await assert.rejects(() => adapter.dispatch({ hostExecutionContract: { ...implementationContract, provider: 'gemini' } }), /provider_field/);
  assert.equal(calls, 1);
});

test('Gemini native transport uses a fresh read-only process and records only CLI terminal telemetry', () => {
  const launch = createGeminiCliLauncher({
    command: process.execPath, args: ['gemini.js'],
    runProcess: (command, args, options) => {
      assert.equal(command, process.execPath);
      assert.ok(args.includes('plan'));
      assert.ok(args.includes('--skip-trust'));
      assert.equal(args.includes('--resume'), false);
      assert.equal(options.shell, false);
      return { status: 0, stdout: JSON.stringify({
        session_id: 'actual-session', response: JSON.stringify({ verdict: 'pass', findings: [] }),
        stats: { models: { 'observed-gemini': { tokens: { prompt: 123, candidates: 45, cached: 67 } } } },
      }) };
    },
  });
  const result = launch({ message: 'review', readOnly: true, model: 'requested-gemini' });
  assert.equal(result.resolvedModel, 'observed-gemini');
  assert.equal(result.sessionId, 'actual-session');
  assert.equal(result.inputTokens, 123);
  assert.equal(result.cachedInputTokens, 67);
  assert.equal(result.outcome.verdict, 'pass');
  assert.equal(parseGeminiCliResult(JSON.stringify({ error: { code: 41, message: 'Auth required' } })).status, 'blocked');
  assert.equal(parseGeminiCliResult('{}').status, 'failed');
  assert.equal(parseGeminiCliResult(JSON.stringify({ session_id: 's', response: 'non-JSON prose' })).status, 'failed');
});

test('W-15: ADE preserves one fresh non-nested sequential worker semantics', () => {
  const ade = createAdeAdapter({ spawnAgent: async () => ({ status: 'completed' }) });
  assert.equal(ade.ownerDirectAvailable, false);
  assert.equal(ade.ownerDirectDefault, false);
  assert.equal(ade.nativeDelegationAvailable, true);
  assert.equal(ade.capabilities.freshWorkerRequired, true);
  assert.equal(ade.capabilities.maxConcurrentWorkers, 1);
  assert.equal(ade.capabilities.maxNestedAgents, 0);
  assert.equal(ade.capabilities.parallelDispatchAllowed, false);
  assert.equal(ade.capabilities.orchestratorOnly, true);
  assert.equal(ade.capabilities.semantic.parallelExecution, false);
  assert.equal(ade.capabilities.semantic.modelSelection, false);
});

test('W-15: generic Host keeps unknown model and usage unclaimed', async () => {
  const generic = createFableAdapter();
  const result = await generic.dispatch({
    decision: { role: 'implementer', modelClass: 'standard', permissions: 'workspace_write' },
    resolution: { model: null, effort: null },
  });
  assert.equal(result.status, 'unsupported');
  assert.equal(result.resolvedModel, null);
  assert.equal(generic.capabilities.supportsResolvedModelIdentity, false);
  assert.equal(generic.capabilities.supportsUsageTokens, false);
  assert.equal(generic.capabilities.semantic.modelSelection, false);
});

test('Gemini semantic execution traverses the actual Host dispatcher contract boundary', async () => {
  const projectRoot=await mkdtemp(path.join(os.tmpdir(),'gemini-dispatch-project-'));
  const runtimeHome=await mkdtemp(path.join(os.tmpdir(),'gemini-dispatch-home-'));
  let cp;
  try {
    await writeFile(path.join(projectRoot,'package.json'),JSON.stringify({scripts:{test:'node -p 1'}}));
    await writeFile(path.join(projectRoot,'app.mjs'),'export const v=1;');
    cp=await createKernelControlPlane({projectRoot,runtimeHome});
    await cp.startRun({runId:'gemini-dispatch',objective:'semantic transport contract',taskContract:{acceptance:['works'],allowedPaths:['app.mjs']}});
    let calls=0;
    const adapter=createGeminiAdapter({capabilities:{workspaceWrite:true},launch:async(request)=>{
      calls++;
      assert.equal(request.freshContext,true);
      return {status:'completed',resolvedModel:request.model,sessionId:'injected-gemini-session',report:{summary:'semantic launch'}};
    }});
    const result=await dispatchKernelTurn({controlPlane:cp,runId:'gemini-dispatch',adapter,registry:createModelRegistry({surface:'gemini',env:{MOON_RELAY_KERNEL_MODEL_VALUE:'configured-gemini'}}),actionContext:{executionMode:'native-subagent',delegationRequested:true}});
    assert.equal(calls,1,'the dispatcher must deliver the v2 hostExecutionContract to the launcher');
    assert.equal(result.dispatched,true);
    assert.equal(result.dispatch.observedModel,'configured-gemini');
    assert.equal(result.admission.decision,'admitted');
  } finally {await cp?.close();await rm(projectRoot,{recursive:true,force:true});await rm(runtimeHome,{recursive:true,force:true});}
});


test('Gemini parallel default dispatch preserves the admitted v2 Host contract', async () => {
  const projectRoot=await mkdtemp(path.join(os.tmpdir(),'gemini-parallel-project-'));
  const runtimeHome=await mkdtemp(path.join(os.tmpdir(),'gemini-parallel-home-'));
  let cp;
  try {
    await writeFile(path.join(projectRoot,'package.json'),JSON.stringify({scripts:{test:'node -p 1'}}));
    await writeFile(path.join(projectRoot,'app.mjs'),'export const v=1;');
    cp=await createKernelControlPlane({projectRoot,runtimeHome});
    const runId='gemini-parallel';
    await cp.startRun({runId,objective:'parallel contract transport',taskContract:{acceptance:['works'],allowedPaths:['app.mjs']}});
    await cp.next(runId); const step=cp.getCurrentStep(runId);
    const registered=cp.registerExecutionWorkspace(runId,projectRoot);
    const workspace={workspaceRoot:projectRoot,workspaceId:registered.workspaceId,baseWorkspaceIdentity:observeWorkspaceIdentity({projectRoot}).identity};
    let calls=0;
    const adapter=createGeminiAdapter({capabilities:{workspaceWrite:true,workspaceIsolation:true,parallelExecution:true},launch:async(request)=>{
      calls++;
      assert.equal(request.workingDirectory,projectRoot);
      assert.equal(request.freshContext,true);
      return {status:'completed',resolvedModel:request.model,sessionId:'injected-parallel-session',report:{summary:'semantic worker'}};
    }});
    const registry=createModelRegistry({surface:'gemini',env:{MOON_RELAY_KERNEL_MODEL_VALUE:'configured-gemini'}});
    const result=await dispatchKernelStep({controlPlane:cp,runId,step,workspace,adapter,hostCapabilities:adapter.capabilities,
      deferReport:true,actionContext:{executionMode:'native-subagent',delegationRequested:true},
      prepareDispatch:({hosted,step})=>prepareParallelWorkerDispatch({controlPlane:cp,runId,adapter,hosted,step,registry})});
    assert.equal(calls,1,JSON.stringify(result));
    assert.equal(result.dispatchContext.admission.decision,'admitted');
    assert.equal(result.result.observedModel,'configured-gemini');
    assert.equal(result.status,'passed');
  } finally {await cp?.close();await rm(projectRoot,{recursive:true,force:true});await rm(runtimeHome,{recursive:true,force:true});}
});

