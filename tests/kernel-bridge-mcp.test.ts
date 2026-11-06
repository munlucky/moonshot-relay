import { assertTestArray, assertTestPresent, assertTestRecord, assertTestString, optionalTestRecord } from './helpers/assert-value.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { createMcpBridgeHandler, handleMcpToolCall, startMcpBridgeServer } from '../src/kernel/bridge/mcp.js';
import { createKernelControlPlane } from '../src/host/kernel/control-plane-runtime.js';
import { createHostWorkerSessions } from '../src/host/kernel/host-worker-sessions.js';
import { dispatchKernelTurn } from '../src/host/kernel/turn-dispatcher.js';
import { createClaudeAdapter } from '../src/host/kernel/adapters/claude.js';
import { createKernelHostReviewBridge } from '../src/host/kernel/lifecycle-bridge.js';
import { assessReviewReadiness } from '../src/host/kernel/review-readiness.js';
import { createModelRegistry } from '../src/host/kernel/model-registry.js';
import { CODEX_EXECUTION_POLICY } from '../src/host/kernel/codex-model-policy.js';

const tempRoots: string[] = [];

const createFixtureRepo = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kernel-bridge-fixture-'));
  tempRoots.push(root);
  spawnSync('git', ['init', '--quiet'], { cwd: root, encoding: 'utf8' });
  spawnSync('git', ['config', 'user.name', 'Bridge Test'], { cwd: root, encoding: 'utf8' });
  spawnSync('git', ['config', 'user.email', 'bridge@example.invalid'], { cwd: root, encoding: 'utf8' });
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'bridge-fixture', scripts: { test: 'node --version' } }));
  await writeFile(path.join(root, 'README.md'), '# Bridge Fixture\n');
  spawnSync('git', ['add', '.'], { cwd: root, encoding: 'utf8' });
  spawnSync('git', ['commit', '-m', 'initial', '--quiet'], { cwd: root, encoding: 'utf8' });
  return root;
};

const prepareMcpReviewRun = async (runId: string) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kernel-mcp-review-'));
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-mcp-review-state-'));
  await mkdir(path.join(root, '.moon-relay'), { recursive: true });
  await writeFile(path.join(root, '.moon-relay', 'track.yaml'), 'track: kernel\n');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test', lint: 'node -e "process.exit(0)"' } }));
  await writeFile(path.join(root, 'app.mjs'), 'export const value = 0;\n');
  const cp = await createKernelControlPlane({ runtimeHome, projectRoot: root });
  try {
    await cp.startRun({
      runId,
      objective: 'secure change',
      taskContract: {
        surfaces: ['security_boundary'],
        acceptance: ['secure'],
        allowedPaths: ['app.mjs'],
      },
    });
    const implementer = createClaudeAdapter({
      launch: async ({ invocation }) => ({
        resolvedModel: assertTestRecord(invocation).model,
        observedModel: assertTestRecord(invocation).model,
        resolvedEffort: assertTestRecord(invocation).effort,
        observedEffort: assertTestRecord(invocation).effort,
        sessionId: `${runId}-implementer`,
      }),
    });
    const implementation = await dispatchKernelTurn({
      controlPlane: cp,
      runId,
      adapter: implementer,
      registry: createModelRegistry({
        surface: 'claude',
        env: { MOON_RELAY_KERNEL_MODEL_FRONTIER: 'configured-frontier', MOON_RELAY_KERNEL_MODEL_VALUE: 'configured-value' },
      }),
      actionContext: { executionMode: 'native-subagent', delegationRequested: true },
    });
    await writeFile(path.join(root, 'app.mjs'), 'export const value = 1;\n');
    await cp.report(runId, {
      summary: 'implemented',
      capsuleId: assertTestPresent(implementation.executionCapsule).capsuleId,
      stepId: assertTestPresent(implementation.executionCapsule).stepId,
      changedPaths: ['app.mjs'],
    });
    await cp.transition(runId, 'EXECUTE');
    await cp.transition(runId, 'PROVE');
  } finally {
    await cp.close();
  }
  return { root, runtimeHome };
};

const parseToolText = (response: unknown) => assertTestRecord(JSON.parse(assertTestString(assertTestRecord(assertTestArray(assertTestRecord(assertTestRecord(response).result).content)[0]).text)));

