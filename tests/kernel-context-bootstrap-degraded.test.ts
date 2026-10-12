import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildProjectKnowledgeContext } from '../src/kernel/knowledge/context-load.js';
import { openKernelStateStore } from '../src/kernel/state-store.js';

const setup = async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'krn-ctx-deg-home-'));
  return { runtimeHome };
};

const cleanup = async ({ runtimeHome }: { runtimeHome: string }) => {
  await rm(runtimeHome, { recursive: true, force: true });
};

test('Context Wave 2: Empty or missing project knowledge returns degraded/ready-empty without throwing', async () => {
  const fixture = await setup();
  const store = await openKernelStateStore({ runtimeHome: fixture.runtimeHome });
  try {
    const context = await buildProjectKnowledgeContext({
      projectId: 'proj-empty',
      stateStore: store,
      stage: 'FRAME',
      runId: 'run-ctx-1',
      env: { MOON_RELAY_KERNEL_HOME: fixture.runtimeHome },
    });
    assert.ok(context, 'Context payload must be returned');
    assert.equal(context.status, 'ready-empty');
    assert.equal(context.degradedContext, true);
    assert.equal(typeof context.promptBlock, 'string');
  } finally {
    store.close();
    await cleanup(fixture);
  }
});

test('Context Wave 2: Cross-worktree shared project knowledge and cross-project isolation', async () => {
  const fixture = await setup();
  const store = await openKernelStateStore({ runtimeHome: fixture.runtimeHome });
  try {
    const sourceIdentity = 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    store.createRun({
      runId: 'run-a-1',
      objective: 'seed knowledge',
      sourceIdentity,
      projectId: 'proj-a',
    });
    store.recordCompletionDecision('run-a-1', {
      decision: 'accepted',
      sourceIdentity,
      mutationRevision: 0,
      evidenceDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      decisionJson: { status: 'accepted' },
    });

    // Commit knowledge for Project A
    const recA = {
      id: 'rec-proj-a-fact',
      projectId: 'proj-a',
      type: 'semantic_fact',
      statement: 'Project A uses Node 20',
      status: 'committed',
      trustTier: 'verified',
      createdAt: new Date().toISOString(),
      evidence: { refs: ['ev-1'] },
    };
    store.commitKnowledgeTransaction({
      transactionId: 'tx-a',
      runId: 'run-a-1',
      projectId: 'proj-a',
      expectedRevision: '1',
      records: [recA],
      supersessions: [],
      provenance: { runId: 'run-a-1', committedCount: 1 },
      noChange: false,
    });

    // Worktree 2 of Project A queries context
    const ctxA_worktree2 = await buildProjectKnowledgeContext({
      projectId: 'proj-a',
      stateStore: store,
      stage: 'FRAME',
      runId: 'run-a-worktree-2',
      env: { MOON_RELAY_KERNEL_HOME: fixture.runtimeHome },
    });
    assert.equal(ctxA_worktree2.status, 'ready-populated');
    assert.ok(ctxA_worktree2.promptBlock.includes('Project A uses Node 20'), 'Project A knowledge must be shared across worktrees');

    // Project B queries context
    const ctxB = await buildProjectKnowledgeContext({
      projectId: 'proj-b',
      stateStore: store,
      stage: 'FRAME',
      runId: 'run-b-1',
      env: { MOON_RELAY_KERNEL_HOME: fixture.runtimeHome },
    });
    assert.ok(!ctxB.promptBlock.includes('Project A uses Node 20'), 'Project B must not see Project A knowledge');
  } finally {
    store.close();
    await cleanup(fixture);
  }
});
