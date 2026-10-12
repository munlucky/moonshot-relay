import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openKernelStateStore, kernelDbPath } from '../src/kernel/state-store.js';
import { openSqliteDb } from '../src/kernel/sqlite-adapter.js';
import { resolveModelRoute } from '../src/kernel/run/model-routing.js';
import { hashSessionId } from '../src/contracts/model-execution.js';

const SESSION = hashSessionId('implementer-session');

type TestStore = Awaited<ReturnType<typeof openKernelStateStore>>;
const withStore = async <T>(fn: (store: TestStore, runtimeHome: string) => T | Promise<T>) => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'krn-cache-db-'));
  const store = await openKernelStateStore({ runtimeHome });
  try {
    return await fn(store, runtimeHome);
  } finally {
    store.close();
    await rm(runtimeHome, { recursive: true, force: true });
  }
};

const seed = (store: TestStore, runId: string) => {
  store.createRun({ runId, objective: 'cache telemetry', sourceIdentity: 'kernel-test-source' });
  return store.recordModelRouteDecision(runId, resolveModelRoute({ runId, actionKind: 'implement' }));
};

const NEW_COLUMNS = [
  'provider', 'surface', 'speed_mode', 'reasoning_context', 'reasoning_mode', 'delegation_mode',
  'session_lineage_id', 'previous_response_id_digest', 'prompt_prefix_digest', 'prompt_cache_key_digest',
  'cache_mode', 'cache_ttl', 'cache_miss_reason', 'model_escalation_reason',
  'eligible_prefix_tokens', 'uncached_input_tokens', 'cache_read_input_tokens',
  'cache_write_input_tokens', 'reasoning_tokens',
];

test('the migration adds every economics column to model_usage_receipts', async () => {
  await withStore(async (store, runtimeHome) => {
    // Read the live schema rather than trusting the migration list: an ALTER
    // that silently failed would still leave the code path looking correct.
    const db = await openSqliteDb(kernelDbPath(runtimeHome));
    try {
      const columns = db.prepare('PRAGMA table_info(model_usage_receipts)').all().map((row: unknown) => { assert.ok(row && typeof row === 'object' && 'name' in row); return row.name; });
      for (const column of NEW_COLUMNS) assert.ok(columns.includes(column), `missing column: ${column}`);
      // Additive only: the pre-existing columns must survive untouched.
      for (const column of ['receipt_id', 'decision_id', 'run_id', 'cached_input_tokens', 'input_tokens', 'output_tokens', 'cost_micros']) {
        assert.ok(columns.includes(column), `migration dropped an existing column: ${column}`);
      }
    } finally {
      db.close?.();
    }
  });
});

test('a receipt round-trips its cache and routing telemetry', async () => {
  await withStore(async (store) => {
    const decision = seed(store, 'r-1');
    store.recordModelUsageReceipt('r-1', {
      decisionId: decision.decisionId,
      runId: 'r-1',
      hostSurface: 'claude',
      actorSessionId: SESSION,
      enforcementStatus: 'advisory',
      resultStatus: 'completed',
      provider: 'claude',
      surface: 'claude',
      speedMode: 'standard',
      cacheMode: 'on',
      cacheTtl: 'default',
      promptPrefixDigest: 'sha256:prefix',
      sessionLineageId: 'session-abc',
      eligiblePrefixTokens: 1000,
      cacheReadInputTokens: 900,
      cacheWriteInputTokens: 40,
      reasoningTokens: 25,
    });
    const stored = store.listModelUsageReceipts('r-1')[0];
    assert.equal(stored.cacheReadInputTokens, 900);
    assert.equal(stored.cacheWriteInputTokens, 40);
    assert.equal(stored.eligiblePrefixTokens, 1000);
    assert.equal(stored.promptPrefixDigest, 'sha256:prefix');
    assert.equal(stored.sessionLineageId, 'session-abc');
    assert.equal(stored.cacheMode, 'on');
  });
});

test('a receipt that reports nothing stores NULL, not zero', async () => {
  await withStore(async (store) => {
    const decision = seed(store, 'r-2');
    store.recordModelUsageReceipt('r-2', {
      decisionId: decision.decisionId,
      runId: 'r-2',
      hostSurface: 'codex',
      actorSessionId: SESSION,
      enforcementStatus: 'unsupported',
      resultStatus: 'completed',
    });
    const stored = store.listModelUsageReceipts('r-2')[0];
    for (const field of ['cacheReadInputTokens', 'cacheWriteInputTokens', 'eligiblePrefixTokens', 'reasoningTokens', 'promptPrefixDigest', 'sessionLineageId'] as const) {
      assert.equal(stored[field], null, `${field} must persist as null`);
    }
  });
});

test('re-recording the same receipt updates the economics rather than duplicating the row', async () => {
  await withStore(async (store) => {
    const decision = seed(store, 'r-3');
    const payload = {
      decisionId: decision.decisionId,
      runId: 'r-3',
      hostSurface: 'claude',
      actorSessionId: SESSION,
      enforcementStatus: 'advisory',
      resultStatus: 'completed',
      startedAt: '2026-07-29T00:00:00.000Z',
    };
    store.recordModelUsageReceipt('r-3', payload);
    store.recordModelUsageReceipt('r-3', { ...payload, cacheReadInputTokens: 700 });
    const receipts = store.listModelUsageReceipts('r-3');
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].cacheReadInputTokens, 700);
  });
});

test('active legacy lifecycle rows are canonicalized to FRAME while terminal history is preserved', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'krn-legacy-state-'));
  const store = await openKernelStateStore({ runtimeHome });
  try {
    store.createRun({ runId: 'legacy-active', objective: 'legacy active', sourceIdentity: 'kernel-test-source' });
    store.createRun({ runId: 'legacy-terminal', objective: 'legacy terminal', sourceIdentity: 'kernel-test-source' });
    store.close();

    const db = await openSqliteDb(kernelDbPath(runtimeHome));
    try {
      db.prepare("UPDATE runs SET state = 'SHAPE' WHERE run_id = ?").run('legacy-active');
      db.prepare("UPDATE runs SET state = 'SLICE', status = 'completed' WHERE run_id = ?").run('legacy-terminal');
    } finally {
      db.close?.();
    }

    const reopened = await openKernelStateStore({ runtimeHome });
    try {
      const active = reopened.getRun('legacy-active');
      const terminal = reopened.getRun('legacy-terminal');
      assert.ok(active && terminal);
      assert.equal(active.state, 'FRAME');
      assert.equal(terminal.state, 'SLICE');
      assert.equal(terminal.status, 'completed');
    } finally {
      reopened.close();
    }
  } finally {
    await rm(runtimeHome, { recursive: true, force: true });
  }
});