const cleanupMcpReviewRun = async ({ root, runtimeHome }: { root: string; runtimeHome: string }) => {
  await rm(runtimeHome, { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
};

test('mcp bridge provides initialize, ping, tools/list, and tool execution', async (t) => {
  t.after(async () => {
    await Promise.all(tempRoots.map((r) => rm(r, { recursive: true, force: true })));
  });

  const workspaceRoot = await createFixtureRepo();
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-runtime-'));
  tempRoots.push(runtimeHome);

  const handler = createMcpBridgeHandler({ runtimeHome });

  // 1. initialize
  const initRes = await handler({ jsonrpc: '2.0', id: 1, method: 'initialize' });
  assert.equal(assertTestPresent(assertTestPresent(assertTestPresent(initRes).result).serverInfo).name, 'moon-relay-kernel-bridge');
  assert.ok(assertTestPresent(assertTestPresent(assertTestPresent(initRes).result).capabilities).tools);

  // 2. initialized notification
  const notifyRes = await handler({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(notifyRes, null);

  // 3. ping
  const pingRes = await handler({ jsonrpc: '2.0', id: 2, method: 'ping' });
  assert.deepEqual(assertTestPresent(pingRes).result, {});

  // 4. tools/list
  const listRes = await handler({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
  const listedTools = assertTestArray(assertTestRecord(assertTestPresent(assertTestPresent(listRes).result)).tools);
  const toolNames = listedTools.map((tool) => assertTestRecord(tool).name);
  assert.ok(toolNames.includes('kernel_attach'));
  assert.ok(toolNames.includes('kernel_next'));
  assert.ok(toolNames.includes('kernel_report'));
  assert.ok(toolNames.includes('kernel_status'));
  assert.ok(toolNames.includes('kernel_detach'));
  const nextTool = assertTestRecord(assertTestPresent(listedTools.find((tool) => assertTestRecord(tool).name === 'kernel_next')));
  const nextContractDescription = assertTestString(
    assertTestRecord(assertTestRecord(assertTestRecord(nextTool.inputSchema).properties).contractJson).description,
  );
  assert.match(nextContractDescription, /Semantic Task Contract input/i);
  assert.match(nextContractDescription, /Supply meaning, not Kernel-generated IDs or digests/i);
  assert.match(nextContractDescription, /omit unknown scope instead of sending an empty allowedPaths claim/i);

  const reportTool = assertTestPresent(listedTools.find((tool) => assertTestRecord(tool).name === 'kernel_report'));
  assert.match(assertTestString(assertTestRecord(reportTool).description), /canonical continuation in next/i);
  assert.match(assertTestString(assertTestRecord(reportTool).description), /instead of immediately calling kernel_next/i);

  // 5. tools/call kernel_next (contract-first)
  const taskContract = {
    objective: 'Implement MCP bridge test',
    nonGoals: ['no broad scope'],
    acceptance: ['bridge responds'],
    constraints: ['use git'],
  };

  const nextCall = await handler({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: {
      name: 'kernel_next',
      arguments: {
        workspaceRoot,
        contractJson: taskContract,
        surface: 'claude_app',
      },
    },
  });

  assert.equal(assertTestPresent(assertTestPresent(nextCall).result).isError, false);
  const nextResult = JSON.parse(assertTestString(assertTestRecord(assertTestArray(assertTestPresent(assertTestPresent(nextCall).result).content)[0]).text));
  assert.ok(nextResult.runId || nextResult.action);
  assert.deepEqual(
    nextResult.acceptancePlans.map((item: { id: string; statement: string }) => ({ id: item.id, statement: item.statement })),
    [{ id: 'AC-1', statement: 'bridge responds' }],
    'MCP accepts semantic statements and Kernel owns canonical acceptance IDs',
  );

  const runId = nextResult.runId;

  // 6. tools/call kernel_status
  const statusCall = await handler({
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: {
      name: 'kernel_status',
      arguments: {
        workspaceRoot,
        runId,
      },
    },
  });

  assert.equal(assertTestPresent(assertTestPresent(statusCall).result).isError, false);
  const statusResult = JSON.parse(assertTestString(assertTestRecord(assertTestArray(assertTestPresent(assertTestPresent(statusCall).result).content)[0]).text));
  assert.equal(statusResult.run?.runId, runId);
  assert.ok(statusResult.completion);
  assert.ok(Array.isArray(statusResult.workerAttempts));
  assert.ok(statusResult.workerAttempts.every((attempt: { liveState: string; writerExitVerified: boolean }) =>
    attempt.liveState === 'unobserved' && attempt.writerExitVerified === false));

  // A fresh Main has the same durable Kernel Contract/Evidence projection,
  // without implicitly preparing a next action or creating an Attempt.
  const newMain = createMcpBridgeHandler({ runtimeHome });
  const reattached = parseToolText(await newMain({
    jsonrpc: '2.0', id: 51, method: 'tools/call', params: {
      name: 'kernel_attach', arguments: { workspaceRoot, runId },
    },
  }));
  assert.equal(reattached.status, 'attached');
  assert.equal(reattached.next, undefined);
  assert.deepEqual(reattached.resume, statusResult.resume);
  assert.deepEqual(reattached.workAuthority, statusResult.workAuthority);
  assert.deepEqual(reattached.trustAuthority, statusResult.trustAuthority);
  assert.deepEqual(reattached.workerAttempts, statusResult.workerAttempts);
  assert.equal(reattached.liveWorker, null);

  // 7. tools/call kernel_report
  await writeFile(path.join(workspaceRoot, 'README.md'), '# Bridge Fixture\n\nchanged by report\n');
  const reportCall = await handler({
    jsonrpc: '2.0',
    id: 6,
    method: 'tools/call',
    params: {
      name: 'kernel_report',
      arguments: {
        workspaceRoot,
        runId,
        report: {
          stepId: nextResult.action?.stepId || 'step-1',
          changedPaths: ['README.md'],
          evidence: [],
          outcome: 'completed',
        },
      },
    },
  });

  assert.equal(assertTestPresent(assertTestPresent(reportCall).result).isError, false);
  const reportResult = parseToolText(reportCall);
  const reportNext = assertTestRecord(reportResult.next);
  assertTestString(assertTestRecord(reportNext.action).type);

  // No second kernel_next call is needed here: kernel_report already returned
  // the prepared canonical continuation for the next model decision.

  // 8. tools/call kernel_detach
  const detachCall = await handler({
    jsonrpc: '2.0',
    id: 7,
    method: 'tools/call',
    params: {
      name: 'kernel_detach',
      arguments: {
        workspaceRoot,
        runId,
      },
    },
  });

  assert.equal(assertTestPresent(assertTestPresent(detachCall).result).isError, false);
  const detachResult = JSON.parse(assertTestString(assertTestRecord(assertTestArray(assertTestPresent(assertTestPresent(detachCall).result).content)[0]).text));
  assert.equal(detachResult.status, 'detached');
  assert.ok(detachResult.worktreeId);
});

test('mcp bridge fails closed when workspaceRoot is missing or invalid', async (t) => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-runtime-'));
  tempRoots.push(runtimeHome);
  const handler = createMcpBridgeHandler({ runtimeHome });

  const missingRootCall = await handler({
    jsonrpc: '2.0',
    id: 10,
    method: 'tools/call',
    params: {
      name: 'kernel_next',
      arguments: {},
    },
  });

  assert.equal(assertTestPresent(assertTestPresent(missingRootCall).result).isError, true);
  const errPayload = JSON.parse(assertTestString(assertTestRecord(assertTestArray(assertTestPresent(assertTestPresent(missingRootCall).result).content)[0]).text));
  assert.ok(errPayload.error.includes('workspaceRoot is required'));
});

test('mcp next automatically dispatches an independent Host review and returns the Kernel receipt', async () => {
  const runId = 'mcp-host-review-chain';
  const fixture = await prepareMcpReviewRun(runId);
  try {
    const reviewer = createClaudeAdapter({
      launch: async ({ invocation }) => ({
        resolvedModel: assertTestRecord(invocation).model,
        observedModel: assertTestRecord(invocation).model,
        resolvedEffort: assertTestRecord(invocation).effort,
        observedEffort: assertTestRecord(invocation).effort,
        sessionId: 'mcp-reviewer-session',
        outcome: { verdict: 'pass', findings: [], risks: [], evidenceRefs: ['review://mcp'] },
      }),
    });
    const bridge = createKernelHostReviewBridge({
      adapter: reviewer,
      registry: createModelRegistry({
        surface: 'claude',
        env: {
          MOON_RELAY_KERNEL_MODEL_FRONTIER: 'mcp-review-frontier',
          MOON_RELAY_KERNEL_MODEL_FRONTIER_EFFORT: 'high',
        },
      }),
      runtimeHome: fixture.runtimeHome,
      env: {},
      parentSessionId: 'mcp-owner-session',
    });
    const handler = createMcpBridgeHandler({ runtimeHome: fixture.runtimeHome, env: {}, hostBridge: bridge });
    const response = await handler({
      jsonrpc: '2.0',
      id: 20,
      method: 'tools/call',
      params: {
        name: 'kernel_next',
        arguments: { workspaceRoot: fixture.root, runId, surface: 'claude_app' },
      },
    });

    assert.equal(assertTestPresent(assertTestPresent(response).result).isError, false);
    const result = parseToolText(response);
    assert.equal(assertTestRecord(result.hostReview).status, 'receipt-recorded');
    assert.match(assertTestString(assertTestRecord(result.hostReview).reviewReceiptId), /^review-receipt-[a-f0-9]{24}$/);
    assert.equal(assertTestRecord(result.hostReview).verdict, 'pass');
    assert.equal(assertTestRecord(assertTestRecord(result.hostReview).wait).repeatedPolling, false);
    assert.notEqual(optionalTestRecord(result.action)?.type, 'review');

    // A second next must see the recorded judgment rather than re-entering the
    // readiness gate or dispatching the same review again.
    const secondResponse = await handler({
      jsonrpc: '2.0',
      id: 21,
      method: 'tools/call',
      params: {
        name: 'kernel_next',
        arguments: { workspaceRoot: fixture.root, runId, surface: 'claude_app' },
      },
    });
    assert.equal(assertTestPresent(assertTestPresent(secondResponse).result).isError, false);
    const secondResult = parseToolText(secondResponse);
    assert.notEqual(secondResult.status, 'execution-readiness-blocked');

    const cp = await createKernelControlPlane({ runtimeHome: fixture.runtimeHome, projectRoot: fixture.root });
    try {
      const receipts = cp.listReviewReceipts(runId);
      assert.equal(receipts.length, 1);
      assert.equal(receipts[0].verdict, 'pass');
    } finally {
      await cp.close();
    }
  } finally {
    await cleanupMcpReviewRun(fixture);
  }
});

test('mcp report dispatches pending Host review and returns the refreshed continuation without a second next call', async () => {
  const runId = 'mcp-report-review-continuation';
  const fixture = await prepareMcpReviewRun(runId);
  try {
    const reviewer = createClaudeAdapter({
      launch: async ({ invocation }) => ({
        resolvedModel: assertTestRecord(invocation).model,
        observedModel: assertTestRecord(invocation).model,
        resolvedEffort: assertTestRecord(invocation).effort,
        observedEffort: assertTestRecord(invocation).effort,
        sessionId: 'mcp-report-reviewer-session',
        outcome: { verdict: 'pass', findings: [], risks: [], evidenceRefs: ['review://mcp-report'] },
      }),
    });
    const bridge = createKernelHostReviewBridge({
      adapter: reviewer,
      registry: createModelRegistry({
        surface: 'claude',
        env: {
          MOON_RELAY_KERNEL_MODEL_FRONTIER: 'mcp-review-frontier',
          MOON_RELAY_KERNEL_MODEL_FRONTIER_EFFORT: 'high',
        },
      }),
      runtimeHome: fixture.runtimeHome,
      env: {},
      parentSessionId: 'mcp-report-owner-session',
    });
    const handler = createMcpBridgeHandler({ runtimeHome: fixture.runtimeHome, env: {}, hostBridge: bridge });
    const response = await handler({
      jsonrpc: '2.0',
      id: 22,
      method: 'tools/call',
      params: {
        name: 'kernel_report',
        arguments: {
          workspaceRoot: fixture.root,
          runId,
          surface: 'claude_app',
          report: {
            summary: 'continue proof with the already reported implementation',
            changedPaths: ['app.mjs'],
          },
        },
      },
    });

    assert.equal(assertTestPresent(assertTestPresent(response).result).isError, false);
    const result = parseToolText(response);
    assert.equal(assertTestRecord(result.hostReview).status, 'receipt-recorded');
    assert.match(assertTestString(assertTestRecord(result.hostReview).reviewReceiptId), /^review-receipt-[a-f0-9]{24}$/);
    const continuation = assertTestRecord(result.next);
    assert.notEqual(assertTestRecord(continuation.action).type, 'review');

    const cp = await createKernelControlPlane({ runtimeHome: fixture.runtimeHome, projectRoot: fixture.root });
    try {
      assert.equal(cp.listReviewReceipts(runId).length, 1);
    } finally {
      await cp.close();
    }
  } finally {
    await cleanupMcpReviewRun(fixture);
  }
});

test('mcp next coalesces concurrent review delivery for the same run revision', async () => {
  const runId = 'mcp-host-review-concurrent';
  const fixture = await prepareMcpReviewRun(runId);
  try {
    let launchCount = 0;
    const reviewer = createClaudeAdapter({
      launch: async ({ invocation }) => {
        launchCount += 1;
        await new Promise((resolve) => setTimeout(resolve, 75));
        return {
          resolvedModel: assertTestRecord(invocation).model,
          observedModel: assertTestRecord(invocation).model,
          resolvedEffort: assertTestRecord(invocation).effort,
          observedEffort: assertTestRecord(invocation).effort,
          sessionId: 'mcp-concurrent-reviewer-session',
          outcome: { verdict: 'pass', findings: [], risks: [], evidenceRefs: ['review://mcp-concurrent'] },
        };
      },
    });
    const bridge = createKernelHostReviewBridge({
      adapter: reviewer,
      registry: createModelRegistry({
        surface: 'claude',
        env: {
          MOON_RELAY_KERNEL_MODEL_FRONTIER: 'mcp-review-frontier',
          MOON_RELAY_KERNEL_MODEL_FRONTIER_EFFORT: 'high',
        },
      }),
      runtimeHome: fixture.runtimeHome,
      env: {},
      parentSessionId: 'mcp-owner-session',
    });
    const handler = createMcpBridgeHandler({ runtimeHome: fixture.runtimeHome, env: {}, hostBridge: bridge });
    const request = (id: string | number) => handler({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: {
        name: 'kernel_next',
        arguments: { workspaceRoot: fixture.root, runId, surface: 'claude_app' },
      },
    });

    const responses = await Promise.all([request(30), request(31)]);
    for (const response of responses) {
      assert.equal(assertTestPresent(assertTestPresent(response).result).isError, false);
      const result = parseToolText(response);
      assert.equal(assertTestRecord(result.hostReview).status, 'receipt-recorded');
      assert.equal(assertTestRecord(result.hostReview).verdict, 'pass');
    }
    assert.equal(launchCount, 1, 'concurrent callers must share one reviewer launch');

    const cp = await createKernelControlPlane({ runtimeHome: fixture.runtimeHome, projectRoot: fixture.root });
    try {
      assert.equal(cp.listReviewReceipts(runId).length, 1);
    } finally {
      await cp.close();
    }
  } finally {
    await cleanupMcpReviewRun(fixture);
  }
});

test('review readiness uses the enforced Codex policy and requires independent context', () => {
  const readiness = assessReviewReadiness({
    run: { projectMode: 'greenfield', objective: 'review a secure change', proofTier: 'T3' },
    contract: { objective: 'review a secure change' },
    modelInput: {
      action: {
        type: 'review',
        independentReviewRequired: true,
        outstandingObligations: ['security-review'],
      },
    },
    obligations: [{ obligationId: 'security-review', evidenceClass: 'judgment' }],
    adapter: {
      nativeDelegationAvailable: true,
      dispatch: async () => {},
      capabilities: {
        surface: 'codex',
        supportsIndependentContext: false,
        supportsReadOnlyReview: true,
      },
    },
    registry: createModelRegistry({
      surface: 'codex',
      env: { MOON_RELAY_KERNEL_MODEL_REVIEW: 'gpt-5.6-sol' },
    }),
    controlPlane: { ingestReviewerOutcome: async () => {} },
    env: {},
  });

  assert.equal(readiness.status, 'BLOCKED');
  assert.ok(readiness.blockers.includes('review-independent-context-unavailable'));
  assert.equal(readiness.review.model, CODEX_EXECUTION_POLICY.review.model);
  assert.equal(readiness.review.effort, CODEX_EXECUTION_POLICY.review.effort);
  assert.equal(readiness.review.modelSource, 'codex-model-policy');
});

test('mcp next blocks before mutation when the Host cannot execute an independent review', async () => {
  const runId = 'mcp-host-review-blocked';
  const fixture = await prepareMcpReviewRun(runId);
  try {
    const bridge = createKernelHostReviewBridge({
      adapter: createClaudeAdapter(),
      registry: createModelRegistry({
        surface: 'claude',
        env: {
          MOON_RELAY_KERNEL_MODEL_FRONTIER: 'mcp-review-frontier',
          MOON_RELAY_KERNEL_MODEL_FRONTIER_EFFORT: 'high',
        },
      }),
      runtimeHome: fixture.runtimeHome,
      env: {},
    });
    const handler = createMcpBridgeHandler({ runtimeHome: fixture.runtimeHome, env: {}, hostBridge: bridge });
    const response = await handler({
      jsonrpc: '2.0',
      id: 23,
      method: 'tools/call',
      params: {
        name: 'kernel_next',
        arguments: { workspaceRoot: fixture.root, runId, surface: 'claude_app' },
      },
    });

    assert.equal(assertTestPresent(assertTestPresent(response).result).isError, false);
    const result = parseToolText(response);
    assert.equal(result.status, 'execution-readiness-blocked');
    assert.equal(assertTestRecord(result.executionReadiness).status, 'BLOCKED');
    assert.ok(assertTestArray(assertTestRecord(result.executionReadiness).blockers).includes('review-execution-unavailable'));
    assert.equal(assertTestRecord(result.action).type, 'blocked');

    // The report path must preserve the same readiness denial instead of
    // returning cp.report's unguarded next payload.
    const reportResponse = await handler({
      jsonrpc: '2.0',
      id: 24,
      method: 'tools/call',
      params: {
        name: 'kernel_report',
        arguments: {
          workspaceRoot: fixture.root,
          runId,
          report: { summary: 'retry review gate', changedPaths: ['app.mjs'] },
        },
      },
    });
    assert.equal(assertTestPresent(assertTestPresent(reportResponse).result).isError, false);
    const reported = parseToolText(reportResponse);
    assert.equal(assertTestRecord(reported.next).status, 'execution-readiness-blocked');

    const cp = await createKernelControlPlane({ runtimeHome: fixture.runtimeHome, projectRoot: fixture.root });
    try {
      assert.equal(cp.listReviewReceipts(runId).length, 0);
      assert.equal(assertTestPresent(cp.stateStore.getRun(runId)).state, 'PROVE');
    } finally {
      await cp.close();
    }
  } finally {
    await cleanupMcpReviewRun(fixture);
  }
});

type TestControlPlane = Awaited<ReturnType<typeof import('../src/host/kernel/control-plane-runtime.js').createKernelControlPlane>>;
type TestStateStore = Awaited<ReturnType<typeof import('../src/kernel/state-store.js').openKernelStateStore>>;


test('mcp Host carries recovery continuity across retries without model-supplied bookkeeping', async (t) => {
  t.after(async () => {
    await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
  });

  const workspaceRoot = await createFixtureRepo();
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-mcp-recovery-state-'));
  tempRoots.push(runtimeHome);
  const handler = createMcpBridgeHandler({ runtimeHome, env: {} });
  const invalidContract = {
    objective: 'exercise MCP recovery continuity',
    acceptance: ['change is valid'],
    steps: [
      {
        stepId: 'repair-step',
        objective: 'repair one file',
        allowedPaths: ['README.md'],
        acceptanceIds: ['AC-missing'],
      },
    ],
  };

  const diagnose = async (id: number) => {
    const response = await handler({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: {
        name: 'kernel_next',
        arguments: {
          workspaceRoot,
          runId: 'mcp-recovery-continuity',
          contractJson: invalidContract,
          surface: 'codex_app',
        },
      },
    });
    const payload = parseToolText(response);
    assert.equal(assertTestPresent(assertTestPresent(response).result).isError, true);
    return assertTestRecord(payload.recovery);
  };

  const attempts = [
    await diagnose(70),
    await diagnose(71),
    await diagnose(72),
    await diagnose(73),
  ];
  assert.deepEqual(attempts.map((entry) => entry.unchangedAttempts), [0, 1, 2, 3]);
  assert.equal(attempts[3].mode, 'escalate');
});

const startFixtureWorker = async (
  sessions: ReturnType<typeof createHostWorkerSessions>,
  projectRoot: string, runtimeHome: string, runId: string, objective: string,
) => {
  const cp = await createKernelControlPlane({ projectRoot, runtimeHome });
  try {
    const ensured = await cp.ensureRun({
      runId, objective,
      taskContract: { objective, acceptance: ['README is updated'], allowedPaths: ['README.md'] },
    });
    return await sessions.start({ projectRoot, runtimeHome, runId, model: 'test-model',
      effort: 'high', modelInput: assertTestRecord(ensured.next) });
  } finally {
    await cp.close();
  }
};

test('W1/W2: a second Main reads and interrupts the same Host-owned Attempt without re-running or delivering it', async (t) => {
  const workspaceRoot = await createFixtureRepo();
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-host-worker-mcp-'));
  const server = path.join(runtimeHome, 'mock-app-server.cjs');
  t.after(async () => {
    await Promise.all([workspaceRoot, runtimeHome].map(root => rm(root, { recursive: true, force: true })));
  });
  await writeFile(server, String.raw`
const readline = require('node:readline');
const send = (data) => process.stdout.write(JSON.stringify(data) + '\n');
const input = readline.createInterface({ input: process.stdin });
let thread = null;
let turn = null;
input.on('line', (line) => {
  const item = JSON.parse(line);
  if (item.method === 'initialize') send({ id: item.id, result: { userAgent: 'fixture' } });
  if (item.method === 'thread/start') {
    thread = 'thread-owned';
    send({ id: item.id, result: { thread: { id: thread } } });
  }
  if (item.method === 'turn/start') {
    turn = 'turn-owned';
    send({ id: item.id, result: { turn: { id: turn, status: 'inProgress' } } });
  }
  if (item.method === 'turn/interrupt') {
    if (item.params.threadId === thread && item.params.turnId === turn) {
      send({ id: item.id, result: {} });
      send({ method: 'turn/completed', params: { threadId: thread, turn: { id: turn, status: 'interrupted' } } });
    }
  }
});
`);
  const sessions = createHostWorkerSessions({
    transportOptions: { executable: process.execPath, args: [server], requestTimeoutMs: 1500 },
  });
  const handler = createMcpBridgeHandler({ runtimeHome, hostWorkerSessions: sessions });
  const otherHost = createMcpBridgeHandler({ runtimeHome });
  const runId = 'run-mcp-host-owned-worker';
  const call = (client: typeof handler, id: number, name: string, args: Record<string, unknown>) =>
    client({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: { workspaceRoot, runId, ...args } } });
  const defaultHost = createMcpBridgeHandler({ runtimeHome });
  const unknownSignalId = 'run-no-existing-host-worker';
  const unknownSignal = parseToolText(await call(handler, 190, 'kernel_attach', {
    runId: unknownSignalId,
    worker: { action: 'interrupt', attemptId: 'attempt-00000000-0000-0000-0000-000000000000' },
  }));
  assert.equal(unknownSignal.status, 'not_found', 'a signal must not create a new Run');
  const rejectedRunId = 'run-mcp-unverified-native-worker';
  const rejected = await call(defaultHost, 102, 'kernel_next', {
    runId: rejectedRunId,
    contractJson: { objective: 'implement README change', acceptance: ['README contains a new sentence'], allowedPaths: ['README.md'] },
    worker: { action: 'start', model: 'test-model', effort: 'high' },
  });
  assert.equal(parseToolText(rejected).code, 'host_worker_native_isolation_unverified');
  const verificationPlane = await createKernelControlPlane({ projectRoot: workspaceRoot, runtimeHome });
  try {
    assert.ok(!(await verificationPlane.getRun(rejectedRunId)), 'a rejected Worker start must not create a Run');
    assert.ok(!(await verificationPlane.getRun(unknownSignalId)), 'an unknown signal must not create a Run');
  } finally {
    await verificationPlane.close();
  }
  const started = assertTestRecord(await startFixtureWorker(sessions, workspaceRoot, runtimeHome, runId, 'implement README change'));
  assert.equal(started.runId, runId);
  const attemptId = assertTestString(started.attemptId);
  assert.equal(started.writerExitVerified, false);
  assert.equal(started.deliveryAuthorized, false);
  // A new Main attaches without preparing next or launching another Worker.
  // The same Host exposes the live handle, while a different Host can only
  // read the durable Attempt and must not claim live control.
  const attachedMain = parseToolText(await call(handler, 201, 'kernel_attach', {}));
  assert.equal(attachedMain.status, 'attached');
  assert.equal(assertTestRecord(attachedMain.liveWorker).attemptId, attemptId);
  assert.ok(assertTestArray(attachedMain.workerAttempts).some(item => assertTestRecord(item).attemptId === attemptId));
  const detachedMain = parseToolText(await call(otherHost, 202, 'kernel_attach', {}));
  assert.equal(detachedMain.status, 'attached');
  assert.equal(detachedMain.liveWorker, null);
  assert.ok(assertTestArray(detachedMain.workerAttempts).some(item => assertTestRecord(item).attemptId === attemptId));
  assert.equal(detachedMain.next, undefined, 'reattachment does not consume a next action');
  // W3: a new Main must not be handed the same executable Step while the
  // Host-owned Worker is still writing (including before Workspace bind).
  const inFlightNext = parseToolText(await call(otherHost, 105, 'kernel_next', {}));
  assert.equal(inFlightNext.status, 'worker-reconciliation-required');
  assert.equal(inFlightNext.errorCode, 'WORKER_RESULT_NOT_RECONCILED');
  assert.equal(inFlightNext.attemptId, attemptId);
  assert.equal(assertTestRecord(inFlightNext.action).type, 'blocked');
  assert.equal(inFlightNext.writerExitVerified, false);
  const immutable = await createKernelControlPlane({ projectRoot: workspaceRoot, runtimeHome });
  try {
    const before = await immutable.getRun(runId);
    const attemptCount = immutable.getHostRoutingSnapshot(runId).stepAttempts.length;
    await assert.rejects(immutable.ensureRun({
      runId,
      taskContract: {
        objective: 'change the scope while Worker is active',
        acceptance: ['different result'],
        allowedPaths: ['README.md'],
      },
    }), { code: 'host_worker_contract_revision_blocked' });
    const afterRevision = await immutable.getRun(runId);
    assert.equal(afterRevision?.contractRevision, before?.contractRevision);
    assert.equal(afterRevision?.planRevision, before?.planRevision);
    assert.equal(immutable.getHostRoutingSnapshot(runId).stepAttempts.length, attemptCount);
  } finally { await immutable.close(); }
  const startRequest = { projectRoot: workspaceRoot, runtimeHome, runId, model: 'test-model',
    effort: 'high', modelInput: inFlightNext };
  const sameHost = await sessions.start(startRequest);
  assert.equal(sameHost.attemptId, attemptId,
    'the original Host reattaches to its Attempt without a second Worker');
  await assert.rejects(createHostWorkerSessions().start(startRequest),
    { code: 'host_worker_previous_attempt_unreconciled' });
  const prematureReport = parseToolText(await call(otherHost, 103, 'kernel_report', {
    report: { summary: 'claiming a finished Worker', changedPaths: [] },
  }));
  assert.equal(prematureReport.status, 'worker-reconciliation-required');
  assert.equal(prematureReport.errorCode, 'WORKER_RESULT_NOT_RECONCILED');
  assert.equal(prematureReport.attemptId, attemptId);
  assert.ok(assertTestArray(parseToolText(await call(otherHost, 104, 'kernel_status', {})).workerAttempts)
    .some(item => assertTestRecord(item).attemptId === attemptId && assertTestRecord(item).provenanceKind === 'host-owned-worker'));
  assert.equal(prematureReport.writerExitVerified, false);
  assert.equal(prematureReport.next, null, 'an unverified Worker cannot advance report.next');
  const denied = await call(defaultHost, 101, 'kernel_next', {
    worker: { action: 'start', model: 'test-model', effort: 'high' },
  });
  assert.equal(assertTestRecord(assertTestRecord(denied).result).isError, true);
  assert.equal(parseToolText(denied).code, 'host_worker_native_isolation_unverified',
    'an ordinary product Host must never opt into unsafe Native Writer execution');

  let live: Record<string, unknown> = {};
  for (let i = 0; i < 30; i++) {
    const response = await call(handler, 110 + i, 'kernel_status', {});
    assert.equal(assertTestRecord(assertTestRecord(response).result).isError, false);
    const status = parseToolText(response);
    live = assertTestRecord(status.liveWorker);
    if (live.nativeTurn && assertTestRecord(live.nativeTurn).turnId === 'turn-owned') break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(live.nativeTurn && assertTestRecord(live.nativeTurn).turnId, 'turn-owned', JSON.stringify(live));
  const external = parseToolText(await call(otherHost, 150, 'kernel_status', {}));
  assert.equal(external.liveWorker, null, 'a different Host may not claim a live handle');
  assert.ok(assertTestArray(external.workerAttempts).some(item => assertTestRecord(item).attemptId === attemptId));

  const beforeSignal = await createKernelControlPlane({ projectRoot: workspaceRoot, runtimeHome });
  const revisionBeforeSignal = (await beforeSignal.getRun(runId))?.revision;
  await beforeSignal.close();
  const signaled = await call(handler, 151, 'kernel_attach', {
    worker: { action: 'interrupt', attemptId },
  });
  assert.equal(assertTestRecord(assertTestRecord(signaled).result).isError, false, JSON.stringify(signaled));
  assert.equal(assertTestRecord(parseToolText(signaled).hostWorkerSignal).status, 'requested');
  const afterSignal = await createKernelControlPlane({ projectRoot: workspaceRoot, runtimeHome });
  try {
    assert.equal((await afterSignal.getRun(runId))?.revision, revisionBeforeSignal,
      'signal-only attach must not advance the canonical Run');
  } finally { await afterSignal.close(); }
  let after = parseToolText(await call(handler, 152, 'kernel_status', {}));
  for (let i = 0; i < 20 && assertTestRecord(after.liveWorker).turnStatus === 'pending'; i++) {
    await new Promise(resolve => setTimeout(resolve, 20));
    after = parseToolText(await call(handler, 153 + i, 'kernel_status', {}));
  }
  assert.equal(assertTestRecord(after.liveWorker).turnStatus, 'interrupted');
  const lateReport = parseToolText(await call(otherHost, 174, 'kernel_report', {
    report: { summary: 'Turn ended, but OS Writer exit remains unknown', changedPaths: [] },
  }));
  assert.equal(lateReport.status, 'worker-reconciliation-required');
  assert.equal(lateReport.writerExitVerified, false);
  assert.equal(lateReport.next, null);
  const stillUnreconciled = parseToolText(await call(otherHost, 175, 'kernel_next', {}));
  assert.equal(stillUnreconciled.status, 'worker-reconciliation-required',
    'interrupting a Turn cannot authorize re-execution of an unknown Writer');
  assert.equal(assertTestRecord(stillUnreconciled.action).type, 'blocked');
  assert.equal(assertTestRecord(assertTestRecord(after.liveWorker).completedTurn).threadId, 'thread-owned');
  assert.equal(assertTestRecord(assertTestRecord(after.liveWorker).completedTurn).turnId, 'turn-owned');
  assert.equal(assertTestRecord(assertTestRecord(after.liveWorker).completedTurn).turnStatus, 'interrupted');
  assert.equal(assertTestRecord(after.liveWorker).writerExitVerified, false);
  assert.ok(assertTestArray(after.workerAttempts).some(item =>
    assertTestRecord(item).attemptId === attemptId && assertTestRecord(item).status === 'started'),
  'MCP Turn interrupt cannot finish or deliver the Kernel Attempt');
  const blocked = await call(otherHost, 180, 'kernel_next', {
    worker: { action: 'start', model: 'test-model', effort: 'high' },
  });
  assert.equal(assertTestRecord(assertTestRecord(blocked).result).isError, true,
    'a new Host must not start a second Worker after losing its process-local handle');
});


test('W2: same Host coalesces concurrent Worker start calls into one canonical Attempt', async (t) => {
  const workspaceRoot = await createFixtureRepo();
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-worker-coalesce-'));
  const server = path.join(runtimeHome, 'mock-app-server.cjs');
  t.after(async () => {
    await Promise.all([workspaceRoot, runtimeHome].map(root => rm(root, { recursive: true, force: true })));
  });
  await writeFile(server, String.raw`
const readline = require('node:readline');
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const input = readline.createInterface({ input: process.stdin });
input.on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') send({ id: message.id, result: { userAgent: 'fixture' } });
  if (message.method === 'thread/start') send({ id: message.id, result: { thread: { id: 'thread-once' } } });
  if (message.method === 'turn/start') {
    const threadId = message.params.threadId;
    send({ id: message.id, result: { turn: { id: 'turn-once', status: 'inProgress' } } });
    for (let i = 0; i < 33; i++) {
      send({ method: 'item/started', params: {
        threadId, turnId: 'turn-once', item: {
          type: 'commandExecution', id: 'item-' + i,
          processId: i === 32 ? 'sk-proj-fixtureevent0123456789' : 'provider-' + i,
          aggregatedOutput: 'raw-provider-output-not-for-status',
        },
      } });
    }
    send({ method: 'item/started', params: {
      threadId, turnId: 'other-turn', item: { type: 'commandExecution', id: 'other-item' },
    } });
  }
  if (message.method === 'turn/interrupt') {
    send({ id: message.id, result: {} });
    send({ method: 'turn/completed', params: { threadId: message.params.threadId, turn: { id: message.params.turnId, status: 'interrupted' } } });
  }
});
`);
  const runId = 'run-coalesced-host-worker';
  const cp = await createKernelControlPlane({ runtimeHome, projectRoot: workspaceRoot });
  try {
    const registration = {
      name: 'kernel_next', runtimeHome,
      parameters: {
        workspaceRoot, runId,
        contractJson: { objective: 'update README', acceptance: ['README updated'], allowedPaths: ['README.md'] },
        worker: { action: 'start' as const, model: 'test-model', effort: 'high' },
      },
    };
    assert.deepEqual(await handleMcpToolCall(registration), { runId });
    assert.equal((await cp.getRun(runId))?.objective, 'update README');
    const modelInput = assertTestRecord(await cp.next(runId));
    assert.equal(assertTestRecord(modelInput.action).type, 'implement');
    const sessions = createHostWorkerSessions({
      transportOptions: { executable: process.execPath, args: [server], requestTimeoutMs: 1500 },
    });
    const request = { projectRoot: workspaceRoot, runtimeHome, runId, model: 'test-model', effort: 'high', modelInput };
    const originalStep = assertTestPresent(cp.getCurrentStep(runId));
    const runBeforeClaim = assertTestPresent(await cp.getRun(runId));
    const binding = {
      stepId: originalStep.stepId, provenanceKind: 'host-owned-worker',
      expectedContractRevision: runBeforeClaim.contractRevision,
      planRevision: runBeforeClaim.planRevision, mutationRevision: runBeforeClaim.mutationRevision,
    };
    for (const field of ['expectedContractRevision', 'planRevision', 'mutationRevision'] as const) {
      assert.throws(() => cp.beginAttempt(runId, { ...binding, [field]: binding[field] + 1 }),
        { code: 'STEP_ATTEMPT_REVISION_STALE' });
      assert.deepEqual(cp.getCurrentStep(runId), originalStep, 'a rejected claim cannot change the Step');
      assert.equal(cp.getHostRoutingSnapshot(runId).stepAttempts.length, 0);
    }
    const authority = assertTestRecord(modelInput.workAuthority);
    const staleDirective = {
      ...modelInput, workAuthority: {
        ...authority,
        task: { ...assertTestRecord(authority.task), contractRevision: runBeforeClaim.contractRevision + 1 },
      },
    };
    await assert.rejects(sessions.start({ ...request, modelInput: staleDirective }),
      { code: 'host_worker_continuation_stale' });
    assert.equal(await sessions.status(workspaceRoot, runtimeHome, runId), null);
    assert.deepEqual(cp.getCurrentStep(runId), originalStep);
    assert.equal(cp.getHostRoutingSnapshot(runId).stepAttempts.length, 0);
    const [left, right] = await Promise.all([sessions.start(request), sessions.start(request)]);
    const contender = await createKernelControlPlane({ runtimeHome, projectRoot: workspaceRoot });
    try {
      assert.throws(() => contender.beginAttempt(runId, binding), { code: 'STEP_ATTEMPT_ALREADY_CLAIMED' });
    } finally {
      await contender.close();
    }
    assert.equal(left.attemptId, right.attemptId);
    assert.equal(cp.getHostRoutingSnapshot(runId).stepAttempts.length, 1, 'no duplicate canonical Attempt');
    await assert.rejects(sessions.start({ ...request, model: 'conflicting-model' }), /host_worker_start_conflict/);
    const otherRuntime = await mkdtemp(path.join(os.tmpdir(), 'kernel-other-runtime-'));
    t.after(() => rm(otherRuntime, { recursive: true, force: true }));
    assert.equal(await sessions.status(workspaceRoot, otherRuntime, runId), null,
      'a shared Host must not attach to a different Kernel Runtime with the same Run ID');
    assert.equal((await sessions.interrupt(workspaceRoot, otherRuntime, runId, left.attemptId)).status, 'not-attached');
    // Two separate MCP client streams share only the owning Host's existing
    // WorkerSessions. Closing one Main stream must not close its live Worker.
    const connectMain = () => {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const service = startMcpBridgeServer({ stdin, stdout, runtimeHome, hostWorkerSessions: sessions });
      return {
        call: (id: number, name: string, extra: Record<string, unknown> = {}) => {
          const response = new Promise<unknown>((resolve, reject) => {
            let buffer = '';
            const onData = (chunk: Buffer) => {
              buffer += chunk.toString('utf8');
              const end = buffer.indexOf('\n');
              if (end < 0) return;
              stdout.off('data', onData);
              try { resolve(JSON.parse(buffer.slice(0, end))); } catch (error) { reject(error); }
            };
            stdout.on('data', onData);
          });
          stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call',
            params: { name, arguments: { workspaceRoot, runId, ...extra } } }) + '\n');
          return response;
        },
        close: () => { service.close(); stdin.destroy(); stdout.destroy(); },
      };
    };
    let readback = (await sessions.status(workspaceRoot, runtimeHome, runId))?.commandEventReadback;
    for (let n = 0; n < 100 && readback?.observedCount !== 33; n++) {
      await new Promise(resolve => setTimeout(resolve, 10));
      readback = (await sessions.status(workspaceRoot, runtimeHome, runId))?.commandEventReadback;
    }
    assert.ok(readback);
    assert.equal(readback.scope, 'current-host-attempt');
    assert.equal(readback.observedCount, 33);
    assert.equal(readback.omittedCount, 1);
    assert.equal(readback.events.length, 32);
    assert.equal(readback.events[0]?.itemId, 'item-1');
    assert.equal(readback.events.at(-1)?.itemId, 'item-32');
    assert.ok(readback.events.every(event =>
      event.attemptId === left.attemptId && event.threadId === 'thread-once' && event.turnId === 'turn-once'));
    assert.ok(readback.events.at(-1)?.processId?.includes('[REDACTED]'));

    const originalMain = connectMain();
    const original = parseToolText(await originalMain.call(99, 'kernel_attach'));
    assert.equal(assertTestRecord(original.liveWorker).attemptId, left.attemptId);
    assert.deepEqual(assertTestRecord(original.liveWorker).commandEventReadback, readback);
    originalMain.close();
    const replacementMain = connectMain();
    const observed = parseToolText(await replacementMain.call(100, 'kernel_attach'));
    assert.equal(assertTestRecord(observed.liveWorker).attemptId, left.attemptId);
    assert.deepEqual(assertTestRecord(observed.liveWorker).commandEventReadback, readback);
    const response = JSON.stringify(observed);
    assert.ok(!response.includes('raw-provider-output-not-for-status'));
    assert.ok(!response.includes('sk-proj-fixtureevent0123456789'));
    assert.ok(!response.includes('other-item'));
    assert.equal(observed.next, undefined);
    assert.equal(cp.getHostRoutingSnapshot(runId).stepAttempts.length, 1);
    const beforeRetry = await cp.getRun(runId);
    assert.deepEqual(await handleMcpToolCall(registration), { runId });
    await assert.rejects(handleMcpToolCall({
      ...registration,
      parameters: {
        ...registration.parameters,
        contractJson: { ...registration.parameters.contractJson, acceptance: ['Change the running scope'] },
      },
    }), { code: 'host_worker_contract_revision_blocked' });
    const retried = parseToolText(await replacementMain.call(102, 'kernel_next', {
      worker: { action: 'start', model: 'test-model', effort: 'high' },
    }));
    assert.equal(retried.status, 'host-worker-attached');
    assert.equal(assertTestRecord(retried.hostWorker).attemptId, left.attemptId);
    assert.equal(retried.action, undefined);
    assert.equal(retried.next, undefined);
    const differentlyBoundMain = createMcpBridgeHandler({
      runtimeHome, hostWorkerSessions: sessions,
      env: { ...process.env, MOON_RELAY_KERNEL_RUN_ID: 'different-bound-run' },
    });
    const conflict = parseToolText(await differentlyBoundMain({
      jsonrpc: '2.0', id: 103, method: 'tools/call', params: {
        name: 'kernel_next', arguments: {
          workspaceRoot, runId, worker: { action: 'start', model: 'test-model', effort: 'high' },
        },
      },
    }));
    assert.equal(conflict.code, 'run_binding_conflict');
    assert.equal((await cp.getRun(runId))?.revision, beforeRetry?.revision);
    assert.equal((await cp.getRun(runId))?.mutationRevision, beforeRetry?.mutationRevision);
    assert.equal((await cp.getRun(runId))?.contractRevision, beforeRetry?.contractRevision);
    assert.equal(cp.getHostRoutingSnapshot(runId).stepAttempts.length, 1);
    // The replacement Main cancels the same Turn after observing its events.
    const signaled = parseToolText(await replacementMain.call(101, 'kernel_attach', {
      worker: { action: 'interrupt', attemptId: left.attemptId },
    }));
    replacementMain.close();
    assert.equal(assertTestRecord(signaled.hostWorkerSignal).status, 'requested');
    assert.equal(cp.getHostRoutingSnapshot(runId).stepAttempts.length, 1);
    let live = await sessions.status(workspaceRoot, runtimeHome, runId);
    for (let n = 0; n < 100 && live?.turnStatus === 'pending'; n++) {
      await new Promise(resolve => setTimeout(resolve, 10));
      live = await sessions.status(workspaceRoot, runtimeHome, runId);
    }
    assert.equal(live?.completedTurn?.threadId, 'thread-once');
    assert.equal(live?.completedTurn?.turnId, 'turn-once');
    assert.equal(live?.completedTurn?.turnStatus, 'interrupted');
    assert.equal(live?.preflight?.status, 'blocked');
    assert.equal(live?.preflight?.failureCode, 'host_worker_turn_not_completed');
    assert.equal(live?.resultCandidate, null);
    assert.equal(live?.writerExitVerified, false);
    assert.equal(live?.deliveryAuthorized, false);
    assert.equal(cp.getHostRoutingSnapshot(runId).stepAttempts[0]?.status, 'started');
  } finally {
    await cp.close();
  }
});


test('W3: Host-owned Worker source delta is observable by a different Main without false Owner Delivery', async (t) => {
  const workspaceRoot = await createFixtureRepo();
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-worker-result-'));
  const server = path.join(runtimeHome, 'mock-app-server.cjs');
  t.after(async () => {
    await Promise.all([workspaceRoot, runtimeHome].map(root => rm(root, { recursive: true, force: true })));
  });
  await writeFile(server, String.raw`
const readline = require('node:readline');
const fs = require('node:fs');
const path = require('node:path');
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
const input = readline.createInterface({ input: process.stdin });
input.on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') send({ id: message.id, result: { userAgent: 'fixture' } });
  if (message.method === 'thread/start') send({ id: message.id, result: { thread: { id: 'thread-write' } } });
  if (message.method === 'turn/start') {
    if (message.params.sandboxPolicy.type !== 'workspaceWrite') throw Error('fixture is not writable');
    fs.writeFileSync(path.join(message.params.cwd, 'README.md'), '# Updated by Host Worker\n');
    send({ id: message.id, result: { turn: { id: 'turn-write', status: 'inProgress' } } });
    setTimeout(() => send({ method: 'turn/completed', params: {
      threadId: message.params.threadId, turn: { id: 'turn-write', status: 'completed' },
    } }), 10);
  }
});
`);
  const runId = 'run-host-worker-result';
  const sessions = createHostWorkerSessions({
    transportOptions: { executable: process.execPath, args: [server], requestTimeoutMs: 1500 },
  });
  const host = createMcpBridgeHandler({ runtimeHome, hostWorkerSessions: sessions });
  const independentMain = (id: number, name: string, extra: Record<string, unknown> = {}) =>
    host({ jsonrpc: '2.0', id, method: 'tools/call', params: {
      name, arguments: { workspaceRoot, runId, ...extra },
    } });
  const { attemptId } = await startFixtureWorker(sessions, workspaceRoot, runtimeHome, runId, 'update README');
  let status = parseToolText(await independentMain(2, 'kernel_status'));
  for (let n = 0; n < 80 && assertTestRecord(status.liveWorker).turnStatus === 'pending'; n++) {
    await new Promise(resolve => setTimeout(resolve, 20));
    status = parseToolText(await independentMain(3 + n, 'kernel_status'));
  }
  const live = assertTestRecord(status.liveWorker);
  assert.equal(live.turnStatus, 'completed');
  assert.equal(assertTestRecord(live.completedTurn).turnId, 'turn-write');
  const candidate = assertTestRecord(live.resultCandidate);
  assert.deepEqual(candidate.changedPaths, ['README.md']);
  assert.deepEqual(candidate.outsideStepScope, []);
  assert.match(assertTestString(candidate.workspaceIdentity), /^sha256:/);
  assert.match(assertTestString(candidate.patchDigest), /^sha256:[a-f\d]{64}$/);
  assert.equal(candidate.ownerApplyCheck, 'passed');
  assert.ok(!JSON.stringify(live).includes('diff --git'), 'raw patch bytes stay Host-private');
  // The Host automatically handles pre-delivery proof selection. It does not
  // turn an unsupported Native isolation environment into Owner delivery.
  let preflight = optionalTestRecord(live.preflight);
  for (let n = 0; n < 40 && !preflight; n++) {
    await new Promise(resolve => setTimeout(resolve, 20));
    preflight = optionalTestRecord(assertTestRecord(parseToolText(await independentMain(100 + n, 'kernel_status')).liveWorker).preflight);
  }
  assert.ok(preflight && typeof preflight.status === 'string');
  assert.notEqual(preflight.status, 'delivered');
  assert.equal(candidate.writerExitVerified, false);
  assert.equal(candidate.deliveryAuthorized, false);
  assert.equal(await readFile(path.join(workspaceRoot, 'README.md'), 'utf8'), '# Bridge Fixture\n',
    'the Owner repository remains unchanged until verified Delivery');
  const cp = await createKernelControlPlane({ projectRoot: workspaceRoot, runtimeHome });
  try {
    const attempt = cp.getAttemptById(runId, attemptId);
    assert.equal(attempt?.status, 'started');
    assert.equal(attempt?.resultCommitSha, null);
    assert.notEqual(cp.getCurrentStep(runId)?.state, 'passed');
  } finally { await cp.close(); }
  const next = parseToolText(await independentMain(90, 'kernel_next'));
  assert.equal(next.status, 'worker-reconciliation-required');
  assert.equal(next.attemptId, attemptId);
});

test('A2-1: Host result handoff survives Main replacement without secret exposure, Delivery flags or a new Attempt', async (t) => {
  const workspaceRoot = await createFixtureRepo();
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-host-result-handoff-'));
  const server = path.join(runtimeHome, 'finite-writer.cjs');
  const reportSecret = 'sk-proj-fixtureworkerreport123456';
  const patchMarker = 'worker-patch-content-not-for-status';
  t.after(async () => {
    await Promise.all([workspaceRoot, runtimeHome].map(root => rm(root, { recursive: true, force: true })));
  });
  // Finite fixture: one synchronous write and JSON notifications, no tools or
  // descendants. No Native isolation or Writer exit capability is asserted.
  await writeFile(server, String.raw`
const fs = require('node:fs');
const path = require('node:path');
const send = value => process.stdout.write(JSON.stringify(value)+'\n');
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const message = JSON.parse(line);
  if(message.method==='initialize') send({id:message.id,result:{}});
  if(message.method==='thread/start') send({id:message.id,result:{thread:{id:'host-result-thread'}}});
  if(message.method==='turn/start') {
    if(!message.params.outputSchema) throw Error('missing Worker schema');
    fs.writeFileSync(path.join(message.params.cwd,'README.md'),process.argv[3] + '\n');
    send({id:message.id,result:{turn:{id:'host-result-turn',status:'inProgress'}}});
    send({method:'item/completed',params:{threadId:message.params.threadId,turnId:'host-result-turn',
      item:{type:'agentMessage',id:'worker-final',phase:'final_answer',text:JSON.stringify({
        status:'completed',summary:'Worker changed README ' + process.argv[2],changedPaths:['README.md'],risks:[],
        verifications:[{obligationId:'default',commandRef:'test',acceptanceCoverage:['AC-1']}],
        requestedVerifications:[],judgments:[],knowledgeObservations:[],blocker:null,
      })}}});
    send({method:'turn/completed',params:{threadId:message.params.threadId,turn:{id:'host-result-turn',status:'completed'}}});
  }
});
`);
  const sessions = createHostWorkerSessions({ transportOptions: {
    executable: process.execPath, args: [server, reportSecret, patchMarker], requestTimeoutMs: 1500,
  } });
  const firstMain = createMcpBridgeHandler({ runtimeHome, hostWorkerSessions: sessions });
  const secondMain = createMcpBridgeHandler({ runtimeHome, hostWorkerSessions: sessions });
  const runId = 'run-durable-host-handoff';
  const call = (handler: ReturnType<typeof createMcpBridgeHandler>, id: number, name: string, extra: Record<string, unknown> = {}) =>
    handler({ jsonrpc: '2.0', id, method: 'tools/call', params: {
      name, arguments: { workspaceRoot, runId, ...extra },
    } });
  const next = parseToolText(await call(firstMain, 1, 'kernel_next', {
    contractJson: { objective: 'Host candidate only', acceptance: ['README updated'], allowedPaths: ['README.md'] },
  }));
  // Invoke the production Host composition boundary directly. The public MCP
  // Native start gate stays closed; the test supplies no capability booleans.
  const started = await sessions.start({ projectRoot: workspaceRoot, runtimeHome, runId,
    model: 'test-model', effort: 'high', modelInput: next });
  let live: Record<string, unknown> = {};
  for (let n = 0; n < 100; n++) {
    const status = parseToolText(await call(secondMain, n + 2, 'kernel_status'));
    const response = JSON.stringify(status);
    assert.ok(!response.includes(reportSecret));
    assert.ok(!response.includes(patchMarker));
    live = assertTestRecord(status.liveWorker);
    if (live.preflight && optionalTestRecord(live.preflight)?.status !== 'running') break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.deepEqual(live.resultHandoff, { status: 'recorded', failureCode: null });
  assert.equal(live.attemptId, started.attemptId);
  assert.equal(live.writerExitVerified, false);
  assert.equal(live.deliveryAuthorized, false);
  const reader = await createKernelControlPlane({ projectRoot: workspaceRoot, runtimeHome });
  try {
    const attempt = assertTestPresent(reader.getAttemptById(runId, started.attemptId));
    assert.equal(attempt.status, 'started');
    assert.equal(attempt.resultCommitSha, assertTestRecord(live.resultCandidate).resultCommitSha);
    const summary = assertTestString(assertTestRecord(attempt.workerReport).summary);
    assert.match(summary, /^Worker changed README /u);
    assert.ok(summary.includes('[REDACTED]'));
    assert.ok(!summary.includes(reportSecret));
    assert.equal(assertTestRecord(attempt.workerReport).attemptId, started.attemptId);
    assert.equal(reader.getCurrentStep(runId)?.executionWorkspaceId, attempt.workspaceId);
    assert.equal(reader.stateStore.getMutationProvenance(runId), null);
    assert.equal(attempt.reportResult, null);
    assert.equal((await reader.getRun(runId))?.mutationRevision, 0);
    const exactReceipt = { attemptId: started.attemptId, executionWorkspaceId: attempt.workspaceId,
      expectedContractRevision: (await reader.getRun(runId))!.contractRevision,
      mutationRevision: attempt.mutationRevision, resultCommitSha: attempt.resultCommitSha,
      resultWorkspaceIdentity: attempt.resultWorkspaceIdentity, patchDigest: attempt.patchDigest,
      changedPaths: attempt.changedPaths, workerReport: attempt.workerReport, recordMutationProvenance: false };
    reader.recordStepResult(runId, attempt.stepId, exactReceipt);
    assert.throws(() => reader.recordStepResult(runId, attempt.stepId, { ...exactReceipt, patchDigest: 'sha256:forged' }),
      { code: 'STEP_RESULT_IMMUTABLE_CONFLICT' });
    assert.throws(() => reader.recordStepResult(runId, attempt.stepId, { ...exactReceipt, expectedContractRevision: 0 }),
      { code: 'host_worker_result_lineage_changed' });
    assert.deepEqual(reader.getAttemptById(runId, started.attemptId), attempt, 'replay and rejected changes leave the receipt intact');
  } finally { await reader.close(); }
  const attached = parseToolText(await call(secondMain, 120, 'kernel_attach'));
  const attachedResponse = JSON.stringify(attached);
  assert.ok(attachedResponse.includes(started.attemptId));
  assert.ok(!attachedResponse.includes(reportSecret));
  assert.ok(!attachedResponse.includes(patchMarker));
  const rejected = parseToolText(await call(secondMain, 121, 'kernel_report', { report: {
    summary: 'premature settlement', attemptId: started.attemptId, changedPaths: ['README.md'],
  } }));
  assert.equal(rejected.status, 'worker-reconciliation-required');
  const continuation = parseToolText(await call(secondMain, 122, 'kernel_next'));
  const reused = await sessions.start({ projectRoot: workspaceRoot, runtimeHome, runId,
    model: 'test-model', effort: 'high', modelInput: continuation });
  assert.equal(reused.attemptId, started.attemptId);
  assert.equal(await readFile(path.join(workspaceRoot, 'README.md'), 'utf8'), '# Bridge Fixture\n');
  // The existing recovery path must recognize the durable Host candidate as
  // well as routed parallel receipts. An ambiguous Owner change cannot cause
  // a new Worker or a second apply on reconnect.
  await writeFile(path.join(workspaceRoot, 'README.md'), '# Unexplained Owner change\n');
  const recoveryReader = await createKernelControlPlane({ projectRoot: workspaceRoot, runtimeHome });
  try {
    const recovered = await recoveryReader.recoverPendingDeliveryMaterialization(runId);
    assert.equal(recovered.status, 'blocked');
    assert.equal((await recoveryReader.getRun(runId))?.blockedReason, 'delivery_materialization_recovery_required');
    assert.equal((await recoveryReader.getRun(runId))?.mutationRevision, 0);
    assert.equal(recoveryReader.getHostRoutingSnapshot(runId).stepAttempts.length, 1);
    assert.equal(recoveryReader.getAttemptById(runId, started.attemptId)?.reportResult, null);
    assert.equal(recoveryReader.getAttemptById(runId, started.attemptId)?.status, 'started');
  } finally { await recoveryReader.close(); }
});

test('W1: failed Host Turn exposes blocked preflight without re-execution or false Writer retirement', async (t) => {
  const workspaceRoot = await createFixtureRepo();
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-worker-failed-turn-'));
  const server = path.join(runtimeHome, 'fail-turn.cjs');
  t.after(async () => {
    await Promise.all([workspaceRoot, runtimeHome].map(root => rm(root, { recursive: true, force: true })));
  });
  await writeFile(server, String.raw`
const readline = require('node:readline');
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const item = JSON.parse(line);
  if (item.method === 'initialize') send({ id: item.id, result: { userAgent: 'fixture' } });
  if (item.method === 'thread/start') send({ id: item.id, result: { thread: { id: 'thread-failed' } } });
  if (item.method === 'turn/start') process.exit(21);
});
`);
  const runId = 'run-host-failed-turn';
  const sessions = createHostWorkerSessions({
    transportOptions: { executable: process.execPath, args: [server], requestTimeoutMs: 1500 },
  });
  const handler = createMcpBridgeHandler({ runtimeHome, hostWorkerSessions: sessions });
  const call = (id: number, name: string, args: Record<string, unknown> = {}) =>
    handler({ jsonrpc: '2.0', id, method: 'tools/call', params: {
      name, arguments: { workspaceRoot, runId, ...args },
    } });
  const { attemptId } = await startFixtureWorker(sessions, workspaceRoot, runtimeHome, runId, 'change README');
  let live: Record<string, unknown> = {};
  for (let i = 0; i < 100; i++) {
    const status = parseToolText(await call(2 + i, 'kernel_status'));
    live = assertTestRecord(status.liveWorker);
    if (optionalTestRecord(live.preflight)?.failureCode === 'host_worker_turn_unknown') break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(live.turnStatus, 'unknown');
  assert.equal(assertTestRecord(live.preflight).status, 'blocked');
  assert.equal(assertTestRecord(live.preflight).failureCode, 'host_worker_turn_unknown');
  assert.equal(live.writerExitVerified, false);
  assert.equal(live.deliveryAuthorized, false);
  assert.equal(assertTestRecord(parseToolText(await call(200, 'kernel_next'))).attemptId, attemptId);
  const plane = await createKernelControlPlane({ projectRoot: workspaceRoot, runtimeHome });
  try {
    assert.equal(plane.getHostRoutingSnapshot(runId).stepAttempts.length, 1);
    assert.equal(plane.getAttemptById(runId, attemptId)?.status, 'started');
  } finally { await plane.close(); }
});

test('Owner-direct MCP: fresh Main reuses report.next across three Steps, fixes proof and refreshes stale evidence', async (t) => {
  const workspaceRoot = await createFixtureRepo();
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-mcp-3step-resume-'));
  t.after(async () => {
    await Promise.all([workspaceRoot, runtimeHome].map(root => rm(root, { recursive: true, force: true })));
  });
  const runId = 'run-mcp-3step-resume';
  const cp = await createKernelControlPlane({ projectRoot: workspaceRoot, runtimeHome });
  const names = ['README.md', 'second.md', 'third.md'];
  // The trusted manifest command must fail on the actual third-step bytes.
  // Missing acceptanceCoverage alone is an incomplete claim, not a failed
  // proof; this fixture exercises a genuine Kernel-executed test failure.
  await writeFile(path.join(workspaceRoot, 'proof-check.cjs'), String.raw`const fs = require('node:fs');
if (fs.existsSync('third.md') && !fs.readFileSync('third.md', 'utf8').includes('Completed third step')) process.exit(9);
`);
  await writeFile(path.join(workspaceRoot, 'package.json'), JSON.stringify({
    name: 'three-step-fixture', scripts: { test: 'node proof-check.cjs' },
  }));
  assert.equal(spawnSync('git', ['add', 'package.json', 'proof-check.cjs'], { cwd: workspaceRoot }).status, 0);
  assert.equal(spawnSync('git', ['commit', '-m', 'trusted fixture verification', '--quiet'], { cwd: workspaceRoot }).status, 0);
  const obligations = ['first-proof', 'second-proof', 'third-proof'];
  const acceptances = ['first change', 'second change', 'third change'];
  let stepIds: string[];
  try {
    await cp.startRun({ runId, objective: 'Complete three independently verifiable changes',
      taskContract: {
        complex: true,
        acceptance: acceptances.map((acceptance, i) => ({
          acceptance,
          evidencePlan: { class: 'hard', method: 'unit-test', commandRefs: ['test'], obligationId: obligations[i] },
        })),
        steps: names.map((name, i) => ({
          objective: 'Modify ' + name, allowedPaths: [name],
          acceptanceIds: ['AC-' + (i + 1)], obligationIds: [obligations[i]],
        })),
      },
    });
    stepIds = cp.getRunSteps(runId).map(row => row.stepId);
    assert.equal(stepIds.length, 3);
  } finally { await cp.close(); }

  const host = createMcpBridgeHandler({ runtimeHome });
  const freshHost = createMcpBridgeHandler({ runtimeHome });
  const call = (client: typeof host, id: number, name: string, args: Record<string, unknown> = {}) =>
    client({ jsonrpc: '2.0', id, method: 'tools/call', params: {
      name, arguments: { workspaceRoot, runId, ...args },
    } });
  const next = parseToolText(await call(host, 1, 'kernel_next'));
  assert.equal(assertTestRecord(assertTestRecord(next.action).step).stepId, stepIds[0]);

  const report = async (client: typeof host, id: number, index: number) => {
    const claimed = {
      stepId: stepIds[index], summary: 'Implemented ' + names[index],
      changedPaths: [names[index]],
      verifications: [{
        obligationId: obligations[index], commandRef: 'test',
        acceptanceCoverage: ['AC-' + (index + 1)],
      }],
    };
    return parseToolText(await call(client, id, 'kernel_report', { report: claimed }));
  };

  await writeFile(path.join(workspaceRoot, names[0]), '# Step one complete\n');
  const first = await report(host, 2, 0);
  assert.equal(assertTestRecord(first.step).state, 'passed', JSON.stringify(first));
  assert.equal(assertTestRecord(assertTestRecord(first.next).action).type, 'implement');
  assert.equal(assertTestRecord(assertTestRecord(assertTestRecord(first.next).action).step).stepId, stepIds[1]);

  // A separate Main handler reconnects to the same Runtime; the original
  // Host process is not killed. It restores authority without a second next.
  const reattached = parseToolText(await call(freshHost, 3, 'kernel_attach'));
  const status = parseToolText(await call(freshHost, 4, 'kernel_status'));
  assert.equal(reattached.runId, runId);
  assert.equal(reattached.next, undefined);
  assert.equal(assertTestRecord(reattached.currentStep).stepId, stepIds[1]);
  assert.deepEqual(reattached.resume, status.resume);
  assert.deepEqual(reattached.workAuthority, status.workAuthority);
  assert.deepEqual(reattached.trustAuthority, status.trustAuthority);
  assert.equal(assertTestRecord(assertTestRecord(reattached.resume).implementation).mutationRevision,
    assertTestRecord(assertTestRecord(status.resume).implementation).mutationRevision);
  const check = await createKernelControlPlane({ projectRoot: workspaceRoot, runtimeHome });
  try {
    assert.equal(check.getHostRoutingSnapshot(runId).stepAttempts.length, 1);
    assert.equal(check.getCurrentStep(runId)?.stepId, stepIds[1]);
  } finally { await check.close(); }

  await writeFile(path.join(workspaceRoot, names[1]), 'Step two complete\n');
  const second = await report(freshHost, 5, 1);
  assert.equal(assertTestRecord(second.step).state, 'passed', JSON.stringify(second));
  assert.equal(assertTestRecord(assertTestRecord(assertTestRecord(second.next).action).step).stepId, stepIds[2]);

  await writeFile(path.join(workspaceRoot, names[2]), 'Incomplete third step\n');
  const failed = await report(freshHost, 6, 2);
  assert.equal(failed.status, 'evidence-failed', JSON.stringify(failed));
  assert.equal(assertTestRecord(assertTestRecord(failed.next).action).type, 'fix', JSON.stringify(failed));
  assert.equal(assertTestRecord(assertTestRecord(assertTestRecord(failed.next).action).step).stepId, stepIds[2]);

  await writeFile(path.join(workspaceRoot, names[2]), 'Completed third step after proof failure\n');
  const finalStep = await report(freshHost, 7, 2);
  assert.equal(assertTestRecord(finalStep.step).state, 'passed', JSON.stringify(finalStep));
  // Mutations in later Steps legitimately stale earlier hard proofs. Re-run
  // only those original obligations on the final workspace, not another Step.
  assert.equal(finalStep.status, 'in-progress');
  const pendingProofs = assertTestArray(assertTestRecord(assertTestRecord(finalStep.next).verification).pending);
  assert.deepEqual([...pendingProofs].sort(), obligations.slice(0, 2).sort());
  const completed = parseToolText(await call(freshHost, 8, 'kernel_report', {
    report: {
      summary: 'Revalidate prior hard acceptance on the final workspace',
      verifications: [0, 1].map(index => ({
        obligationId: obligations[index], commandRef: 'test',
        acceptanceCoverage: ['AC-' + (index + 1)],
      })),
    },
  }));
  assert.equal(completed.status, 'completed', JSON.stringify(completed));
  assert.equal(assertTestRecord(assertTestRecord(completed.next).action).type, 'done');
  const finalPlane = await createKernelControlPlane({ projectRoot: workspaceRoot, runtimeHome });
  try {
    assert.equal((await finalPlane.getRun(runId))?.status, 'completed');
    assert.equal(finalPlane.getHostRoutingSnapshot(runId).stepAttempts.length, 4);
  } finally { await finalPlane.close(); }
});

test('G2: independent MCP server processes reattach read-only without advancing the canonical Run', async (t) => {
  const workspaceRoot = await createFixtureRepo();
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-mcp-process-reattach-'));
  t.after(async () => {
    await Promise.all([workspaceRoot, runtimeHome].map(root => rm(root, { recursive: true, force: true })));
  });
  const runId = 'run-independent-main-reattach';
  const cp = await createKernelControlPlane({ projectRoot: workspaceRoot, runtimeHome });
  let beforeStatus: Record<string, unknown>;
  let originalRevision: number | undefined;
  try {
    await cp.ensureRun({ runId, objective: 'Keep the original contract and evidence across Main process replacement',
      taskContract: {
        objective: 'Keep the original contract and evidence across Main process replacement',
        acceptance: ['README remains within its allowed scope'],
        allowedPaths: ['README.md'],
        forbiddenPaths: ['private.txt'],
      },
    });
    beforeStatus = assertTestRecord(await cp.status(runId));
    originalRevision = (await cp.getRun(runId))?.revision;
    assert.equal(cp.getHostRoutingSnapshot(runId).stepAttempts.length, 0);
  } finally { await cp.close(); }

  const invokeInNewProcess = (id: number, name: string) => {
    const input = JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call',
      params: { name, arguments: { workspaceRoot, runId } },
    }) + '\n';
    const child = spawnSync(process.execPath, [path.resolve('scripts/kernel/bridge/mcp.js')], {
      cwd: workspaceRoot, input, encoding: 'utf8', timeout: 20000,
      env: { ...process.env, MOON_RELAY_KERNEL_HOME: runtimeHome },
    });
    assert.equal(child.status, 0, child.stderr || child.error?.message || 'MCP server process failed');
    const responses = child.stdout.split('\n').filter(Boolean);
    assert.equal(responses.length, 1, child.stdout);
    const response = assertTestRecord(JSON.parse(responses[0]!));
    assert.equal(response.id, id);
    assert.equal(assertTestRecord(response.result).isError, false);
    return parseToolText(response);
  };

  const first = invokeInNewProcess(100, 'kernel_attach');
  const second = invokeInNewProcess(101, 'kernel_attach');
  const detachedStatus = invokeInNewProcess(102, 'kernel_status');
  assert.equal(first.status, 'attached');
  assert.equal(second.status, 'attached');
  assert.equal(first.next, undefined);
  assert.equal(second.next, undefined);
  assert.equal(first.liveWorker, null);
  assert.equal(second.liveWorker, null);
  assert.deepEqual(first.resume, beforeStatus.resume);
  assert.deepEqual(first.workAuthority, beforeStatus.workAuthority);
  assert.deepEqual(first.trustAuthority, beforeStatus.trustAuthority);
  assert.deepEqual(second.resume, first.resume);
  assert.deepEqual(second.workAuthority, first.workAuthority);
  assert.deepEqual(second.trustAuthority, first.trustAuthority);
  assert.deepEqual(detachedStatus.resume, first.resume);

  const after = await createKernelControlPlane({ projectRoot: workspaceRoot, runtimeHome });
  try {
    assert.equal((await after.getRun(runId))?.revision, originalRevision,
      'read-only reattachment cannot mutate the Run');
    assert.equal(after.getHostRoutingSnapshot(runId).stepAttempts.length, 0,
      'reattachment cannot spawn an Attempt');
    assert.equal(after.getCurrentStep(runId)?.stepId, assertTestRecord(first.currentStep).stepId);
  } finally { await after.close(); }
  assert.equal(await readFile(path.join(workspaceRoot, 'README.md'), 'utf8'), '# Bridge Fixture\n');
});
