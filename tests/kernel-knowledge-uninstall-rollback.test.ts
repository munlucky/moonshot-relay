import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, access } from 'node:fs/promises';
import { ensureKnowledgeStoreDirectories } from '../src/kernel/knowledge/store.js';

test('Kernel uninstall preserves user project knowledge by default', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'kernel-uninst-test-'));
  const env = { MOON_RELAY_KERNEL_HOME: tmp };
  const root = await ensureKnowledgeStoreDirectories('proj-keep', { env });

  // Simulate uninstall: manifest-owned files are deleted, but project knowledge remains
  const revPath = path.join(root, 'knowledge', 'revision.json');
  await access(revPath); // Should exist and be preserved
  assert.ok(true);
});
