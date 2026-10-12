import { requiredIndex } from '../../shared/required-index.js';
import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { atomicWriteText } from '../durable-write.js';
import {
  KERNEL_DEFAULT_HOME,
  canonicalPath,
  resolveProjectTrackScope,
} from '../runtime-home.js';

type UnknownRecord = Record<string, unknown>;

interface ReadonlyStatement {
  get(...params: unknown[]): UnknownRecord | undefined;
}

interface ReadonlyRuntimeDb {
  prepare(sql: string): ReadonlyStatement;
  close(): void;
}

type OpenReadonlyRuntimeDb = (dbPath: string) => ReadonlyRuntimeDb;

interface BetterSqlite3Constructor {
  new (
    dbPath: string,
    options: { readonly: true; fileMustExist: true },
  ): {
    prepare(sql: string): {
      get(...params: unknown[]): unknown;
    };
    close(): void;
  };
}

interface ProjectIdentityLike extends UnknownRecord {
  projectId?: unknown;
  canonicalRoot?: unknown;
  gitCommonDir?: unknown;
  gitWorktreeDir?: unknown;
}

interface WorktreeLike extends UnknownRecord {
  workspaceId?: unknown;
  worktreeId?: unknown;
  gitCommonDir?: unknown;
  canonicalGitDir?: unknown;
}

interface RunLike extends UnknownRecord {
  runId?: unknown;
  projectId?: unknown;
  workspaceId?: unknown;
  worktreeId?: unknown;
  status?: unknown;
  state?: unknown;
  currentState?: unknown;
  finalizationStatus?: unknown;
}

export interface RunLocatorRecord extends UnknownRecord {
  schemaVersion: 1;
  runId: string;
  taskHandle: string;
  runtimeHome: string;
  projectId: string | null;
  workspaceId: string | null;
  worktreeId: string | null;
  canonicalRoot: string | null;
  gitCommonDir: string | null;
  gitWorktreeDir: string | null;
  status: string;
  state: string | null;
  finalizationStatus: string | null;
  createdAt: string;
  updatedAt: string;
}

export type RunLocatorValidation =
  | {
      status: 'valid';
      runStatus: string | null;
      runState: string | null;
      finalizationStatus: string | null;
    }
  | {
      status: 'stale';
      reason: string;
    };

const recordOf = (value: unknown): UnknownRecord | null => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : null
);

const optionalString = (value: unknown): string | null => (
  value === null || value === undefined || value === ''
    ? null
    : String(value)
);

const adaptReadonlyDb = (db: {
  prepare(sql: string): { get(...params: unknown[]): unknown };
  close(): void;
}): ReadonlyRuntimeDb => ({
  prepare(sql: string): ReadonlyStatement {
    const statement = db.prepare(sql);
    return {
      get(...params: unknown[]): UnknownRecord | undefined {
        const value = statement.get(...params);
        return recordOf(value) || undefined;
      },
    };
  },
  close(): void {
    db.close();
  },
});

export const RUN_LOCATOR_SCHEMA_VERSION = 1;

const require = createRequire(import.meta.url);
let openReadonlyRuntimeDb: OpenReadonlyRuntimeDb | null = null;
try {
  const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
  openReadonlyRuntimeDb = (dbPath: string) => adaptReadonlyDb(
    new DatabaseSync(dbPath, {
      readOnly: true,
    }),
  );
} catch {
  try {
    const BetterSqlite3 = require('better-sqlite3') as BetterSqlite3Constructor;
    openReadonlyRuntimeDb = (dbPath: string) => adaptReadonlyDb(
      new BetterSqlite3(dbPath, {
        readonly: true,
        fileMustExist: true,
      }),
    );
  } catch {
    // The Kernel package normally has either node:sqlite or better-sqlite3.
    // Discovery must still fail closed if neither read-only validator loads.
  }
}

const normalizedPath = (value: unknown): string | null => {
  if (!value) return null;
  const normalized = String(value).replaceAll('\\', '/').replace(/\/+$/u, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
};

const samePath = (left: unknown, right: unknown): boolean => (
  normalizedPath(left) === normalizedPath(right)
);

const accountKernelHome = (): string => canonicalPath(KERNEL_DEFAULT_HOME);

// The normal locator is kept under the Kernel account/runtime boundary, which
// lets a fresh default-runtime session find a Run after its ambient home has
// changed. An explicitly isolated runtime keeps a local locator by design, so
// tests and disposable environments do not mutate the account index; callers
// that need a shared custom runtime can provide an explicit locatorRoot.
export const runLocatorRoot = (
  runtimeHome: string = KERNEL_DEFAULT_HOME,
): string => {
  const runtime = canonicalPath(runtimeHome);
  const account = accountKernelHome();
  const root = normalizedPath(runtime) === normalizedPath(account)
    ? account
    : runtime;
  return path.join(root, 'state', 'run-locator');
};

const fileNameForRun = (runId: unknown): string => {
  const value = String(runId || '').trim();
  if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) {
    return `${value}.json`;
  }
  return `run-${createHash('sha256').update(value).digest('hex')}.json`;
};

