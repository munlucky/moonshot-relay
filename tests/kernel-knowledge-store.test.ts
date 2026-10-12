import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import {
  ensureKnowledgeStoreDirectories,
  writeAtomicJson,
  writeAtomicJsonl,
  projectKnowledgeDirectory,
} from '../src/kernel/knowledge/store.js';

test('ensureKnowledgeStoreDirectories creates the account-root namespace and initial projection marker', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'kernel-store-test-'));
  const env = { MOON_RELAY_KERNEL_HOME: tmp };
  try {
    const root = await ensureKnowledgeStoreDirectories('test-proj', { env });
    assert.ok(root.endsWith('test-proj'));

    const revision = JSON.parse(await readFile(
      path.join(projectKnowledgeDirectory('test-proj', { env }), 'knowledge', 'revision.json'),
      'utf8',
    ));
    assert.equal(revision.revision, '1');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('writeAtomicJson writes files atomically without partial writes', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'kernel-store-test-'));
  try {
    const targetFile = path.join(tmp, 'test.json');
    await writeAtomicJson(targetFile, { hello: 'world' });

    const content = JSON.parse(await readFile(targetFile, 'utf8'));
    assert.equal(content.hello, 'world');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('writeAtomicJsonl emits an empty derived file cleanly', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'kernel-store-test-'));
  try {
    const targetFile = path.join(tmp, 'empty.jsonl');
    await writeAtomicJsonl(targetFile, []);
    assert.equal(await readFile(targetFile, 'utf8'), '');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
