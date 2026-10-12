import test from 'node:test';
import assert from 'node:assert/strict';
import { rebuildKnowledgeProjection } from '../scripts/kernel/knowledge/projection.js';
import { openKernelStateStore } from '../scripts/kernel/state-store.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('Knowledge Projection - rebuilds modern and legacy derived files from SQLite store', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'mr-test-kn-proj-'));
  const store = await openKernelStateStore({ runtimeHome: tmp });
  try {
    store.saveKnowledgeRecord('proj-p1', 'rec-p1', {
      recordType: 'semantic_fact',
      status: 'committed',
      trustTier: 'verified',
      recordJson: {
        id: 'rec-p1',
        projectId: 'proj-p1',
        type: 'semantic_fact',
        statement: 'Project uses projection rebuild',
        status: 'committed',
        trustTier: 'verified',
      },
      revision: 1,
    });

    const res = await rebuildKnowledgeProjection('proj-p1', {
      stateStore: store,
      runtimeHome: tmp,
    });

    assert.equal(res.status, 'rebuilt');
    assert.equal(res.count, 1);

    const modern = await readFile(join(res.projectDir, 'semantic', 'facts.jsonl'), 'utf8');
    const legacy = await readFile(join(res.projectDir, 'semantic', 'verified-facts.jsonl'), 'utf8');
    const manifest = JSON.parse(await readFile(join(res.projectDir, 'revision.json'), 'utf8'));
    assert.match(modern, /Project uses projection rebuild/);
    assert.equal(legacy, modern);
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.revision, String(store.getProjectKnowledgeRevision('proj-p1')));
    assert.equal(String(manifest.knowledgeRevision), manifest.revision);
    assert.equal(manifest.recordCount, 1);
  } finally {
    store.close();
    await rm(tmp, { recursive: true, force: true });
  }
});
