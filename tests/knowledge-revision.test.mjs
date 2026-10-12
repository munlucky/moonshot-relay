import test from 'node:test';
import assert from 'node:assert/strict';
import { openKernelStateStore } from '../scripts/kernel/state-store.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('Knowledge Revision - validates CAS knowledge revision updates', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'mr-test-kn-rev-'));
  const store = await openKernelStateStore({ runtimeHome: tmp });
  try {
    const rev1 = store.getProjectKnowledgeRevision('proj-r1');
    assert.equal(rev1, 1);

    const updated = store.updateProjectKnowledgeRevision('proj-r1', 1, 2);
    assert.equal(updated, true);

    const rev2 = store.getProjectKnowledgeRevision('proj-r1');
    assert.equal(rev2, 2);

    // Stale update should fail
    const stale = store.updateProjectKnowledgeRevision('proj-r1', 1, 3);
    assert.equal(stale, false);
  } finally {
    store.close();
    await rm(tmp, { recursive: true, force: true });
  }
});
