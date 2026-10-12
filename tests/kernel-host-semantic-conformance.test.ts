import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {observeWorkspaceIdentity} from '../src/host/kernel/workspace/workspace-identity.js';
import {createKernelControlPlane} from '../src/host/kernel/control-plane-runtime.js';
import {dispatchKernelStep} from '../src/host/kernel/parallel-dispatcher.js';
import {dispatchKernelTurn,prepareParallelWorkerDispatch} from '../src/host/kernel/turn-dispatcher.js';
import {createModelRegistry} from '../src/host/kernel/model-registry.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCodexAdapter } from '../src/host/kernel/adapters/codex.js';
import { createClaudeAdapter } from '../src/host/kernel/adapters/claude.js';
import { createAdeAdapter } from '../src/host/kernel/adapters/ade.js';
import { createFableAdapter } from '../src/host/kernel/adapters/fable.js';
import { createGeminiAdapter } from '../src/host/kernel/adapters/gemini.js';
import { createGeminiCliLauncher, parseGeminiCliResult } from '../src/host/kernel/adapters/gemini-cli.js';
import { admitHostExecutionContract, buildHostExecutionContract } from '../src/contracts/host-execution-contract.js';

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
    for (const key of ['freshContext', 'workspaceWrite', 'workspaceIsolation', 'parallelExecution', 'independentReview', 'modelSelection'] as const) {
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
      return { pid: 1, output: [], stderr: '', signal: null, status: 0, stdout: JSON.stringify({
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
  assert.ok(result && typeof result === 'object' && 'outcome' in result);
  assert.ok(result.outcome !== null && result.outcome !== undefined);
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
  const fixtureInput1 = {
    decision: { role: 'implementer', modelClass: 'standard', permissions: 'workspace_write' },
    resolution: { model: null, effort: null },
  };
  const result = await generic.dispatch(fixtureInput1);
  assert.equal(result.status, 'unsupported');
  assert.equal(result.resolvedModel, null);
  assert.equal(generic.capabilities.supportsResolvedModelIdentity, false);
  assert.equal(generic.capabilities.supportsUsageTokens, false);
  assert.equal(generic.capabilities.semantic.modelSelection, false);
});

test('Gemini semantic execution traverses the actual Host dispatcher contract boundary', async () => {
  const projectRoot=await mkdtemp(path.join(os.tmpdir(),'gemini-dispatch-project-'));
  const runtimeHome=await mkdtemp(path.join(os.tmpdir(),'gemini-dispatch-home-'));
  let cp: KernelControlPlane | undefined;
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
    assert.ok(result && typeof result === 'object' && 'dispatch' in result);
    assert.ok(result.dispatch && typeof result.dispatch === 'object' && 'observedModel' in result.dispatch);
    assert.equal(result.dispatch.observedModel,'configured-gemini');
    assert.ok(result && typeof result === 'object' && 'admission' in result);
    assert.ok(result.admission !== null && result.admission !== undefined);
    assert.equal(result.admission.decision,'admitted');
  } finally {await cp?.close();await rm(projectRoot,{recursive:true,force:true});await rm(runtimeHome,{recursive:true,force:true});}
});


test('Gemini parallel default dispatch preserves the admitted v2 Host contract', async () => {
  const projectRoot=await mkdtemp(path.join(os.tmpdir(),'gemini-parallel-project-'));
  const runtimeHome=await mkdtemp(path.join(os.tmpdir(),'gemini-parallel-home-'));
  let cp: KernelControlPlane | undefined;
  try {
    await writeFile(path.join(projectRoot,'package.json'),JSON.stringify({scripts:{test:'node -p 1'}}));
    await writeFile(path.join(projectRoot,'app.mjs'),'export const v=1;');
    cp=await createKernelControlPlane({projectRoot,runtimeHome});
    const runId='gemini-parallel';
    await cp.startRun({runId,objective:'parallel contract transport',taskContract:{acceptance:['works'],allowedPaths:['app.mjs']}});
    await cp.next(runId); const step=cp.getCurrentStep(runId); assert.ok(step);
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
      prepareDispatch:({hosted,step})=>{ assert.ok(cp); assert.ok(hosted && typeof hosted === 'object'); assert.ok(step && typeof step === 'object'); return prepareParallelWorkerDispatch({controlPlane:cp,runId,adapter,hosted,step,registry}); }});
    assert.equal(calls,1,JSON.stringify(result));
    assert.ok(result && typeof result === 'object' && 'dispatchContext' in result);
    assert.ok(result.dispatchContext !== null && result.dispatchContext !== undefined);
    assert.ok(result.dispatchContext.admission !== null && result.dispatchContext.admission !== undefined);
    assert.equal(result.dispatchContext.admission.decision,'admitted');
    assert.ok(result && typeof result === 'object' && 'result' in result);
    assert.ok(result.result !== null && result.result !== undefined);
    assert.equal(result.result.observedModel,'configured-gemini');
    assert.equal(result.status,'passed');
  } finally {await cp?.close();await rm(projectRoot,{recursive:true,force:true});await rm(runtimeHome,{recursive:true,force:true});}
});


type KernelControlPlane = Awaited<ReturnType<typeof createKernelControlPlane>>;
