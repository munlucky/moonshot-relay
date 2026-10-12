import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { attachFreshness, cheapReVerify, computeSourceDigest } from '../src/kernel/knowledge/freshness.js';
import { mapCandidateToCanonicalRecord } from '../src/kernel/knowledge/canonical-record-mapper.js';
import { buildTopologyProjection } from '../src/kernel/knowledge/topology-projection.js';
import { scanRepositoryEvidence } from '../src/host/kernel/workspace/repository-observation.js';

test('records carry freshness metadata after mapping', async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'krn-fresh-'));
  try {
    await writeFile(path.join(projectRoot, 'auth.js'), 'export const login = () => 401;\n');
    const record = mapCandidateToCanonicalRecord(
      { proposedType: 'semantic_fact', statement: 'auth returns 401', sourceRefs: ['auth.js'], confidence: 0.95 },
      { runId: 'r1', projectId: 'p1', revision: 2, projectRoot },
    );
    assert.ok(record.sourceDigest);
  assert.ok(record.sourceDigest.startsWith('sha256:'));
    assert.deepEqual(record.sourceRefs, ['auth.js']);
    assert.equal(record.confidence, 0.95);
    assert.equal(record.freshnessPolicy, 'verify_on_source_change');
    assert.ok(record.lastVerifiedAt);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('cheap re-verify keeps unchanged records and stales deleted references', async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'krn-fresh-rv-'));
  try {
    await writeFile(path.join(projectRoot, 'mod.js'), 'export const v = 1;\n');
    const record = attachFreshness({ id: 'r', scope: ['mod.js'] }, { projectRoot, sourceRefs: ['mod.js'] });

    // Unchanged -> fresh.
    assert.equal(cheapReVerify(record, { projectRoot }).status, 'fresh');

    // Content drift -> deferred deep verify, not immediate discard.
    await writeFile(path.join(projectRoot, 'mod.js'), 'export const v = 2;\n');
    assert.equal(cheapReVerify(record, { projectRoot }).status, 'needs_deep_verify');

    // Referenced path deleted -> stale.
    await rm(path.join(projectRoot, 'mod.js'));
    const stale = cheapReVerify(record, { projectRoot });
    assert.equal(stale.status, 'stale');
    assert.deepEqual(stale.missing, ['mod.js']);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('source digest is stable and order-independent across the same refs', async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'krn-fresh-digest-'));
  try {
    await writeFile(path.join(projectRoot, 'a.js'), 'a\n');
    await writeFile(path.join(projectRoot, 'b.js'), 'b\n');
    const d1 = computeSourceDigest({ projectRoot, sourceRefs: ['a.js', 'b.js'] });
    const d2 = computeSourceDigest({ projectRoot, sourceRefs: ['b.js', 'a.js'] });
    assert.equal(d1, d2);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('topology projection is read-only and marks itself non-authoritative', async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'krn-topo-'));
  try {
    await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({ name: 'x', main: 'index.mjs', scripts: { test: 'node t.mjs', build: 'node b.mjs' } }));
    const projection = buildTopologyProjection({ observation: scanRepositoryEvidence({ projectRoot }) });
    assert.equal(projection.authority, false);
    assert.equal(projection.kind, 'projection');
    assert.ok(projection.entrypoints.includes('index.mjs'));
    assert.ok(projection.testCommands.includes('test'));
    assert.ok(projection.buildCommands.includes('build'));
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});
