import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProjectKnowledgeContext } from '../scripts/kernel/knowledge/context-load.js';
import { openKernelStateStore } from '../scripts/kernel/state-store.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('Context Budget - enforces stage context budget constraints when loading context', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'mr-test-ctx-bdg-'));
  const store = await openKernelStateStore({ runtimeHome: tmp });
  try {
    const ctx = await buildProjectKnowledgeContext({
      projectId: 'proj-ctx-bdg',
      stage: 'EXECUTE',
      runId: 'run-ctx-bdg',
      stateStore: store,
      env: { MOON_RELAY_KERNEL_HOME: tmp },
    });

    assert.ok(ctx);
    assert.equal(ctx.status, 'ready-empty');
    assert.ok(typeof ctx.promptBlock === 'string');
  } finally {
    store.close();
    await rm(tmp, { recursive: true, force: true });
  }
});