export const runLocatorPath = ({
  runId,
  locatorRoot = null,
  runtimeHome = KERNEL_DEFAULT_HOME,
}: {
  runId?: unknown;
  locatorRoot?: string | null;
  runtimeHome?: (string) | undefined;
} = {}): string => path.join(
  locatorRoot || runLocatorRoot(runtimeHome),
  fileNameForRun(runId),
);

const locatorStatus = (run: RunLike | null | undefined): string => (
  String(run?.status || 'active')
);

const normalizeEntries = (
  entries: unknown,
): Array<{ path: string; digest: string }> => (
  Array.isArray(entries) ? entries : []
)
  .map((entry) => {
    if (Array.isArray(entry)) {
      return {
        path: String(entry[0] || ''),
        digest: String(entry[1] || ''),
      };
    }
    const record = recordOf(entry);
    return {
      path: String(record?.path || ''),
      digest: String(record?.digest || ''),
    };
  })
  .filter((entry) => entry.path && entry.digest);

const identityLike = (value: unknown): ProjectIdentityLike => (
  recordOf(value) || {}
);

const worktreeLike = (value: unknown): WorktreeLike => (
  recordOf(value) || {}
);

export const buildRunLocatorRecord = ({
  run,
  runtimeHome,
  projectRoot = null,
  projectIdentity = null,
  worktree = null,
  previous = null,
}: {
  run?: (RunLike | null) | undefined;
  runtimeHome?: (string) | undefined;
  projectRoot?: string | null;
  projectIdentity?: ProjectIdentityLike | null;
  worktree?: WorktreeLike | null;
  previous?: Partial<RunLocatorRecord> | null;
} = {}): RunLocatorRecord => {
  if (!run?.runId) throw new Error('run locator requires a runId');
  const scope = identityLike(
    projectIdentity
      || (projectRoot ? resolveProjectTrackScope(projectRoot) : {}),
  );
  const project = identityLike(projectIdentity);
  const worktreeScope = worktreeLike(worktree);
  const timestamp = new Date().toISOString();
  return {
    schemaVersion: RUN_LOCATOR_SCHEMA_VERSION,
    runId: String(run.runId),
    taskHandle: String(run.runId),
    runtimeHome: canonicalPath(runtimeHome || KERNEL_DEFAULT_HOME),
    projectId: optionalString(run.projectId || project.projectId),
    workspaceId: optionalString(run.workspaceId || worktreeScope.workspaceId),
    worktreeId: optionalString(run.worktreeId || worktreeScope.worktreeId),
    canonicalRoot: optionalString(project.canonicalRoot || scope.canonicalRoot),
    gitCommonDir: optionalString(
      project.gitCommonDir || worktreeScope.gitCommonDir || scope.gitCommonDir,
    ),
    gitWorktreeDir: optionalString(
      worktreeScope.canonicalGitDir || scope.gitWorktreeDir,
    ),
    status: locatorStatus(run),
    state: optionalString(run.state || run.currentState),
    finalizationStatus: optionalString(run.finalizationStatus),
    createdAt: previous?.createdAt || timestamp,
    updatedAt: timestamp,
  };
};

export const writeRunLocator = async ({
  run,
  runtimeHome,
  projectRoot = null,
  projectIdentity = null,
  worktree = null,
  locatorRoot = null,
}: {
  run?: RunLike | null;
  runtimeHome?: string;
  projectRoot?: string | null;
  projectIdentity?: ProjectIdentityLike | null;
  worktree?: WorktreeLike | null;
  locatorRoot?: string | null;
} = {}): Promise<RunLocatorRecord> => {
  const filePath = runLocatorPath({
    runId: run?.runId,
    locatorRoot,
    runtimeHome,
  });
  let previous: Partial<RunLocatorRecord> | null = null;
  try {
    previous = recordOf(
      JSON.parse(fs.readFileSync(filePath, 'utf8')),
    ) as Partial<RunLocatorRecord> | null;
  } catch {
    previous = null;
  }
  const record = buildRunLocatorRecord({
    run,
    runtimeHome,
    projectRoot,
    projectIdentity,
    worktree,
    previous,
  });
  await atomicWriteText(filePath, `${JSON.stringify(record, null, 2)}\n`);
  return record;
};

