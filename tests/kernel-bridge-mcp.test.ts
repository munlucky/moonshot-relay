import { assertTestArray, assertTestPresent, assertTestRecord, assertTestString, optionalTestRecord } from './helpers/assert-value.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createMcpBridgeHandler } from '../src/kernel/bridge/mcp.js';
import { createKernelControlPlane } from '../src/host/kernel/control-plane-runtime.js';
import { dispatchKernelTurn } from '../src/host/kernel/turn-dispatcher.js';
import { createClaudeAdapter } from '../src/host/kernel/adapters/claude.js';
import { createKernelHostReviewBridge } from '../src/host/kernel/lifecycle-bridge.js';
import { assessReviewReadiness } from '../src/host/kernel/review-readiness.js';
import { createModelRegistry } from '../src/host/kernel/model-registry.js';

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
  const toolNames = assertTestPresent(assertTestPresent(assertTestPresent(listRes).result).tools).map((tool) => tool.name);
  assert.ok(toolNames.includes('kernel_attach'));
  assert.ok(toolNames.includes('kernel_next'));
  assert.ok(toolNames.includes('kernel_report'));
  assert.ok(toolNames.includes('kernel_status'));
  assert.ok(toolNames.includes('kernel_detach'));

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

  // 7. tools/call kernel_report
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
  assert.equal(readiness.review.model, 'gpt-6-astra');
  assert.equal(readiness.review.effort, 'high');
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
