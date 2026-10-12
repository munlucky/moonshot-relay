export interface SqliteStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface SqliteDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): SqliteStatement;
  transaction<TArgs extends unknown[], TResult>(fn: (...args: TArgs) => TResult): (...args: TArgs) => TResult;
  close(): void;
}

interface RawStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

interface RawDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): RawStatement;
  close(): void;
}

interface ErrorLike extends Error {
  code?: string;
}

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const asError = (error: unknown): ErrorLike => (
  error instanceof Error ? error as ErrorLike : Object.assign(new Error(String(error)), { cause: error })
);

const normalizeError = (error: unknown): ErrorLike => {
  const normalized = asError(error);
  if (/constraint/i.test(String(normalized.code || normalized.message))) {
    normalized.code = normalized.code || 'SQLITE_CONSTRAINT';
  }
  return normalized;
};

const withBusyRetry = <T>(operation: () => T, { retries = 3 }: { retries?: number } = {}): T => {
  let attempt = 0;
  while (true) {
    try {
      return operation();
    } catch (error) {
      const normalized = asError(error);
      const busy = normalized.code === 'SQLITE_BUSY'
        || /database is (?:locked|busy)/i.test(normalized.message);
      if (!busy || attempt >= retries) throw normalizeError(normalized);
      sleepSync([10, 25, 50][attempt] || 50);
      attempt += 1;
    }
  }
};

const wrapDatabase = (db: RawDatabase): SqliteDatabase => ({
  exec: (sql) => withBusyRetry(() => db.exec(sql)),
  prepare: (sql) => {
    const statement = db.prepare(sql);
    return {
      run: (...params) => withBusyRetry(() => statement.run(...params)),
      get: (...params) => withBusyRetry(() => statement.get(...params)),
      all: (...params) => withBusyRetry(() => statement.all(...params)),
    };
  },
  transaction: <TArgs extends unknown[], TResult>(fn: (...args: TArgs) => TResult) => (...args: TArgs) => {
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

export const openSqliteDb = async (
  dbPath: string,
  { backend = 'auto' }: { backend?: 'auto' | 'node:sqlite' | 'better-sqlite3' } = {},
): Promise<SqliteDatabase> => {
  let DatabaseSync: (new (path: string) => RawDatabase) | null = null;

  if (backend !== 'better-sqlite3') {
    try {
      const mod = await import('node:sqlite');
      DatabaseSync = mod.DatabaseSync as unknown as new (path: string) => RawDatabase;
    } catch (error) {
      const normalized = asError(error);
      if (backend === 'node:sqlite') throw normalized;
      if (normalized.code !== 'ERR_UNKNOWN_BUILTIN_MODULE' && !normalized.message.includes('node:sqlite')) {
        throw normalized;
      }
    }
  }

  if (DatabaseSync) return wrapDatabase(new DatabaseSync(dbPath));

  const { default: Database } = await import('better-sqlite3');
  return wrapDatabase(new Database(dbPath) as unknown as RawDatabase);
};
