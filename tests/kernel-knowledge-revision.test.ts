import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { openKernelStateStore } from '../src/kernel/state-store.js';

test('Knowledge revision advances through the SQLite CAS authority only', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-rev-test-'));
  const store = await openKernelStateStore({ runtimeHome });
  try {
    assert.equal(store.getProjectKnowledgeRevision('test-proj'), 1);
    assert.equal(store.updateProjectKnowledgeRevision('test-proj', 1, 2), true);
    assert.equal(store.getProjectKnowledgeRevision('test-proj'), 2);

    assert.equal(
      store.updateProjectKnowledgeRevision('test-proj', 1, 3),
      false,
      'stale revision writers must lose the CAS',
    );
    assert.equal(store.getProjectKnowledgeRevision('test-proj'), 2);

    assert.equal(store.updateProjectKnowledgeRevision('test-proj', 2, 3), true);
    assert.equal(store.getProjectKnowledgeRevision('test-proj'), 3);
  } finally {
    store.close();
    await rm(runtimeHome, { recursive: true, force: true });
  }
});
