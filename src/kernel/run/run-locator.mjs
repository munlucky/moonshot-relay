import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { atomicWriteText } from '../durable-write.mjs';
import {
  KERNEL_DEFAULT_HOME,
  canonicalPath,
  resolveProjectTrackScope,
} from '../runtime-home.mjs';

export const RUN_LOCATOR_SCHEMA_VERSION = 1;

const require = createRequire(import.meta.url);
let openReadonlyRuntimeDb = null;
try {
  const BetterSqlite3 = require('better-sqlite3');
  openReadonlyRuntimeDb = (dbPath) => new BetterSqlite3(dbPath, {
    readonly: true,
    fileMustExist: true,
  });
} catch {
  try {
    const { DatabaseSync } = require('node:sqlite');
    openReadonlyRuntimeDb = (dbPath) => new DatabaseSync(dbPath, {
      readOnly: true,
    });
  } catch {
    // The Kernel package normally has either node:sqlite or better-sqlite3.
    // Discovery must still fail closed if neither read-only validator loads.
  }
}

const normalizedPath = (value) => {
  if (!value) return null;
  const normalized = String(value).replaceAll('\\', '/').replace(/\/+$/u, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
};

const samePath = (left, right) => normalizedPath(left) === normalizedPath(right);

const accountKernelHome = () => canonicalPath(KERNEL_DEFAULT_HOME);

// The normal locator is kept under the Kernel account/runtime boundary, which
// lets a fresh default-runtime session find a Run after its ambient home has
// changed. An explicitly isolated runtime keeps a local locator by design, so
// tests and disposable environments do not mutate the account index; callers
// that need a shared custom runtime can provide an explicit locatorRoot.
export const runLocatorRoot = (runtimeHome = KERNEL_DEFAULT_HOME) => {
  const runtime = canonicalPath(runtimeHome);
  const account = accountKernelHome();
  const root = normalizedPath(runtime) === normalizedPath(account) ? account : runtime;
  return path.join(root, 'state', 'run-locator');
};

const fileNameForRun = (runId) => {
  const value = String(runId || '').trim();
  if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) return `${value}.json`;
  return `run-${createHash('sha256').update(value).digest('hex')}.json`;
};

export const runLocatorPath = ({ runId, locatorRoot = null, runtimeHome = KERNEL_DEFAULT_HOME } = {}) =>
  path.join(locatorRoot || runLocatorRoot(runtimeHome), fileNameForRun(runId));

const locatorStatus = (run) => String(run?.status || 'active');

const normalizeEntries = (entries) => (Array.isArray(entries) ? entries : [])
  .map((entry) => {
    if (Array.isArray(entry)) return { path: String(entry[0] || ''), digest: String(entry[1] || '') };
    return { path: String(entry?.path || ''), digest: String(entry?.digest || '') };
  })
  .filter((entry) => entry.path && entry.digest);

