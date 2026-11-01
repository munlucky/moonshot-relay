import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { openSqliteDb } from '../src/kernel/sqlite-adapter.js';
import { openKernelStateStore, kernelDbPath } from '../src/kernel/state-store.js';

const readSqliteVersions = (db: Awaited<ReturnType<typeof openSqliteDb>>) => ({
  schema: (db.prepare('PRAGMA schema_version').get() as { schema_version: number }).schema_version,
  data: (db.prepare('PRAGMA data_version').get() as { data_version: number }).data_version,
  version: (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
});

test('W6: normal Kernel opens do not re-run schema DDL or persistent data backfills', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-w6-hot-open-'));
  try {
    const first = await openKernelStateStore({ runtimeHome });
    try {
      first.createRun({
        runId: 'w6-live-run', projectId: 'w6-project',
        objective: 'persistent live Run must survive fast open',
        sourceIdentity: 'sha256:' + 'a'.repeat(64),
      });
    } finally {
      first.close();
    }
    const observer = await openSqliteDb(kernelDbPath(runtimeHome));
    try {
      const baseline = readSqliteVersions(observer);
      assert.equal(baseline.version, 1);
      assert.equal(
        (observer.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode,
        'wal',
      );
      for (let i = 0; i < 3; i += 1) {
        const reopened = await openKernelStateStore({ runtimeHome });
        try {
          assert.equal(reopened.getRun('w6-live-run')?.status, 'active');
        } finally {
          reopened.close();
        }
      }
      assert.deepEqual(readSqliteVersions(observer), baseline,
        'repeated DB open must not run DDL or UPDATE when schema is current');
    } finally {
      observer.close();
    }
  } finally {
    await rm(runtimeHome, { recursive: true, force: true });
  }
});

test('W6: legacy schema is upgraded once, while a newer schema revision fails closed', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-w6-legacy-open-'));
  try {
    const original = await openKernelStateStore({ runtimeHome });
    original.close();
    const db = await openSqliteDb(kernelDbPath(runtimeHome));
    try {
      db.exec('DROP INDEX IF EXISTS idx_run_steps_run');
      db.exec('PRAGMA user_version=0');
    } finally {
      db.close();
    }
    const migrated = await openKernelStateStore({ runtimeHome });
    migrated.close();
    const observer = await openSqliteDb(kernelDbPath(runtimeHome));
    try {
      const now = readSqliteVersions(observer);
      assert.equal(now.version, 1);
      assert.ok(observer.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_run_steps_run'",
      ).get(), 'missing legacy index must be rebuilt once');
      const hot = await openKernelStateStore({ runtimeHome });
      hot.close();
      assert.deepEqual(readSqliteVersions(observer), now);
      observer.exec('PRAGMA user_version=2');
      const future = readSqliteVersions(observer);
      await assert.rejects(
        openKernelStateStore({ runtimeHome }),
        /KERNEL_SQLITE_SCHEMA_REVISION_UNSUPPORTED/,
      );
      assert.deepEqual(readSqliteVersions(observer), future,
        'older code must not downgrade or rewrite a newer DB');
    } finally {
      observer.close();
    }
  } finally {
    await rm(runtimeHome, { recursive: true, force: true });
  }
});
