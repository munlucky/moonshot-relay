import { requiredIndex } from '../../shared/required-index.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { readFile, mkdir, access } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import { atomicWriteText } from '../durable-write.js';
import { canonicalPath, resolveKernelRuntimeHome, assertIsolatedRuntimeHomes } from '../runtime-home.js';
import { resolveKernelProjectIdentity } from '../project-identity.js';

type UnknownRecord = Record<string, unknown>;
type JsonObject = Record<string, unknown>;

interface NamespaceLock {
  fd: number;
  lockPath: string;
  references: number;
}

interface ReentrantNamespaceLock {
  base: NamespaceLock;
  reentrant: true;
}

type NamespaceLockHandle = NamespaceLock | ReentrantNamespaceLock;

interface NamespaceLockOptions {
  allowReentrant?: boolean;
  staleTimeoutMs?: number;
}

interface NamespaceLockRetryOptions extends NamespaceLockOptions {
  retries?: number;
  retryDelayMs?: number;
}

type MigrationPhase =
  | 'prepared'
  | 'staged'
  | 'backup-pending'
  | 'destination-install-pending'
  | 'destination-installed'
  | 'db-pending'
  | 'db-committed'
  | 'sources-preserved'
  | 'sources-removed';

interface MigrationState extends UnknownRecord {
  schemaVersion: 1;
  kind: 'identity-knowledge-migration';
  journal: string;
  sourceRoot: string;
  sourceIds: string[];
  projectId: string;
  canonicalRoot: string;
  identityDigest: string;
  sourceFingerprints: Record<string, string>;
  destination: string;
  stagedDestination: string;
  destinationBackup: string;
  destinationPresenceMarker: string;
  destinationInstalledMarker: string;
  destinationExisted: boolean;
  destinationBackupCreated: boolean;
  destinationBackupPending: boolean;
  destinationInstalled: boolean;
  destinationInstallPending: boolean;
  sourceRemovalBlocked: boolean;
  phase: MigrationPhase;
  updatedAt?: string;
}

interface MigrationOperation {
  migratedProjectIds: string[];
  finalize(): void;
  rollback(): void;
}

interface NamespaceInfo {
  projectsRoot: string;
  lexicalProjectsRoot: string;
  projectId: string;
  filePath: string;
  lockPath: string;
}

const asRecord = (value: unknown): UnknownRecord => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : {}
);

const errorCode = (error: unknown): string => (
  typeof asRecord(error).code === 'string' ? String(asRecord(error).code) : ''
);

const errorMessage = (error: unknown): string => (
  error instanceof Error ? error.message : String(error)
);

export class KernelKnowledgeStoreError extends Error {
  readonly code: string;
  readonly details: UnknownRecord;

  constructor(code: string, message: string, details: UnknownRecord = {}) {
    super(message);
    this.name = 'KernelKnowledgeStoreError';
    this.code = code;
    this.details = details;
  }
}

export function projectKnowledgeDirectory(projectId: string, { env = process.env }: { env?: NodeJS.ProcessEnv } = {}): string {
  const kernelHome = resolveKernelRuntimeHome({ env });
  assertIsolatedRuntimeHomes(kernelHome);
  const root = path.join(kernelHome, 'state', 'projects', safeNamespaceSegment(projectId));
  assertNamespacePathSafe(root, path.join(kernelHome, 'state', 'projects'));
  return root;
}

const safeNamespaceSegment = (value: unknown): string => {
  const segment = String(value || '');
  const windowsReservedName = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i;
  if (
    !segment
    || segment === '.'
    || segment === '..'
    || path.basename(segment) !== segment
    || /[\\/]/.test(segment)
    || /[<>:"|?*\u0000-\u001f\u007f]/.test(segment)
    || /[. ]$/.test(segment)
    || windowsReservedName.test(segment)
  ) {
    throw new KernelKnowledgeStoreError('INVALID_NAMESPACE_ID', `Invalid project knowledge namespace id: ${segment}`);
  }
  return segment;
};

const normalizedIdentityRoot = (value: unknown): string => {
  const raw = String(value || '').trim();
  if (!raw) throw new KernelKnowledgeStoreError('IDENTITY_MIGRATION_JOURNAL_INVALID', 'Identity migration canonicalRoot cannot be empty');
  return path.resolve(raw).replaceAll('\\', '/').toLowerCase();
};

const normalizedFilesystemPath = (value: unknown): string => {
  const resolved = path.resolve(String(value || ''));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

const lstatIfExists = (target: string): fs.Stats | null => {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  }
};

const projectsRootForPath = (target: string): string | null => {
  let current = path.resolve(target);
  while (true) {
    if (path.basename(current).toLowerCase() === 'projects') return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
};

// Resolve the host's system aliases (for example macOS /var -> /private/var)
// without allowing a namespace-owned symlink to redirect a write. The lexical
// walk deliberately starts at the Runtime Home projects boundary, so a stable
// OS alias above that boundary is not mistaken for user-controlled namespace
// indirection.
function assertLexicalNamespacePathSafe(target: string, boundaryRoot: string): string {
  const boundary = path.resolve(boundaryRoot);
  const absoluteTarget = path.resolve(target);
  const relative = path.relative(boundary, absoluteTarget);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new KernelKnowledgeStoreError('NAMESPACE_PATH_ESCAPE', `Knowledge namespace path escapes Runtime Home: ${target}`);
  }
  const components = relative ? relative.split(path.sep).filter(Boolean) : [];
  const paths = [boundary];
  let current = boundary;
  for (const component of components) {
    current = path.join(current, component);
    paths.push(current);
  }
  for (const candidate of paths) {
    const stat = lstatIfExists(candidate);
    if (!stat) continue;
    if (stat.isSymbolicLink()) {
      throw new KernelKnowledgeStoreError('SYMLINK_NAMESPACE_UNSUPPORTED', `Knowledge namespace cannot traverse a symlink or junction: ${candidate}`);
    }
    if (!stat.isDirectory() && normalizedFilesystemPath(candidate) !== normalizedFilesystemPath(absoluteTarget)) {
      throw new KernelKnowledgeStoreError('INVALID_NAMESPACE_ROOT', `Knowledge namespace component is not a directory: ${candidate}`);
    }
  }
  const canonicalBoundary = canonicalPath(boundary);
  const canonicalTarget = canonicalPath(absoluteTarget);
  if (canonicalTarget !== canonicalBoundary && !canonicalTarget.startsWith(`${canonicalBoundary}${path.sep}`)) {
    throw new KernelKnowledgeStoreError('NAMESPACE_PATH_ESCAPE', `Knowledge namespace path resolves outside Runtime Home: ${target}`);
  }
  return canonicalTarget;
}

const namespaceInfoForPath = (target: string): NamespaceInfo | null => {
  const lexicalTarget = path.resolve(target);
  const lexicalProjectsRoot = projectsRootForPath(lexicalTarget);
  if (!lexicalProjectsRoot) return null;
  const canonicalTarget = assertLexicalNamespacePathSafe(lexicalTarget, lexicalProjectsRoot);
  const projectsRoot = canonicalPath(lexicalProjectsRoot);
  const relative = path.relative(projectsRoot, canonicalTarget);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  const projectId = relative.split(path.sep)[0];
  if (!projectId || projectId.startsWith('.')) return null;
  const safeId = safeNamespaceSegment(projectId);
  return {
    projectsRoot,
    lexicalProjectsRoot,
    projectId: safeId,
    filePath: canonicalTarget,
    lockPath: path.join(projectsRoot, `.kernel-namespace-lock-${safeId}`),
  };
};

const lockOwnerPid = (lockPath: string): number | null => {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    return Number.isInteger(parsed?.pid) ? parsed.pid : null;
  } catch {
    return null;
  }
};