const readLocatorFile = (filePath: string): RunLocatorRecord | null => {
  try {
    const parsed = recordOf(JSON.parse(fs.readFileSync(filePath, 'utf8')));
    if (
      !parsed
      || parsed.schemaVersion !== RUN_LOCATOR_SCHEMA_VERSION
      || !parsed.runId
      || !parsed.runtimeHome
    ) {
      return null;
    }
    const createdAt = optionalString(parsed.createdAt);
    const updatedAt = optionalString(parsed.updatedAt);
    if (!createdAt || !updatedAt) return null;
    return {
      ...parsed,
      schemaVersion: RUN_LOCATOR_SCHEMA_VERSION,
      runId: String(parsed.runId),
      runtimeHome: canonicalPath(String(parsed.runtimeHome)),
      taskHandle: String(parsed.taskHandle || parsed.runId),
      projectId: optionalString(parsed.projectId),
      workspaceId: optionalString(parsed.workspaceId),
      worktreeId: optionalString(parsed.worktreeId),
      canonicalRoot: normalizedPath(parsed.canonicalRoot),
      gitCommonDir: normalizedPath(parsed.gitCommonDir),
      gitWorktreeDir: normalizedPath(parsed.gitWorktreeDir),
      status: String(parsed.status || 'active'),
      state: optionalString(parsed.state),
      finalizationStatus: optionalString(parsed.finalizationStatus),
      createdAt,
      updatedAt,
    };
  } catch {
    return null;
  }
};

export const readRunLocator = ({
  runId,
  locatorRoot = null,
  runtimeHome = KERNEL_DEFAULT_HOME,
}: {
  runId?: unknown;
  locatorRoot?: string | null;
  runtimeHome?: string;
} = {}): RunLocatorRecord | null => readLocatorFile(
  runLocatorPath({ runId, locatorRoot, runtimeHome }),
);

export const listRunLocators = ({
  locatorRoot = null,
  runtimeHome = KERNEL_DEFAULT_HOME,
}: {
  locatorRoot?: string | null;
  runtimeHome?: string;
} = {}): RunLocatorRecord[] => {
  const root = locatorRoot || runLocatorRoot(runtimeHome);
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith('.json'))
    .map((name) => readLocatorFile(path.join(root, name)))
    .filter((record): record is RunLocatorRecord => Boolean(record));
};

const MUTABLE_RUN_STATUSES = new Set(['active', 'blocked']);

