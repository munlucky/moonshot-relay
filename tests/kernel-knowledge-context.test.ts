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

test('W1: canonical context collapse serves one representative for duplicate semantic facts', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kernel-context-dedupe-'));
  try {
    const duplicate = Array.from({ length: 10 }, (_, index) => ({
      id: `duplicate-${String(index).padStart(2, '0')}`,
      type: 'semantic_fact',
      statement: 'Unsupported verification should not be repeated in PROVE context.',
      scope: [],
      status: 'committed',
      trustTier: index === 9 ? 'authoritative' : 'verified',
      confidence: index === 0 ? 1 : 0.8,
      revision: index + 1,
      lastVerifiedAt: `2026-10-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
    }));
    const context = await buildProjectKnowledgeContext({
      projectId: 'context-dedupe',
      runId: 'run-context-dedupe',
      stage: 'PROVE',
      stateStore: contextStateStore(duplicate),
      env: { MOON_RELAY_KERNEL_HOME: root },
    });

    assert.equal(context.semanticFacts.length, 1);
    assert.equal(context.semanticFacts[0]?.id, 'duplicate-09');
    assert.equal(context.omittedByPolicy.filter((entry) => entry.reason === 'canonical_duplicate').length, 9);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('W1: same statement with different scope remains distinct', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kernel-context-scope-dedupe-'));
  try {
    const context = await buildProjectKnowledgeContext({
      projectId: 'context-scope-dedupe',
      runId: 'run-context-scope-dedupe',
      stage: 'PROVE',
      stateStore: contextStateStore([
        {
          id: 'scope-auth',
          type: 'semantic_fact',
          statement: 'The bounded component must preserve its current contract.',
          scope: ['src/auth/**'],
          status: 'committed',
          trustTier: 'verified',
        },
        {
          id: 'scope-billing',
          type: 'semantic_fact',
          statement: 'The bounded component must preserve its current contract.',
          scope: ['src/billing/**'],
          status: 'committed',
          trustTier: 'verified',
        },
      ]),
      env: { MOON_RELAY_KERNEL_HOME: root },
    });

    assert.equal(context.semanticFacts.length, 2);
    assert.equal(context.omittedByPolicy.filter((entry) => entry.reason === 'canonical_duplicate').length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('W1: stale duplicate is filtered before canonical collapse selects a fresh record', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kernel-context-fresh-dedupe-'));
  try {
    const context = await buildProjectKnowledgeContext({
      projectId: 'context-fresh-dedupe',
      runId: 'run-context-fresh-dedupe',
      stage: 'PROVE',
      stateStore: contextStateStore([
        {
          id: 'stale-duplicate',
          type: 'semantic_fact',
          statement: 'Verification evidence must remain current.',
          scope: [],
          status: 'superseded',
          trustTier: 'authoritative',
        },
        {
          id: 'fresh-duplicate',
          type: 'semantic_fact',
          statement: 'Verification evidence must remain current.',
          scope: [],
          status: 'committed',
          trustTier: 'verified',
        },
      ]),
      env: { MOON_RELAY_KERNEL_HOME: root },
    });

    assert.deepEqual(context.semanticFacts.map((entry) => entry.id), ['fresh-duplicate']);
    assert.ok(context.staleOrUnavailable.some((entry) => (
      entry.id === 'stale-duplicate' && entry.reason === 'status_superseded'
    )));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('W1: required verification command and obligation semantics prevent unsafe collapse', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kernel-context-verification-dedupe-'));
  try {
    const base = {
      type: 'required_verification',
      statement: 'Run the required verification before accepting the change.',
      scope: ['src/auth/**'],
      status: 'committed',
      trustTier: 'verified',
    };
    const context = await buildProjectKnowledgeContext({
      projectId: 'context-verification-dedupe',
      runId: 'run-context-verification-dedupe',
      stage: 'PROVE',
      stateStore: contextStateStore([
        {
          ...base,
          id: 'verify-base',
          verification: {
            commandRefs: ['test:auth'],
            obligationId: 'auth-unit',
            method: 'command',
            evidenceLevel: 'work',
          },
        },
        {
          ...base,
          id: 'verify-command',
          verification: {
            commandRefs: ['test:auth-other'],
            obligationId: 'auth-unit',
            method: 'command',
            evidenceLevel: 'work',
          },
        },
        {
          ...base,
          id: 'verify-obligation',
          verification: {
            commandRefs: ['test:auth'],
            obligationId: 'auth-integration',
            method: 'command',
            evidenceLevel: 'work',
          },
        },
        {
          ...base,
          id: 'verify-method',
          verification: {
            commandRefs: ['test:auth'],
            obligationId: 'auth-unit',
            method: 'review-receipt',
            evidenceLevel: 'work',
          },
        },
        {
          ...base,
          id: 'verify-evidence',
          verification: {
            commandRefs: ['test:auth'],
            obligationId: 'auth-unit',
            method: 'command',
            evidenceLevel: 'integration',
          },
        },
      ]),
      env: { MOON_RELAY_KERNEL_HOME: root },
    });

    assert.deepEqual(
      context.semanticFacts.map((entry) => entry.id).sort(),
      ['verify-base', 'verify-command', 'verify-evidence', 'verify-method', 'verify-obligation'],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('W1: duplicate collapse happens before budget so the next valid record can enter', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kernel-context-budget-dedupe-'));
  try {
    const repeatedStatement = `Repeated verification guidance ${'x'.repeat(1200)}`;
    const records = [
      ...Array.from({ length: 10 }, (_, index) => ({
        id: `budget-duplicate-${index}`,
        type: 'semantic_fact',
        statement: repeatedStatement,
        scope: [],
        status: 'committed',
        trustTier: 'verified',
      })),
      {
        id: 'budget-next-valid',
        type: 'semantic_fact',
        statement: `NEXT_VALID_RECORD ${'y'.repeat(1200)}`,
        scope: [],
        status: 'committed',
        trustTier: 'verified',
      },
    ];
    const context = await buildProjectKnowledgeContext({
      projectId: 'context-budget-dedupe',
      runId: 'run-context-budget-dedupe',
      stage: 'PROVE',
      stateStore: contextStateStore(records),
      env: { MOON_RELAY_KERNEL_HOME: root },
    });

    assert.equal(context.semanticFacts.filter((entry) => String(entry.id).startsWith('budget-duplicate-')).length, 1);
    assert.ok(context.semanticFacts.some((entry) => entry.id === 'budget-next-valid'));
    assert.match(context.promptBlock, /NEXT_VALID_RECORD/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