const isProcessAlive = (pid: number | null): boolean => {
  if (pid === null || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === 'EPERM';
  }
};

const heldNamespaceLocks = new Map<string, NamespaceLock>();

export const clearStaleNamespaceLock = (lockPath: string, { staleTimeoutMs = 30000 }: { staleTimeoutMs?: number } = {}): boolean => {
  const stat = lstatIfExists(lockPath);
  if (!stat) return false;
  let metadata = null;
  try {
    metadata = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch {}
  const pid = Number.isInteger(metadata?.pid) ? metadata.pid : null;

  if (pid != null) {
    if (isProcessAlive(pid)) {
      return false;
    }
    try {
      fs.unlinkSync(lockPath);
      return true;
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return true;
      throw error;
    }
  }

  // If pid is null/missing (empty or unparseable metadata):
  // Check file mtime. If within staleTimeoutMs, another process is actively creating/writing it.
  const fileAgeMs = Date.now() - stat.mtimeMs;
  if (fileAgeMs > staleTimeoutMs) {
    try {
      fs.unlinkSync(lockPath);
      return true;
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return true;
      throw error;
    }
  }

  return false;
};

export const tryAcquireNamespaceLock = (projectsRoot: string, projectId: string, { allowReentrant = false, staleTimeoutMs = 30000 }: NamespaceLockOptions = {}): NamespaceLockHandle | null => {
  const safeId = safeNamespaceSegment(projectId);
  const lockPath = path.join(projectsRoot, `.kernel-namespace-lock-${safeId}`);
  assertNamespacePathSafe(lockPath, projectsRoot);
  const held = heldNamespaceLocks.get(lockPath);
  if (held) {
    if (!allowReentrant) {
      throw new KernelKnowledgeStoreError('IDENTITY_MIGRATION_LOCKED', `Knowledge namespace is locked for identity migration: ${projectsRoot}/${safeId}`, { lockPath });
    }
    held.references += 1;
    return { base: held, reentrant: true };
  }
  clearStaleNamespaceLock(lockPath, { staleTimeoutMs });
  try {
    const fd = fs.openSync(lockPath, 'wx');
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
    const lock = { fd, lockPath, references: 1 };
    heldNamespaceLocks.set(lockPath, lock);
    return lock;
  } catch (error) {
    if (errorCode(error) === 'EEXIST') return null;
    throw error;
  }
};

export const acquireNamespaceLockWithRetry = async (projectsRoot: string, projectId: string, { allowReentrant = false, retries = 60, retryDelayMs = 50, staleTimeoutMs = 30000 }: NamespaceLockRetryOptions = {}): Promise<NamespaceLockHandle | undefined> => {
  const safeId = safeNamespaceSegment(projectId);
  const lockPath = path.join(projectsRoot, `.kernel-namespace-lock-${safeId}`);
  assertNamespacePathSafe(lockPath, projectsRoot);
  const held = heldNamespaceLocks.get(lockPath);
  if (held) {
    if (!allowReentrant) {
      throw new KernelKnowledgeStoreError('IDENTITY_MIGRATION_LOCKED', `Knowledge namespace is locked for identity migration: ${projectsRoot}/${safeId}`, { lockPath });
    }
    held.references += 1;
    return { base: held, reentrant: true };
  }
  for (let attempt = 0; attempt <= retries; attempt++) {
    clearStaleNamespaceLock(lockPath, { staleTimeoutMs });
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
      const lock = { fd, lockPath, references: 1 };
      heldNamespaceLocks.set(lockPath, lock);
      return lock;
    } catch (error) {
      if (errorCode(error) === 'EEXIST') {
        if (attempt < retries) {
          await sleep(retryDelayMs);
          continue;
        }
        throw new KernelKnowledgeStoreError('IDENTITY_MIGRATION_LOCKED', `Knowledge namespace is locked for identity migration: ${projectsRoot}/${safeId}`, { lockPath });
      }
      throw error;
    }
  }
};

export const acquireNamespaceLock = (projectsRoot: string, projectId: string, { allowReentrant = false, staleTimeoutMs = 30000 }: NamespaceLockOptions = {}): NamespaceLockHandle => {
  const lock = tryAcquireNamespaceLock(projectsRoot, projectId, { allowReentrant, staleTimeoutMs });
  if (!lock) {
    const safeId = safeNamespaceSegment(projectId);
    const lockPath = path.join(projectsRoot, `.kernel-namespace-lock-${safeId}`);
    throw new KernelKnowledgeStoreError('IDENTITY_MIGRATION_LOCKED', `Knowledge namespace is locked for identity migration: ${projectsRoot}/${safeId}`, { lockPath });
  }
  return lock;
};

export const releaseNamespaceLock = (lock: NamespaceLockHandle | null | undefined): void => {
  if (!lock) return;
  const base = 'base' in lock ? lock.base : lock;
  base.references -= 1;
  if (base.references > 0) return;
  heldNamespaceLocks.delete(base.lockPath);
  try { fs.closeSync(base.fd); } catch (error) { if (errorCode(error) !== 'EBADF') throw error; }
  try { fs.unlinkSync(base.lockPath); } catch (error) { if (errorCode(error) !== 'ENOENT') throw error; }
};

export const acquireNamespaceLocks = (projectsRoot: string, projectIds: string[], { allowReentrant = false, staleTimeoutMs = 30000 }: NamespaceLockOptions = {}): NamespaceLockHandle[] => {
  const locks: NamespaceLockHandle[] = [];
  try {
    for (const projectId of [...new Set(projectIds)].sort()) locks.push(acquireNamespaceLock(projectsRoot, projectId, { allowReentrant, staleTimeoutMs }));
    return locks;
  } catch (error) {
    for (const lock of locks.reverse()) releaseNamespaceLock(lock);
    throw error;
  }
};

const releaseOwnedNamespaceLocks = (projectsRoot: string, projectIds: string[]): void => {
  for (const projectId of [...new Set(projectIds)].sort()) {
    const safeId = safeNamespaceSegment(projectId);
    const lockPath = path.join(projectsRoot, `.kernel-namespace-lock-${safeId}`);
    const held = heldNamespaceLocks.get(lockPath);
    if (!held) continue;
    held.references = 1;
    releaseNamespaceLock(held);
  }
};

