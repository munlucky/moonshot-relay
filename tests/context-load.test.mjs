import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProjectKnowledgeContext } from '../scripts/kernel/knowledge/context-load.js';
import { openKernelStateStore } from '../scripts/kernel/state-store.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('Context Load - loads stage context from SQLite knowledge authority', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'mr-test-ctx-load-'));
  const store = await openKernelStateStore({ runtimeHome: tmp });
  try {
    const ctx = await buildProjectKnowledgeContext({
      projectId: 'proj-ctx-1',
      stage: 'FRAME',
      runId: 'run-ctx-1',
      stateStore: store,
      env: { MOON_RELAY_KERNEL_HOME: tmp },
    });

    assert.ok(ctx);
    assert.ok(ctx.digest);
    assert.ok(ctx.promptBlock);
  } finally {
    store.close();
    await rm(tmp, { recursive: true, force: true });
  }
});
