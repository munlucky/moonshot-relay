import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { collectRetroRecord } from '../tools/retro/collect.mjs';
import { importCollectRecords, readCollectRecord, resolveRetroRoot } from '../tools/retro/retro-store.mjs';
import { canonicalPath } from '../scripts/kernel/runtime-home.js';

const root = process.cwd();

test('retro root defaults to Kernel runtime home and ignores retired Relay home', async () => {
  const kernelHome = await mkdtemp(path.join(os.tmpdir(), 'retro-kernel-home-'));
  const legacyHome = await mkdtemp(path.join(os.tmpdir(), 'retro-legacy-home-'));

  assert.equal(
    resolveRetroRoot({
      projectId: 'fixture',
      env: {
        MOON_RELAY_KERNEL_HOME: kernelHome,
        MOONSHOT_RELAY_HOME: legacyHome,
      },
    }),
    path.join(canonicalPath(kernelHome), 'state', 'projects', 'fixture', 'retro'),
  );
});

test('retro collect writes a schema-shaped advisory outbox record', async () => {
  const out = await mkdtemp(path.join(os.tmpdir(), 'retro-outbox-'));
  const result = await collectRetroRecord({
    projectId: 'fixture',
    taskId: 'TASK-001',
    taskRoot: path.join(root, 'tests/fixtures/retro/task-full'),
    date: '2026-07-03',
    out,
  });

  const record = JSON.parse(await readFile(result.path, 'utf8'));
  assert.equal(record.schemaVersion, 'retro.collect.v1');
  assert.equal(record.projectId, 'fixture');
  assert.equal(record.taskId, 'TASK-001');
  assert.equal(record.promotionAuthority, false);
  assert.equal(record.redactions.rawLogsCopied, false);
  assert.deepEqual(record.failureClasses, ['acceptance_mapping_missing']);
});

test('retro collect refuses overwrite unless replace is explicit', async () => {
  const out = await mkdtemp(path.join(os.tmpdir(), 'retro-outbox-'));
  const args = {
    projectId: 'fixture',
    taskId: 'TASK-001',
    taskRoot: path.join(root, 'tests/fixtures/retro/task-full'),
    date: '2026-07-03',
    out,
  };
  await collectRetroRecord(args);
  await assert.rejects(() => collectRetroRecord(args), /already exists/);
  await collectRetroRecord({ ...args, replace: true });
});

test('retro collect rejects task ids that are unsafe as filenames', async () => {
  const out = await mkdtemp(path.join(os.tmpdir(), 'retro-outbox-unsafe-'));
  await assert.rejects(() => collectRetroRecord({
    projectId: 'fixture',
    taskId: '..\\escaped-collect-task',
    taskRoot: path.join(root, 'tests/fixtures/retro/task-full'),
    date: '2026-07-03',
    out,
  }), /taskId must match/);
});

test('retro collect uses verifier status when score status is absent', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'retro-status-fallback-'));
  const taskRoot = path.join(temp, 'task');
  await mkdir(path.join(taskRoot, 'artifacts'), { recursive: true });
  await writeFile(path.join(taskRoot, 'artifacts', 'verify.json'), `${JSON.stringify({
    status: 'FULL',
    failureClasses: [],
    reviewFindings: { critical: 0, important: 0, minor: 0 },
  }, null, 2)}\n`);
  await writeFile(path.join(taskRoot, 'artifacts', 'score.json'), `${JSON.stringify({
    total: 0.9,
    hardGatesPassed: true,
  }, null, 2)}\n`);

  const result = await collectRetroRecord({
    projectId: 'fixture',
    taskId: 'TASK-STATUS',
    taskRoot,
    date: '2026-07-03',
    out: path.join(temp, 'out'),
  });
  const record = JSON.parse(await readFile(result.path, 'utf8'));
  assert.equal(record.status, 'FULL');
  assert.equal(record.score.status, 'UNKNOWN');
});

test('retro import validates collect records and skips deterministic duplicates', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'retro-state-'));
  const result = await importCollectRecords({
    projectId: 'fixture',
    date: '2026-07-03',
    source: path.join(root, 'tests/fixtures/retro/2026-07-03'),
    stateRoot: temp,
  });
  assert.equal(result.imported, 3);
  assert.equal(result.skippedDuplicates, 0);
  assert.equal(result.rejected, 0);
  assert.equal(result.promotionAuthority, false);

  const second = await importCollectRecords({
    projectId: 'fixture',
    date: '2026-07-03',
    source: path.join(root, 'tests/fixtures/retro/2026-07-03'),
    stateRoot: temp,
  });
  assert.equal(second.imported, 0);
  assert.equal(second.skippedDuplicates, 3);
});

test('retro collect record validation rejects missing required fields', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'retro-invalid-'));
  const file = path.join(temp, 'bad.collect.json');
  await writeFile(file, `${JSON.stringify({ schemaVersion: 'retro.collect.v1' })}\n`);
  await assert.rejects(() => readCollectRecord(file), /missing required field/);
});

test('retro import rejects unknown fields out-of-range scores and duplicate failure classes', async () => {
  const fixture = JSON.parse(await readFile(path.join(root, 'tests/fixtures/retro/2026-07-03/TASK-001.collect.json'), 'utf8'));

  for (const [name, mutate] of [
    ['unknown-field', (record) => { record.extraRawLogs = 'full local transcript copied here'; }],
    ['score-range', (record) => { record.score.total = 999; }],
    ['duplicate-failure', (record) => { record.failureClasses = ['acceptance_mapping_missing', 'acceptance_mapping_missing']; }],
  ]) {
    const source = await mkdtemp(path.join(os.tmpdir(), `retro-invalid-${name}-`));
    const stateRoot = await mkdtemp(path.join(os.tmpdir(), `retro-state-${name}-`));
    const record = structuredClone(fixture);
    mutate(record);
    await writeFile(path.join(source, `${name}.collect.json`), `${JSON.stringify(record, null, 2)}\n`);

    const result = await importCollectRecords({
      projectId: 'fixture',
      date: '2026-07-03',
      source,
      stateRoot,
    });
    assert.equal(result.imported, 0, name);
    assert.equal(result.rejected, 1, name);
  }
});

test('retro import rejects unsafe project and task identifiers before filesystem writes', async () => {
  const fixture = JSON.parse(await readFile(path.join(root, 'tests/fixtures/retro/2026-07-03/TASK-001.collect.json'), 'utf8'));
  const source = await mkdtemp(path.join(os.tmpdir(), 'retro-traversal-source-'));
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'retro-traversal-state-'));

  const unsafeTask = structuredClone(fixture);
  unsafeTask.taskId = '..\\..\\escaped-retro-task';
  await writeFile(path.join(source, 'unsafe-task.collect.json'), `${JSON.stringify(unsafeTask, null, 2)}\n`);
  const result = await importCollectRecords({
    projectId: 'fixture',
    date: '2026-07-03',
    source,
    stateRoot,
  });
  assert.equal(result.imported, 0);
  assert.equal(result.rejected, 1);

  await assert.rejects(() => importCollectRecords({
    projectId: '..\\escaped-project',
    date: '2026-07-03',
    source,
    stateRoot,
  }), /projectId must match/);
});