// Lexical path checks are insufficient on Windows because junctions/reparse
// points can redirect an apparently contained path outside Runtime Home.
// Walk each existing component and compare its native real path with the
// requested path before any read, write, rename, or removal.
const assertNamespacePathSafe = (target: string, boundaryRoot: string): string => {
  const boundary = path.resolve(boundaryRoot);
  const absoluteTarget = path.resolve(target);
  const relative = path.relative(boundary, absoluteTarget);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new KernelKnowledgeStoreError('NAMESPACE_PATH_ESCAPE', `Knowledge namespace path escapes Runtime Home: ${target}`);
  }
  const components = relative ? relative.split(path.sep).filter(Boolean) : [];
  const paths = [boundary];
  let current = boundary;
  for (const component of components) {
    current = path.join(current, component);
    paths.push(current);
  }
  for (const candidate of paths) {
    const stat = lstatIfExists(candidate);
    if (!stat) continue;
    if (stat.isSymbolicLink()) {
      throw new KernelKnowledgeStoreError('SYMLINK_NAMESPACE_UNSUPPORTED', `Knowledge namespace cannot traverse a symlink or junction: ${candidate}`);
    }
    if (!stat.isDirectory() && normalizedFilesystemPath(candidate) !== normalizedFilesystemPath(absoluteTarget)) {
      throw new KernelKnowledgeStoreError('INVALID_NAMESPACE_ROOT', `Knowledge namespace component is not a directory: ${candidate}`);
    }
    let realPath;
    try {
      realPath = fs.realpathSync.native(candidate);
    } catch (error) {
      throw new KernelKnowledgeStoreError('NAMESPACE_PATH_UNAVAILABLE', `Knowledge namespace real path is unavailable: ${candidate} - ${errorMessage(error)}`);
    }
    if (normalizedFilesystemPath(realPath) !== normalizedFilesystemPath(candidate)) {
      throw new KernelKnowledgeStoreError('SYMLINK_NAMESPACE_UNSUPPORTED', `Knowledge namespace component redirects outside its lexical path: ${candidate}`);
    }
  }
  return absoluteTarget;
};

const listNamespaceFiles = (root: string, prefix = ''): string[] => {
  if (!fs.existsSync(root)) return [];
  const stat = fs.lstatSync(root);
  if (stat.isSymbolicLink()) throw new KernelKnowledgeStoreError('SYMLINK_NAMESPACE_UNSUPPORTED', `Knowledge namespace cannot contain a symlink root: ${root}`);
  if (!stat.isDirectory()) throw new KernelKnowledgeStoreError('INVALID_NAMESPACE_ROOT', `Knowledge namespace is not a directory: ${root}`);
  const files = [];
  for (const name of fs.readdirSync(root)) {
    const absolute = path.join(root, name);
    const relative = prefix ? path.join(prefix, name) : name;
    const child = fs.lstatSync(absolute);
    if (child.isSymbolicLink()) throw new KernelKnowledgeStoreError('SYMLINK_NAMESPACE_UNSUPPORTED', `Knowledge namespace cannot contain a symlink: ${absolute}`);
    if (child.isDirectory()) files.push(...listNamespaceFiles(absolute, relative));
    else files.push(relative.replaceAll('\\', '/'));
  }
  return files.sort();
};

const copyNamespaceTree = (source: string, destination: string): void => {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) throw new KernelKnowledgeStoreError('SYMLINK_NAMESPACE_UNSUPPORTED', `Knowledge namespace cannot contain a symlink: ${source}`);
  if (stat.isDirectory()) {
    fs.mkdirSync(destination, { recursive: true });
    for (const name of fs.readdirSync(source)) copyNamespaceTree(path.join(source, name), path.join(destination, name));
    return;
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
  const handle = fs.openSync(destination, 'r');
  try {
    try { fs.fsyncSync(handle); } catch (error) {
      if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM'].includes(errorCode(error))) throw error;
    }
  } finally { fs.closeSync(handle); }
};

const rewriteProjectIdValue = (value: unknown, legacyIds: ReadonlySet<string>, canonicalId: string): unknown => {
  if (Array.isArray(value)) return value.map((item) => rewriteProjectIdValue(item, legacyIds, canonicalId));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if ((key === 'projectId' || key === 'project_id') && legacyIds.has(String(item))) return [key, canonicalId];
    return [key, rewriteProjectIdValue(item, legacyIds, canonicalId)];
  }));
};

const rewriteProjectIdFiles = (root: string, legacyIds: ReadonlySet<string>, canonicalId: string): void => {
  for (const relative of listNamespaceFiles(root)) {
    if (!/\.jsonl?$/i.test(relative)) continue;
    const filePath = path.join(root, relative);
    const source = fs.readFileSync(filePath, 'utf8');
    if (relative.toLowerCase().endsWith('.jsonl')) {
      const lines = source.split(/\r?\n/).filter((line) => line.trim()).map((line) => {
        let parsed;
        try { parsed = JSON.parse(line); } catch (error) {
          throw new KernelKnowledgeStoreError('STORE_CORRUPTED', `Knowledge JSONL is invalid: ${filePath} - ${errorMessage(error)}`, { filePath });
        }
        return JSON.stringify(rewriteProjectIdValue(parsed, legacyIds, canonicalId));
      });
      fs.writeFileSync(filePath, lines.length > 0 ? `${lines.join('\n')}\n` : '', 'utf8');
    } else {
      let parsed;
      try { parsed = JSON.parse(source); } catch (error) {
        throw new KernelKnowledgeStoreError('STORE_CORRUPTED', `Knowledge JSON is invalid: ${filePath} - ${errorMessage(error)}`, { filePath });
      }
      fs.writeFileSync(filePath, JSON.stringify(rewriteProjectIdValue(parsed, legacyIds, canonicalId), null, 2), 'utf8');
    }
  }
};

const readRevision = (filePath: string, fallbackProjectId: string) => {
  try {
    const value: { schemaVersion?: number; revision?: unknown; updatedAt?: string } = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return {
      schemaVersion: value.schemaVersion || 1,
      projectId: fallbackProjectId,
      revision: String(value.revision || '1'),
      updatedAt: value.updatedAt || new Date(0).toISOString(),
    };
  } catch (error) {
    throw new KernelKnowledgeStoreError('STORE_CORRUPTED', `Knowledge revision is invalid: ${filePath} - ${errorMessage(error)}`, { filePath });
  }
};

const isRebuildableNamespaceProjection = (relative: string): boolean => String(relative || '').replaceAll('\\', '/').startsWith('codebase/');

