const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const normalizeError = (error) => {
  if (/constraint/i.test(String(error?.code || error?.message))) error.code = error.code || 'SQLITE_CONSTRAINT';
  return error;
};

const withBusyRetry = (operation, { retries = 3 } = {}) => {
  let attempt = 0;
  while (true) {
    try {
      return operation();
    } catch (error) {
      const busy = error?.code === 'SQLITE_BUSY' || /database is (?:locked|busy)/i.test(String(error?.message || ''));
      if (!busy || attempt >= retries) throw normalizeError(error);
      sleepSync([10, 25, 50][attempt] || 50);
      attempt += 1;
    }
  }
};

const wrapDatabase = (db) => ({
  exec: (sql) => withBusyRetry(() => db.exec(sql)),
  prepare: (sql) => {
    const statement = db.prepare(sql);
    return {
      run: (...params) => withBusyRetry(() => statement.run(...params)),
      get: (...params) => withBusyRetry(() => statement.get(...params)),
      all: (...params) => withBusyRetry(() => statement.all(...params)),
    };
  },
  transaction: (fn) => (...args) => {
    withBusyRetry(() => db.exec('BEGIN IMMEDIATE'));
    try {
      const result = fn(...args);
      db.exec('COMMIT');
      return result;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw normalizeError(error);
    }
  },
  close: () => db.close(),
});

export const openSqliteDb = async (dbPath, { backend = 'auto' } = {}) => {
  let DatabaseSync = null;
  if (backend !== 'better-sqlite3') {
    try {
      const mod = await import('node:sqlite');
      DatabaseSync = mod.DatabaseSync;
    } catch (error) {
      if (backend === 'node:sqlite') throw error;
      if (error.code !== 'ERR_UNKNOWN_BUILTIN_MODULE' && !error.message?.includes('node:sqlite')) throw error;
    }
  }

  if (DatabaseSync) return wrapDatabase(new DatabaseSync(dbPath));

  const { default: Database } = await import('better-sqlite3');
  return wrapDatabase(new Database(dbPath));
};
