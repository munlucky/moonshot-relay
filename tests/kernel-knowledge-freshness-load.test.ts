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

test('context load keeps source-bound verification out when its referenced source vanished', async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'krn-freshload-'));
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'krn-freshload-home-'));
  try {
    await writeFile(path.join(projectRoot, 'present.js'), 'export const a = 1;\n');

    const freshRecord = attachFreshness(
      { id: 'kn-fresh', type: 'semantic_fact', statement: 'present fact', status: 'committed', trustTier: 'verified', scope: [] },
      { projectRoot, sourceRefs: ['present.js'] },
    );
    const staleRecord = attachFreshness(
      { id: 'kn-stale', type: 'required_verification', statement: 'stale verification', status: 'committed', trustTier: 'verified', scope: [] },
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
    assert.ok(!ctx.promptBlock.includes('stale verification'));
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(runtimeHome, { recursive: true, force: true });
  }
});


test('A5: reusable semantic and architecture knowledge survives source path relocation', async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'krn-fresh-relocation-'));
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'krn-fresh-relocation-home-'));
  try {
    await writeFile(path.join(projectRoot, 'fact-source.md'), 'fact source\n');
    await writeFile(path.join(projectRoot, 'architecture-source.md'), 'architecture source\n');
    const fact = attachFreshness(
      { id: 'kn-relocated-fact', type: 'semantic_fact', statement: 'Authentication owns session issuance.', status: 'committed', trustTier: 'verified', scope: [] },
      { projectRoot, sourceRefs: ['fact-source.md'] },
    );
    const architecture = attachFreshness(
      { id: 'kn-relocated-architecture', type: 'architecture_decision', statement: 'Session issuance stays behind the auth boundary.', status: 'committed', trustTier: 'verified', scope: [] },
      { projectRoot, sourceRefs: ['architecture-source.md'] },
    );

    await rm(path.join(projectRoot, 'fact-source.md'));
    await rm(path.join(projectRoot, 'architecture-source.md'));

    const ctx = await buildProjectKnowledgeContext({
      projectId: 'p-relocation',
      stage: 'FRAME',
      runId: 'r-relocation',
      objective: 'update authentication session behavior',
      projectRoot,
      stateStore: makeStore([fact, architecture]),
      env: { MOON_RELAY_KERNEL_HOME: runtimeHome },
    });

    const servedIds = ctx.semanticFacts.map((record) => record.id);
    assert.ok(servedIds.includes('kn-relocated-fact'));
    assert.ok(servedIds.includes('kn-relocated-architecture'));
    assert.ok(ctx.promptBlock.includes('Authentication owns session issuance.'));
    assert.ok(ctx.promptBlock.includes('Session issuance stays behind the auth boundary.'));
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

test('W2: applicability glob is not treated as a freshness path when an explicit source exists', async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'krn-fresh-boundary-'));
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'krn-fresh-boundary-home-'));
  try {
    await writeFile(path.join(projectRoot, 'source.ts'), 'export const source = true;\n');
    const record = attachFreshness({
      id: 'kn-boundary',
      type: 'semantic_fact',
      statement: 'Kernel changes follow the bounded Knowledge rule.',
      status: 'committed',
      trustTier: 'verified',
      scope: ['src/kernel/**'],
    }, {
      projectRoot,
      sourceRefs: ['source.ts'],
    });

    const ctx = await buildProjectKnowledgeContext({
      projectId: 'p-boundary',
      stage: 'FRAME',
      runId: 'r-boundary',
      objective: 'change kernel knowledge',
      changedPaths: ['src/kernel/knowledge/context-load.ts'],
      projectRoot,
      stateStore: makeStore([record]),
      env: { MOON_RELAY_KERNEL_HOME: runtimeHome },
    });

    assert.ok(ctx.semanticFacts.some((fact) => fact.id === 'kn-boundary'));
    assert.ok(!ctx.staleOrUnavailable.some((entry) => entry.id === 'kn-boundary'));
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(runtimeHome, { recursive: true, force: true });
  }
});

test('W2: scope-only records remain selectable with projectRoot freshness checks enabled', async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'krn-fresh-scope-context-'));
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'krn-fresh-scope-context-home-'));
  try {
    const record = attachFreshness({
      id: 'kn-scope-only',
      type: 'semantic_fact',
      statement: 'Kernel Knowledge applies across the kernel scope.',
      status: 'committed',
      trustTier: 'verified',
      scope: ['src/kernel/**'],
    }, { projectRoot });

    const ctx = await buildProjectKnowledgeContext({
      projectId: 'p-scope-only',
      stage: 'FRAME',
      runId: 'r-scope-only',
      objective: 'change kernel knowledge',
      changedPaths: ['src/kernel/run-loop.ts'],
      projectRoot,
      stateStore: makeStore([record]),
      env: { MOON_RELAY_KERNEL_HOME: runtimeHome },
    });

    assert.deepEqual(record.sourceRefs, []);
    assert.ok(ctx.semanticFacts.some((fact) => fact.id === 'kn-scope-only'));
    assert.ok(!ctx.staleOrUnavailable.some((entry) => entry.id === 'kn-scope-only'));
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(runtimeHome, { recursive: true, force: true });
  }
});