const mergeNamespaceFile = (source: string, destination: string, relative: string, canonicalId: string): void => {
  if (!fs.existsSync(destination)) {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
    return;
  }
  const sourceStat = fs.lstatSync(source);
  const destinationStat = fs.lstatSync(destination);
  if (sourceStat.isDirectory() || destinationStat.isDirectory()) {
    throw new KernelKnowledgeStoreError('KNOWLEDGE_NAMESPACE_CONFLICT', `Knowledge namespace file/directory conflict at ${relative}`);
  }
  const sourceText = fs.readFileSync(source, 'utf8');
  const destinationText = fs.readFileSync(destination, 'utf8');
  if (sourceText === destinationText) return;

  if (relative.toLowerCase().endsWith('.jsonl')) {
    const lines = [...destinationText.split(/\r?\n/), ...sourceText.split(/\r?\n/)]
      .map((line) => line.trim())
      .filter(Boolean);
    const unique = [...new Set(lines)];
    fs.writeFileSync(destination, unique.length > 0 ? `${unique.join('\n')}\n` : '', 'utf8');
    return;
  }

  if (relative === 'knowledge/revision.json') {
    const left = readRevision(destination, canonicalId);
    const right = readRevision(source, canonicalId);
    const leftRevision = Number.parseInt(left.revision, 10);
    const rightRevision = Number.parseInt(right.revision, 10);
    fs.writeFileSync(destination, JSON.stringify({
      schemaVersion: Math.max(left.schemaVersion, right.schemaVersion),
      projectId: canonicalId,
      revision: String(Math.max(Number.isFinite(leftRevision) ? leftRevision : 1, Number.isFinite(rightRevision) ? rightRevision : 1)),
      updatedAt: left.updatedAt >= right.updatedAt ? left.updatedAt : right.updatedAt,
    }, null, 2), 'utf8');
    return;
  }

  // Codebase indexes are derived projections over the repository. When both
  // namespaces contain one, the canonical namespace already has the active
  // projection and can rebuild it after migration. Never let stale derived
  // bytes block migration of authoritative SQLite/typed-knowledge state.
  if (isRebuildableNamespaceProjection(relative)) return;

  throw new KernelKnowledgeStoreError('KNOWLEDGE_NAMESPACE_CONFLICT', `Conflicting knowledge file during identity migration: ${relative}`);
};

const mergeNamespaceTree = (source: string, destination: string, relative = '', canonicalId = ''): void => {
  const sourceStat = fs.lstatSync(source);
  if (sourceStat.isSymbolicLink()) throw new KernelKnowledgeStoreError('SYMLINK_NAMESPACE_UNSUPPORTED', `Knowledge namespace cannot contain a symlink: ${source}`);
  if (sourceStat.isDirectory()) {
    if (fs.existsSync(destination) && !fs.lstatSync(destination).isDirectory()) {
      throw new KernelKnowledgeStoreError('KNOWLEDGE_NAMESPACE_CONFLICT', `Knowledge namespace directory conflict at ${relative || '.'}`);
    }
    fs.mkdirSync(destination, { recursive: true });
    for (const name of fs.readdirSync(source)) {
      const childRelative = relative ? `${relative}/${name}` : name;
      mergeNamespaceTree(path.join(source, name), path.join(destination, name), childRelative, canonicalId);
    }
    return;
  }
  mergeNamespaceFile(source, destination, relative, canonicalId);
};

const namespaceHasMeaningfulData = (root: string, projectId: string): boolean => {
  if (!fs.existsSync(root)) return false;
  const files = listNamespaceFiles(root);
  if (files.length === 0) return false;
  if (files.length === 1 && files[0] === 'knowledge/revision.json') {
    try {
      const revision = JSON.parse(fs.readFileSync(path.join(root, files[0]), 'utf8'));
      return String(revision.projectId || '') !== String(projectId) || String(revision.revision || '1') !== '1';
    } catch {
      return true;
    }
  }
  return true;
};