export const buildRunLocatorRecord = ({
  run,
  runtimeHome,
  projectRoot = null,
  projectIdentity = null,
  worktree = null,
  previous = null,
} = {}) => {
  if (!run?.runId) throw new Error('run locator requires a runId');
  const scope = projectIdentity || (projectRoot ? resolveProjectTrackScope(projectRoot) : {});
  const worktreeScope = worktree || {};
  const timestamp = new Date().toISOString();
  return {
    schemaVersion: RUN_LOCATOR_SCHEMA_VERSION,
    runId: String(run.runId),
    taskHandle: String(run.runId),
    runtimeHome: canonicalPath(runtimeHome),
    projectId: run.projectId || projectIdentity?.projectId || null,
    workspaceId: run.workspaceId || worktreeScope.workspaceId || null,
    worktreeId: run.worktreeId || worktreeScope.worktreeId || null,
    canonicalRoot: projectIdentity?.canonicalRoot || scope.canonicalRoot || null,
    gitCommonDir: projectIdentity?.gitCommonDir || worktreeScope.gitCommonDir || scope.gitCommonDir || null,
    gitWorktreeDir: worktreeScope.canonicalGitDir || scope.gitWorktreeDir || null,
    status: locatorStatus(run),
    state: run.state || run.currentState || null,
    finalizationStatus: run.finalizationStatus || null,
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
} = {}) => {
  const filePath = runLocatorPath({ runId: run?.runId, locatorRoot, runtimeHome });
  let previous = null;
  try {
    previous = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {}
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

const readLocatorFile = (filePath) => {
  try {
    const record = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (record?.schemaVersion !== RUN_LOCATOR_SCHEMA_VERSION || !record.runId || !record.runtimeHome) return null;
    return {
      ...record,
      runtimeHome: canonicalPath(record.runtimeHome),
      taskHandle: record.taskHandle || record.runId,
      projectId: record.projectId || null,
      workspaceId: record.workspaceId || null,
      worktreeId: record.worktreeId || null,
      canonicalRoot: normalizedPath(record.canonicalRoot),
      gitCommonDir: normalizedPath(record.gitCommonDir),
      gitWorktreeDir: normalizedPath(record.gitWorktreeDir),
    };
  } catch {
    return null;
  }
};

export const readRunLocator = ({ runId, locatorRoot = null, runtimeHome = KERNEL_DEFAULT_HOME } = {}) =>
  readLocatorFile(runLocatorPath({ runId, locatorRoot, runtimeHome }));

export const listRunLocators = ({ locatorRoot = null, runtimeHome = KERNEL_DEFAULT_HOME } = {}) => {
  const root = locatorRoot || runLocatorRoot(runtimeHome);
  let names;
  try {
    names = fs.readdirSync(root);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    return [];
  }
  return names
    .filter((name) => name.endsWith('.json'))
    .map((name) => readLocatorFile(path.join(root, name)))
    .filter(Boolean);
};

const MUTABLE_RUN_STATUSES = new Set(['active', 'blocked']);

const dedupeCandidates = (records) => {
  const seen = new Set();
  return records.filter((record) => {
    const key = `${record.runId}\0${normalizedPath(record.runtimeHome)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const runtimeStateDbPath = (runtimeHome) =>
  path.join(canonicalPath(runtimeHome), 'state', 'runtime-state.sqlite');

const locatorCandidateSummary = (record, validation = null) => ({
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
export const validateRunLocatorRuntime = (record) => {
  if (!record?.runId || !record?.runtimeHome) {
    return { status: 'stale', reason: 'locator-record-invalid' };
  }

  const dbPath = runtimeStateDbPath(record.runtimeHome);
  if (!fs.existsSync(dbPath)) return { status: 'stale', reason: 'runtime-db-missing' };
  if (!openReadonlyRuntimeDb) return { status: 'stale', reason: 'runtime-state-reader-unavailable' };

  let db = null;
  try {
    db = openReadonlyRuntimeDb(dbPath);
    const runsTable = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'runs'",
    ).get();
    if (!runsTable) return { status: 'stale', reason: 'runtime-state-schema-missing' };

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
      runStatus: row.runStatus || null,
      runState: row.runState || null,
      finalizationStatus: row.finalizationStatus || null,
    };
  } catch (error) {
    return {
      status: 'stale',
      reason: error?.code === 'SQLITE_NOTADB' ? 'runtime-state-invalid' : 'runtime-state-unreadable',
    };
  } finally {
    try { db?.close(); } catch {}
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
} = {}) => {
  const resolvedHome = runtimeHome || KERNEL_DEFAULT_HOME;
  const records = listRunLocators({ locatorRoot, runtimeHome: resolvedHome });
  const requested = runId ? String(runId) : null;
  const scope = projectRoot ? resolveProjectTrackScope(projectRoot) : null;
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
  const valid = validations.filter(({ validation }) => validation.status === 'valid');
  const stale = validations.filter(({ validation }) => validation.status !== 'valid');

  // Lifecycle mutability comes from the authoritative Run row, not from the
  // JSON locator. A terminal Run may still be addressed explicitly by run id
  // for status/diagnostics, but it must not win project/worktree resume
  // discovery over a genuinely active/blocked Run.
  const selectable = valid.filter(({ validation }) => (
    requested || MUTABLE_RUN_STATUSES.has(validation.runStatus)
  ));

  if (selectable.length === 1) {
    return {
      status: 'resolved',
      runtimeHome: selectable[0].candidate.runtimeHome,
      locator: selectable[0].candidate,
      candidates: selectable.map(({ candidate }) => candidate),
    };
  }
  if (selectable.length > 1) {
    return {
      status: 'ambiguous',
      runtimeHome: null,
      locator: null,
      candidates: selectable.map(({ candidate }) => locatorCandidateSummary(candidate)),
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
      candidates: validations.map(({ candidate, validation }) => locatorCandidateSummary(candidate, validation)),
      stale: stale.map(({ candidate, validation }) => locatorCandidateSummary(candidate, validation)),
    };
  }
  return { status: 'not-found', runtimeHome: null, locator: null, candidates: [] };
};

export const normalizeRunLocatorEntries = normalizeEntries;
