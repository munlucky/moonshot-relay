import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { openSqliteDb } from '../src/kernel/sqlite-adapter.js';
import { openKernelStateStore, kernelDbPath } from '../src/kernel/state-store.js';

// A disposable child intentionally stops with an uncommitted transaction.
// The test never touches an account runtime or any live user process.
const crashWriter = [
  "import { DatabaseSync } from 'node:sqlite';",
  'const db = new DatabaseSync(process.argv[1]);',
  'db.exec("BEGIN IMMEDIATE");',
  'db.prepare("INSERT INTO meta(key,value) VALUES (?,?)").run("w6b-aborted-write","uncommitted");',
  'process.exit(37);',
].join('\n');

test('W6-B: killed SQLite writer rolls back without losing committed Work', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-w6b-restart-'));
  try {
    const initial = await openKernelStateStore({ runtimeHome });
    try {
      initial.createRun({
        runId: 'w6b-persisted-run',
        projectId: 'w6b-project',
        objective: 'ensure completed transaction survives child crash',
        sourceIdentity: 'sha256:' + 'f'.repeat(64),
      });
    } finally {
      initial.close();
    }

    const dbPath = kernelDbPath(runtimeHome);
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', crashWriter, dbPath], {
      encoding: 'utf8',
      timeout: 15_000,
    });
    assert.equal(child.status, 37, child.stderr || String(child.error));

    const recovered = await openKernelStateStore({ runtimeHome });
    try {
      assert.equal(recovered.getRun('w6b-persisted-run')?.status, 'active');
      const db = await openSqliteDb(dbPath);
      try {
        assert.equal(db.prepare("SELECT value FROM meta WHERE key='w6b-aborted-write'").get(), undefined);
        assert.equal(
          (db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check,
          'ok',
        );
      } finally {
        db.close();
      }
    } finally {
      recovered.close();
    }
  } finally {
    await rm(runtimeHome, { recursive: true, force: true });
  }
});

test('W6-B: a locked SQLite writer fails explicitly then recovers on release', async () => {
  const runtimeHome = await mkdtemp(path.join(os.tmpdir(), 'kernel-w6b-contention-'));
  try {
    const initial = await openKernelStateStore({ runtimeHome });
    initial.close();

    const first = await openSqliteDb(kernelDbPath(runtimeHome));
    const second = await openSqliteDb(kernelDbPath(runtimeHome));
    try {
      // Exercise the adapter's bounded SQLITE_BUSY retry, without its
      // production 5s timeout slowing the regression.
      second.exec('PRAGMA busy_timeout=1');
      first.exec('BEGIN IMMEDIATE');
      try {
        first.prepare('INSERT INTO meta(key,value) VALUES (?,?)').run('w6b-owner', 'committed');
        assert.throws(
          () => second.prepare('INSERT INTO meta(key,value) VALUES (?,?)').run('w6b-peer', 'retry'),
          (error: unknown) => (
            error instanceof Error && 'code' in error && error.code === 'SQLITE_BUSY'
          ),
          'contending writer must not silently succeed or write through a lock',
        );
      } finally {
        first.exec('COMMIT');
      }
      second.prepare('INSERT INTO meta(key,value) VALUES (?,?)').run('w6b-peer', 'retry');
      assert.deepEqual(
        (second.prepare('SELECT key,value FROM meta WHERE key LIKE ? ORDER BY key').all('w6b-%') as Array<{ key: string; value: string }>).map((row) => ({ ...row })),
        [
          { key: 'w6b-owner', value: 'committed' },
          { key: 'w6b-peer', value: 'retry' },
        ],
      );
    } finally {
      second.close();
      first.close();
    }
    const reopened = await openKernelStateStore({ runtimeHome });
    reopened.close();
  } finally {
    await rm(runtimeHome, { recursive: true, force: true });
  }
});
