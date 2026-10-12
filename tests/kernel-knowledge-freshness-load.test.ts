import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildProjectKnowledgeContext } from '../src/kernel/knowledge/context-load.js';
import { attachFreshness } from '../src/kernel/knowledge/freshness.js';

// A minimal in-memory store exposing just what context-load consumes.
type ContextStore = NonNullable<NonNullable<Parameters<typeof buildProjectKnowledgeContext>[0]>['stateStore']>;
const makeStore = (records: ReturnType<ContextStore['listKnowledgeRecords']>) => ({
  getProjectKnowledgeRevision: () => 2,
  listKnowledgeRecords: () => records,
});

test('context load omits records whose referenced source vanished (stale)', async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'krn-freshload-'));
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'krn-freshload-home-'));
  try {
    await writeFile(path.join(projectRoot, 'present.js'), 'export const a = 1;\n');

    const freshRecord = attachFreshness(
      { id: 'kn-fresh', type: 'semantic_fact', statement: 'present fact', status: 'committed', trustTier: 'verified', scope: [] },
      { projectRoot, sourceRefs: ['present.js'] },
    );
    const staleRecord = attachFreshness(
      { id: 'kn-stale', type: 'semantic_fact', statement: 'stale fact', status: 'committed', trustTier: 'verified', scope: [] },
      { projectRoot, sourceRefs: ['deleted.js'] },
    );

    const ctx = await buildProjectKnowledgeContext({
      projectId: 'p-fresh',
      stage: 'FRAME',
      runId: 'r-fresh',
      projectRoot,
      stateStore: makeStore([freshRecord, staleRecord]),
      env: { MOON_RELAY_KERNEL_HOME: runtimeHome },
    });

    const servedIds = ctx.semanticFacts.map((f) => f.id);
    assert.ok(servedIds.includes('kn-fresh'), 'fresh record should be served');
    assert.ok(!servedIds.includes('kn-stale'), 'stale record must be omitted');
    assert.ok(ctx.staleOrUnavailable.some((s) => s.id === 'kn-stale' && s.reason === 'freshness_stale'));
    assert.ok(!ctx.promptBlock.includes('stale fact'));
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(runtimeHome, { recursive: true, force: true });
  }
});

test('context load omits records whose source drifted (needs_deep_verify)', async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'krn-freshdrift-'));
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'krn-freshdrift-home-'));
  try {
    await writeFile(path.join(projectRoot, 'mod.js'), 'export const v = 1;\n');
    const record = attachFreshness(
      { id: 'kn-drift', type: 'semantic_fact', statement: 'drift fact', status: 'committed', trustTier: 'verified', scope: [] },
      { projectRoot, sourceRefs: ['mod.js'] },
    );
    // Source drifts after the record was captured.
    await writeFile(path.join(projectRoot, 'mod.js'), 'export const v = 2;\n');

    const ctx = await buildProjectKnowledgeContext({
      projectId: 'p-drift',
      stage: 'FRAME',
      runId: 'r-drift',
      projectRoot,
      stateStore: makeStore([record]),
      env: { MOON_RELAY_KERNEL_HOME: runtimeHome },
    });

    assert.ok(!ctx.semanticFacts.some((f) => f.id === 'kn-drift'));
    assert.ok(ctx.staleOrUnavailable.some((s) => s.reason === 'freshness_needs_deep_verify'));
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(runtimeHome, { recursive: true, force: true });
  }
});

test('without projectRoot, freshness is skipped (backward compatible)', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'krn-freshnop-home-'));
  try {
    const record = { id: 'kn-norefs', type: 'semantic_fact', statement: 'no refs', status: 'committed', trustTier: 'verified', scope: [], sourceRefs: ['whatever.js'] };
    const ctx = await buildProjectKnowledgeContext({
      projectId: 'p-norefs',
      stage: 'FRAME',
      runId: 'r-norefs',
      stateStore: makeStore([record]),
      env: { MOON_RELAY_KERNEL_HOME: runtimeHome },
    });
    assert.ok(ctx.semanticFacts.some((f) => f.id === 'kn-norefs'));
  } finally {
    await rm(runtimeHome, { recursive: true, force: true });
  }
});
