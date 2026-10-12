import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openSqliteDb } from '../src/kernel/sqlite-adapter.js';

const sqliteValue = (row: unknown): string => { assert.ok(row && typeof row === 'object' && 'value' in row && typeof row.value === 'string'); return row.value; };
for (const backend of ['node:sqlite', 'better-sqlite3'] as const) {
  test(`${backend} exposes the common statement and transaction contract`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kernel-sqlite-'));
    const db = await openSqliteDb(path.join(root, 'state.sqlite'), { backend });
    db.exec('CREATE TABLE items(id INTEGER PRIMARY KEY, value TEXT UNIQUE)');
    db.prepare('INSERT INTO items(value) VALUES(?)').run('one');
    assert.equal(sqliteValue(db.prepare('SELECT value FROM items WHERE id=?').get(1)), 'one');
    assert.deepEqual(db.prepare('SELECT value FROM items ORDER BY id').all().map(sqliteValue), ['one']);
    const transaction = db.transaction(() => {
      db.prepare('INSERT INTO items(value) VALUES(?)').run('two');
      throw new Error('rollback');
    });
    assert.throws(transaction, /rollback/);
    assert.deepEqual(db.prepare('SELECT value FROM items ORDER BY id').all().map(sqliteValue), ['one']);
    db.close();
    assert.throws(() => db.prepare('SELECT 1').get());
  });
}
