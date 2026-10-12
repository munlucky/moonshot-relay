import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import {
  ensureKnowledgeStoreDirectories,
  writeAtomicJsonl,
  projectKnowledgeDirectory,
} from '../src/kernel/knowledge/store.js';
import { buildProjectKnowledgeContext } from '../src/kernel/knowledge/context-load.js';
import { openKernelStateStore } from '../src/kernel/state-store.js';

test('SQLite knowledge remains authoritative when projection files disagree', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'kernel-ctx-test-'));
  const env = { MOON_RELAY_KERNEL_HOME: tmp };
  const store = await openKernelStateStore({ runtimeHome: tmp });
  try {
    store.saveKnowledgeRecord('test-proj', 'fact-1', {
      recordType: 'policy_anchor',
      status: 'committed',
      trustTier: 'verified',
      recordJson: {
        id: 'fact-1',
        projectId: 'test-proj',
        type: 'policy_anchor',
        statement: 'System uses UTC timestamping.',
        status: 'committed',
        trustTier: 'verified',
        createdAt: '2026-07-23T00:00:00.000Z',
      },
      revision: 1,
    });

    await ensureKnowledgeStoreDirectories('test-proj', { env });
    const root = projectKnowledgeDirectory('test-proj', { env });
    const projectionPath = path.join(root, 'knowledge', 'semantic', 'verified-facts.jsonl');
    await writeAtomicJsonl(projectionPath, [{
      id: 'projection-only',
      projectId: 'test-proj',
      type: 'policy_anchor',
      statement: 'Projection content must never become canonical knowledge.',
      status: 'verified',
      trustTier: 'verified',
    }]);

    const ctx1 = await buildProjectKnowledgeContext({
      projectId: 'test-proj',
      stage: 'FRAME',
      runId: 'run-context-1',
      stateStore: store,
      env,
    });

    await writeAtomicJsonl(projectionPath, [{
      id: 'projection-corrupted',
      projectId: 'test-proj',
      type: 'policy_anchor',
      statement: 'Corrupted projection content.',
      status: 'verified',
      trustTier: 'verified',
    }]);

    const ctx2 = await buildProjectKnowledgeContext({
      projectId: 'test-proj',
      stage: 'FRAME',
      runId: 'run-context-2',
      stateStore: store,
      env,
    });

    assert.equal(ctx1.digest, ctx2.digest);
    assert.equal(ctx1.stage, 'FRAME');
    assert.equal(ctx1.status, 'ready-populated');
    assert.ok(ctx1.promptBlock.includes('System uses UTC timestamping.'));
    assert.ok(!ctx1.promptBlock.includes('Projection content must never become canonical knowledge.'));
    assert.ok(!ctx2.promptBlock.includes('Corrupted projection content.'));

    await assert.rejects(
      () => buildProjectKnowledgeContext({
        projectId: 'test-proj',
        stage: 'FRAME',
        runId: 'projection-only-run',
        env,
      }),
      (error) => { assert.ok(error && typeof error === 'object' && 'code' in error); return error?.code === 'KNOWLEDGE_AUTHORITY_REQUIRED'; },
    );
  } finally {
    store.close();
    await rm(tmp, { recursive: true, force: true });
  }
});

const contextStateStore = (records: ReturnType<NonNullable<NonNullable<Parameters<typeof buildProjectKnowledgeContext>[0]>['stateStore']>['listKnowledgeRecords']>) => ({
  getProjectKnowledgeRevision: () => 7,
  listKnowledgeRecords: () => records,
});

test('empty and populated context states are explicit and degraded only when empty', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kernel-context-quality-'));
  const env = { MOON_RELAY_KERNEL_HOME: root };
  try {
    const empty = await buildProjectKnowledgeContext({
      projectId: 'context-quality',
      runId: 'run-empty',
      stage: 'FRAME',
      stateStore: contextStateStore([]),
      projectRoot: root,
      env,
    });
    assert.equal(empty.status, 'ready-empty');
    assert.equal(empty.degradedContext, true);
    assert.equal(empty.quality.status, 'ready-empty');
    assert.equal(empty.quality.usableRecordCount, 0);
    assert.ok(empty && typeof empty === 'object' && 'quality' in empty);
    assert.ok(empty.quality.selectedCounts && typeof empty.quality.selectedCounts === 'object');
    assert.ok(empty.quality.selectedCounts && typeof empty.quality.selectedCounts === 'object' && 'policy' in empty.quality.selectedCounts);
    assert.equal(empty.quality.selectedCounts.policy, 0);

    const populated = await buildProjectKnowledgeContext({
      projectId: 'context-quality',
      runId: 'run-populated',
      stage: 'FRAME',
      stateStore: contextStateStore([{
        id: 'policy-1',
        type: 'policy_anchor',
        statement: 'Use the Kernel receipt authority.',
        status: 'committed',
        trustTier: 'verified',
      }]),
      projectRoot: root,
      env,
    });
    assert.equal(populated.status, 'ready-populated');
    assert.equal(populated.degradedContext, false);
    assert.equal(populated.quality.usableRecordCount, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('context store failures become unavailable instead of ready-empty', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kernel-context-unavailable-'));
  const env = { MOON_RELAY_KERNEL_HOME: root };
  try {
    const context = await buildProjectKnowledgeContext({
      projectId: 'context-unavailable',
      runId: 'run-unavailable',
      stage: 'FRAME',
      stateStore: {
        getProjectKnowledgeRevision: () => { throw Object.assign(new Error('store offline'), { code: 'STORE_OFFLINE' }); },
        listKnowledgeRecords: () => [],
      },
      projectRoot: root,
      env,
    });
    assert.equal(context.status, 'unavailable');
    assert.equal(context.degradedContext, true);
    assert.ok(context && typeof context === 'object' && 'quality' in context);
    assert.ok(context.quality.omittedCounts && typeof context.quality.omittedCounts === 'object');
    assert.ok(context.quality.omittedCounts && typeof context.quality.omittedCounts === 'object' && 'unavailable' in context.quality.omittedCounts);
    assert.equal(context.quality.omittedCounts.unavailable, 1);
    assert.equal(context.staleOrUnavailable[0].errorCode, 'STORE_OFFLINE');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('context with only stale candidates is reported as stale', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kernel-context-stale-'));
  try {
    const context = await buildProjectKnowledgeContext({
      projectId: 'context-stale',
      runId: 'run-stale',
      stage: 'FRAME',
      projectRoot: root,
      env: { MOON_RELAY_KERNEL_HOME: root },
      stateStore: {
        getProjectKnowledgeRevision: () => 3,
        listKnowledgeRecords: () => [{
          id: 'stale-policy',
          type: 'policy_anchor',
          statement: 'This source no longer exists.',
          status: 'committed',
          trustTier: 'verified',
          sourceRefs: ['missing-source.md'],
          sourceDigest: 'sha256:stale',
        }],
      },
    });
    assert.equal(context.status, 'stale');
    assert.equal(context.quality.reason, 'all-candidates-stale-or-unavailable');
    assert.ok(context && typeof context === 'object' && 'quality' in context);
    assert.ok(context.quality.omittedCounts && typeof context.quality.omittedCounts === 'object');
    assert.ok(context.quality.omittedCounts && typeof context.quality.omittedCounts === 'object' && 'stale' in context.quality.omittedCounts);
    assert.equal(context.quality.omittedCounts.stale, 1);
    assert.equal(context.semanticFacts.length, 0);
    assert.equal(context.policyAnchors.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