const namespaceContentDigest = (root: string): string => {
  if (!lstatIfExists(root)) return 'absent';
  const hash = crypto.createHash('sha256');
  for (const relative of listNamespaceFiles(root)) {
    const filePath = path.join(root, relative);
    hash.update(relative.replaceAll('\\', '/'));
    hash.update('\0');
    hash.update(fs.readFileSync(filePath));
    hash.update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
};

export function projectKnowledgeNamespaceHasData(projectId: string, { runtimeHome = null, env = process.env }: { runtimeHome?: string | null; env?: NodeJS.ProcessEnv } = {}): boolean {
  const root = runtimeHome
    ? path.join(canonicalPath(runtimeHome), 'state', 'projects', safeNamespaceSegment(projectId))
    : projectKnowledgeDirectory(projectId, { env });
  const projectsRoot = runtimeHome
    ? path.join(canonicalPath(runtimeHome), 'state', 'projects')
    : path.dirname(root);
  assertNamespacePathSafe(root, projectsRoot);
  return namespaceHasMeaningfulData(root, projectId);
}

const migrationJournalPath = (journal: string): string => path.join(journal, 'journal.json');

const syncDirectorySync = (directory: string): void => {
  let fd = null;
  try {
    fd = fs.openSync(directory, 'r');
    fs.fsyncSync(fd);
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM'].includes(errorCode(error))) throw error;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
};

const writeDurableFileSync = (filePath: string, content: string, flags = 'w'): void => {
  const fd = fs.openSync(filePath, flags, 0o600);
  try {
    fs.writeFileSync(fd, content, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  syncDirectorySync(path.dirname(filePath));
};

const writeMigrationJournal = (journal: string, state: MigrationState): void => {
  const temporary = `${migrationJournalPath(journal)}.${crypto.randomUUID()}.tmp`;
  try {
    writeDurableFileSync(temporary, JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2));
    fs.renameSync(temporary, migrationJournalPath(journal));
    syncDirectorySync(journal);
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch {}
    throw error;
  }
};

const readMigrationJournal = (journal: string, { runtimeHome }: { runtimeHome: string }): MigrationState => {
  const filePath = migrationJournalPath(journal);
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const state = asRecord(parsed);
    if (!state || state.schemaVersion !== 1 || state.kind !== 'identity-knowledge-migration' || !state.projectId || !Array.isArray(state.sourceIds)) {
      throw new Error('invalid migration journal shape');
    }
    const projectsRoot = path.resolve(path.join(canonicalPath(runtimeHome), 'state', 'projects'));
    const journalRoot = path.resolve(journal);
    const canonicalId = safeNamespaceSegment(state.projectId);
    const sourceIds = [...new Set(state.sourceIds.map((value) => safeNamespaceSegment(value)))];
    if (sourceIds.length !== state.sourceIds.length || sourceIds.includes(canonicalId)) {
      throw new Error('invalid migration journal source ids');
    }
    const canonicalRoot = state.canonicalRoot == null ? null : normalizedIdentityRoot(state.canonicalRoot);
    const identityDigest = state.identityDigest == null ? null : String(state.identityDigest).trim();
    if (!canonicalRoot || !identityDigest) {
      throw new Error('invalid migration journal identity witness');
    }
    if (!state.sourceFingerprints || typeof state.sourceFingerprints !== 'object' || Array.isArray(state.sourceFingerprints)) {
      throw new Error('identity migration journal is missing source fingerprints');
    }
    const sourceFingerprints = Object.fromEntries(Object.entries(state.sourceFingerprints).map(([legacyId, fingerprint]) => {
      if (!sourceIds.includes(legacyId) || !/^sha256:[a-f0-9]{64}$/i.test(String(fingerprint))) {
        throw new Error('invalid identity migration source fingerprint');
      }
      return [legacyId, String(fingerprint)];
    }));
    if (Object.keys(sourceFingerprints).length !== sourceIds.length) {
      throw new Error('identity migration journal source fingerprint coverage is incomplete');
    }
    const expected = {
      journal: journalRoot,
      sourceRoot: projectsRoot,
      destination: path.join(projectsRoot, canonicalId),
      stagedDestination: path.join(journalRoot, 'destination-stage'),
      destinationBackup: path.join(journalRoot, 'destination-original'),
      destinationPresenceMarker: path.join(journalRoot, 'destination-presence.marker'),
      destinationInstalledMarker: path.join(journalRoot, 'destination-installed.marker'),
    };
    const actual = {
      journal: path.resolve(String(state.journal || '')),
      sourceRoot: path.resolve(String(state.sourceRoot || '')),
      destination: path.resolve(String(state.destination || '')),
      stagedDestination: path.resolve(String(state.stagedDestination || '')),
      destinationBackup: path.resolve(String(state.destinationBackup || '')),
      destinationPresenceMarker: path.resolve(String(state.destinationPresenceMarker || '')),
      destinationInstalledMarker: path.resolve(String(state.destinationInstalledMarker || '')),
    };
    if (
      path.basename(journalRoot).startsWith('.identity-migration-') === false
      || actual.journal !== expected.journal
      || actual.sourceRoot !== expected.sourceRoot
      || actual.destination !== path.resolve(expected.destination)
      || actual.stagedDestination !== path.resolve(expected.stagedDestination)
      || actual.destinationBackup !== path.resolve(expected.destinationBackup)
      || actual.destinationPresenceMarker !== path.resolve(expected.destinationPresenceMarker)
      || actual.destinationInstalledMarker !== path.resolve(expected.destinationInstalledMarker)
    ) {
      throw new Error('identity migration journal paths are outside the expected Runtime Home namespace');
    }
    assertNamespacePathSafe(journalRoot, projectsRoot);
    assertNamespacePathSafe(actual.destination, projectsRoot);
    assertNamespacePathSafe(actual.stagedDestination, projectsRoot);
    assertNamespacePathSafe(actual.destinationBackup, projectsRoot);
    assertNamespacePathSafe(actual.destinationPresenceMarker, projectsRoot);
    assertNamespacePathSafe(actual.destinationInstalledMarker, projectsRoot);
    if (typeof state.destinationExisted !== 'boolean' || typeof state.destinationInstalled !== 'boolean' || typeof state.destinationBackupCreated !== 'boolean' || typeof state.destinationBackupPending !== 'boolean' || typeof state.destinationInstallPending !== 'boolean') {
      throw new Error('invalid migration journal destination flags');
    }
    if (state.sourceRemovalBlocked != null && typeof state.sourceRemovalBlocked !== 'boolean') {
      throw new Error('invalid migration journal source removal flag');
    }
    const phase = state.phase;
    if (!isMigrationPhase(phase)) {
      throw new Error('invalid migration journal phase');
    }
    const phaseInstalled = migrationPhaseOrder[phase] >= migrationPhaseOrder['destination-installed'];
    if (state.destinationInstalled !== phaseInstalled) {
      throw new Error('migration journal phase/install flag mismatch');
    }
    if (state.destinationBackupPending !== (state.phase === 'backup-pending')) {
      throw new Error('migration journal backup pending flag mismatch');
    }
    if (state.destinationInstallPending !== (state.phase === 'destination-install-pending')) {
      throw new Error('migration journal install pending flag mismatch');
    }
    const backupExists = Boolean(lstatIfExists(actual.destinationBackup));
    const committedPhase = migrationPhaseOrder[phase] >= migrationPhaseOrder['db-committed'];
    if (!state.destinationExisted && (state.destinationBackupCreated || backupExists)) {
      throw new Error('migration journal has a backup for a destination that did not exist');
    }
    const backupPending = state.phase === 'backup-pending';
    if (!committedPhase && !backupPending && backupExists !== state.destinationBackupCreated) {
      throw new Error('migration journal backup flag does not match the durable backup');
    }
    if (!committedPhase && !backupPending && migrationPhaseOrder[phase] >= migrationPhaseOrder['destination-installed'] && state.destinationExisted && (!state.destinationBackupCreated || !backupExists)) {
      throw new Error('migration journal cannot roll back an installed destination without its verified backup');
    }
    if (state.phase === 'destination-install-pending' && state.destinationExisted && (!state.destinationBackupCreated || !backupExists)) {
      throw new Error('migration journal cannot roll back a pending destination install without its verified backup');
    }
    if (state.phase === 'sources-preserved' && state.sourceRemovalBlocked !== true) {
      throw new Error('migration journal preserved-source phase is missing its safety flag');
    }
    const presenceMarker = fs.readFileSync(actual.destinationPresenceMarker, 'utf8').trim();
    if (!['present', 'absent'].includes(presenceMarker) || (presenceMarker === 'present') !== state.destinationExisted) {
      throw new Error('migration journal destination presence marker mismatch');
    }
    const installedMarkerExists = Boolean(lstatIfExists(actual.destinationInstalledMarker));
    if (installedMarkerExists !== state.destinationInstalled) {
      throw new Error('migration journal destination install marker mismatch');
    }
    return {
      ...state,
      schemaVersion: 1,
      kind: 'identity-knowledge-migration',
      phase,
      destinationExisted: state.destinationExisted,
      destinationInstalled: state.destinationInstalled,
      destinationBackupCreated: state.destinationBackupCreated,
      destinationBackupPending: state.destinationBackupPending,
      destinationInstallPending: state.destinationInstallPending,
      journal: journalRoot,
      sourceRoot: projectsRoot,
      projectId: canonicalId,
      sourceIds,
      sourceFingerprints,
      sourceRemovalBlocked: state.sourceRemovalBlocked === true,
      canonicalRoot,
      identityDigest,
      destination: path.resolve(expected.destination),
      stagedDestination: path.resolve(expected.stagedDestination),
      destinationBackup: path.resolve(expected.destinationBackup),
      destinationPresenceMarker: path.resolve(expected.destinationPresenceMarker),
      destinationInstalledMarker: path.resolve(expected.destinationInstalledMarker),
    };
  } catch (error) {
    if (error instanceof KernelKnowledgeStoreError) throw error;
    throw new KernelKnowledgeStoreError('IDENTITY_MIGRATION_JOURNAL_INVALID', `Identity migration journal is invalid: ${filePath} - ${errorMessage(error)}`, { filePath });
  }
};

const removeIfExists = (target: string, { boundaryRoot }: { boundaryRoot?: string } = {}): void => {
  const stat = lstatIfExists(target);
  if (!stat) return;
  if (boundaryRoot) assertNamespacePathSafe(target, boundaryRoot);
  if (stat.isSymbolicLink()) {
    throw new KernelKnowledgeStoreError('SYMLINK_NAMESPACE_UNSUPPORTED', `Refusing to remove a symlink or junction in the knowledge namespace: ${target}`);
  }
  fs.rmSync(target, { recursive: true, force: true });
};

const migrationPhaseOrder = Object.freeze({
  prepared: 0,
  staged: 1,
  'backup-pending': 2,
  'destination-install-pending': 3,
  'destination-installed': 4,
  'db-pending': 5,
  'db-committed': 6,
  'sources-preserved': 7,
  'sources-removed': 8,
});

const isMigrationPhase = (phase: unknown): phase is MigrationPhase => typeof phase === 'string' && Object.hasOwn(migrationPhaseOrder, phase);

interface MigrationLockOptions { heldLocks?: NamespaceLockHandle[] | null }

const restoreMigrationJournal = (state: MigrationState, { heldLocks = null }: MigrationLockOptions = {}): void => {
  const destination = state.destination;
  const destinationBackup = state.destinationBackup;
  const stagedDestination = state.stagedDestination;
  const projectsRoot = state.sourceRoot;
  const locks = heldLocks || acquireNamespaceLocks(projectsRoot, [state.projectId, ...state.sourceIds], { allowReentrant: true });
  try {
    assertNamespacePathSafe(destination, projectsRoot);
    assertNamespacePathSafe(destinationBackup, projectsRoot);
    assertNamespacePathSafe(stagedDestination, projectsRoot);
    assertNamespacePathSafe(state.destinationPresenceMarker, projectsRoot);
    assertNamespacePathSafe(state.destinationInstalledMarker, projectsRoot);

  const destinationExists = Boolean(lstatIfExists(destination));
  const backupExists = Boolean(lstatIfExists(destinationBackup));
  const installedMarkerExists = Boolean(lstatIfExists(state.destinationInstalledMarker));
  const destinationWasInstalled = Boolean(state.destinationInstalled || installedMarkerExists);
  if (state.destinationInstalled !== installedMarkerExists) {
    throw new KernelKnowledgeStoreError('IDENTITY_MIGRATION_JOURNAL_INVALID', `Migration journal install marker disagrees with its state: ${state.journal}`);
  }
  const committedPhase = migrationPhaseOrder[state.phase] >= migrationPhaseOrder['db-committed'];
  if (!state.destinationExisted && (state.destinationBackupCreated || backupExists)) {
    throw new KernelKnowledgeStoreError('IDENTITY_MIGRATION_JOURNAL_INVALID', `Migration journal has a backup for an absent original destination: ${state.journal}`);
  }
  const backupPending = state.phase === 'backup-pending';
  if (!committedPhase && !backupPending && backupExists !== Boolean(state.destinationBackupCreated)) {
    throw new KernelKnowledgeStoreError('IDENTITY_MIGRATION_JOURNAL_INVALID', `Migration journal backup flag disagrees with its durable backup: ${state.journal}`);
  }
  if (!committedPhase && migrationPhaseOrder[state.phase] >= migrationPhaseOrder['destination-installed'] && state.destinationExisted && (!state.destinationBackupCreated || !backupExists)) {
    throw new KernelKnowledgeStoreError('IDENTITY_MIGRATION_ROLLBACK_UNSAFE', `Cannot roll back an installed destination without its verified backup: ${destination}`);
  }
  if (destinationWasInstalled && state.destinationExisted && !backupExists) {
    throw new KernelKnowledgeStoreError('IDENTITY_MIGRATION_ROLLBACK_UNSAFE', `Cannot remove an installed destination without its verified backup: ${destination}`);
  }
  if (state.phase === 'backup-pending') {
    if (backupExists && destinationExists) {
      throw new KernelKnowledgeStoreError('IDENTITY_MIGRATION_ROLLBACK_UNSAFE', `Backup-pending migration has both original and backup destinations: ${state.journal}`);
    }
    if (backupExists && !destinationExists) {
      fs.renameSync(destinationBackup, destination);
      syncDirectorySync(projectsRoot);
    }
    removeIfExists(stagedDestination, { boundaryRoot: projectsRoot });
    removeIfExists(state.destinationInstalledMarker, { boundaryRoot: projectsRoot });
    removeIfExists(state.destinationPresenceMarker, { boundaryRoot: projectsRoot });
    removeIfExists(state.journal, { boundaryRoot: projectsRoot });
    return;
  }
  if (state.phase === 'destination-install-pending') {
    const stagedExists = Boolean(lstatIfExists(stagedDestination));
    if (state.destinationExisted) {
      if (!backupExists) throw new KernelKnowledgeStoreError('IDENTITY_MIGRATION_ROLLBACK_UNSAFE', `Pending destination install has no verified original backup: ${destination}`);
      if (destinationExists) removeIfExists(destination, { boundaryRoot: projectsRoot });
      fs.renameSync(destinationBackup, destination);
      syncDirectorySync(projectsRoot);
    } else if (destinationExists && !stagedExists) {
      removeIfExists(destination, { boundaryRoot: projectsRoot });
    }
    removeIfExists(stagedDestination, { boundaryRoot: projectsRoot });
    removeIfExists(state.destinationInstalledMarker, { boundaryRoot: projectsRoot });
    removeIfExists(state.destinationPresenceMarker, { boundaryRoot: projectsRoot });
    removeIfExists(state.journal, { boundaryRoot: projectsRoot });
    return;
  }
  if (destinationWasInstalled && destinationExists) removeIfExists(destination, { boundaryRoot: projectsRoot });
  if (backupExists && !lstatIfExists(destination)) {
    fs.renameSync(destinationBackup, destination);
    syncDirectorySync(projectsRoot);
  }
  removeIfExists(stagedDestination, { boundaryRoot: projectsRoot });
  removeIfExists(state.destinationInstalledMarker, { boundaryRoot: projectsRoot });
    removeIfExists(state.destinationPresenceMarker, { boundaryRoot: projectsRoot });
    removeIfExists(state.journal, { boundaryRoot: projectsRoot });
  } finally {
    if (!heldLocks) for (const lock of locks.reverse()) releaseNamespaceLock(lock);
  }
};

const cleanupMigrationArtifacts = (state: MigrationState, projectsRoot: string): void => {
  removeIfExists(state.destinationBackup, { boundaryRoot: projectsRoot });
  removeIfExists(state.stagedDestination, { boundaryRoot: projectsRoot });
  removeIfExists(state.destinationInstalledMarker, { boundaryRoot: projectsRoot });
  removeIfExists(state.destinationPresenceMarker, { boundaryRoot: projectsRoot });
  removeIfExists(state.journal, { boundaryRoot: projectsRoot });
};

const finalizeMigrationJournal = (state: MigrationState, { heldLocks = null }: MigrationLockOptions = {}): void => {
  const destination = state.destination;
  const projectsRoot = state.sourceRoot;
  const locks = heldLocks || acquireNamespaceLocks(projectsRoot, [state.projectId, ...state.sourceIds], { allowReentrant: true });
  try {
    assertNamespacePathSafe(destination, projectsRoot);
    if (!fs.existsSync(destination)) {
      assertNamespacePathSafe(state.stagedDestination, projectsRoot);
      assertNamespacePathSafe(state.destinationBackup, projectsRoot);
      if (fs.existsSync(state.stagedDestination)) fs.renameSync(state.stagedDestination, destination);
      else if (fs.existsSync(state.destinationBackup)) fs.renameSync(state.destinationBackup, destination);
      else throw new KernelKnowledgeStoreError('IDENTITY_MIGRATION_DESTINATION_MISSING', `Committed identity migration has no destination namespace: ${destination}`, { destination, journal: state.journal });
      syncDirectorySync(projectsRoot);
    }

    if (state.sourceRemovalBlocked || state.phase === 'sources-preserved') {
      cleanupMigrationArtifacts(state, projectsRoot);
      return;
    }

    const sourcePaths = state.sourceIds.map((legacyId) => path.join(state.sourceRoot, legacyId));
    const lockedFingerprints = Object.fromEntries(state.sourceIds.map((legacyId, index) => [
      legacyId,
      namespaceContentDigest(requiredIndex(sourcePaths, index)),
    ]));
    const allAbsent = state.sourceIds.every((legacyId) => lockedFingerprints[legacyId] === 'absent');
    const allUnchanged = state.sourceIds.every((legacyId) => lockedFingerprints[legacyId] === state.sourceFingerprints[legacyId]);
    if (!allAbsent && !allUnchanged) {
      state.sourceRemovalBlocked = true;
      state.phase = 'sources-preserved';
      writeMigrationJournal(state.journal, state);
    } else if (allAbsent) {
      state.phase = 'sources-removed';
      writeMigrationJournal(state.journal, state);
    } else {
      for (const source of sourcePaths) removeIfExists(source, { boundaryRoot: projectsRoot });
      syncDirectorySync(projectsRoot);
      state.phase = 'sources-removed';
      writeMigrationJournal(state.journal, state);
    }
    cleanupMigrationArtifacts(state, projectsRoot);
  } finally {
    if (!heldLocks) for (const lock of locks.reverse()) releaseNamespaceLock(lock);
  }
};

// A process can terminate after the SQLite transaction commits but before the
// caller removes the legacy namespace. Recovery uses the persisted SQLite
// identity state supplied by the caller to choose forward completion or a
// byte-preserving rollback. The source namespace is never removed before the
// database commit, so an interrupted migration cannot strand the only copy.
export function recoverProjectKnowledgeNamespaceMigrations({ runtimeHome, isCommitted = () => false }: { runtimeHome?: string; isCommitted?: (state: MigrationState) => boolean } = {}) {
  if (!runtimeHome) return [];
  const canonicalRuntimeHome = canonicalPath(runtimeHome);
  const root = path.join(canonicalRuntimeHome, 'state', 'projects');
  if (!fs.existsSync(root)) return [];
  assertNamespacePathSafe(root, path.join(canonicalRuntimeHome, 'state'));
  const recovered = [];
  for (const name of fs.readdirSync(root).filter((entry) => entry.startsWith('.identity-migration-'))) {
    const journal = path.join(root, name);
    assertNamespacePathSafe(journal, root);
    const journalFile = path.join(journal, 'journal.json');
    if (!fs.existsSync(journalFile)) continue;
    const state = readMigrationJournal(journal, { runtimeHome });
    if (isCommitted(state)) {
      finalizeMigrationJournal(state);
      recovered.push({ journal, status: 'completed', projectId: state.projectId, sourceIds: state.sourceIds });
    } else {
      restoreMigrationJournal(state);
      recovered.push({ journal, status: 'rolled-back', projectId: state.projectId, sourceIds: state.sourceIds });
    }
    // A same-process test or host can invoke recovery after a simulated crash
    // while the abandoned migration object still owns its in-memory handles.
    // Recovery is the authority for that journal, so release those handles
    // after the durable rollback/forward decision has completed.
    releaseOwnedNamespaceLocks(root, [state.projectId, ...state.sourceIds]);
  }
  return recovered;
}

// Prepare a copy-first filesystem migration before the SQLite identity
// transaction. A durable journal is written before any namespace replacement;
// legacy sources remain intact until finalize() is called after SQLite commit.
export function prepareProjectKnowledgeNamespaceMigration({ runtimeHome, legacyProjectIds = [], projectId, canonicalRoot = null, identityDigest = null }: { runtimeHome?: string; legacyProjectIds?: unknown[]; projectId?: string; canonicalRoot?: string | null; identityDigest?: string | null } = {}): MigrationOperation {
  if (!runtimeHome || !projectId) return { migratedProjectIds: [], finalize() {}, rollback() {} };
  const canonicalId = safeNamespaceSegment(projectId);
  const identityRoot = canonicalRoot == null ? null : normalizedIdentityRoot(canonicalRoot);
  const identityDigestValue = identityDigest == null ? null : String(identityDigest).trim();
  if (!identityRoot || !identityDigestValue) {
    throw new KernelKnowledgeStoreError('IDENTITY_MIGRATION_JOURNAL_INVALID', 'Identity migration requires both canonicalRoot and identityDigest as its commit witness');
  }
  const legacyIds = [...new Set((Array.isArray(legacyProjectIds) ? legacyProjectIds : [])
    .map((value) => safeNamespaceSegment(value))
    .filter((value) => value !== canonicalId))];
  if (legacyIds.length === 0) return { migratedProjectIds: [], finalize() {}, rollback() {} };
  const canonicalRuntimeHome = canonicalPath(runtimeHome);
  const root = path.join(canonicalRuntimeHome, 'state', 'projects');
  assertNamespacePathSafe(root, path.join(canonicalRuntimeHome, 'state'));
  const destination = path.join(root, canonicalId);
  const sourceIds = legacyIds.filter((legacyId) => namespaceHasMeaningfulData(path.join(root, legacyId), legacyId));
  if (sourceIds.length === 0) return { migratedProjectIds: [], finalize() {}, rollback() {} };

  const journal = path.join(root, `.identity-migration-${crypto.randomUUID()}`);
  const stagedDestination = path.join(journal, 'destination-stage');
  const destinationBackup = path.join(journal, 'destination-original');
  const destinationPresenceMarker = path.join(journal, 'destination-presence.marker');
  const destinationInstalledMarker = path.join(journal, 'destination-installed.marker');
  fs.mkdirSync(journal, { recursive: true });
  assertNamespacePathSafe(journal, root);
  assertNamespacePathSafe(destination, root);
  const namespaceLocks = acquireNamespaceLocks(root, [canonicalId, ...sourceIds]);
  let state: MigrationState | null = null;
  let locksReleased = false;
  const releaseLocks = () => {
    if (locksReleased) return;
    locksReleased = true;
    for (const lock of namespaceLocks.reverse()) releaseNamespaceLock(lock);
  };
  try {
    const sourceFingerprints = Object.fromEntries(sourceIds.map((legacyId) => [
      legacyId,
      namespaceContentDigest(path.join(root, legacyId)),
    ]));
    const destinationExisted = Boolean(lstatIfExists(destination));
    writeDurableFileSync(destinationPresenceMarker, destinationExisted ? 'present\n' : 'absent\n', 'wx');
    state = {
      schemaVersion: 1,
      kind: 'identity-knowledge-migration',
      journal,
      sourceRoot: root,
      sourceIds,
      projectId: canonicalId,
      canonicalRoot: identityRoot,
      identityDigest: identityDigestValue,
      sourceFingerprints,
      destination,
      stagedDestination,
      destinationBackup,
      destinationPresenceMarker,
      destinationInstalledMarker,
      destinationExisted,
      destinationBackupCreated: false,
      destinationBackupPending: false,
      destinationInstalled: false,
      destinationInstallPending: false,
      sourceRemovalBlocked: false,
      phase: 'prepared',
    };
    writeMigrationJournal(journal, state);

    fs.mkdirSync(stagedDestination, { recursive: true });
    if (fs.existsSync(destination) && namespaceHasMeaningfulData(destination, canonicalId)) {
      copyNamespaceTree(destination, stagedDestination);
    }
    const sourceIdsSet = new Set(sourceIds);
    for (const legacyId of sourceIds) {
      const source = path.join(root, legacyId);
      const sourceStage = path.join(journal, `source-${legacyId}`);
      copyNamespaceTree(source, sourceStage);
      rewriteProjectIdFiles(sourceStage, sourceIdsSet, canonicalId);
      mergeNamespaceTree(sourceStage, stagedDestination, '', canonicalId);
    }
    for (const legacyId of sourceIds) {
      const currentFingerprint = namespaceContentDigest(path.join(root, legacyId));
      if (currentFingerprint !== sourceFingerprints[legacyId]) {
        throw new KernelKnowledgeStoreError('IDENTITY_MIGRATION_SOURCE_CHANGED', `Legacy knowledge namespace changed during identity migration: ${legacyId}`, { legacyId });
      }
    }
    state.phase = 'staged';
    writeMigrationJournal(journal, state);

    if (fs.existsSync(destination)) {
      state.destinationBackupPending = true;
      state.phase = 'backup-pending';
      writeMigrationJournal(journal, state);
      assertNamespacePathSafe(destination, root);
      assertNamespacePathSafe(destinationBackup, root);
      fs.renameSync(destination, destinationBackup);
      syncDirectorySync(root);
      state.destinationBackupCreated = true;
      state.destinationBackupPending = false;
      writeMigrationJournal(journal, state);
    }
    state.destinationInstallPending = true;
    state.phase = 'destination-install-pending';
    writeMigrationJournal(journal, state);
    assertNamespacePathSafe(stagedDestination, root);
    assertNamespacePathSafe(destination, root);
    fs.renameSync(stagedDestination, destination);
    syncDirectorySync(root);
    writeDurableFileSync(destinationInstalledMarker, 'installed\n', 'wx');
    state.destinationInstalled = true;
    state.destinationInstallPending = false;
    state.phase = 'destination-installed';
    writeMigrationJournal(journal, state);
    state.phase = 'db-pending';
    writeMigrationJournal(journal, state);
  } catch (error) {
    if (state) {
      try { restoreMigrationJournal(state, { heldLocks: namespaceLocks }); } finally { releaseLocks(); }
    } else {
      releaseLocks();
      removeIfExists(journal, { boundaryRoot: root });
    }
    throw error;
  }

  const preparedState = state;
  return {
    migratedProjectIds: sourceIds,
    finalize() {
      try {
        preparedState.phase = 'db-committed';
        writeMigrationJournal(journal, preparedState);
        finalizeMigrationJournal(preparedState, { heldLocks: namespaceLocks });
      } finally {
        releaseLocks();
      }
    },
    rollback() {
      try { restoreMigrationJournal(preparedState, { heldLocks: namespaceLocks }); } finally { releaseLocks(); }
    },
  };
}

export async function ensureKnowledgeStoreDirectories(projectId: string, { env = process.env }: { env?: NodeJS.ProcessEnv } = {}): Promise<string> {
  const root = projectKnowledgeDirectory(projectId, { env });
  const projectsRoot = path.join(resolveKernelRuntimeHome({ env }), 'state', 'projects');
  assertNamespacePathSafe(root, projectsRoot);
  await mkdir(projectsRoot, { recursive: true });
  const lock = await acquireNamespaceLockWithRetry(projectsRoot, projectId, { allowReentrant: true });
  try {
  const dirs = [
    root,
    path.join(root, 'knowledge', 'policy'),
    path.join(root, 'knowledge', 'semantic'),
    path.join(root, 'knowledge', 'architecture'),
    path.join(root, 'knowledge', 'episodic'),
    path.join(root, 'knowledge', 'graph'),
    path.join(root, 'knowledge', 'ontology'),
    path.join(root, 'knowledge', 'provenance'),
    path.join(root, 'knowledge', 'candidates'),
    path.join(root, 'context-packs'),
    path.join(root, 'receipts'),
  ];
  for (const dir of dirs) {
    assertNamespacePathSafe(dir, projectsRoot);
    await mkdir(dir, { recursive: true });
    assertNamespacePathSafe(dir, projectsRoot);
  }

  // Ensure revision.json exists
  const revisionPath = path.join(root, 'knowledge', 'revision.json');
  assertNamespacePathSafe(revisionPath, projectsRoot);
  try {
    await access(revisionPath);
  } catch {
    const defaultRevision = {
      schemaVersion: 1,
      projectId,
      revision: '1',
      updatedAt: new Date().toISOString(),
    };
    await writeAtomicJsonUnlocked(revisionPath, defaultRevision);
  }
    return root;
  } finally {
    releaseNamespaceLock(lock);
  }
}

const writeAtomicJsonUnlocked = async (filePath: string, data: unknown): Promise<void> => {
  const content = JSON.stringify(data, null, 2);
  await atomicWriteText(filePath, content);
};

export async function writeAtomicJson(filePath: string, data: unknown): Promise<void> {
  const info = namespaceInfoForPath(filePath);
  // Context packs may be the first write in a fresh Runtime Home. Create the
  // lock directory before opening the namespace lock; otherwise the lock
  // itself fails with ENOENT before the atomic writer can create its parent.
  if (info) await mkdir(info.projectsRoot, { recursive: true });
  const lock = info ? await acquireNamespaceLockWithRetry(info.projectsRoot, info.projectId) : null;
  try {
    return await writeAtomicJsonUnlocked(info?.filePath || filePath, data);
  } finally {
    releaseNamespaceLock(lock);
  }
}

const writeAtomicJsonlUnlocked = async (filePath: string, records: unknown[]): Promise<void> => {
  const lines = records.map((r) => JSON.stringify(r)).join('\n');
  await atomicWriteText(filePath, lines ? `${lines}\n` : '');
};

export async function writeAtomicJsonl(filePath: string, records: unknown[]): Promise<void> {
  const info = namespaceInfoForPath(filePath);
  if (info) await mkdir(info.projectsRoot, { recursive: true });
  const lock = info ? await acquireNamespaceLockWithRetry(info.projectsRoot, info.projectId) : null;
  try {
    return await writeAtomicJsonlUnlocked(info?.filePath || filePath, records);
  } finally {
    releaseNamespaceLock(lock);
  }
}