const dedupeCandidates = (records: RunLocatorRecord[]): RunLocatorRecord[] => {
  const seen = new Set<string>();
  return records.filter((record) => {
    const key = `${record.runId}\0${normalizedPath(record.runtimeHome)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const runtimeStateDbPath = (runtimeHome: string): string => (
  path.join(canonicalPath(runtimeHome), 'state', 'runtime-state.sqlite')
);

const locatorCandidateSummary = (
  record: RunLocatorRecord,
  validation: RunLocatorValidation | null = null,
) => ({
  runId: record.runId,
  taskHandle: record.taskHandle || record.runId,
  runtimeHome: record.runtimeHome,
  projectId: record.projectId,
  workspaceId: record.workspaceId,
  worktreeId: record.worktreeId,
  status: record.status || null,
  updatedAt: record.updatedAt || null,
  ...(validation ? {
    validation: validation.status === 'valid'
      ? { status: 'valid' }
      : { status: 'stale', reason: validation.reason },
  } : {}),
});

// A locator is only an address book. Before discovery can select it, prove
// that the addressed runtime and the exact Run still exist. This is
// deliberately synchronous and read-only because the CLI performs discovery
// before it opens the authoritative state store; importantly, a stale locator
// must never cause openKernelStateStore() to create a replacement database.
export const validateRunLocatorRuntime = (
  record: RunLocatorRecord | null | undefined,
): RunLocatorValidation => {
  if (!record?.runId || !record?.runtimeHome) {
    return { status: 'stale', reason: 'locator-record-invalid' };
  }

  const dbPath = runtimeStateDbPath(record.runtimeHome);
  if (!fs.existsSync(dbPath)) {
    return { status: 'stale', reason: 'runtime-db-missing' };
  }
  if (!openReadonlyRuntimeDb) {
    return { status: 'stale', reason: 'runtime-state-reader-unavailable' };
  }

  let db: ReadonlyRuntimeDb | null = null;
  try {
    db = openReadonlyRuntimeDb(dbPath);
    const runsTable = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'runs'",
    ).get();
    if (!runsTable) {
      return { status: 'stale', reason: 'runtime-state-schema-missing' };
    }

    const row = db.prepare(`
      SELECT
        run_id AS runId,
        project_id AS projectId,
        workspace_id AS workspaceId,
        worktree_id AS worktreeId,
        status AS runStatus,
        state AS runState,
        finalization_status AS finalizationStatus
      FROM runs
      WHERE run_id = ?
    `).get(record.runId);
    if (!row) return { status: 'stale', reason: 'run-not-found' };
    if (record.projectId && row.projectId !== record.projectId) {
      return { status: 'stale', reason: 'project-mismatch' };
    }
    if (record.workspaceId && row.workspaceId !== record.workspaceId) {
      return { status: 'stale', reason: 'workspace-mismatch' };
    }
    if (record.worktreeId && row.worktreeId !== record.worktreeId) {
      return { status: 'stale', reason: 'worktree-mismatch' };
    }
    return {
      status: 'valid',
      runStatus: optionalString(row.runStatus),
      runState: optionalString(row.runState),
      finalizationStatus: optionalString(row.finalizationStatus),
    };
  } catch (error: unknown) {
    const code = error && typeof error === 'object' && 'code' in error
      ? String(error.code)
      : '';
    return {
      status: 'stale',
      reason: code === 'SQLITE_NOTADB'
        ? 'runtime-state-invalid'
        : 'runtime-state-unreadable',
    };
  } finally {
    try {
      db?.close();
    } catch {
      // Read-only validation is fail-soft; close errors cannot authorize a Run.
    }
  }
};

// Runtime discovery is intentionally a locator operation, not a state
// authority. It only selects which existing SQLite runtime to open; the
// selected runtime still validates the Run, owner binding, and completion.
export const discoverRunLocator = ({
  runId = null,
  projectRoot = null,
  locatorRoot = null,
  runtimeHome = KERNEL_DEFAULT_HOME,
}: {
  runId?: string | null;
  projectRoot?: string | null;
  locatorRoot?: string | null;
  runtimeHome?: (string) | undefined;
} = {}) => {
  const resolvedHome = runtimeHome || KERNEL_DEFAULT_HOME;
  const records = listRunLocators({
    locatorRoot,
    runtimeHome: resolvedHome,
  });
  const requested = runId ? String(runId) : null;
  const scope = projectRoot
    ? identityLike(resolveProjectTrackScope(projectRoot))
    : null;
  const candidates = dedupeCandidates(records.filter((record) => {
    if (requested) return record.runId === requested;
    if (!scope) return false;
    return samePath(record.canonicalRoot, scope.canonicalRoot)
      && samePath(record.gitCommonDir, scope.gitCommonDir)
      && samePath(record.gitWorktreeDir, scope.gitWorktreeDir);
  }));

  const validations = candidates.map((candidate) => ({
    candidate,
    validation: validateRunLocatorRuntime(candidate),
  }));
  const valid = validations.filter(
    ({ validation }) => validation.status === 'valid',
  );
  const stale = validations.filter(
    ({ validation }) => validation.status !== 'valid',
  );

  // Lifecycle mutability comes from the authoritative Run row, not from the
  // JSON locator. A terminal Run may still be addressed explicitly by run id
  // for status/diagnostics, but it must not win project/worktree resume
  // discovery over a genuinely active/blocked Run.
  const selectable = valid.filter(({ validation }) => (
    requested
    || (
      validation.status === 'valid'
      && validation.runStatus !== null
      && MUTABLE_RUN_STATUSES.has(validation.runStatus)
    )
  ));

  if (selectable.length === 1) {
    return {
      status: 'resolved',
      runtimeHome: requiredIndex(selectable, 0).candidate.runtimeHome,
      locator: requiredIndex(selectable, 0).candidate,
      candidates: selectable.map(({ candidate }) => candidate),
    };
  }
  if (selectable.length > 1) {
    return {
      status: 'ambiguous',
      runtimeHome: null,
      locator: null,
      candidates: selectable.map(({ candidate }) => (
        locatorCandidateSummary(candidate)
      )),
    };
  }
  // A stale address-book entry is actionable only when no valid candidate can
  // resume the requested Run/worktree. One obsolete locator must not shadow a
  // different, validated active Run for the same canonical workspace.
  if (stale.length > 0) {
    return {
      status: 'stale',
      runtimeHome: null,
      locator: null,
      candidates: validations.map(({ candidate, validation }) => (
        locatorCandidateSummary(candidate, validation)
      )),
      stale: stale.map(({ candidate, validation }) => (
        locatorCandidateSummary(candidate, validation)
      )),
    };
  }
  return {
    status: 'not-found',
    runtimeHome: null,
    locator: null,
    candidates: [],
  };
};

export const normalizeRunLocatorEntries = normalizeEntries;
