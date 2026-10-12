import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openKernelStateStore } from '../src/kernel/state-store.js';
import { resolveModelRoute } from '../src/kernel/run/model-routing.js';
import { hashSessionId, normalizeModelUsageReceipt } from '../src/contracts/model-execution.js';

const SESSION_A = hashSessionId('implementer-session');
const SESSION_B = hashSessionId('reviewer-session');

type TestStore = Awaited<ReturnType<typeof openKernelStateStore>>;
const withStore = async <T>(fn: (store: TestStore, runtimeHome: string) => T | Promise<T>) => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'krn-usage-db-'));
  const store = await openKernelStateStore({ runtimeHome });
  try {
    return await fn(store, runtimeHome);
  } finally {
    store.close();
    await rm(runtimeHome, { recursive: true, force: true });
  }
};

const seed = (store: TestStore, runId: string, options: Partial<Parameters<typeof resolveModelRoute>[0]> = {}) => {
  store.createRun({ runId, objective: 'usage receipts', sourceIdentity: 'kernel-test-source' });
  return store.recordModelRouteDecision(runId, resolveModelRoute({ runId, actionKind: 'implement', ...options }));
};

test('a usage receipt binds to its decision and preserves unreported counts as null', async () => {
  await withStore(async (store) => {
    const decision = seed(store, 'r-1');
    const receipt = store.recordModelUsageReceipt('r-1', {
      decisionId: decision.decisionId,
      runId: 'r-1',
      hostSurface: 'claude',
      actorSessionId: SESSION_A,
      resolvedModel: 'host-configured-value-model',
      resolvedEffort: 'high',
      observedModel: 'host-configured-value-model',
      observedEffort: 'high',
      enforcementStatus: 'enforced',
      resultStatus: 'completed',
      inputTokens: 1200,
      outputTokens: 340,
      costMicros: null,
    });
    const stored = store.getModelUsageReceipt(receipt.receiptId);
    assert.ok(stored);
    assert.equal(stored.enforcementStatus, 'enforced');
    assert.equal(stored.inputTokens, 1200);
    assert.equal(stored.costMicros, null);
    assert.equal(stored.wallClockMs, null);
    assert.equal(store.listModelUsageReceipts('r-1').length, 1);
  });
});

test('a Host that could not enforce the class may not claim it did', async () => {
  await withStore(async (store) => {
    const decision = seed(store, 'r-1');
    const base = { decisionId: decision.decisionId, runId: 'r-1', hostSurface: 'fable', actorSessionId: SESSION_A, resultStatus: 'completed' };
    assert.throws(() => store.recordModelUsageReceipt('r-1', { ...base, enforcementStatus: 'enforced' }), /requires the resolved provider model/);
    const unsupported = store.recordModelUsageReceipt('r-1', { ...base, enforcementStatus: 'unsupported', resolvedModel: null });
    assert.equal(unsupported.enforcementStatus, 'unsupported');
    assert.equal(unsupported.resolvedModel, null);
  });
});

test('receipts reject raw session identifiers, negative counts, and unknown statuses', () => {
  const base = { decisionId: 'route-abcdef0123456789', runId: 'r-1', hostSurface: 'claude', actorSessionId: SESSION_A, enforcementStatus: 'advisory', resultStatus: 'completed' };
  assert.throws(() => normalizeModelUsageReceipt({ ...base, actorSessionId: 'session-1234' }), /must be a sha256/);
  assert.throws(() => normalizeModelUsageReceipt({ ...base, inputTokens: -1 }), /non-negative integer or null/);
  assert.throws(() => normalizeModelUsageReceipt({ ...base, enforcementStatus: 'pretend' }), /enforcementStatus must be one of/);
  assert.throws(() => normalizeModelUsageReceipt({ ...base, resultStatus: 'maybe' }), /resultStatus must be one of/);
  assert.equal(normalizeModelUsageReceipt(base).inputTokens, null);
});

test('an enforced receipt requires requested, resolved, and observed identity to agree', () => {
  const exact = {
    decisionId: 'route-abcdef12',
    runId: 'r-identity',
    hostSurface: 'codex',
    actorSessionId: SESSION_A,
    resultStatus: 'completed',
    enforcementStatus: 'enforced',
    requestedModel: 'gpt-5.6-luna',
    requestedEffort: 'max',
    resolvedModel: 'gpt-5.6-luna',
    resolvedEffort: 'max',
    observedModel: 'gpt-5.6-luna',
    observedEffort: 'max',
  };
  assert.equal(normalizeModelUsageReceipt(exact).observedModel, 'gpt-5.6-luna');
  assert.throws(
    () => normalizeModelUsageReceipt({ ...exact, resolvedModel: 'gpt-5.6-sol' }),
    /resolved provider model to equal the requested model/,
  );
  assert.throws(
    () => normalizeModelUsageReceipt({ ...exact, observedEffort: 'high' }),
    /observed reasoning effort equal to the requested effort/,
  );
  assert.throws(
    () => normalizeModelUsageReceipt({ ...exact, observedModel: undefined }),
    /observed provider model equal to the requested model/,
  );
});

test('a receipt cannot reference a decision from another run', async () => {
  await withStore(async (store) => {
    const decision = seed(store, 'r-1');
    store.createRun({ runId: 'r-2', objective: 'other', sourceIdentity: 'kernel-test-source' });
    assert.throws(
      () => store.recordModelUsageReceipt('r-2', { decisionId: decision.decisionId, runId: 'r-2', hostSurface: 'claude', actorSessionId: SESSION_A, enforcementStatus: 'advisory', resultStatus: 'completed' }),
      /does not belong to run/,
    );
  });
});

test('the latest implementation session is resolvable for reviewer independence checks', async () => {
  await withStore(async (store) => {
    const implementDecision = seed(store, 'r-1');
    const reviewDecision = store.recordModelRouteDecision('r-1', resolveModelRoute({ runId: 'r-1', actionKind: 'review_engineering', riskTier: 'T3', sequence: 1 }));
    store.recordModelUsageReceipt('r-1', { decisionId: implementDecision.decisionId, runId: 'r-1', hostSurface: 'claude', actorSessionId: SESSION_A, enforcementStatus: 'advisory', resultStatus: 'completed' });
    store.recordModelUsageReceipt('r-1', { decisionId: reviewDecision.decisionId, runId: 'r-1', hostSurface: 'claude', actorSessionId: SESSION_B, enforcementStatus: 'advisory', resultStatus: 'completed' });
    const session = store.getLatestImplementationSession('r-1');
    assert.ok(session);
    assert.equal(session.actorSessionId, SESSION_A);
    assert.equal(session.decisionId, implementDecision.decisionId);
    assert.notEqual(session.actorSessionId, SESSION_B);
  });
});
