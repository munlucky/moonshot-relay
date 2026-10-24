import { requiredIndex } from '../shared/required-index.js';
import {
  canonicalPathIdentity,
  isValidWindowsAbsolutePathIdentity,
  sameCrossSurfacePathIdentity,
  samePathSurfaceIdentity,
} from '../shared/path-identity.js';
import type { PersistedWorktreeMutationLease, PersistedWorkspaceMutationLock } from './persistence/work-lifecycle-store.js';
import type { WorkStepStore } from './persistence/work-store.js';
import type { WorkAttemptStore } from './persistence/work-attempt-store.js';
import type { KnowledgeLifecycleStore } from './persistence/knowledge-lifecycle-store.js';
import type { DeclaredRunObligationInput, PersistedRunObligation, PersistedVerification } from './persistence/trust-store.js';
import type { PersistedWorkStep } from './persistence/work-store.js';
import type { WorkAttempt, FinishStepAttemptInput } from './persistence/work-attempt-store.js';
import type { ReviewReceiptInput } from './proof/review-receipt.js';
import { isProofTier, type ProofTier } from './proof-route.js';
import type { ModelRouteDecisionInput } from '../contracts/model-route.js';
import type {
  ModelUsageReceiptInput,
  UnknownRecord,
  SqliteTableRow,
  KnowledgeRevisionRow,
  StoredTaskContract,
  RunSignals,
  StoredRunRoute,
  KernelRun,
  BindingInput,
  LegacyIdentityCandidate,
  ProjectIdentityInput,
  IdentityRow,
  WorkspaceInput,
  CreateRunInput,
  CompletionEvaluation
} from './persistence/state-store-contracts.js';

const asRecord = (value: unknown): UnknownRecord => value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : {};

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

const errorCode = (error: unknown): string => typeof asRecord(error).code === 'string' ? String(asRecord(error).code) : '';
import path from 'node:path';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { resolveKernelRuntimeHome, assertIsolatedRuntimeHomes } from './runtime-home.js';
import { canTransition } from './transition.js';
import { openSqliteDb } from './sqlite-adapter.js';
import { isProtectedObligation } from './proof/protected-obligations.js';
import { assertCommandBinding } from './run/obligation-compiler.js';
import { deriveEvidenceLevel } from '../contracts/verification-settlement.js';
import { normalizeModelRouteDecision } from '../contracts/model-route.js';
import { hashSessionId, normalizeModelUsageReceipt } from '../contracts/model-execution.js';
import { assertAttemptLineage } from './run/attempt-provenance.js';
import { TRUSTED_ENFORCEMENT_STATUSES, digestOfEvidence, evaluateReviewReceipt, normalizeReviewReceipt, parseReviewEvidenceRef } from './proof/review-receipt.js';
import { sanitizePersistentPayload, sanitizePersistentText } from '../shared/persistent-sanitizer.js';
import { buildSuccessorKey } from './run/successor-key.js';
import { emptyKnowledgeDoctorFinding } from './knowledge/capture.js';
import { exactEvidenceIdentityMatch } from './proof/evidence-reuse.js';
import { assessMutationProvenance } from './proof/completion-provenance.js';
import { normalizeAcceptanceCoverage } from './task/task-contract.js';
import { deriveKernelWorktreeId } from '../contracts/worktree-authority.js';
import {
  prepareProjectKnowledgeNamespaceMigration,
  projectKnowledgeNamespaceHasData,
} from './knowledge/store.js';
import { buildKernelDurableStateView } from './persistence/durable-state.js';
import { createRunJournalPersistence, runJournalSchema } from './persistence/run-journal.js';
import { initializeKernelSchema } from './persistence/schema.js';
import { migrateKernelSchema } from './persistence/schema-migrations.js';
import { recoverKnowledgeMigrations } from './persistence/knowledge-migration-recovery.js';
import { createWorkStepStore } from './persistence/work-store.js';
import { createWorkAttemptStore } from './persistence/work-attempt-store.js';
import { createWorkLifecyclePersistence } from './persistence/work-lifecycle-store.js';
import { createKnowledgeLifecycleStore } from './persistence/knowledge-lifecycle-store.js';
import { createTrustPersistence } from './persistence/trust-store.js';
import { createHostExecutionPersistence } from './persistence/host-execution-store.js';
import { createFinalizationPersistence } from './persistence/finalization-store.js';
import { createProjectIdentityPersistence } from './persistence/project-identity-store.js';
import { canonicalReceiptPaths, receiptValueIsMissing, mergeImmutableReceiptFields } from './run/receipt-fields.js';

const TIER_RANK: Record<ProofTier, number> = { T0: 0, T1: 1, T2: 2, T3: 3 };
const EVIDENCE_RANK: Record<string, number> = { E0: 0, E1: 1, E2: 2 };
const PROJECT_ID_PATTERN = /^(?!(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$)[a-z0-9][a-z0-9._-]{1,126}[a-z0-9]$/;

export const kernelDbPath = (runtimeHome: string = resolveKernelRuntimeHome()) => path.join(runtimeHome, 'state', 'runtime-state.sqlite');

const canonicalRuntimeHome = (value: string) => {
  const resolved = path.resolve(value);
  let current = resolved;
  const suffix = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return resolved;
    suffix.unshift(path.basename(current));
    current = parent;
  }
  try {
    return path.join(fs.realpathSync.native(current), ...suffix);
  } catch {
    return resolved;
  }
};

const sourceIdentityRegex = /^(?:[a-f0-9]{40}|sha256:[a-f0-9]{64}|[a-zA-Z0-9_.:/-]{1,128})$/i;
const gitCommitShaRegex = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const sha256Regex = /^sha256:[a-f0-9]{64}$/i;

const reviewSubjectKey = (receipt: ReviewReceiptInput = {}) => `review-subject-${createHash('sha256').update(JSON.stringify({
  runId: receipt.runId || null,
  obligationId: receipt.obligationId || null,
  stepId: receipt.stepId || null,
  planRevision: Number(receipt.planRevision || 1),
  mutationRevision: Number(receipt.subject?.mutationRevision || 0),
  workspaceIdentity: receipt.subject?.workspaceIdentity || null,
  changedPathsDigest: receipt.subject?.changedPathsDigest || null,
  evidenceDigest: receipt.subject?.evidenceDigest || null,
})).digest('hex')}`;

const reviewSubjectAdoptionEligible = (receipt: ReviewReceiptInput = {}) => {
  const enforcement = receipt.reviewer?.enforcementStatus || null;
  if (!(TRUSTED_ENFORCEMENT_STATUSES as readonly unknown[]).includes(enforcement)) return false;
  if (enforcement === 'operator_approved') return true;
  if (receipt.reviewer?.modelClass !== 'frontier_reasoning') return false;
  const reviewerSession = receipt.reviewer?.actorSessionId || null;
  const implementerSession = receipt.implementer?.actorSessionId || null;
  return Boolean(reviewerSession && implementerSession && reviewerSession !== implementerSession);
};

/** @param {{ runtimeHome?: string | null, relayHome?: string | null }} [options] */
export const openKernelStateStore = async ({ runtimeHome: runtimeHomeInput = resolveKernelRuntimeHome(), relayHome }: { runtimeHome?: (string) | undefined; relayHome?: (string) | undefined } = {}) => {
  const runtimeHome = canonicalRuntimeHome(runtimeHomeInput);
  assertIsolatedRuntimeHomes(runtimeHome, relayHome);
  const dbPath = kernelDbPath(runtimeHome);
  await mkdir(path.dirname(dbPath), { recursive: true });
  const db = await openSqliteDb(dbPath);
  // Initialization can reject before the public store owns the connection.
  // Release that connection on every schema/migration failure, including
  // uniqueness failures, so recovery can reopen or remove the database.
  try {
  initializeKernelSchema(db);


  migrateKernelSchema(db);

  recoverKnowledgeMigrations(db, runtimeHome);

  const now = () => new Date().toISOString();
  db.exec(runJournalSchema());

  function safeJsonParse(str: unknown): string[];
  function safeJsonParse<T>(str: unknown, fallback: T): T;
  function safeJsonParse(str: unknown, fallback: unknown = []): unknown {
    try {
      return JSON.parse(String(str || '[]')) as unknown;
    } catch {
      return fallback;
    }
  }
  const persistentJson = (value: unknown) => typeof value === 'string'
    ? sanitizePersistentText(value)
    : JSON.stringify(sanitizePersistentPayload(value));
  const trustPersistence = createTrustPersistence({
    db,
    now,
    serialize: persistentJson,
  });
  const hostExecutionPersistence = createHostExecutionPersistence({
    db,
    now,
    serialize: persistentJson,
  });
  const finalizationPersistence = createFinalizationPersistence({
    db,
    now,
    serialize: persistentJson,
  });
  const workLifecyclePersistence = createWorkLifecyclePersistence({ db, now });
  const runJournalPersistence = createRunJournalPersistence({ db });
  const projectIdentityPersistence = createProjectIdentityPersistence({ db });
  const knowledgeLifecyclePersistence: KnowledgeLifecycleStore = createKnowledgeLifecycleStore({ db, now, serialize: persistentJson, getRun: (runId): KernelRun | null => store.getRun(runId), getCompletionDecision: (runId): UnknownRecord | null => store.getCompletionDecision(runId) });
  const workStepPersistence: WorkStepStore = createWorkStepStore({ db, now, getRun: (runId): KernelRun | null => store.getRun(runId) });
  const workAttemptPersistence: WorkAttemptStore = createWorkAttemptStore({ db, now, getRun: (runId): KernelRun | null => store.getRun(runId), getRunStep: (runId, stepId): PersistedWorkStep | null => store.getRunStep(runId, stepId), hashActorSessionId: hashSessionId, serialize: persistentJson, finishAttemptForReport: (attemptId, input): WorkAttempt | null => store.finishStepAttempt(attemptId, input) });
  const canonicalIdentityRoot = (value: unknown) => {
    const input = String(value || '');
    if (!input.trim()) return '';
    const raw = input;
    const trimmed = input.trim();
    // Surrounding whitespace is part of a POSIX path. For a Windows-like
    // spelling it is never valid ownership evidence, so preserve the input
    // unchanged and let invalidWindowsOwnershipPath reject it at the boundary.
    if (trimmed !== input && /^[a-z]:(?:[\\/]|$)/i.test(trimmed)) {
      return input.replaceAll('\\', '/');
    }
    // Windows drive-relative paths (C: and C:repo) depend on per-drive current
    // directories. They are not stable repository roots and must never be
    // resolved into ownership evidence.
    if (/^[a-z]:(?![\\/])/i.test(raw)) {
      return input.replaceAll('\\', '/');
    }
    // Invalid Windows-like spellings must not normalize into a valid persisted
    // root before ownership checks. Preserve the original spelling so direct
    // DB lookup cannot collapse it onto an existing repository identity.
    if (/^[a-z]:[\\/]/i.test(raw) && !isValidWindowsAbsolutePathIdentity(input)) {
      return input.replaceAll('\\', '/');
    }
    // State can be shared by Windows and POSIX host surfaces. Preserve a
    // foreign Windows drive path instead of resolving it as a relative POSIX
    // path (for example, /cwd/c:/repo).
    if (process.platform !== 'win32' && /^[a-z]:[\\/]/i.test(raw)) {
      return canonicalPathIdentity(raw, { platform: 'win32' });
    }
    // A persisted POSIX absolute path can be inspected on a Windows Host.
    // Keep its POSIX casing instead of resolving it onto the current Windows
    // drive and lowercasing a path that may name a distinct repository.
    if (process.platform === 'win32' && /^\/(?!\/)/.test(raw)) {
      return path.posix.normalize(raw);
    }
    const resolved = path.resolve(raw);
    try {
      const real = fs.realpathSync(resolved);
      return process.platform === 'win32'
        ? real.replaceAll('\\', '/').toLowerCase()
        : real;
    } catch {
      return process.platform === 'win32'
        ? resolved.replaceAll('\\', '/').toLowerCase()
        : resolved;
    }
  };
  const invalidWindowsOwnershipPath = (value: unknown) => {
    const raw = String(value || '').trim();
    if (/^[a-z]:(?![\\/])/i.test(raw)) return true;
    return /^[a-z]:[\\/]/i.test(raw) && !isValidWindowsAbsolutePathIdentity(value);
  };
  const sameIdentityPath = (left: unknown, right: unknown) => {
    if (invalidWindowsOwnershipPath(left) || invalidWindowsOwnershipPath(right)) return false;
    return sameCrossSurfacePathIdentity(left, right)
      || sameCrossSurfacePathIdentity(canonicalIdentityRoot(left), canonicalIdentityRoot(right));
  };
  const sameOwnershipPath = (left: unknown, right: unknown) => {
    if (invalidWindowsOwnershipPath(left) || invalidWindowsOwnershipPath(right)) return false;
    return samePathSurfaceIdentity(left, right)
      || samePathSurfaceIdentity(canonicalIdentityRoot(left), canonicalIdentityRoot(right));
  };
  const hasPairedCrossSurfaceRepositoryEvidence = ({
    projectId,
    persistedRoot,
    observedRoot,
    observedGitCommonDir,
  }: {
    projectId: string;
    persistedRoot: unknown;
    observedRoot: unknown;
    observedGitCommonDir: unknown;
  }) => Boolean(
    observedGitCommonDir
    && sameIdentityPath(persistedRoot, observedRoot)
    && workLifecyclePersistence
      .listProjectWorkspaceRecords(projectId)
      .some((workspace) => sameIdentityPath(workspace.gitCommonDir, observedGitCommonDir))
  );
  type WorkspaceRepositoryEvidence = {
    workspaceId?: string;
    canonicalRoot: unknown;
    gitCommonDir?: unknown;
    gitWorktreeDir?: unknown;
    createdAt?: unknown;
  };
  const sameWorkspaceRepositoryEvidence = (
    left: WorkspaceRepositoryEvidence,
    right: WorkspaceRepositoryEvidence,
  ) => (
    sameOwnershipPath(left.canonicalRoot, right.canonicalRoot)
    || Boolean(
      left.gitCommonDir
      && right.gitCommonDir
      && sameIdentityPath(left.canonicalRoot, right.canonicalRoot)
      && sameIdentityPath(left.gitCommonDir, right.gitCommonDir)
    )
  );
  const workspaceRepositoryComponent = <T extends WorkspaceRepositoryEvidence>(
    seed: WorkspaceRepositoryEvidence,
    candidates: readonly T[],
  ): T[] => {
    const connected = new Set<T>();
    const frontier: WorkspaceRepositoryEvidence[] = [seed];
    while (frontier.length > 0) {
      const current = frontier.pop()!;
      for (const candidate of candidates) {
        if (connected.has(candidate)) continue;
        if (!sameWorkspaceRepositoryEvidence(current, candidate)) continue;
        connected.add(candidate);
        frontier.push(candidate);
      }
    }
    return candidates.filter((candidate) => connected.has(candidate));
  };
  const isWorkspaceRepositoryAnchor = (
    candidate: WorkspaceRepositoryEvidence,
    component: readonly WorkspaceRepositoryEvidence[],
  ) => component.every((member) => sameWorkspaceRepositoryEvidence(candidate, member));
  const preservesPersistedWorkspaceGitEvidence = (
    candidate: WorkspaceRepositoryEvidence,
    persistedMembers: readonly WorkspaceRepositoryEvidence[],
  ) => {
    const preservesPathEvidence = (
      candidatePath: unknown,
      persistedPaths: unknown[],
    ) => (
      persistedPaths.length === 0
      || Boolean(
        candidatePath
        && persistedPaths.every((persistedPath) => (
          sameIdentityPath(candidatePath, persistedPath)
        )),
      )
    );
    return preservesPathEvidence(
      candidate.gitCommonDir,
      persistedMembers.map((member) => member.gitCommonDir).filter(Boolean),
    ) && preservesPathEvidence(
      candidate.gitWorktreeDir,
      persistedMembers.map((member) => member.gitWorktreeDir).filter(Boolean),
    );
  };
  const compareWorkspaceRecords = (
    left: { workspaceId: string; createdAt?: unknown },
    right: { workspaceId: string; createdAt?: unknown },
  ) => (
    String(left.createdAt || '').localeCompare(String(right.createdAt || ''))
    || left.workspaceId.localeCompare(right.workspaceId)
  );
  const mapProjectIdentity = (row: IdentityRow | null | undefined, aliases: string[] | null = null) => row ? ({
    projectId: row.project_id || row.projectId!,
    canonicalRoot: row.canonical_root || row.canonicalRoot!,
    identitySource: row.identity_source || row.identitySource,
    identityDigest: row.identity_digest || row.identityDigest,
    aliases: aliases || safeJsonParse(row.aliases_json || row.aliasesJson, []),
    createdAt: row.created_at || row.createdAt,
    updatedAt: row.updated_at || row.updatedAt,
  }) : null;
  const findProjectIdentityByRoot = (root: string) => {
    if (invalidWindowsOwnershipPath(root)) return null;
    const exact = projectIdentityPersistence.getIdentityByCanonicalRoot(root);
    if (exact) return exact;
    return projectIdentityPersistence.listIdentities()
      .find((candidate) => sameOwnershipPath(candidate.canonical_root, root)) || null;
  };
  const projectIdentityAlias = (value: unknown, type: string | null = null) => {
    const raw = String(value || '');
    const alias = type === 'workspace-root' ? raw : raw.trim();
    if (!alias) return null;
    return {
      alias,
      aliasType: type || (alias.startsWith('http') ? 'remote' : alias.startsWith('workspace:') ? 'workspace-root' : 'legacy-project-id'),
    };
  };
  const projectScopedTables = () => (db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type='table' AND name NOT LIKE 'sqlite_%'
  `).all() as Array<SqliteTableRow>)
    .map((row) => row.name)
    .filter((name) => name !== 'project_identities')
    .filter((name) => (db.prepare(`PRAGMA table_info("${String(name).replaceAll('"', '""')}")`).all() as Array<SqliteTableRow>).some((column) => column.name === 'project_id'));
  const hasProjectData = (projectId: string) => Boolean(
    projectIdentityPersistence.getIdentityByProjectId(projectId)
      || projectScopedTables().some((table) => (
        Number((db.prepare(`SELECT COUNT(*) as count FROM "${String(table).replaceAll('"', '""')}" WHERE project_id=?`).get(projectId) as { count: number } | undefined)?.count || 0) > 0
      ))
      || projectKnowledgeNamespaceHasData(projectId, { runtimeHome }),
  );
  const projectDataSummary = (projectId: string) => {
    const tables = projectScopedTables().map((table) => ({
      table,
      count: Number((db.prepare(`SELECT COUNT(*) as count FROM "${String(table).replaceAll('"', '""')}" WHERE project_id=?`).get(projectId) as { count: number } | undefined)?.count || 0),
    })).filter((entry) => entry.count > 0);
    const knowledgeNamespace = projectKnowledgeNamespaceHasData(projectId, { runtimeHome });
    return {
      hasData: Boolean(tables.length || knowledgeNamespace),
      tables,
      knowledgeNamespace,
    };
  };
  const quoteIdentifier = (value: unknown) => `"${String(value).replaceAll('"', '""')}"`;
  const tableColumns = (table: string) => (db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as Array<SqliteTableRow>);
  const jsonReferenceColumns = (table: string) => tableColumns(table)
    .map((column) => column.name)
    .filter((name) => /(?:_json|_coverage)$/.test(name));
  const projectIdKeys = new Set([
    'projectId',
    'project_id',
    'canonicalProjectId',
    'canonical_project_id',
    'legacyProjectId',
    'legacy_project_id',
  ]);
  const projectIdListKeys = new Set([
    'projectIds',
    'project_ids',
    'legacyProjectIds',
    'legacy_project_ids',
  ]);
  // Rewrite only fields whose schema says they carry project identity. A
  // project_id-bearing JSON column can contain free-form statements, prompts,
  // or evidence text; replacing every matching string would corrupt those
  // payloads and make a multi-legacy migration non-deterministic.
  const rewriteProjectIdJson = (value: unknown, legacyIds: Set<string>, canonicalId: string, key: string | null = null): unknown => {
    if (typeof value === 'string') return key && projectIdKeys.has(key) && legacyIds.has(value) ? canonicalId : value;
    if (Array.isArray(value)) {
      return value.map((item) => {
        if (typeof item === 'string' && key && projectIdListKeys.has(key) && legacyIds.has(item)) return canonicalId;
        return rewriteProjectIdJson(item, legacyIds, canonicalId, key);
      });
    }
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([childKey, item]) => {
      if (typeof item === 'string' && projectIdKeys.has(childKey) && legacyIds.has(item)) return [childKey, canonicalId];
      if (Array.isArray(item) && projectIdListKeys.has(childKey)) {
        return [childKey, item.map((entry) => typeof entry === 'string' && legacyIds.has(entry) ? canonicalId : rewriteProjectIdJson(entry, legacyIds, canonicalId, childKey))];
      }
      return [childKey, rewriteProjectIdJson(item, legacyIds, canonicalId, childKey)];
    }));
  };
  const rewriteJsonColumnsForRows = (table: string, where: string, params: unknown[], legacyIds: Set<string>, canonicalId: string) => {
    const columns = jsonReferenceColumns(table);
    if (columns.length === 0) return;
    const quotedTable = quoteIdentifier(table);
    const selectColumns = ['rowid AS __kernel_rowid', ...columns.map(quoteIdentifier)].join(', ');
    const rows = (db.prepare(`SELECT ${selectColumns} FROM ${quotedTable} WHERE ${where}`).all(...params) as Array<UnknownRecord & { __kernel_rowid: number }>);
    for (const row of rows) {
      for (const column of columns) {
        if (row[column] === null || row[column] === undefined) continue;
        let parsed;
        try {
          parsed = JSON.parse(String(row[column]));
        } catch (error) {
          throw Object.assign(new Error(`project_identity_json_rewrite_invalid: ${table}.${column}: ${errorMessage(error)}`), {
            code: 'project_identity_json_rewrite_invalid',
            table,
            column,
          });
        }
        const rewritten = rewriteProjectIdJson(parsed, legacyIds, canonicalId);
        if (JSON.stringify(rewritten) !== row[column]) {
          db.prepare(`UPDATE ${quotedTable} SET ${quoteIdentifier(column)}=? WHERE rowid=?`).run(JSON.stringify(rewritten), row.__kernel_rowid);
        }
      }
    }
  };
  const tablesWithColumn = (columnName: string, { excludeProjectScoped = false }: { excludeProjectScoped?: boolean } = {}) => (db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type='table' AND name NOT LIKE 'sqlite_%'
  `).all() as Array<SqliteTableRow>)
    .map((row) => row.name)
    .filter((name) => !excludeProjectScoped || !tableColumns(name).some((column) => column.name === 'project_id'))
    .filter((name) => tableColumns(name).some((column) => column.name === columnName));
  const rewriteProjectScopedJson = (fromProjectId: string, toProjectId: string) => {
    const legacyIds = new Set([String(fromProjectId)]);
    for (const table of projectScopedTables()) rewriteJsonColumnsForRows(table, `${quoteIdentifier('project_id')}=?`, [fromProjectId], legacyIds, toProjectId);
    const runIds = workLifecyclePersistence.listRunIds({ projectId: fromProjectId });
    for (const table of tablesWithColumn('run_id', { excludeProjectScoped: true })) {
      for (const runId of runIds) rewriteJsonColumnsForRows(table, `${quoteIdentifier('run_id')}=?`, [runId], legacyIds, toProjectId);
    }
  };
  const workspaceReferenceColumns = ['workspace_id', 'execution_workspace_id', 'integration_workspace_id'];
  const sourceWorkspaceIdsForProject = (projectId: string) => workLifecyclePersistence
    .listProjectWorkspaceRecords(projectId)
    .map((workspace) => workspace.workspaceId);
  const rewriteWorkspaceScopedJson = (workspaceIds: string[], legacyProjectId: string, canonicalProjectId: string) => {
    if (workspaceIds.length === 0) return;
    const legacyIds = new Set([String(legacyProjectId)]);
    const workspaceTables = [...new Set(workspaceReferenceColumns.flatMap((column) => tablesWithColumn(column)))];
    for (const table of workspaceTables) {
      const columns = tableColumns(table).map((column) => column.name).filter((name) => workspaceReferenceColumns.includes(name));
      for (const column of columns) {
        for (const workspaceId of workspaceIds) rewriteJsonColumnsForRows(table, `${quoteIdentifier(column)}=?`, [workspaceId], legacyIds, canonicalProjectId);
      }
    }
  };
  const migrateProjectId = (fromProjectId: string, toProjectId: string) => {
    if (!fromProjectId || !toProjectId || fromProjectId === toProjectId) return false;
    const sourceWorkspaceIds = sourceWorkspaceIdsForProject(fromProjectId);
    rewriteProjectScopedJson(fromProjectId, toProjectId);
    rewriteWorkspaceScopedJson(sourceWorkspaceIds, fromProjectId, toProjectId);
    migrateProjectWorkspaces(fromProjectId, toProjectId);
    for (const table of projectScopedTables()) {
      const quotedTable = `"${String(table).replaceAll('"', '""')}"`;
      if (table === 'project_workspaces') {
        continue;
      }
      if (table === 'knowledge_revisions') {
        const source = (db.prepare(`SELECT revision, updated_at FROM ${quotedTable} WHERE project_id=?`).get(fromProjectId) as KnowledgeRevisionRow | undefined);
        if (!source) continue;
        const destination = (db.prepare(`SELECT revision, updated_at FROM ${quotedTable} WHERE project_id=?`).get(toProjectId) as KnowledgeRevisionRow | undefined);
        if (destination) {
          const revision = Math.max(Number(source.revision || 1), Number(destination.revision || 1));
          const updatedAt = String(source.updated_at || '') >= String(destination.updated_at || '') ? source.updated_at : destination.updated_at;
          db.prepare(`UPDATE ${quotedTable} SET revision=?, updated_at=? WHERE project_id=?`).run(revision, updatedAt, toProjectId);
          db.prepare(`DELETE FROM ${quotedTable} WHERE project_id=?`).run(fromProjectId);
        } else {
          db.prepare(`UPDATE ${quotedTable} SET project_id=? WHERE project_id=?`).run(toProjectId, fromProjectId);
        }
        continue;
      }
      db.prepare(`UPDATE ${quotedTable} SET project_id=? WHERE project_id=?`).run(toProjectId, fromProjectId);
    }
    return true;
  };
  const legacyIdentityCandidates = (identity: ProjectIdentityInput = {}) => {
    const raw = Array.isArray(identity.legacyAliases) && identity.legacyAliases.length > 0
      ? identity.legacyAliases
      : (Array.isArray(identity.legacyProjectIds) ? identity.legacyProjectIds.map((projectId) => ({ projectId, source: 'unknown' })) : []);
    const priority: Record<string, number> = { persisted: 0, 'path-hash': 1, origin: 2, package: 3, basename: 4, unknown: 5 };
    return [...new Map(raw.map((candidate): [string, Required<LegacyIdentityCandidate>] => {
      const normalized: LegacyIdentityCandidate = typeof candidate === 'string' ? { projectId: candidate, source: 'unknown' } : candidate;
      const projectId = String(normalized?.projectId || '').trim();
      return [projectId, {
        projectId,
        source: String(normalized?.source || 'unknown'),
        aliasType: String(normalized?.aliasType || 'legacy-project-id'),
        canonicalRoot: normalized?.canonicalRoot ? canonicalIdentityRoot(normalized.canonicalRoot) : null,
      }];
    }).filter(([projectId]) => projectId)).values()]
      .sort((left, right) => (priority[left.source] ?? 9) - (priority[right.source] ?? 9));
  };
  const workspaceScopedTables = () => (db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type='table' AND name NOT LIKE 'sqlite_%'
  `).all() as Array<SqliteTableRow>)
    .map((row) => row.name)
    .filter((name) => name !== 'project_workspaces')
    .filter((name) => tableColumns(name).some((column) => workspaceReferenceColumns.includes(column.name)));
  const rebindWorkspaceWorktreeAuthority = ({
    fromProjectId,
    toProjectId,
    workspaceId,
    sourceWorktreeId,
    nextWorktreeId,
  }: {
    fromProjectId: string;
    toProjectId: string;
    workspaceId: string;
    sourceWorktreeId: string | null;
    nextWorktreeId: string;
  }) => {
    const priorRunWorktreeIds = (db.prepare(`
      SELECT DISTINCT worktree_id AS worktreeId
      FROM runs
      WHERE project_id=? AND workspace_id=? AND worktree_id IS NOT NULL
    `).all(fromProjectId, workspaceId) as Array<{ worktreeId: string }>)
      .map((row) => row.worktreeId);
    const priorWorktreeIds = [...new Set([
      sourceWorktreeId,
      ...priorRunWorktreeIds,
    ].filter((value): value is string => Boolean(value)))];

    // Worktree mutation authority follows the surviving workspace identity.
    // Keep the existing target lease when one is already present; otherwise
    // move the source lease to the surviving worktree id.
    db.prepare(`
      UPDATE runs
      SET worktree_id=?
      WHERE project_id=? AND workspace_id=?
    `).run(nextWorktreeId, fromProjectId, workspaceId);
    for (const priorWorktreeId of priorWorktreeIds) {
      const sourceLease = workLifecyclePersistence.getWorktreeMutationLease(priorWorktreeId);
      if (!sourceLease || sourceLease.projectId !== fromProjectId) continue;
      if (priorWorktreeId === nextWorktreeId) {
        if (fromProjectId !== toProjectId) {
          db.prepare(`
            UPDATE worktree_mutation_leases
            SET project_id=?
            WHERE worktree_id=? AND project_id=? AND holder_run_id=?
          `).run(toProjectId, priorWorktreeId, fromProjectId, sourceLease.holderRunId);
        }
        continue;
      }
      const targetLease = workLifecyclePersistence.getWorktreeMutationLease(nextWorktreeId);
      if (targetLease) {
        if (targetLease.projectId !== toProjectId) {
          throw Object.assign(new Error('project_worktree_lease_migration_conflict'), {
            code: 'project_worktree_lease_migration_conflict',
            worktreeId: nextWorktreeId,
            projectIds: [targetLease.projectId, toProjectId],
          });
        }
        workLifecyclePersistence.deleteWorktreeMutationLease({
          worktreeId: priorWorktreeId,
          projectId: fromProjectId,
          runId: sourceLease.holderRunId,
        });
        continue;
      }
      db.prepare(`
        UPDATE worktree_mutation_leases
        SET worktree_id=?, project_id=?
        WHERE worktree_id=? AND project_id=? AND holder_run_id=?
      `).run(
        nextWorktreeId,
        toProjectId,
        priorWorktreeId,
        fromProjectId,
        sourceLease.holderRunId,
      );
    }
  };

  const migrateProjectWorkspaces = (fromProjectId: string, toProjectId: string) => {
    const sourceRows = [...workLifecyclePersistence.listProjectWorkspaceRecords(fromProjectId)]
      .sort(compareWorkspaceRecords);
    const targetRows = [...workLifecyclePersistence.listProjectWorkspaceRecords(toProjectId)]
      .sort(compareWorkspaceRecords);
    const observedRows = [...targetRows, ...sourceRows];
    const sourceWorkspaceIds = new Set(sourceRows.map(({ workspaceId }) => workspaceId));
    const targetWorkspaceIds = new Set(targetRows.map(({ workspaceId }) => workspaceId));
    const processedWorkspaceIds = new Set<string>();

    for (const source of sourceRows) {
      if (processedWorkspaceIds.has(source.workspaceId)) continue;
      const component = workspaceRepositoryComponent(source, observedRows)
        .filter(({ workspaceId }) => !processedWorkspaceIds.has(workspaceId))
        .sort(compareWorkspaceRecords);
      const anchors = component
        .filter((candidate) => (
          isWorkspaceRepositoryAnchor(candidate, component)
          && preservesPersistedWorkspaceGitEvidence(candidate, component)
        ))
        .sort((left, right) => {
          const leftTarget = targetWorkspaceIds.has(left.workspaceId) ? 0 : 1;
          const rightTarget = targetWorkspaceIds.has(right.workspaceId) ? 0 : 1;
          return leftTarget - rightTarget || compareWorkspaceRecords(left, right);
        });
      const survivor = anchors[0] || null;
      if (!survivor) {
        throw Object.assign(new Error('project_workspace_repository_component_unanchored'), {
          code: 'project_workspace_repository_component_unanchored',
          sourceProjectId: fromProjectId,
          targetProjectId: toProjectId,
          workspaceIds: component.map(({ workspaceId }) => workspaceId),
        });
      }

      // Keep a workspace whose persisted root + Git evidence directly proves
      // every member of the component. This preserves the evidence that made
      // the transitive collapse valid, so a later surface re-observation
      // resolves back to the same authority instead of recreating a split.
      const survivorFromProjectId = sourceWorkspaceIds.has(survivor.workspaceId)
        ? fromProjectId
        : toProjectId;
      const nextWorktreeId = deriveKernelWorktreeId({
        projectId: toProjectId,
        canonicalWorktreeRoot: survivor.canonicalRoot,
        canonicalGitDir: survivor.gitWorktreeDir || null,
      });
      rebindWorkspaceWorktreeAuthority({
        fromProjectId: survivorFromProjectId,
        toProjectId,
        workspaceId: survivor.workspaceId,
        sourceWorktreeId: survivor.worktreeId,
        nextWorktreeId,
      });

      const survivorIdentity = safeJsonParse<UnknownRecord>(survivor.identityJson, {});
      survivorIdentity.projectId = toProjectId;
      survivorIdentity.canonicalRoot = survivor.canonicalRoot;
      survivorIdentity.worktreeId = nextWorktreeId;
      workLifecyclePersistence.upsertProjectWorkspaceRecord({
        ...survivor,
        projectId: toProjectId,
        worktreeId: nextWorktreeId,
        identityJson: persistentJson(survivorIdentity),
        lastSeenAt: now(),
      });

      for (const member of component) {
        if (member.workspaceId === survivor.workspaceId) continue;
        const memberFromProjectId = sourceWorkspaceIds.has(member.workspaceId)
          ? fromProjectId
          : toProjectId;
        rebindWorkspaceWorktreeAuthority({
          fromProjectId: memberFromProjectId,
          toProjectId,
          workspaceId: member.workspaceId,
          sourceWorktreeId: member.worktreeId,
          nextWorktreeId,
        });
        workLifecyclePersistence.mergeProjectWorkspaceReferences({
          sourceWorkspaceId: member.workspaceId,
          targetWorkspaceId: survivor.workspaceId,
          canonicalRoot: survivor.canonicalRoot,
          withinTransaction: true,
        });
      }

      for (const member of component) processedWorkspaceIds.add(member.workspaceId);
    }
  };
  const terminalRunStatuses = new Set(['completed', 'blocked', 'abandoned']);
  const worktreeLeaseTerminalStatuses = new Set(['completed', 'abandoned']);
  const reconcileTerminalLifecycleInTransaction = ({
    projectId = null,
    runId = null,
    observedAt = now(),
  }: { projectId?: string | null; runId?: string | null; observedAt?: string } = {}) => {
    const deactivatedBindings = [];
    const terminalBindings = workLifecyclePersistence.listSessionBindings({
      projectId,
      runId,
      status: 'active',
      accessMode: 'owner',
    }).map((binding) => ({
      ...binding,
      runStatus: workLifecyclePersistence.getRunLifecycleIdentity(binding.runId)?.status || null,
    })).filter((binding) => ['completed', 'blocked'].includes(binding.runStatus || ''));
    for (const binding of terminalBindings) {
      const closedAt = now();
      const updated = workLifecyclePersistence.updateSessionBinding({
        bindingId: binding.bindingId,
        expected: {
          projectId: binding.projectId,
          runId: binding.runId,
          status: 'active',
          accessMode: 'owner',
        },
        changes: {
          status: 'inactive',
          closedAt,
          closeReason: `terminal_${binding.runStatus}_cleanup`,
          successorRunId: null,
          updatedAt: closedAt,
        },
      });
      if (updated) deactivatedBindings.push({
        bindingId: binding.bindingId,
        runId: binding.runId,
        projectId: binding.projectId,
        sessionId: binding.sessionId,
        runStatus: binding.runStatus,
      });
    }

    const observedMs = Date.parse(observedAt);
    const releasedLocks = [];
    const worktreeLeases = workLifecyclePersistence.listWorktreeMutationLeases({
      projectId,
      runId,
    });
    for (const lease of worktreeLeases) {
      if (!worktreeLeaseTerminalStatuses.has(lease.runStatus || '')) continue;
      const released = workLifecyclePersistence.deleteWorktreeMutationLease({
        worktreeId: lease.worktreeId,
        projectId: lease.projectId,
        runId: lease.holderRunId,
      });
      if (released) releasedLocks.push({
        version: 3,
        worktreeId: lease.worktreeId,
        projectId: lease.projectId,
        holderRunId: lease.holderRunId,
        reason: `terminal_${lease.runStatus}`,
      });
    }
    const v2Locks = workLifecyclePersistence.listWorkspaceMutationLocksV2({ projectId });
    for (const lock of v2Locks) {
      const run = workLifecyclePersistence.getRunLifecycleIdentity(lock.holderRunId);
      const expired = Number.isFinite(Date.parse(lock.expiresAt))
        ? Date.parse(lock.expiresAt) <= observedMs
        : true;
      const invalidOwner = !run
        || run.projectId !== lock.projectId
        || run.workspaceId !== lock.workspaceId;
      const terminal = run && terminalRunStatuses.has(run.status);
      const shouldRelease = expired || invalidOwner || terminal;
      if (!shouldRelease) continue;
      const released = workLifecyclePersistence.deleteWorkspaceMutationLockV2({
        workspaceId: lock.workspaceId,
        projectId: lock.projectId,
        runId: lock.holderRunId,
        sessionToken: lock.sessionToken,
        fencingToken: Number(lock.fencingToken),
      });
      if (released) releasedLocks.push({
        version: 2,
        workspaceId: lock.workspaceId,
        projectId: lock.projectId,
        holderRunId: lock.holderRunId,
        reason: expired ? 'expired' : (invalidOwner ? 'invalid_owner' : `terminal_${run.status}`),
      });
    }


    return {
      deactivatedBindings,
      releasedLocks,
    };
  };
  const bindingConflict: (error: unknown) => never = (error) => {
    if (String(errorMessage(error) || '').includes('UNIQUE constraint failed')) {
      throw Object.assign(new Error('successor_binding_conflict'), {
        code: 'successor_binding_conflict',
        errorCode: 'successor_binding_conflict',
        nextAction: 'inspect-active-owner-binding',
      });
    }
    throw error;
  };

  const claimWorktreeLeaseInTransaction = ({ worktreeId, projectId, runId }: { worktreeId: string; projectId: string; runId: string }) => {
    let current = workLifecyclePersistence.getWorktreeMutationLease(worktreeId);
    if (current?.holderRunId === runId && current.projectId === projectId) {
      return { acquired: true, created: false, lease: current };
    }
    if (current) {
      const holder = workLifecyclePersistence.getRunLifecycleIdentity(current.holderRunId);
      if (!holder || worktreeLeaseTerminalStatuses.has(holder.status)) {
        workLifecyclePersistence.deleteWorktreeMutationLease({
          worktreeId,
          runId: current.holderRunId,
        });
        current = null;
      }
    }
    if (current) return { acquired: false, created: false, lease: current };

    const lease = workLifecyclePersistence.insertWorktreeMutationLease({
      worktreeId,
      projectId,
      runId,
    });
    return { acquired: true, created: true, lease };
  };

  const throwWorktreeRunConflict = (lease: PersistedWorktreeMutationLease | null = null) => {
    throw Object.assign(new Error('worktree_run_conflict'), {
      code: 'worktree_run_conflict',
      errorCode: 'worktree_run_conflict',
      nextAction: 'resume-the-worktree-bound-run',
      details: lease ? { holderRunId: lease.holderRunId, worktreeId: lease.worktreeId } : {},
    });
  };

  const store = {
    ...knowledgeLifecyclePersistence,
    ...workStepPersistence,
    ...workAttemptPersistence,
    dbPath,
    createRun({
      runId,
      objective,
      sourceIdentity,
      proofTier = 'T0',
      evidenceTier = 'E0',
      requiredObligations = [],
      acceptanceCriteria = [],
      requireReleaseEvidence = false,
      projectId = null,
      knowledgeRevisionStart = null,
      workspaceIdentity = null,
      runStartGitCommitSha = null,
      projectMode = null,
      taskContract = null,
      contractRevision = 1,
      route = null,
      implementationContext = null,
      workspaceId = null,
      worktreeId = null,
      baselineChangedPaths = [],
      baselineWorkspaceEntries = [],
      reportBaselineChangedPaths = null,
      reportBaselineWorkspaceEntries = null,
      workspaceBaselineStatus = 'known',
      ownerBindingId = null,
      successorKey = null,
      withinTransaction = false,
    }: CreateRunInput) {
      if (!sourceIdentity || typeof sourceIdentity !== 'string' || !sourceIdentityRegex.test(sourceIdentity)) {
        throw new Error('sourceIdentity is required and must be a valid candidate identity string for Kernel run');
      }
      if (workspaceIdentity !== null && !sha256Regex.test(workspaceIdentity)) {
        throw new Error('workspaceIdentity must be a sha256:<hex> digest when provided');
      }
      if (runStartGitCommitSha !== null && !gitCommitShaRegex.test(runStartGitCommitSha)) {
        throw new Error('runStartGitCommitSha must be a full Git commit SHA when provided');
      }
      const registeredWorkspace = workspaceId ? this.getProjectWorkspace(workspaceId) : null;
      if (registeredWorkspace && projectId && registeredWorkspace.projectId !== projectId) {
        throw Object.assign(new Error('run_project_mismatch'), { code: 'run_project_mismatch' });
      }
      if (worktreeId && registeredWorkspace?.worktreeId && worktreeId !== registeredWorkspace.worktreeId) {
        throw Object.assign(new Error('run_worktree_mismatch'), { code: 'run_worktree_mismatch' });
      }
      const effectiveWorktreeId = worktreeId || registeredWorkspace?.worktreeId || null;
      const persistRun = () => {
        workLifecyclePersistence.insertRun({
          runId,
          objective,
          sourceIdentity,
          runStartGitCommitSha,
          workspaceIdentity,
          projectMode: projectMode || null,
          proofTier,
          evidenceTier,
          requiredObligationsJson: JSON.stringify(requiredObligations),
          acceptanceCriteriaJson: JSON.stringify(acceptanceCriteria),
          requireReleaseEvidence,
          projectId: projectId || null,
          knowledgeRevisionStart: knowledgeRevisionStart !== undefined && knowledgeRevisionStart !== null
            ? String(knowledgeRevisionStart)
            : null,
          taskContractJson: taskContract ? persistentJson(taskContract) : null,
          contractRevision: Number(contractRevision) || 1,
          routeJson: route ? JSON.stringify(route) : null,
          implementationContextJson: implementationContext ? persistentJson(implementationContext) : null,
          workspaceId,
          worktreeId: effectiveWorktreeId,
          baselineChangedPathsJson: JSON.stringify(canonicalReceiptPaths(baselineChangedPaths)),
          baselineWorkspaceEntriesJson: persistentJson(baselineWorkspaceEntries),
          workspaceBaselineChangedPathsJson: JSON.stringify(
            canonicalReceiptPaths(
              reportBaselineChangedPaths === null ? baselineChangedPaths : reportBaselineChangedPaths,
            ),
          ),
          workspaceBaselineEntriesJson: persistentJson(
            reportBaselineWorkspaceEntries === null
              ? baselineWorkspaceEntries
              : reportBaselineWorkspaceEntries,
          ),
          workspaceBaselineStatus,
          ownerBindingId,
          successorKey,
        });
        if (effectiveWorktreeId && projectId) {
          const lease = claimWorktreeLeaseInTransaction({
            worktreeId: effectiveWorktreeId,
            projectId,
            runId,
          });
          if (!lease.acquired) throwWorktreeRunConflict(lease.lease);
        }
      };
      if (withinTransaction) persistRun();
      else db.transaction(persistRun)();
      return this.getRun(runId)!;
    },

    // Remove only a Run that was created by a failed pre-dispatch bootstrap.
    // This is deliberately stricter than abandon: an initialized or mutated
    // Run is durable user history and must never be erased as cleanup. The
    // child-table order is derived from SQLite foreign keys so rollback remains
    // valid as lifecycle receipts gain new references.
    rollbackRunInitialization(runId: string, { projectId = null, sourceIdentity = null }: { projectId?: string | null; sourceIdentity?: string | null } = {}) {
      if (!runId) throw new Error('rollbackRunInitialization requires runId');
      return db.transaction(() => workLifecyclePersistence.rollbackRunInitialization({
        runId,
        projectId,
        sourceIdentity,
      }))();
    },

    // Task Contract is the run's authority; a revision bump records that the
    // model refined it (for example with an optional evidence plan) mid-run.
    updateTaskContract(runId: string, taskContract: StoredTaskContract, { bumpRevision = true }: { bumpRevision?: boolean } = {}) {
      const run = this.getRun(runId);
      if (!run) throw new Error(`Run ${runId} not found`);
      const nextRevision = bumpRevision ? Number(run.contractRevision || 1) + 1 : Number(run.contractRevision || 1);
      workLifecyclePersistence.persistRunTaskContract({
        runId,
        taskContractJson: persistentJson(taskContract),
        contractRevision: nextRevision,
        acceptanceCriteriaJson: persistentJson(
          (taskContract.acceptance || []).map((item) => item.statement).filter(Boolean),
        ),
      });
      return this.getRun(runId)!;
    },

    // Contract revisions change the binding authority for both plans and
    // persisted proof. Keep the contract, compiled obligations, and legacy
    // statement coverage in one SQLite transaction so a rebase cannot leave a
    // half-updated contract whose evidence points at a different AC namespace.
    reviseTaskContractAtomic(runId: string, taskContract: StoredTaskContract, { obligations = [], bumpRevision = true }: { obligations?: DeclaredRunObligationInput[]; bumpRevision?: boolean } = {}) {
      const run = this.getRun(runId);
      if (!run) throw new Error(`Run ${runId} not found`);
      const nextRevision = bumpRevision
        ? Number(run.contractRevision || 1) + 1
        : Number(run.contractRevision || 1);
      const revise = db.transaction(() => {
        const compiledIds = [...new Set(obligations.map((obligation) => obligation.obligationId))];
        const previousObligationRows = new Map(this.getRunObligations(runId).map((obligation) => [obligation.obligationId, obligation]));
        const existingObligationIds = [...previousObligationRows.keys()];
        const supersededObligationIds = existingObligationIds
          .filter((obligationId) => !compiledIds.includes(obligationId));
        // The compiled result is the complete current authority. Historical
        // rows remain queryable and are marked superseded below, but they must
        // not silently keep a removed requirement alive in the Run gate.
        const nextRequiredObligations = compiledIds;
        workLifecyclePersistence.persistRunTaskContract({
          runId,
          taskContractJson: persistentJson(taskContract),
          contractRevision: nextRevision,
          acceptanceCriteriaJson: persistentJson(
            (taskContract.acceptance || []).map((item) => item.statement).filter(Boolean),
          ),
          requiredObligationsJson: persistentJson(nextRequiredObligations),
        });

        trustPersistence.supersedeRunObligations(runId, supersededObligationIds);
        trustPersistence.declareRunObligations(
          runId,
          obligations.map((obligation) => ({
            ...obligation,
            contractRevision: nextRevision,
          })),
        );

        const obligationRows: Map<string, DeclaredRunObligationInput> = new Map(this.getRunObligations(runId).map((obligation) => [obligation.obligationId, obligation]));
        for (const obligation of obligations) obligationRows.set(obligation.obligationId, obligation);
        const canonicalCoverage = (rawCoverage: unknown, obligationId: string) => {
          const coverage = Array.isArray(rawCoverage)
            ? rawCoverage
            : safeJsonParse(rawCoverage, []);
          if (coverage.length === 0) return [];
          const previousObligation = previousObligationRows.get(obligationId) || null;
          // Once an obligation has been superseded it no longer participates
          // in the current completion authority. Its historical coverage is
          // retained for audit only and may refer to acceptance ids removed by
          // an earlier replacement, so do not validate it against the reduced
          // current contract on later revisions.
          if (previousObligation?.status === 'superseded' && !compiledIds.includes(obligationId)) {
            return coverage;
          }
          // Validate historical evidence against the old authority first. A
          // genuinely malformed old receipt still fails closed; a criterion
          // deliberately removed by the new contract becomes stale history.
          try {
            normalizeAcceptanceCoverage({
              contract: run.taskContract || {},
              acceptanceCriteria: run.acceptanceCriteria || [],
              obligation: previousObligation,
              coverage,
            });
          } catch (error) {
            throw Object.assign(new Error(`CONTRACT_COVERAGE_REBASE_FAILED: ${errorMessage(error)}`), {
              code: 'CONTRACT_COVERAGE_REBASE_FAILED',
              detail: { obligationId, coverage, cause: errorCode(error) || 'ACCEPTANCE_COVERAGE_INVALID' },
            });
          }
          if (!compiledIds.includes(obligationId)) return coverage;
          try {
            return normalizeAcceptanceCoverage({
              contract: taskContract,
              acceptanceCriteria: (taskContract.acceptance || []).map((item) => item.statement).filter(Boolean),
              obligation: obligationRows.has(obligationId) ? { ...obligationRows.get(obligationId)! } : null,
              coverage,
            });
          } catch (error) {
            // Removal or rebinding of an acceptance criterion makes prior
            // proof stale, not a reason to abandon the Run. The old validation
            // above preserves the fail-closed check for corrupt history.
            if (errorCode(error) === 'ACCEPTANCE_COVERAGE_UNKNOWN'
              || errorCode(error) === 'ACCEPTANCE_COVERAGE_NOT_BOUND') return [];
            throw Object.assign(new Error(`CONTRACT_COVERAGE_REBASE_FAILED: ${errorMessage(error)}`), {
              code: 'CONTRACT_COVERAGE_REBASE_FAILED',
              detail: { obligationId, coverage, cause: errorCode(error) || 'ACCEPTANCE_COVERAGE_INVALID' },
            });
          }
        };

        for (const row of trustPersistence.getVerificationHistory(runId)) {
          const canonical = canonicalCoverage(row.acceptanceCoverage, row.obligationId);
          trustPersistence.updateVerificationAcceptanceCoverage(Number(row.id), canonical);
        }
        for (const row of trustPersistence.getWaivers(runId)) {
          const canonical = canonicalCoverage(row.acceptanceCoverage, row.obligationId);
          trustPersistence.updateWaiverAcceptanceCoverage(Number(row.id), canonical);
        }
        for (const receipt of trustPersistence.listReviewReceipts(runId)) {
          const canonical = canonicalCoverage(receipt.acceptanceCoverage, String(receipt.obligationId));
          trustPersistence.updateReviewReceiptAcceptanceCoverage(
            String(receipt.receiptId),
            canonical,
            { ...receipt, acceptanceCoverage: canonical },
          );
        }
      });
      revise();
      return this.getRun(runId)!;
    },

    setRunRoute(runId: string, route: StoredRunRoute) {
      hostExecutionPersistence.setRunRoute(runId, route);
      return this.getRun(runId)!;
    },

    // Finalization is tracked separately from completion (P0-7): an accepted
    // completion whose knowledge commit or Git closeout failed is NOT done.
    setFinalizationStatus(runId: string, finalizationStatus: string) {
      finalizationPersistence.setRunFinalizationStatus(runId, String(finalizationStatus));
      return this.getRun(runId)!;
    },

    // Compiled obligations are the run's binding authority: which evidence
    // class and which project commands may satisfy each required obligation.
    declareRunObligations(runId: string, obligations: DeclaredRunObligationInput[] = []) {
      return trustPersistence.declareRunObligations(runId, obligations);
    },

    // Within a run, route and tier may only be promoted, never demoted
    // (§13.5). Demotion requires a new run.
    escalateRun(runId: string, { proofTier, evidenceTier, addObligations = [] }: { proofTier?: (string) | undefined; evidenceTier?: (string) | undefined; addObligations?: string[] } = {}) {
      const run = this.getRun(runId);
      if (!run) throw new Error(`Run ${runId} not found`);
      if (run.status === 'completed') throw new Error(`Cannot escalate completed run ${runId}`);

      let nextTier = run.proofTier;
      if (proofTier) {
        if (!isProofTier(proofTier)) throw new Error(`Unknown proof tier: ${proofTier}`);
        if (TIER_RANK[proofTier] < TIER_RANK[run.proofTier]) {
          throw new Error(`ROUTE_DEMOTION_FORBIDDEN: cannot demote ${run.proofTier} -> ${proofTier}; start a new run instead`);
        }
        nextTier = proofTier;
      }

      let nextEvidence = run.evidenceTier;
      if (evidenceTier) {
        if (EVIDENCE_RANK[evidenceTier] === undefined) throw new Error(`Unknown evidence tier: ${evidenceTier}`);
        const currentEvidenceRank = EVIDENCE_RANK[run.evidenceTier];
        if (currentEvidenceRank === undefined) throw new Error(`Unknown persisted evidence tier: ${run.evidenceTier}`);
        if (EVIDENCE_RANK[evidenceTier] < currentEvidenceRank) {
          throw new Error(`ROUTE_DEMOTION_FORBIDDEN: cannot demote evidence ${run.evidenceTier} -> ${evidenceTier}`);
        }
        nextEvidence = evidenceTier;
      }

      const mergedObligations = [...new Set([...run.requiredObligations, ...addObligations])];
      trustPersistence.setRunProofPolicy(runId, {
        proofTier: nextTier,
        evidenceTier: nextEvidence,
        requiredObligations: mergedObligations,
        releaseEvidenceRequired: nextEvidence === 'E2' ? true : Boolean(run.releaseEvidenceRequired),
      });
      return this.getRun(runId)!;
    },

    setBaselineFailures(runId: string, failures: UnknownRecord[] = []) {
      if (!this.getRun(runId)) throw new Error(`Run ${runId} not found`);
      trustPersistence.setRunBaselineFailures(runId, failures);
      return this.getRun(runId)!;
    },

    setBaselineStatus(runId: string, status: string) {
      if (!this.getRun(runId)) throw new Error(`Run ${runId} not found`);
      trustPersistence.setRunBaselineStatus(runId, String(status));
      return this.getRun(runId)!;
    },

    setKnowledgeStatus(runId: string, status: string) {
      if (!this.getRun(runId)) throw new Error(`Run ${runId} not found`);
      knowledgeLifecyclePersistence.setRunKnowledgeStatus(runId, String(status || 'no_candidates_submitted'));
      return this.getRun(runId)!;
    },

    // A replan is a durable event; counting it keeps the measurement honest.
    markRunBlocked(runId: string, reason: string, blockingClass: string | null = null) {
      const run = this.getRun(runId);
      if (!run) throw new Error(`Run ${runId} not found`);
      if (run.status === 'completed') throw new Error(`Cannot block completed run ${runId}`);
      const normReason = String(reason || 'question');
      const resolvedClass = blockingClass
        || (normReason.includes('verification') || normReason.includes('obligation') || normReason.includes('dependency') || normReason.includes('question') || normReason.includes('permission') || normReason.includes('scope') ? 'completion' : 'safety');
      db.transaction(() => {
        workLifecyclePersistence.updateRunLifecycle({
          runId,
          status: 'blocked',
          blockedReason: normReason,
          blockingClass: String(resolvedClass),
          incrementRevision: true,
        });
        reconcileTerminalLifecycleInTransaction({ projectId: run.projectId, runId });
      })();
      this.recordRunEfficiency(runId, { timestamps: { blockedAt: now() } });
      return this.getRun(runId)!;
    },

    // Each blocked->active resume is a user intervention; counting it here
    // keeps the measurement honest without a caller-held tally.
    resumeBlockedRun(runId: string) {
      const run = this.getRun(runId);
      if (!run) throw new Error(`Run ${runId} not found`);
      if (run.status !== 'blocked') return run;
      db.transaction(() => {
        if (run.worktreeId && run.projectId) {
          const lease = claimWorktreeLeaseInTransaction({
            worktreeId: run.worktreeId,
            projectId: run.projectId,
            runId,
          });
          if (!lease.acquired) throwWorktreeRunConflict(lease.lease);
        }
        workLifecyclePersistence.updateRunLifecycle({
          runId,
          status: 'active',
          blockedReason: null,
          blockingClass: null,
          incrementIntervention: true,
          incrementRevision: true,
        });
      })();
      return this.getRun(runId)!;
    },

    // A blocked run's owner is intentionally inactive. Resumption is the
    // explicit lifecycle transition that may reactivate that same binding;
    // another host/session cannot claim it as an unowned run.
    reactivateBlockedRunBinding(binding: Partial<BindingInput> = {}) {
      if (!binding.bindingId || !binding.sessionId || !binding.runId || !binding.projectId) {
        throw Object.assign(new Error('host_binding_missing'), { code: 'host_binding_missing' });
      }
      const validatedBinding = { ...binding, bindingId: binding.bindingId, sessionId: binding.sessionId, runId: binding.runId, projectId: binding.projectId };
      const reactivate = db.transaction(() => {
        const run = workLifecyclePersistence.getRunLifecycleIdentity(validatedBinding.runId);
        if (!run || run.projectId !== validatedBinding.projectId || run.status !== 'blocked') return null;
        if (run.ownerBindingId !== validatedBinding.bindingId) return null;
        if (run.workspaceId && run.workspaceId !== (validatedBinding.workspaceId || null)) return null;
        const current = workLifecyclePersistence.getSessionBinding(validatedBinding.bindingId);
        if (!current || current.status !== 'inactive' || current.projectId !== validatedBinding.projectId || current.runId !== validatedBinding.runId) return null;
        if (current.sessionId !== validatedBinding.sessionId || current.accessMode !== 'owner') return null;
        const conflict = workLifecyclePersistence.listSessionBindings({
          projectId: validatedBinding.projectId,
          sessionId: validatedBinding.sessionId,
          workspaceId: validatedBinding.workspaceId || null,
          status: 'active',
          accessMode: 'owner',
        }).find((candidate) => candidate.bindingId !== validatedBinding.bindingId);
        if (conflict) {
          throw Object.assign(new Error('successor_binding_conflict'), {
            code: 'successor_binding_conflict',
            errorCode: 'successor_binding_conflict',
            nextAction: 'inspect-active-owner-binding',
          });
        }
        const updatedAt = now();
        const updated = workLifecyclePersistence.updateSessionBinding({
          bindingId: validatedBinding.bindingId,
          expected: {
            projectId: validatedBinding.projectId,
            sessionId: validatedBinding.sessionId,
            status: 'inactive',
            accessMode: 'owner',
          },
          changes: {
            provider: validatedBinding.provider || current.provider,
            surface: validatedBinding.surface ?? current.surface,
            workspaceId: validatedBinding.workspaceId || null,
            workspaceRoot: validatedBinding.workspaceRoot || null,
            status: 'active',
            closedAt: null,
            closeReason: null,
            successorRunId: null,
            expiresAt: validatedBinding.expiresAt || null,
            updatedAt,
          },
        });
        if (!updated) return null;
        const resumed = workLifecyclePersistence.updateRunLifecycle({
          runId: validatedBinding.runId,
          expectedStatus: 'blocked',
          expectedOwnerBindingId: validatedBinding.bindingId,
          status: 'active',
          blockedReason: null,
          blockingClass: null,
          incrementIntervention: true,
          incrementRevision: true,
          updatedAt,
        });
        if (!resumed) {
          throw Object.assign(new Error('successor_binding_conflict'), {
            code: 'successor_binding_conflict',
            errorCode: 'successor_binding_conflict',
            nextAction: 'inspect-active-owner-binding',
          });
        }
        return workLifecyclePersistence.getSessionBinding(validatedBinding.bindingId);
      });
      return reactivate();
    },

    recordRunSignals(runId: string, signals: RunSignals = {}) {
      const run = this.getRun(runId);
      if (!run) throw new Error(`Run ${runId} not found`);
      const prior = run.runSignals && typeof run.runSignals === 'object' ? run.runSignals : {};
      const mergeSignals = (left: unknown[] = [], right: unknown[] = []) => [...left, ...right].filter(Boolean);
      const merged = {
        ...prior,
        ...signals,
        failures: mergeSignals(prior.failures, signals.failures),
        blockers: mergeSignals(prior.blockers, signals.blockers),
        architectureJudgments: mergeSignals(prior.architectureJudgments, signals.architectureJudgments),
        regressionVerifications: mergeSignals(prior.regressionVerifications, signals.regressionVerifications),
        invariantObservations: mergeSignals(prior.invariantObservations, signals.invariantObservations),
        supersessionEvidence: mergeSignals(prior.supersessionEvidence, signals.supersessionEvidence),
      };
      workLifecyclePersistence.setRunSignals(runId, persistentJson(merged));
      return this.getRun(runId)!;
    },

    // Efficiency telemetry is an additive projection on the existing Run
    // signals ledger. It deliberately has no table of its own and does not
    // advance the lifecycle revision: timing/counter observations must not
    // invalidate evidence or create a second completion authority.
    recordRunEfficiency(runId: string, { timestamps = {}, increments = {}, counters = {} }: { timestamps?: UnknownRecord; increments?: UnknownRecord; counters?: UnknownRecord } = {}) {
      const run = this.getRun(runId);
      if (!run) throw new Error(`Run ${runId} not found`);
      const priorSignals = run.runSignals && typeof run.runSignals === 'object' && !Array.isArray(run.runSignals)
        ? run.runSignals
        : {};
      const prior: UnknownRecord = priorSignals.efficiency && typeof priorSignals.efficiency === 'object'
        && !Array.isArray(priorSignals.efficiency)
        ? priorSignals.efficiency as UnknownRecord
        : {};
      const firstTimestampFields = new Set([
        'runStartedAt', 'goalResolvedAt', 'readinessCompletedAt', 'firstRepositoryReadAt',
        'firstMutationAt', 'focusedVerificationStartedAt', 'goalRegressionStartedAt',
        'reviewRequestedAt', 'reviewSpawnedAt',
      ]);
      const timestampFields = [
        'runStartedAt', 'goalResolvedAt', 'readinessCompletedAt', 'firstRepositoryReadAt',
        'firstMutationAt', 'lastMutationAt', 'focusedVerificationStartedAt',
        'focusedVerificationFinishedAt', 'goalRegressionStartedAt', 'goalRegressionFinishedAt',
        'reviewRequestedAt', 'reviewSpawnedAt', 'reviewFinishedAt', 'blockedAt',
      ];
      const counterFields = [
        'reportCount', 'reportRejectedCount', 'contractRepairCount', 'scopeRejectedCount',
        'verificationTimeoutCount', 'waitTimeoutCount', 'contextCompactionCount',
        'repositorySearchCount', 'sameFileReadCount',
      ];
      const next = { ...prior };
      for (const field of timestampFields) {
        const incoming = timestamps[field];
        if (!incoming || !Number.isFinite(Date.parse(String(incoming)))) continue;
        const existing = next[field];
        if (!existing || !Number.isFinite(Date.parse(String(existing)))) {
          next[field] = String(incoming);
          continue;
        }
        const incomingMs = Date.parse(String(incoming));
        const existingMs = Date.parse(String(existing));
        next[field] = firstTimestampFields.has(field)
          ? (incomingMs < existingMs ? String(incoming) : String(existing))
          : (incomingMs > existingMs ? String(incoming) : String(existing));
      }
      for (const field of counterFields) {
        const increment = Number(increments[field] || 0);
        if (Number.isFinite(increment) && increment > 0) {
          next[field] = Math.max(0, Number(next[field] || 0)) + increment;
        }
        const absolute = Number(counters[field]);
        if (Number.isFinite(absolute) && absolute >= 0) {
          next[field] = Math.max(Number(next[field] || 0), absolute);
        }
        if (next[field] !== undefined) next[field] = Math.max(0, Math.trunc(Number(next[field]) || 0));
      }
      const merged = { ...priorSignals, efficiency: next };
      workLifecyclePersistence.setRunSignals(runId, persistentJson(merged));
      return this.getRun(runId)!;
    },

    getProjectRunSignals(projectId: string, { excludeRunId = null }: { excludeRunId?: string | null } = {}) {
      return workLifecyclePersistence
        .listProjectRunSignals({ projectId, excludeRunId })
        .map((row) => ({ runId: row.runId, ...(safeJsonParse(row.runSignalsJson, {}) || {}) }));
    },

    // Mutation revision advances only when the observed workspace identity
    // actually changes, never on state transitions alone.
    observeWorkspaceIdentity(runId: string, identity: string, { provenance = null }: { provenance?: UnknownRecord | null } = {}) {
      if (!identity || !sha256Regex.test(identity)) {
        throw new Error('observeWorkspaceIdentity requires a sha256:<hex> workspace identity');
      }
      return db.transaction(() => {
        const run = this.getRun(runId);
        if (!run) throw new Error(`Run ${runId} not found`);
        if (run.currentWorkspaceIdentity === identity) {
          return { changed: false, run, provenance: this.getMutationProvenance(runId) };
        }
        const isInitialObservation = !run.currentWorkspaceIdentity;
        workLifecyclePersistence.updateRunWorkspaceIdentity({
          runId,
          identity,
          incrementMutation: !isInitialObservation,
        });
        const updatedRun = this.getRun(runId)!;
        if (!isInitialObservation && provenance) {
          this.recordMutationProvenance(runId, {
            ...provenance,
            projectId: updatedRun.projectId,
            workspaceId: provenance.workspaceId ?? updatedRun.workspaceId ?? null,
            sourceIdentity: updatedRun.sourceIdentity,
            baseSourceIdentity: provenance.baseSourceIdentity ?? updatedRun.sourceIdentity,
            mutationRevision: updatedRun.mutationRevision,
            workspaceIdentity: identity,
            mutationDigest: provenance.mutationDigest || identity,
          });
        }
        return {
          changed: !isInitialObservation,
          run: updatedRun,
          provenance: !isInitialObservation && provenance ? this.getMutationProvenance(runId) : null,
        };
      })();
    },

    // Delivery materialization uses the same observation route as ordinary
    // reports, but with an owner snapshot CAS. The workspace fence prevents
    // another Kernel owner from entering the critical section; this SQL CAS
    // also protects the revision/identity pair from a stale process that
    // observed the same workspace before its lock was lost.
    observeWorkspaceIdentityCAS(runId: string, {
      expectedMutationRevision,
      expectedWorkspaceIdentity,
      identity,
      provenance = null,
    }: { expectedMutationRevision?: (number) | undefined; expectedWorkspaceIdentity?: (string) | undefined; identity?: string; provenance?: UnknownRecord | null } = {}) {
      if (!identity || !sha256Regex.test(identity)) {
        throw Object.assign(new Error('delivery_workspace_identity_invalid'), {
          code: 'delivery_workspace_identity_invalid',
          errorCode: 'delivery_workspace_identity_invalid',
        });
      }
      const fail: (code: string, message: string) => never = (code, message) => {
        throw Object.assign(new Error(`${code}: ${message}`), { code, errorCode: code });
      };
      return db.transaction(() => {
        const run = this.getRun(runId);
        if (!run || run.status !== 'active') fail('delivery_run_inactive', runId);
        if (expectedMutationRevision === null || expectedMutationRevision === undefined) {
          fail('delivery_mutation_revision_stale', 'expected mutation revision is required');
        }
        if (Number(run.mutationRevision) !== Number(expectedMutationRevision)) {
          fail('delivery_mutation_revision_stale', `Run mutation revision ${run.mutationRevision} does not match expected ${expectedMutationRevision}`);
        }
        if (expectedWorkspaceIdentity && run.currentWorkspaceIdentity !== expectedWorkspaceIdentity) {
          fail('delivery_workspace_drift', 'Run workspace identity no longer matches the Delivery CAS snapshot');
        }
        if (!run.currentWorkspaceIdentity || run.currentWorkspaceIdentity === identity) {
          fail('delivery_mutation_not_observed', 'Delivery identity did not advance from the expected owner identity');
        }
        const updated = workLifecyclePersistence.compareAndSetRunWorkspaceIdentity({
          runId,
          identity,
          expectedMutationRevision: Number(expectedMutationRevision),
          expectedWorkspaceIdentity: expectedWorkspaceIdentity || run.currentWorkspaceIdentity,
        });
        if (!updated) {
          fail('delivery_mutation_revision_stale', 'Delivery identity CAS did not update exactly one Run');
        }
        if (provenance) this.recordMutationProvenance(runId, provenance);
        return {
          changed: true,
          previousWorkspaceIdentity: run.currentWorkspaceIdentity,
          run: this.getRun(runId),
          provenance: provenance ? this.getMutationProvenance(runId) : null,
        };
      })();
    },

    getRun(runId: string): KernelRun | null {
      const row = workLifecyclePersistence.getRunRecord(runId);
      if (!row) return null;
      if (!isProofTier(row.proofTier)) throw new Error(`Unknown persisted proof tier: ${row.proofTier}`);

      return {
        schemaVersion: 1,
        runId: row.runId,
        objective: row.objective,
        currentState: row.state,
        state: row.state,
        status: row.status,
        revision: row.revision,
        mutationRevision: row.mutationRevision,
        sourceIdentity: row.sourceIdentity,
        runStartGitCommitSha: row.runStartGitCommitSha || null,
        runStartWorkspaceIdentity: row.runStartWorkspaceIdentity || null,
        currentWorkspaceIdentity: row.currentWorkspaceIdentity || null,
        blockedReason: row.blockedReason || null,
        blockingClass: row.blockingClass || (row.status === 'blocked' ? 'safety' : null),
        interventionCount: row.interventionCount || 0,
        projectMode: row.projectMode || null,
        baselineFailures: safeJsonParse(row.baselineFailures, []),
        baselineStatus: row.baselineStatus || 'pending',
        replanCount: row.replanCount || 0,
        proofTier: row.proofTier,
        evidenceTier: row.evidenceTier,
        requiredObligations: safeJsonParse(row.requiredObligations),
        acceptanceCriteria: safeJsonParse(row.acceptanceCriteria),
        releaseEvidenceRequired: Boolean(row.releaseEvidenceRequired),
        projectId: row.projectId || null,
        knowledgeRevisionStart: row.knowledgeRevisionStart || null,
        knowledgeRevisionClose: row.knowledgeRevisionClose || null,
        knowledgeStatus: row.knowledgeStatus || null,
        contextPackRef: row.contextPackRef || null,
        baselineChangedPaths: canonicalReceiptPaths(safeJsonParse(row.baselineChangedPaths, [])),
        baselineWorkspaceEntries: safeJsonParse(row.baselineWorkspaceEntries, []),
        reportBaselineChangedPaths: canonicalReceiptPaths(row.reportBaselineChangedPaths
          ? safeJsonParse(row.reportBaselineChangedPaths, [])
          : safeJsonParse(row.baselineChangedPaths, [])),
        reportBaselineWorkspaceEntries: row.reportBaselineWorkspaceEntries
          ? safeJsonParse(row.reportBaselineWorkspaceEntries, [])
          : safeJsonParse(row.baselineWorkspaceEntries, []),
        workspaceBaselineStatus: row.workspaceBaselineStatus || 'unknown',
        taskContract: row.taskContractJson ? safeJsonParse(row.taskContractJson, null) : null,
        contractRevision: Number(row.contractRevision || 1),
        finalizationStatus: row.finalizationStatus || 'pending',
        route: row.routeJson ? safeJsonParse(row.routeJson, null) : null,
        implementationContext: row.implementationContextJson ? safeJsonParse(row.implementationContextJson, null) : null,
        planRevision: Number(row.planRevision || 1),
        workspaceId: row.workspaceId || null,
        worktreeId: row.worktreeId || null,
        ownerBindingId: row.ownerBindingId || null,
        successorKey: row.successorKey || null,
        runSignals: row.runSignalsJson ? safeJsonParse<RunSignals>(row.runSignalsJson, {}) : {},
        updatedAt: row.updatedAt,
      };
    },

    // The durable authority view intentionally omits Host policy, prompt/cache,
    // Git, and optional execution internals. Those tables remain queryable as
    // receipts for audit/recovery, but are not a second Kernel state machine.
    getKernelDurableState(runId: string) {
      const run = this.getRun(runId);
      if (!run) return null;
      return buildKernelDurableStateView({
        run,
        verifications: this.getVerifications(runId),
        obligations: this.getRunObligations(runId),
        completionDecision: this.getCompletionDecision(runId),
      });
    },

    // Read-only audit projection. No authority reads the journal for decisions.
    getRunJournal(runId: string) {
      return runJournalPersistence.listRunJournal(runId);
    },

    // A report describes the delta since the last accepted mutable boundary.
    // Keep the original Run-start baseline immutable for user-change
    // protection, while advancing this observation baseline after a report
    // has been processed so the next step/report can claim only its own work.
    updateRunWorkspaceBaseline(runId: string, { changedPaths = [], entries = [] }: { changedPaths?: string[]; entries?: UnknownRecord[] } = {}) {
      workLifecyclePersistence.updateRunWorkspaceBaseline({
        runId,
        changedPathsJson: JSON.stringify(canonicalReceiptPaths(changedPaths)),
        entriesJson: persistentJson(entries),
      });
      return this.getRun(runId)!;
    },

    getRunMetadata(runId: string) {
      return workLifecyclePersistence.getRunLifecycleIdentity(runId);
    },

    getRunOwnerBinding(runId: string) {
      if (!runId) return null;
      const run = workLifecyclePersistence.getRunLifecycleIdentity(runId);
      if (!run?.ownerBindingId) return null;
      const binding = workLifecyclePersistence.getSessionBinding(run.ownerBindingId);
      return binding
        && binding.runId === runId
        && binding.accessMode === 'owner'
        ? binding
        : null;
    },

    createSessionBinding(binding: BindingInput) {
      const create = db.transaction(() => {
        const run = workLifecyclePersistence.getRunLifecycleIdentity(binding.runId);
        if (!run) {
          throw Object.assign(new Error('run_access_denied'), {
            code: 'run_access_denied',
            errorCode: 'run_access_denied',
            nextAction: 'inspect-run-binding',
          });
        }
        if (run.projectId !== binding.projectId) {
          throw Object.assign(new Error('run_project_mismatch'), {
            code: 'run_project_mismatch',
            errorCode: 'run_project_mismatch',
            nextAction: 'relaunch-from-bound-project',
          });
        }
        if (run.workspaceId && run.workspaceId !== binding.workspaceId) {
          throw Object.assign(new Error('run_workspace_mismatch'), {
            code: 'run_workspace_mismatch',
            errorCode: 'run_workspace_mismatch',
            nextAction: 'return-to-bound-workspace',
          });
        }
        if (binding.accessMode === 'owner' && run.ownerBindingId) {
          throw Object.assign(new Error('successor_binding_conflict'), {
            code: 'successor_binding_conflict',
            errorCode: 'successor_binding_conflict',
            nextAction: 'inspect-active-owner-binding',
          });
        }

        const observed = now();
        workLifecyclePersistence.insertSessionBinding({
          bindingId: binding.bindingId,
          sessionId: binding.sessionId,
          provider: binding.provider,
          surface: binding.surface ?? null,
          runId: binding.runId,
          projectId: binding.projectId,
          workspaceId: binding.workspaceId ?? null,
          workspaceRoot: binding.workspaceRoot ?? null,
          accessMode: binding.accessMode,
          status: binding.status,
          createdAt: observed,
          expiresAt: binding.expiresAt ?? null,
          closedAt: null,
          closeReason: null,
          successorRunId: null,
          updatedAt: observed,
        });
        if (binding.accessMode === 'owner') {
          const updated = workLifecyclePersistence.compareAndSetRunOwnerBinding({
            runId: binding.runId,
            projectId: binding.projectId,
            expectedBindingId: null,
            bindingId: binding.bindingId,
            workspaceId: binding.workspaceId ?? null,
          });
          if (!updated) {
            throw Object.assign(new Error('successor_binding_conflict'), {
              code: 'successor_binding_conflict',
              errorCode: 'successor_binding_conflict',
              nextAction: 'inspect-active-owner-binding',
            });
          }
        }
      });
      try {
        create();
      } catch (error) {
        bindingConflict(error);
      }
      return this.getActiveRunBinding({
        projectId: binding.projectId,
        sessionId: binding.sessionId,
        runId: binding.runId,
      });
    },

    createSuccessorRunAtomic({
      projectId,
      sessionId,
      predecessorRunId,
      successorRun,
      successorBinding,
      obligations = [],
      steps = [],
      successorKey,
      predecessorLock = null,
    }: { projectId?: string; sessionId?: (string) | undefined; predecessorRunId?: string; successorRun?: CreateRunInput; successorBinding?: (BindingInput) | undefined; obligations?: DeclaredRunObligationInput[]; steps?: PersistedWorkStep[]; successorKey?: string; predecessorLock?: PersistedWorkspaceMutationLock | null } = {}) {
      const taskContractDigest = successorRun?.taskContract?.digest;
      const expectedSuccessorKey = buildSuccessorKey({
        projectId,
        predecessorRunId,
        worktreeId: successorRun?.worktreeId,
        workspaceId: successorRun?.workspaceId,
        taskContractDigest,
      });
      if (
        !projectId
        || !predecessorRunId
        || !successorRun?.runId
        || successorKey !== expectedSuccessorKey
      ) {
        throw Object.assign(new Error('successor_creation_conflict'), {
          code: 'successor_creation_conflict',
          errorCode: 'successor_creation_conflict',
          nextAction: 'retry-successor-resolution',
        });
      }
      const create = db.transaction(() => {
        const existing = workLifecyclePersistence.getRunRecordBySuccessorKey(successorKey);
        if (existing) {
          const existingContract = safeJsonParse<StoredTaskContract | null>(existing.taskContractJson, null);
          if (
            existing.projectId !== projectId
            || (successorRun.worktreeId
              ? existing.worktreeId !== successorRun.worktreeId
              : existing.workspaceId !== successorRun.workspaceId)
            || existingContract?.digest !== taskContractDigest
          ) {
            throw Object.assign(new Error('successor_creation_conflict'), {
              code: 'successor_creation_conflict',
              errorCode: 'successor_creation_conflict',
              nextAction: 'inspect-successor-lineage',
            });
          }
          return { created: false, runId: existing.runId };
        }

        const predecessor = workLifecyclePersistence.getRunRecord(predecessorRunId);
        const predecessorBinding = predecessor?.ownerBindingId
          ? workLifecyclePersistence.listSessionBindings({
              bindingId: predecessor.ownerBindingId,
              runId: predecessorRunId,
              projectId,
              status: 'active',
              accessMode: 'owner',
              limit: 1,
            })[0] || null
          : null;
        const successorWorkspace = workLifecyclePersistence.getProjectWorkspaceRecord(
          successorRun.workspaceId || '',
        );
        const validPredecessor = predecessor
          && predecessor.projectId === projectId
          && (successorRun.worktreeId
            ? predecessor.worktreeId === successorRun.worktreeId
            : predecessor.workspaceId === successorRun.workspaceId)
          && predecessor.status === 'completed'
          && predecessor.finalizationStatus === 'completed';
        if (!validPredecessor) {
          throw Object.assign(new Error('successor_not_allowed'), {
            code: 'successor_not_allowed',
            errorCode: 'successor_not_allowed',
            nextAction: predecessor?.status === 'completed'
              && predecessor?.finalizationStatus !== 'completed'
              ? 'retry-finalization'
              : 'inspect-predecessor-binding',
          });
        }
        const predecessorFinalWorkspaceIdentity = predecessor.currentWorkspaceIdentity || null;
        const successorStartWorkspaceIdentity = successorRun.runStartWorkspaceIdentity
          || successorRun.workspaceIdentity
          || null;
        if (!predecessorFinalWorkspaceIdentity
          || !successorStartWorkspaceIdentity
          || predecessorFinalWorkspaceIdentity !== successorStartWorkspaceIdentity) {
          throw Object.assign(new Error('successor_workspace_continuity_mismatch'), {
            code: 'successor_workspace_continuity_mismatch',
            errorCode: 'successor_workspace_continuity_mismatch',
            nextAction: 'inspect-successor-workspace-continuity',
            details: {
              predecessorRunId,
              successorRunId: successorRun.runId,
              predecessorFinalWorkspaceIdentity,
              successorStartWorkspaceIdentity,
            },
          });
        }
        if (
          successorRun.projectId !== projectId
          || (successorRun.worktreeId && successorRun.worktreeId !== successorWorkspace?.worktreeId)
          || successorWorkspace?.projectId !== projectId
          || (successorBinding && (
            successorBinding.projectId !== projectId
            || successorBinding.sessionId !== sessionId
            || successorBinding.runId !== successorRun.runId
            || successorRun.workspaceId !== successorBinding.workspaceId
          ))
          || successorRun.taskContract?.digest !== taskContractDigest
        ) {
          throw Object.assign(new Error('successor_creation_conflict'), {
            code: 'successor_creation_conflict',
            errorCode: 'successor_creation_conflict',
            nextAction: 'retry-successor-resolution',
          });
        }

        this.createRun({
          ...successorRun,
          ownerBindingId: null,
          successorKey,
          withinTransaction: true,
        });
        this.declareRunObligations(successorRun.runId, obligations);
        this.createRunSteps(successorRun.runId, steps);

        const closedAt = now();
        if (predecessorBinding) {
          const closed = workLifecyclePersistence.updateSessionBinding({
            bindingId: predecessorBinding.bindingId,
            expected: {
              projectId,
              runId: predecessorRunId,
              status: 'active',
              accessMode: 'owner',
            },
            changes: {
              status: 'inactive',
              closedAt,
              closeReason: 'successor_started',
              successorRunId: successorRun.runId,
              updatedAt: closedAt,
            },
          });
          if (!closed) {
            throw Object.assign(new Error('successor_binding_conflict'), {
              code: 'successor_binding_conflict',
              errorCode: 'successor_binding_conflict',
              nextAction: 'inspect-active-owner-binding',
            });
          }
        }

        if (successorBinding) {
          workLifecyclePersistence.insertSessionBinding({
            bindingId: successorBinding.bindingId,
            sessionId: successorBinding.sessionId,
            provider: successorBinding.provider,
            surface: successorBinding.surface ?? null,
            runId: successorBinding.runId,
            projectId: successorBinding.projectId,
            workspaceId: successorBinding.workspaceId ?? null,
            workspaceRoot: successorBinding.workspaceRoot ?? null,
            accessMode: 'owner',
            status: 'active',
            createdAt: closedAt,
            expiresAt: successorBinding.expiresAt ?? null,
            closedAt: null,
            closeReason: null,
            successorRunId: null,
            updatedAt: closedAt,
          });
          const owned = workLifecyclePersistence.compareAndSetRunOwnerBinding({
            runId: successorRun.runId,
            projectId,
            expectedBindingId: null,
            bindingId: successorBinding.bindingId,
            workspaceId: successorBinding.workspaceId ?? null,
          });
          if (!owned) {
            throw Object.assign(new Error('successor_creation_conflict'), {
              code: 'successor_creation_conflict',
              errorCode: 'successor_creation_conflict',
              nextAction: 'retry-successor-resolution',
            });
          }
        }

        if (predecessor.workspaceId) {
          const currentLock = workLifecyclePersistence.getWorkspaceMutationLockV2(
            predecessor.workspaceId,
          );
          const lockFailure = () => {
            throw Object.assign(new Error('workspace_lock_handoff_failed'), {
              code: 'workspace_lock_handoff_failed',
              errorCode: 'workspace_lock_handoff_failed',
              nextAction: 'reacquire-predecessor-workspace-lock',
            });
          };
          if (predecessorLock) {
            if (
              !currentLock
              || predecessorLock.workspaceId !== predecessor.workspaceId
              || predecessorLock.projectId !== projectId
              || predecessorLock.holderRunId !== predecessorRunId
              || predecessorLock.sessionToken !== currentLock.sessionToken
              || Number(predecessorLock.fencingToken) !== Number(currentLock.fencingToken)
              || currentLock.projectId !== projectId
              || currentLock.holderRunId !== predecessorRunId
            ) {
              lockFailure();
            }
            const released = workLifecyclePersistence.deleteWorkspaceMutationLockV2({
              workspaceId: predecessor.workspaceId,
              projectId,
              runId: predecessorRunId,
              sessionToken: predecessorLock.sessionToken,
              fencingToken: Number(predecessorLock.fencingToken),
            });
            if (!released) lockFailure();
          } else if (currentLock && Date.parse(currentLock.expiresAt) > Date.now()) {
            lockFailure();
          } else if (currentLock) {
            workLifecyclePersistence.deleteWorkspaceMutationLockV2({
              workspaceId: predecessor.workspaceId,
              expiresAt: currentLock.expiresAt,
            });
          }
        }
        return { created: true, runId: successorRun.runId };
      });

      let result;
      try {
        result = create();
      } catch (error) {
        bindingConflict(error);
      }
      const run = this.getRun(result.runId);
      const predecessorOwnerBindingId = this.getRun(predecessorRunId)?.ownerBindingId || null;
      const binding = sessionId ? this.getActiveRunBinding({
          projectId,
          sessionId,
          runId: result.runId,
        }) : null;
      if (!run || (successorBinding && !binding)) {
        throw Object.assign(new Error('successor_creation_conflict'), {
          code: 'successor_creation_conflict',
          errorCode: 'successor_creation_conflict',
          nextAction: 'inspect-successor-lineage',
        });
      }
      return {
        created: result.created,
        run,
        binding,
        predecessorBinding: predecessorOwnerBindingId
          ? workLifecyclePersistence.getSessionBinding(predecessorOwnerBindingId)
          : null,
      };
    },

    adoptUnownedRunBinding(binding: BindingInput) {
      const adopt = db.transaction(() => {
        const claimed = workLifecyclePersistence.compareAndSetRunOwnerBinding({
          runId: binding.runId,
          projectId: binding.projectId,
          expectedBindingId: null,
          bindingId: binding.bindingId,
          workspaceId: binding.workspaceId ?? null,
        });
        if (!claimed) return false;
        const observed = now();
        workLifecyclePersistence.insertSessionBinding({
          bindingId: binding.bindingId,
          sessionId: binding.sessionId,
          provider: binding.provider,
          surface: binding.surface ?? null,
          runId: binding.runId,
          projectId: binding.projectId,
          workspaceId: binding.workspaceId ?? null,
          workspaceRoot: binding.workspaceRoot ?? null,
          accessMode: binding.accessMode,
          status: binding.status,
          createdAt: observed,
          expiresAt: binding.expiresAt ?? null,
          closedAt: null,
          closeReason: null,
          successorRunId: null,
          updatedAt: observed,
        });
        return true;
      });
      const adopted = adopt();
      return {
        adopted,
        binding: adopted ? this.getActiveRunBinding({
          projectId: binding.projectId,
          sessionId: binding.sessionId,
          runId: binding.runId,
        }) : null,
      };
    },

    getActiveOwnerBinding({ projectId, sessionId, workspaceId = null }: { projectId?: string; sessionId?: string; workspaceId?: string | null } = {}) {
      if (!projectId || !sessionId) return null;
      return workLifecyclePersistence.listSessionBindings({
        projectId,
        sessionId,
        workspaceId,
        status: 'active',
        accessMode: 'owner',
        limit: 1,
      })[0] || null;
    },

    getActiveRunBinding({ projectId, sessionId, runId }: { projectId?: string; sessionId?: string; runId?: string } = {}) {
      if (!projectId || !sessionId || !runId) return null;
      return workLifecyclePersistence.listSessionBindings({
        projectId,
        sessionId,
        runId,
        status: 'active',
        limit: 1,
      })[0] || null;
    },

    migrateLegacySessionBinding({
      projectId,
      legacySessionId,
      canonicalSessionId,
      provider,
    }: { projectId?: string; legacySessionId?: string; canonicalSessionId?: string; provider?: string } = {}) {
      if (!projectId || !legacySessionId || !canonicalSessionId || !provider) {
        throw Object.assign(new Error('provider_session_invalid'), {
          code: 'provider_session_invalid',
          errorCode: 'provider_session_invalid',
          nextAction: 'reopen-from-correct-worktree',
        });
      }
      const migrate = db.transaction(() => {
        const canonical = workLifecyclePersistence.listSessionBindings({
          projectId,
          sessionId: canonicalSessionId,
          status: 'active',
          accessMode: 'owner',
          limit: 1,
        })[0] || null;
        if (canonical) return canonical;

        const legacy = workLifecyclePersistence.listSessionBindings({
          projectId,
          sessionId: legacySessionId,
          status: 'active',
          accessMode: 'owner',
          limit: 1,
        })[0] || null;
        if (!legacy) return null;
        const inferredLegacyCodex = legacy.provider === 'unknown'
          && provider === 'codex'
          && legacy.runId === `codex-${legacySessionId}`;
        if (legacy.provider !== provider && !inferredLegacyCodex) {
          throw Object.assign(new Error('provider_session_invalid'), {
            code: 'provider_session_invalid',
            errorCode: 'provider_session_invalid',
            nextAction: 'reopen-from-correct-worktree',
          });
        }
        try {
          const updated = workLifecyclePersistence.updateSessionBinding({
            bindingId: legacy.bindingId,
            expected: {
              projectId,
              sessionId: legacySessionId,
              provider: legacy.provider,
              status: 'active',
              accessMode: 'owner',
            },
            changes: {
              sessionId: canonicalSessionId,
              provider,
              surface: legacy.surface || provider,
              updatedAt: now(),
            },
          });
          if (!updated) {
            throw Object.assign(new Error('successor_binding_conflict'), {
              code: 'successor_binding_conflict',
              errorCode: 'successor_binding_conflict',
              nextAction: 'inspect-active-owner-binding',
            });
          }
        } catch (error) {
          bindingConflict(error);
        }
        return workLifecyclePersistence.getSessionBinding(legacy.bindingId);
      });
      return migrate();
    },

    getActiveRunBindingScope({ sessionId, runId }: { sessionId?: string; runId?: string } = {}) {
      if (!sessionId || !runId) return null;
      const binding = workLifecyclePersistence.listSessionBindings({
        sessionId,
        runId,
        status: 'active',
        limit: 1,
      })[0] || null;
      return binding ? { projectId: binding.projectId } : null;
    },

    listActiveOwnerBindings({ projectId, sessionId }: { projectId?: string; sessionId?: string } = {}) {
      if (!projectId || !sessionId) return [];
      return workLifecyclePersistence.listSessionBindings({
        projectId,
        sessionId,
        status: 'active',
        accessMode: 'owner',
      });
    },

    diagnoseLifecycleState({ projectId = null, observedAt = now() }: { projectId?: string | null; observedAt?: string } = {}) {
      const findings: Array<UnknownRecord & { code: string; severity: string }> = [];
      const bindings = workLifecyclePersistence.listSessionBindings({ projectId });
      const activeOwners = bindings.filter((binding) => (
        binding.status === 'active' && binding.accessMode === 'owner'
      ));
      const ownerGroups = new Map();
      for (const binding of activeOwners) {
        const key = `${binding.projectId}\0${binding.sessionId}`;
        const group = ownerGroups.get(key) || [];
        group.push(binding);
        ownerGroups.set(key, group);
      }
      for (const group of ownerGroups.values()) {
        if (group.length <= 1) continue;
        findings.push({
          code: 'ambiguous_session_binding',
          severity: 'error',
          projectId: group[0].projectId,
          sessionId: group[0].sessionId,
          count: group.length,
        });
      }

      for (const binding of activeOwners) {
        const run = workLifecyclePersistence.getRunLifecycleIdentity(binding.runId);
        if (run?.status === 'completed') {
          findings.push({
            code: 'terminal_run_active_binding',
            severity: 'warning',
            runId: binding.runId,
            projectId: binding.projectId,
            bindingId: binding.bindingId,
            sessionId: binding.sessionId,
          });
        }
      }

      for (const run of this.listRuns({ projectId })) {
        if (!run.ownerBindingId) continue;
        const binding = workLifecyclePersistence.getSessionBinding(run.ownerBindingId);
        if (!binding
          || binding.runId !== run.runId
          || binding.projectId !== run.projectId
          || binding.accessMode !== 'owner') {
          findings.push({
            code: 'orphaned_run_owner',
            severity: 'error',
            runId: run.runId,
            projectId: run.projectId,
            ownerBindingId: run.ownerBindingId,
          });
        }
      }

      for (const binding of bindings) {
        const sessionProvider = String(binding.sessionId).match(/^([a-z][a-z0-9-]{0,31}):/)?.[1] || null;
        const workspace = binding.workspaceId
          ? this.getProjectWorkspace(binding.workspaceId)
          : null;
        const providerMismatch = sessionProvider
          && binding.provider !== 'unknown'
          && binding.provider !== 'unknown-host'
          && sessionProvider !== binding.provider;
        const workspaceMismatch = binding.workspaceId
          && (!workspace || workspace.projectId !== binding.projectId);
        if (providerMismatch || workspaceMismatch) {
          findings.push({
            code: 'binding_namespace_problem',
            severity: 'error',
            bindingId: binding.bindingId,
            runId: binding.runId,
            projectId: binding.projectId,
            providerMismatch: Boolean(providerMismatch),
            workspaceMismatch: Boolean(workspaceMismatch),
          });
        }
      }

      const locks = workLifecyclePersistence.listWorkspaceMutationLocksV2({ projectId });
      const observedMs = Date.parse(observedAt);
      for (const lock of locks) {
        const lockRun = workLifecyclePersistence.getRunLifecycleIdentity(lock.holderRunId);
        const lockWorkspace = this.getProjectWorkspace(lock.workspaceId);
        const expired = Date.parse(lock.expiresAt) <= observedMs;
        const invalidOwner = !lockRun
          || lockRun.projectId !== lock.projectId
          || lockRun.workspaceId !== lock.workspaceId
          || lockWorkspace?.projectId !== lock.projectId;
        if (expired || invalidOwner) {
          findings.push({
            code: 'stale_workspace_lock',
            severity: 'warning',
            workspaceId: lock.workspaceId,
            projectId: lock.projectId,
            holderRunId: lock.holderRunId,
            fencingToken: Number(lock.fencingToken),
            expired,
            invalidOwner,
          });
        }
      }

      const staleBefore = new Date(observedMs - (24 * 60 * 60 * 1000)).toISOString();
      const staleRuns = workLifecyclePersistence.listStaleRunDiagnostics({
        staleBefore,
        projectId,
      });
      for (const run of staleRuns) {
        const provenance = {
          attemptCount: Number(run.attemptCount || 0),
          capsuleCount: Number(run.capsuleCount || 0),
          verificationCount: Number(run.verificationCount || 0),
          completionReceiptCount: Number(run.completionReceiptCount || 0),
        };
        if (Number(run.readyStepCount || 0) > 0 && Object.values(provenance).every((count) => count === 0)) {
          findings.push({
            code: 'stale_active_run',
            severity: 'warning',
            runId: run.runId,
            projectId: run.projectId,
            workspaceId: run.workspaceId,
            state: run.state,
            updatedAt: run.updatedAt,
            staleBefore,
            provenance,
            recoveryChoices: ['resume', 'replan', 'abort-and-successor'],
          });
        }
      }
      if (projectId) {
        const runCounts = workLifecyclePersistence.getProjectRunCounts(projectId);
        const knowledgeCounts = knowledgeLifecyclePersistence.getProjectKnowledgeDoctorCounts(projectId);
        const doctorFinding = emptyKnowledgeDoctorFinding({
          completedRuns: runCounts.completedRuns,
          mutationRuns: runCounts.mutationRuns,
          knowledgeRevision: this.getProjectKnowledgeRevision(projectId),
          candidateCount: knowledgeCounts.candidateCount,
          committedCount: knowledgeCounts.committedCount,
        });
        if (doctorFinding) findings.push({ projectId, ...doctorFinding });
      }
      return {
        schemaVersion: 1,
        status: findings.some((finding) => finding.severity === 'error') ? 'degraded' : (
          findings.length > 0 ? 'warning' : 'ready'
        ),
        observedAt,
        projectId,
        findings,
        counts: findings.reduce<Record<string, number>>((counts, finding) => ({
          ...counts,
          [finding.code]: (counts[finding.code] || 0) + 1,
        }), {}),
      };
    },

    // Lifecycle cleanup is Kernel-owned: terminal owner bindings are made
    // inactive and stale mutation locks are released in one transaction. A
    // completed binding for the current host is deliberately retained until a
    // successor handoff can atomically replace it; every other terminal owner
    // is safe to close here. This keeps cleanup project/session scoped without
    // selecting or terminating a host process.
    reconcileTerminalLifecycle({ projectId = null, runId = null, observedAt = now() }: { projectId?: string | null; runId?: string | null; observedAt?: string } = {}) {
      return db.transaction(() => reconcileTerminalLifecycleInTransaction({
        projectId,
        runId,
        observedAt,
      }))();
    },

    deactivateSessionBinding({
      projectId,
      sessionId,
      bindingId,
      reason,
      successorRunId = null,
    }: { projectId?: string; sessionId?: string; bindingId?: string; reason?: string; successorRunId?: string | null } = {}) {
      if (!projectId || !sessionId || !bindingId || !reason) {
        throw Object.assign(new Error('host_binding_missing'), { code: 'host_binding_missing' });
      }
      const deactivate = db.transaction(() => {
        const row = workLifecyclePersistence.getSessionBinding(bindingId);
        if (!row || row.projectId !== projectId || row.sessionId !== sessionId) {
          throw Object.assign(new Error('host_binding_missing'), { code: 'host_binding_missing' });
        }
        if (row.status !== 'active') {
          throw Object.assign(new Error('binding_already_inactive'), {
            code: 'binding_already_inactive',
            errorCode: 'binding_already_inactive',
            nextAction: 'inspect-active-owner-binding',
          });
        }
        if (row.accessMode === 'owner') {
          const run = workLifecyclePersistence.getRunLifecycleIdentity(row.runId);
          if (!run || run.projectId !== projectId || run.ownerBindingId !== bindingId) {
            throw Object.assign(new Error('run_access_denied'), { code: 'run_access_denied' });
          }
        }
        const closedAt = now();
        const updated = workLifecyclePersistence.updateSessionBinding({
          bindingId,
          expected: {
            projectId,
            sessionId,
            status: 'active',
          },
          changes: {
            status: 'inactive',
            closedAt,
            closeReason: String(reason),
            successorRunId,
            updatedAt: closedAt,
          },
        });
        if (!updated) {
          throw Object.assign(new Error('binding_already_inactive'), { code: 'binding_already_inactive' });
        }
        return workLifecyclePersistence.getSessionBinding(bindingId);
      });
      return deactivate();
    },

    registerProjectIdentity(identity: ProjectIdentityInput = {}) {
      const projectId = String(identity.projectId || '').trim();
      const suppliedCanonicalRoot = identity.canonicalRoot || identity.projectRoot;
      const canonicalRoot = canonicalIdentityRoot(suppliedCanonicalRoot);
      const identitySource = String(identity.identitySource || 'workspace_root');
      const identityDigest = String(identity.identityDigest || '').trim();
      // Physical Git observation is a Host/identity-resolver concern. The
      // persistence authority stores and compares the already-observed common
      // directory; it never executes Git to re-observe the workspace.
      const suppliedGitCommonDir = identity.gitCommonDir ? canonicalIdentityRoot(identity.gitCommonDir) : null;
      if (
        !PROJECT_ID_PATTERN.test(projectId)
        || !canonicalRoot
        || !identityDigest
        || invalidWindowsOwnershipPath(suppliedCanonicalRoot)
      ) {
        throw Object.assign(new Error('project_identity_invalid'), { code: 'project_identity_invalid' });
      }

      const incomingAliases = [
        ...(Array.isArray(identity.aliases) ? identity.aliases : [])
          .map((value) => projectIdentityAlias(value)),
        projectIdentityAlias(`workspace:${canonicalRoot}`, 'workspace-root'),
      ].filter((value): value is NonNullable<typeof value> => Boolean(value));
      const incomingGitCommonDir = suppliedGitCommonDir;

      const candidates = legacyIdentityCandidates(identity)
        .filter((candidate) => candidate.projectId && candidate.projectId !== projectId);
      const migration: { current: ReturnType<typeof prepareProjectKnowledgeNamespaceMigration> | null } = { current: null };
      const register = db.transaction(() => {
        let row = findProjectIdentityByRoot(canonicalRoot);
        if (!row && incomingGitCommonDir) {
          const crossSurfaceMatches = projectIdentityPersistence.listIdentities()
            .filter((candidate) => hasPairedCrossSurfaceRepositoryEvidence({
              projectId: candidate.project_id,
              persistedRoot: candidate.canonical_root,
              observedRoot: canonicalRoot,
              observedGitCommonDir: incomingGitCommonDir,
            }));
          if (crossSurfaceMatches.length > 1) {
            throw Object.assign(new Error('project_identity_alias_conflict'), {
              code: 'project_identity_alias_conflict',
              projectIds: crossSurfaceMatches.map((match) => match.project_id),
              canonicalRoot,
              gitCommonDir: incomingGitCommonDir,
            });
          }
          row = crossSurfaceMatches[0] || null;
        }
        if (!row) {
          const projectMatches = projectIdentityPersistence.listIdentityMatchesByAliases(
            incomingAliases.map(({ alias }) => alias),
          );
          const compatibleProjectMatches = projectMatches.filter((match) => {
            if (identitySource === 'account_alias_registry' && match.project_id === projectId) return true;
            if (sameOwnershipPath(match.canonical_root, canonicalRoot)) return true;
            if (hasPairedCrossSurfaceRepositoryEvidence({
              projectId: match.project_id,
              persistedRoot: match.canonical_root,
              observedRoot: canonicalRoot,
              observedGitCommonDir: incomingGitCommonDir,
            })) return true;
            if (!incomingGitCommonDir) return false;
            return workLifecyclePersistence
              .listProjectWorkspaceRecords(match.project_id)
              .some((workspace) => sameOwnershipPath(workspace.gitCommonDir, incomingGitCommonDir));
          });
          if (compatibleProjectMatches.length !== projectMatches.length) {
            const code = incomingGitCommonDir
              ? 'project_identity_git_common_dir_unverified'
              : 'project_identity_alias_ownership_unproven';
            throw Object.assign(new Error(code), {
              code,
              nextAction: 'inspect-project-identity-candidates',
              aliases: incomingAliases.map(({ alias }) => alias),
              projectIds: projectMatches.map((match) => match.project_id),
              canonicalRoot,
              gitCommonDir: incomingGitCommonDir,
            });
          }
          if (compatibleProjectMatches.length > 1) {
            throw Object.assign(new Error('project_identity_alias_conflict'), {
              code: 'project_identity_alias_conflict',
              aliases: incomingAliases.map(({ alias }) => alias),
              projectIds: compatibleProjectMatches.map((match) => match.project_id),
            });
          }
          row = compatibleProjectMatches[0] || null;
        }

        // An explicit local identity or linked worktree sharing git_common_dir
        // is a logical project namespace that may be checked out in more than
        // one worktree. Reuse that immutable project row instead of attempting
        // a second row with the same project_id; project_workspaces remains
        // the per-root registry.
        if (!row) {
          const projectIdRow = projectIdentityPersistence.getIdentityByProjectId(projectId);
          if (projectIdRow) {
            const sameRoot = sameOwnershipPath(projectIdRow.canonical_root, canonicalRoot);
            const commonDirProof = Boolean(incomingGitCommonDir && (
              workLifecyclePersistence
                .listProjectWorkspaceRecords(projectIdRow.project_id)
                .some((workspace) => sameOwnershipPath(workspace.gitCommonDir, incomingGitCommonDir))
              || hasPairedCrossSurfaceRepositoryEvidence({
                projectId: projectIdRow.project_id,
                persistedRoot: projectIdRow.canonical_root,
                observedRoot: canonicalRoot,
                observedGitCommonDir: incomingGitCommonDir,
              })
            ));
            if (!sameRoot && !commonDirProof && identitySource !== 'workspace_root') {
              const code = incomingGitCommonDir
                ? 'project_identity_git_common_dir_unverified'
                : 'project_identity_alias_ownership_unproven';
              throw Object.assign(new Error(code), {
                code,
                nextAction: 'inspect-project-identity-candidates',
                projectId,
                canonicalRoot,
                gitCommonDir: incomingGitCommonDir,
              });
            }
            if (sameRoot || commonDirProof) {
              row = projectIdRow;
            }
          }
        }

        let canonicalProjectId = row?.project_id || projectId;
        if (!row && canonicalProjectId !== projectId) {
          throw Object.assign(new Error('project_identity_conflict'), { code: 'project_identity_conflict' });
        }

        if (row) {
          const ownedLegacyIds = candidates.filter((candidate) => {
            const legacyIdentity = projectIdentityPersistence.getIdentityByProjectId(candidate.projectId);
            const ownerProjectId = projectIdentityPersistence.getAliasOwner(`project-id:${candidate.projectId}`);
            const sameRootWorkspace = workLifecyclePersistence
              .listProjectWorkspaceRecords(candidate.projectId)
              .some((workspace) => sameOwnershipPath(workspace.canonicalRoot, canonicalRoot));
            const hasData = hasProjectData(candidate.projectId);
            if (
              !legacyIdentity
              && hasData
              && sameRootWorkspace
              && ownerProjectId
              && ownerProjectId !== row!.project_id
            ) {
              throw Object.assign(new Error('project_identity_alias_conflict'), {
                code: 'project_identity_alias_conflict',
                alias: `project-id:${candidate.projectId}`,
                projectIds: [ownerProjectId, row!.project_id],
              });
            }
            return !legacyIdentity
              && (ownerProjectId === row!.project_id || sameRootWorkspace)
              && hasData;
          }).map((candidate) => candidate.projectId);
          const allowedIncomingAliasOwners = new Set([row.project_id, ...ownedLegacyIds]);
          for (const { alias } of incomingAliases) {
            const existingAliasProjectId = projectIdentityPersistence.getAliasOwner(alias);
            if (existingAliasProjectId && !allowedIncomingAliasOwners.has(existingAliasProjectId)) {
              throw Object.assign(new Error('project_identity_alias_conflict'), {
                code: 'project_identity_alias_conflict',
                alias,
                projectIds: [existingAliasProjectId, row.project_id],
              });
            }
          }
          migration.current = prepareProjectKnowledgeNamespaceMigration({
            runtimeHome,
            legacyProjectIds: ownedLegacyIds,
            projectId: row.project_id,
            canonicalRoot: row.canonical_root,
            identityDigest: row.identity_digest,
          });
          for (const legacyId of ownedLegacyIds) {
            migrateProjectId(legacyId, row.project_id);
            incomingAliases.push(projectIdentityAlias(`project-id:${legacyId}`)!);
          }
        }

        // A state created before immutable identity persistence may already use
        // a derived id. Only a candidate with proven ownership may be moved;
        // package and basename ids are common across repositories and therefore
        // cannot become global aliases merely because rows happen to exist.
        if (!row && canonicalProjectId === projectId) {
          const provenLegacyIds = [];
          for (const candidate of candidates) {
            const legacyId = candidate.projectId;
            const legacyIdentity = projectIdentityPersistence.getIdentityByProjectId(legacyId);
            const existingAliasProjectId = projectIdentityPersistence.getAliasOwner(`project-id:${legacyId}`);
            if (existingAliasProjectId && existingAliasProjectId !== projectId) {
              throw Object.assign(new Error('project_identity_alias_conflict'), {
                code: 'project_identity_alias_conflict',
                alias: `project-id:${legacyId}`,
                projectIds: [existingAliasProjectId, projectId],
              });
            }

            const hasData = hasProjectData(legacyId);
            if (!hasData) continue;

            const sameRootIdentity = legacyIdentity && sameOwnershipPath(legacyIdentity.canonical_root, canonicalRoot);
            const sameRootWorkspace = workLifecyclePersistence
              .listProjectWorkspaceRecords(legacyId)
              .some((workspace) => sameOwnershipPath(workspace.canonicalRoot, canonicalRoot));
            const sameRootRun = workLifecyclePersistence.hasRunForProjectCanonicalRoot({
              projectId: legacyId,
              canonicalRoot,
            });
            // A remote/package/basename string is only a discovery hint. It is
            // not ownership evidence: two unrelated repositories can share
            // the same package or basename, and an origin URL can be copied
            // into a second checkout. Require a persisted identity/workspace or
            // a run tied to this root; caller-provided candidate paths are not
            // ownership evidence because they can be forged at registration.
            const proven = sameRootIdentity || sameRootWorkspace || sameRootRun;
            if (!proven) {
              throw Object.assign(new Error('project_identity_legacy_ownership_unproven'), {
                code: 'project_identity_legacy_ownership_unproven',
          nextAction: 'kernel identity approve --legacy-project-id <id> --approval-ref <operator-ref> --approved-by <operator> then kernel identity repair --legacy-project-id <id> --approval-ref <operator-ref>',
                remediation: 'kernel identity bootstrap --policy isolate preserves legacy state and starts a new namespace',
                legacyProjectId: legacyId,
                source: candidate.source,
                canonicalRoot,
              });
            }
            if (legacyIdentity && !sameRootIdentity) {
              throw Object.assign(new Error('project_identity_migration_conflict'), {
                code: 'project_identity_migration_conflict',
                legacyProjectId: legacyId,
                legacyCanonicalRoot: legacyIdentity.canonical_root,
                canonicalRoot,
              });
            }
            provenLegacyIds.push(legacyId);
          }

          // Every alias that can enter the canonical identity must be owned by
          // the destination or by a legacy namespace being migrated. Check
          // this before preparing the filesystem namespace migration.
          for (const legacyId of provenLegacyIds) {
            const legacyIdentity = projectIdentityPersistence.getIdentityByProjectId(legacyId);
            for (const alias of safeJsonParse(legacyIdentity?.aliases_json, [])) {
              const normalized = projectIdentityAlias(alias);
              if (normalized) incomingAliases.push(normalized);
            }
          }
          const allowedIncomingAliasOwners = new Set([projectId, ...provenLegacyIds]);
          for (const { alias } of incomingAliases) {
            const existingAliasProjectId = projectIdentityPersistence.getAliasOwner(alias);
            if (existingAliasProjectId && !allowedIncomingAliasOwners.has(existingAliasProjectId)) {
              throw Object.assign(new Error('project_identity_alias_conflict'), {
                code: 'project_identity_alias_conflict',
                alias,
                projectIds: [existingAliasProjectId, projectId],
              });
            }
          }

          migration.current = prepareProjectKnowledgeNamespaceMigration({
            runtimeHome,
            legacyProjectIds: provenLegacyIds,
            projectId,
            canonicalRoot,
            identityDigest,
          });

          for (const legacyId of provenLegacyIds) {
            migrateProjectId(legacyId, projectId);
            // project_identities is the one project_id table intentionally not
            // handled by the generic UPDATE because its primary key and unique
            // root constraints need the identity row to be rebuilt below.
            projectIdentityPersistence.deleteIdentity(legacyId);
            incomingAliases.push(projectIdentityAlias(`project-id:${legacyId}`)!);
          }
        }

        const previousAliases = row ? safeJsonParse(row.aliases_json, []) : [];
        const aliases = [...new Set([
          ...previousAliases,
          ...incomingAliases.map(({ alias }) => alias).filter((alias) => !alias.startsWith('workspace:') && !alias.startsWith('project-id:')),
        ])];
        const timestamp = now();
        if (!row) {
          projectIdentityPersistence.insertIdentity({
            projectId: canonicalProjectId,
            canonicalRoot,
            identitySource,
            identityDigest,
            aliasesJson: persistentJson(aliases),
            createdAt: timestamp,
            updatedAt: timestamp,
          });
          row = projectIdentityPersistence.getIdentityByProjectId(canonicalProjectId);
        } else {
          // project_id, canonical_root, and identity_digest are immutable. Only
          // newly observed aliases and last_seen metadata may advance.
          projectIdentityPersistence.updateIdentityAliases({
            projectId: row.project_id,
            aliasesJson: persistentJson(aliases),
            updatedAt: timestamp,
          });
          row = projectIdentityPersistence.getIdentityByProjectId(row.project_id)!;
          canonicalProjectId = row.project_id;
        }

        for (const { alias, aliasType } of incomingAliases) {
          const existingProjectId = projectIdentityPersistence.getAliasOwner(alias);
          if (existingProjectId && existingProjectId !== canonicalProjectId) {
            throw Object.assign(new Error('project_identity_alias_conflict'), {
              code: 'project_identity_alias_conflict',
              alias,
              projectIds: [existingProjectId, canonicalProjectId],
            });
          }
          projectIdentityPersistence.upsertAlias({
            alias,
            projectId: canonicalProjectId,
            aliasType,
            createdAt: timestamp,
            updatedAt: timestamp,
          });
        }
        const persistedAliases = projectIdentityPersistence.listAliases(canonicalProjectId, 'remote');
        return mapProjectIdentity(row, persistedAliases);
      });
      try {
        const result = register();
        if (migration.current) {
          try { migration.current.finalize(); } catch { /* journal cleanup is recoverable; committed state remains authoritative */ }
        }
        return result;
      } catch (error) {
        if (migration.current) {
          try { migration.current.rollback(); } catch (rollbackError) {
            throw Object.assign(new Error(`${errorMessage(error)}; identity filesystem rollback failed: ${errorMessage(rollbackError)}`), {
              code: 'project_identity_migration_rollback_failed',
              cause: error,
              rollbackError,
            });
          }
        }
        throw error;
      }
    },

    getProjectIdentity({ projectId = null, canonicalRoot = null, alias = null }: { projectId?: string | null; canonicalRoot?: string | null; alias?: string | null } = {}) {
      let row = null;
      if (projectId) row = projectIdentityPersistence.getIdentityByProjectId(String(projectId));
      else if (canonicalRoot) row = findProjectIdentityByRoot(canonicalIdentityRoot(canonicalRoot));
      else if (alias) row = projectIdentityPersistence.getIdentityByAlias(String(alias));
      if (!row) return null;
      const aliases = projectIdentityPersistence.listAliases(row.project_id, 'remote');
      return mapProjectIdentity(row, aliases);
    },

    mergeProjectIdentity({
      sourceProjectId = null,
      targetProjectId = null,
      canonicalRoot = null,
      gitCommonDir = null,
      approvedTargetIdentity = null,
    }: {
      sourceProjectId?: string | null;
      targetProjectId?: string | null;
      canonicalRoot?: string | null;
      gitCommonDir?: string | null;
      approvedTargetIdentity?: ProjectIdentityInput | null;
    } = {}) {
      const sourceId = String(sourceProjectId || '').trim();
      const targetId = String(targetProjectId || '').trim();
      const currentRoot = canonicalRoot ? canonicalIdentityRoot(canonicalRoot) : null;
      const currentGitCommonDir = gitCommonDir ? canonicalIdentityRoot(gitCommonDir) : null;
      if (!sourceId || !targetId || sourceId === targetId || !currentRoot) {
        throw Object.assign(new Error('project_identity_merge_invalid'), { code: 'project_identity_merge_invalid' });
      }
      const source = projectIdentityPersistence.getIdentityByProjectId(sourceId);
      const target = projectIdentityPersistence.getIdentityByProjectId(targetId);
      const approvedTargetRoot = approvedTargetIdentity?.canonicalRoot
        ? canonicalIdentityRoot(approvedTargetIdentity.canonicalRoot)
        : null;
      const approvedTargetDigest = String(approvedTargetIdentity?.identityDigest || '').trim();
      const approvedTargetSource = String(approvedTargetIdentity?.identitySource || '').trim();
      const approvedTargetMatches = Boolean(
        approvedTargetIdentity
        && String(approvedTargetIdentity.projectId || '').trim() === targetId
        && approvedTargetRoot
        && sameOwnershipPath(approvedTargetRoot, currentRoot)
        && approvedTargetDigest,
      );
      if (!source || (!target && (!approvedTargetMatches || !hasProjectData(targetId)))) {
        throw Object.assign(new Error('project_identity_merge_identity_missing'), {
          code: 'project_identity_merge_identity_missing',
          sourceProjectId: sourceId,
          targetProjectId: targetId,
        });
      }
      const repositoryProof = (projectId: string, identity: IdentityRow) => (
        sameOwnershipPath(identity.canonical_root, currentRoot)
        || hasPairedCrossSurfaceRepositoryEvidence({
          projectId,
          persistedRoot: identity.canonical_root,
          observedRoot: currentRoot,
          observedGitCommonDir: currentGitCommonDir,
        })
        || Boolean(currentGitCommonDir && workLifecyclePersistence
          .listProjectWorkspaceRecords(projectId)
          .some((workspace) => sameOwnershipPath(workspace.gitCommonDir, currentGitCommonDir)))
      );
      const targetOwnershipProven = target
        ? repositoryProof(targetId, target)
        : approvedTargetMatches;
      if (!repositoryProof(sourceId, source) || !targetOwnershipProven) {
        throw Object.assign(new Error('project_identity_merge_ownership_unproven'), {
          code: 'project_identity_merge_ownership_unproven',
          sourceProjectId: sourceId,
          targetProjectId: targetId,
          canonicalRoot: currentRoot,
          gitCommonDir: currentGitCommonDir,
        });
      }

      const sourceAliases = safeJsonParse<string[]>(source.aliases_json, []);
      const targetAliases = target
        ? safeJsonParse<string[]>(target.aliases_json, [])
        : (Array.isArray(approvedTargetIdentity?.aliases) ? approvedTargetIdentity.aliases : []);
      const targetCanonicalRoot = target?.canonical_root || approvedTargetRoot!;
      const targetIdentitySource = target?.identity_source || approvedTargetSource || 'operator_approved_legacy';
      const targetIdentityDigest = target?.identity_digest || approvedTargetDigest;
      const mergeProjectAliases = [...new Set([
        `project-id:${sourceId}`,
        `project-id:${targetId}`,
        ...sourceAliases,
        ...targetAliases,
      ].map((alias) => projectIdentityAlias(alias)?.alias).filter((alias): alias is string => Boolean(alias)))];
      const assertMergeProjectAliasesAvailable = () => {
        for (const alias of mergeProjectAliases) {
          const existingAliasProjectId = projectIdentityPersistence.getAliasOwner(alias);
          if (
            existingAliasProjectId
            && existingAliasProjectId !== sourceId
            && existingAliasProjectId !== targetId
          ) {
            throw Object.assign(new Error('project_identity_alias_conflict'), {
              code: 'project_identity_alias_conflict',
              alias,
              projectIds: [existingAliasProjectId, sourceId, targetId],
            });
          }
        }
      };
      // Validate DB ownership before preparing the filesystem migration. The
      // preparation stage can move/stage knowledge namespaces, so an alias
      // conflict must fail before it is entered.
      assertMergeProjectAliasesAvailable();
      const migration = prepareProjectKnowledgeNamespaceMigration({
        runtimeHome,
        legacyProjectIds: [sourceId],
        projectId: targetId,
        canonicalRoot: targetCanonicalRoot,
        identityDigest: targetIdentityDigest,
      });
      try {
        const merge = db.transaction(() => {
          // Re-check inside the DB transaction so a concurrent alias change
          // cannot slip between the preflight and the committed migration.
          assertMergeProjectAliasesAvailable();
          migrateProjectId(sourceId, targetId);
          projectIdentityPersistence.deleteIdentity(sourceId);
          const timestamp = now();
          const aliases = [...new Set([...targetAliases, ...sourceAliases])];
          if (target) {
            projectIdentityPersistence.updateIdentityAliases({
              projectId: targetId,
              aliasesJson: persistentJson(aliases),
              updatedAt: timestamp,
            });
          } else {
            projectIdentityPersistence.insertIdentity({
              projectId: targetId,
              canonicalRoot: targetCanonicalRoot,
              identitySource: targetIdentitySource,
              identityDigest: targetIdentityDigest,
              aliasesJson: persistentJson(aliases),
              createdAt: timestamp,
              updatedAt: timestamp,
            });
          }
          projectIdentityPersistence.upsertAlias({
            alias: `project-id:${sourceId}`,
            projectId: targetId,
            aliasType: 'legacy-project-id',
            createdAt: timestamp,
            updatedAt: timestamp,
          });
          for (const aliasValue of aliases) {
            const aliasEntry = projectIdentityAlias(aliasValue);
            if (!aliasEntry) continue;
            projectIdentityPersistence.upsertAlias({
              alias: aliasEntry.alias,
              projectId: targetId,
              aliasType: aliasEntry.aliasType,
              createdAt: timestamp,
              updatedAt: timestamp,
            });
          }
          const row = projectIdentityPersistence.getIdentityByProjectId(targetId)!;
          return mapProjectIdentity(row, projectIdentityPersistence.listAliases(targetId, 'remote'));
        });
        const result = merge();
        try { migration.finalize(); } catch { /* committed state remains authoritative */ }
        return result;
      } catch (error) {
        try { migration.rollback(); } catch (rollbackError) {
          throw Object.assign(new Error(`${errorMessage(error)}; identity filesystem rollback failed: ${errorMessage(rollbackError)}`), {
            code: 'project_identity_migration_rollback_failed',
            cause: error,
            rollbackError,
          });
        }
        throw error;
      }
    },

    inspectProjectIdentity({ projectId = null, canonicalRoot = null, gitCommonDir = null, legacyCandidates = [] }: { projectId?: string | null; canonicalRoot?: string | null; gitCommonDir?: string | null; legacyCandidates?: LegacyIdentityCandidate[] } = {}) {
      const rootIdentity = canonicalRoot
        ? this.getProjectIdentity({ canonicalRoot })
        : null;
      const projectIdentity = projectId
        ? this.getProjectIdentity({ projectId })
          || this.getProjectIdentity({ alias: `project-id:${projectId}` })
        : null;
      // A linked worktree has a distinct canonical root, but it is still the
      // same logical project when its project id and Git common directory both
      // match the persisted project identity. Do not fall back on project id
      // alone: a copied origin or caller-supplied identity is not ownership
      // evidence across unrelated repositories.
      const canonicalIncomingGitCommonDir = gitCommonDir ? canonicalIdentityRoot(gitCommonDir) : null;
      const persistedGitEvidence = projectIdentity && canonicalIncomingGitCommonDir
        ? (
            workLifecyclePersistence
              .listProjectWorkspaceRecords(projectIdentity.projectId)
              .some((workspace) => sameOwnershipPath(workspace.gitCommonDir, canonicalIncomingGitCommonDir))
            || Boolean(canonicalRoot && hasPairedCrossSurfaceRepositoryEvidence({
              projectId: projectIdentity.projectId,
              persistedRoot: projectIdentity.canonicalRoot,
              observedRoot: canonicalRoot,
              observedGitCommonDir: canonicalIncomingGitCommonDir,
            }))
          )
        : false;
      const linkedIdentity = !rootIdentity && projectIdentity && canonicalRoot && canonicalIncomingGitCommonDir
        && persistedGitEvidence
        ? projectIdentity
        : null;
      const currentIdentity = rootIdentity || linkedIdentity || (
        !canonicalRoot ? projectIdentity : null
      );
      // A second host surface can spell the same physical repository as
      // C:\\repo, /c/repo, or /mnt/c/repo. Canonical-root equivalence is
      // already repository ownership evidence; Git common-dir observations are
      // the additional proof for linked roots. A shared remote URL alone remains
      // insufficient ownership proof.
      const crossSurfaceCandidates = projectIdentityPersistence.listIdentities()
        .filter((candidate) => candidate.project_id !== currentIdentity?.projectId)
        .filter((candidate) => (
          Boolean(canonicalRoot && sameOwnershipPath(candidate.canonical_root, canonicalRoot))
          || Boolean(canonicalRoot && canonicalIncomingGitCommonDir && hasPairedCrossSurfaceRepositoryEvidence({
            projectId: candidate.project_id,
            persistedRoot: candidate.canonical_root,
            observedRoot: canonicalRoot,
            observedGitCommonDir: canonicalIncomingGitCommonDir,
          }))
          || Boolean(canonicalIncomingGitCommonDir && workLifecyclePersistence
            .listProjectWorkspaceRecords(candidate.project_id)
            .some((workspace) => sameOwnershipPath(workspace.gitCommonDir, canonicalIncomingGitCommonDir)))
        ))
        .map((candidate) => {
          const canonicalRootMatch = Boolean(
            (canonicalRoot && sameOwnershipPath(candidate.canonical_root, canonicalRoot))
            || (canonicalRoot
              && canonicalIncomingGitCommonDir
              && hasPairedCrossSurfaceRepositoryEvidence({
                projectId: candidate.project_id,
                persistedRoot: candidate.canonical_root,
                observedRoot: canonicalRoot,
                observedGitCommonDir: canonicalIncomingGitCommonDir,
              }))
          );
          return {
            projectId: candidate.project_id,
            source: canonicalRootMatch ? 'canonical-root' : 'git-common-dir',
            aliasType: 'cross-surface-repository',
            canonicalRoot: candidate.canonical_root,
          };
        });
      const candidates = [...new Map([
        ...(Array.isArray(legacyCandidates) ? legacyCandidates : []),
        ...crossSurfaceCandidates,
      ]
        .filter((candidate) => candidate?.projectId && candidate.projectId !== currentIdentity?.projectId)
        .map((candidate) => [String(candidate.projectId), candidate])).values()];
      return {
        currentIdentity,
        legacyCandidates: candidates.map((candidate) => {
          const candidateId = String(candidate.projectId);
          const identity = this.getProjectIdentity({ projectId: candidateId });
          const workspaces = workLifecyclePersistence
            .listProjectWorkspaceRecords(candidateId)
            .map((workspace) => ({
              workspaceId: workspace.workspaceId,
              canonicalRoot: workspace.canonicalRoot,
              gitCommonDir: workspace.gitCommonDir,
            }))
            .sort((left, right) => left.canonicalRoot.localeCompare(right.canonicalRoot));
          const data = projectDataSummary(candidateId);
          const sameRootEvidence = Boolean(
            (identity && sameOwnershipPath(identity.canonicalRoot, canonicalRoot))
              || workspaces.some((workspace) => sameOwnershipPath(workspace.canonicalRoot, canonicalRoot))
              || (identity && canonicalRoot && canonicalIncomingGitCommonDir && hasPairedCrossSurfaceRepositoryEvidence({
                projectId: candidateId,
                persistedRoot: identity.canonicalRoot,
                observedRoot: canonicalRoot,
                observedGitCommonDir: canonicalIncomingGitCommonDir,
              }))
              || (canonicalIncomingGitCommonDir && workspaces.some((workspace) => sameOwnershipPath(workspace.gitCommonDir, canonicalIncomingGitCommonDir))),
          );
          return {
            projectId: candidateId,
            source: candidate.source || null,
            aliasType: candidate.aliasType || null,
            hasData: data.hasData,
            dataTables: data.tables,
            knowledgeNamespace: data.knowledgeNamespace,
            hasPersistedIdentity: Boolean(identity),
            identity,
            workspaceRoots: workspaces.map((workspace) => workspace.canonicalRoot),
            workspaces,
            sameRootEvidence,
          };
        }),
      };
    },

    registerProjectWorkspace(workspace: WorkspaceInput) {
      // Workspace registration is one ownership decision. BEGIN IMMEDIATE is
      // acquired before any persisted ownership read, so concurrent registrars
      // cannot both decide from the same stale "unowned" state and then
      // overwrite project/root/Git authority with a later upsert.
      const register = db.transaction(() => {
        const canonicalRoot = canonicalIdentityRoot(workspace.canonicalRoot || workspace.identity?.canonicalRoot);
      const gitCommonDir = workspace.gitCommonDir ? canonicalIdentityRoot(workspace.gitCommonDir) : null;
      const gitWorktreeDir = workspace.gitWorktreeDir ? canonicalIdentityRoot(workspace.gitWorktreeDir) : null;
      const identity = {
        ...(workspace.identity || {}),
        projectId: workspace.identity?.projectId || workspace.projectId!,
        canonicalRoot,
      };
      const priorObservedRow = workLifecyclePersistence
        .getProjectWorkspaceRecord(workspace.workspaceId);
      if (priorObservedRow && priorObservedRow.projectId !== identity.projectId) {
        throw Object.assign(
          new Error('workspace_project_identity_mismatch'),
          { code: 'workspace_project_identity_mismatch' },
        );
      }
      const projectWorkspaceRows = workLifecyclePersistence
        .listProjectWorkspaceRecords(identity.projectId);
      // A persisted workspace ID is the durable ownership handle for one
      // workspace root. Equivalent cross-surface spellings normalize back to
      // the persisted root; reusing the same ID for a different root fails
      // closed instead of silently moving Run/lease authority. Persisted Git
      // evidence is monotonic and incoming observations only fill gaps.
      if (
        priorObservedRow
        && !sameIdentityPath(priorObservedRow.canonicalRoot, canonicalRoot)
      ) {
        throw Object.assign(
          new Error('project_worktree_identity_mismatch'),
          { code: 'project_worktree_identity_mismatch' },
        );
      }
      const observedCanonicalRoot = priorObservedRow?.canonicalRoot || canonicalRoot;
      const observedGitCommonDir = priorObservedRow?.gitCommonDir || gitCommonDir;
      const observedGitWorktreeDir = priorObservedRow?.gitWorktreeDir || gitWorktreeDir;
      const observedWorktreeId = deriveKernelWorktreeId({
        projectId: identity.projectId,
        canonicalWorktreeRoot: observedCanonicalRoot,
        canonicalGitDir: observedGitWorktreeDir,
      });
      if (workspace.worktreeId && String(workspace.worktreeId) !== observedWorktreeId) {
        throw Object.assign(new Error('project_worktree_identity_mismatch'), { code: 'project_worktree_identity_mismatch' });
      }
      identity.canonicalRoot = observedCanonicalRoot;
      identity.worktreeId = observedWorktreeId;
      const observedEvidence: WorkspaceRepositoryEvidence = {
        workspaceId: workspace.workspaceId,
        canonicalRoot: observedCanonicalRoot,
        gitCommonDir: observedGitCommonDir,
        gitWorktreeDir: observedGitWorktreeDir,
      };
      const equivalentRows = workspaceRepositoryComponent(
        observedEvidence,
        projectWorkspaceRows,
      ).sort(compareWorkspaceRecords);
      const anchorComponent: WorkspaceRepositoryEvidence[] = [
        observedEvidence,
        ...equivalentRows,
      ];
      const referencedWorkspaceIds = new Set([
        ...workLifecyclePersistence.listRunWorkspaceIds(identity.projectId),
        ...workLifecyclePersistence.listSessionBindings({
          projectId: identity.projectId,
        }).map(({ workspaceId }) => workspaceId).filter(Boolean),
        ...workLifecyclePersistence.listWorkspaceMutationLocksV2({ projectId: identity.projectId }).map(({ workspaceId }) => workspaceId),
      ]);
      const existing = equivalentRows
        .filter((candidate) => (
          isWorkspaceRepositoryAnchor(candidate, anchorComponent)
          && preservesPersistedWorkspaceGitEvidence(candidate, equivalentRows)
        ))
        .sort((left, right) => {
          const leftReferenced = referencedWorkspaceIds.has(left.workspaceId) ? 0 : 1;
          const rightReferenced = referencedWorkspaceIds.has(right.workspaceId) ? 0 : 1;
          if (leftReferenced !== rightReferenced) return leftReferenced - rightReferenced;
          const leftExact = left.canonicalRoot === observedCanonicalRoot ? 0 : 1;
          const rightExact = right.canonicalRoot === observedCanonicalRoot ? 0 : 1;
          if (leftExact !== rightExact) return leftExact - rightExact;
          return compareWorkspaceRecords(left, right);
        })[0] || null;
      if (existing) {
          const preserveExistingSurface = existing.canonicalRoot !== observedCanonicalRoot
            && sameIdentityPath(existing.canonicalRoot, observedCanonicalRoot);
          const retainedCanonicalRoot = preserveExistingSurface ? existing.canonicalRoot : observedCanonicalRoot;
          // Persisted Git paths are ownership evidence for this workspace
          // authority. Once established, keep them monotonic across in-place
          // re-observation; a different repository identity must go through
          // the existing identity/repair path instead of rewriting proof that
          // may be required by already-collapsed workspace surfaces.
          const retainedGitCommonDir = existing.gitCommonDir || observedGitCommonDir;
          const retainedGitWorktreeDir = existing.gitWorktreeDir || observedGitWorktreeDir;
          const retainedWorktreeId = deriveKernelWorktreeId({
            projectId: identity.projectId,
            canonicalWorktreeRoot: retainedCanonicalRoot,
            canonicalGitDir: retainedGitWorktreeDir || null,
          });
          const retainedIdentity = preserveExistingSurface
            ? safeJsonParse<UnknownRecord>(existing.identityJson, {})
            : { ...identity };
          retainedIdentity.projectId = identity.projectId;
          retainedIdentity.canonicalRoot = retainedCanonicalRoot;
          retainedIdentity.worktreeId = retainedWorktreeId;

          rebindWorkspaceWorktreeAuthority({
            fromProjectId: identity.projectId,
            toProjectId: identity.projectId,
            workspaceId: existing.workspaceId,
            sourceWorktreeId: existing.worktreeId,
            nextWorktreeId: retainedWorktreeId,
          });
          for (const duplicate of equivalentRows.filter((candidate) => candidate.workspaceId !== existing.workspaceId)) {
            rebindWorkspaceWorktreeAuthority({
              fromProjectId: identity.projectId,
              toProjectId: identity.projectId,
              workspaceId: duplicate.workspaceId,
              sourceWorktreeId: duplicate.worktreeId,
              nextWorktreeId: retainedWorktreeId,
            });
            workLifecyclePersistence.mergeProjectWorkspaceReferences({
              sourceWorkspaceId: duplicate.workspaceId,
              targetWorkspaceId: existing.workspaceId,
              canonicalRoot: retainedCanonicalRoot,
              withinTransaction: true,
            });
          }

          const observedAt = now();
          workLifecyclePersistence.upsertProjectWorkspaceRecord({
            workspaceId: existing.workspaceId,
            projectId: identity.projectId,
            canonicalRoot: retainedCanonicalRoot,
            gitCommonDir: retainedGitCommonDir,
            gitWorktreeDir: retainedGitWorktreeDir,
            worktreeId: retainedWorktreeId,
            identityJson: persistentJson(retainedIdentity),
            createdAt: existing.createdAt || observedAt,
            lastSeenAt: observedAt,
          });
          workLifecyclePersistence.backfillRunWorktreeId({
            projectId: identity.projectId,
            workspaceId: existing.workspaceId,
            worktreeId: retainedWorktreeId,
          });
          return this.getProjectWorkspace(existing.workspaceId)!;
      }

      if (
        equivalentRows.length > 0
        && isWorkspaceRepositoryAnchor(observedEvidence, anchorComponent)
        && preservesPersistedWorkspaceGitEvidence(observedEvidence, equivalentRows)
      ) {
          const observedAt = now();
          if (priorObservedRow) {
            rebindWorkspaceWorktreeAuthority({
              fromProjectId: identity.projectId,
              toProjectId: identity.projectId,
              workspaceId: priorObservedRow.workspaceId,
              sourceWorktreeId: priorObservedRow.worktreeId,
              nextWorktreeId: observedWorktreeId,
            });
          }
          workLifecyclePersistence.upsertProjectWorkspaceRecord({
            workspaceId: workspace.workspaceId,
            projectId: identity.projectId,
            canonicalRoot: observedCanonicalRoot,
            gitCommonDir: observedGitCommonDir,
            gitWorktreeDir: observedGitWorktreeDir,
            worktreeId: observedWorktreeId,
            identityJson: persistentJson(identity),
            createdAt: priorObservedRow?.createdAt || observedAt,
            lastSeenAt: observedAt,
          });
          for (const duplicate of equivalentRows.filter(
            (candidate) => candidate.workspaceId !== workspace.workspaceId,
          )) {
            rebindWorkspaceWorktreeAuthority({
              fromProjectId: identity.projectId,
              toProjectId: identity.projectId,
              workspaceId: duplicate.workspaceId,
              sourceWorktreeId: duplicate.worktreeId,
              nextWorktreeId: observedWorktreeId,
            });
            workLifecyclePersistence.mergeProjectWorkspaceReferences({
              sourceWorkspaceId: duplicate.workspaceId,
              targetWorkspaceId: workspace.workspaceId,
              canonicalRoot: observedCanonicalRoot,
              withinTransaction: true,
            });
          }
          workLifecyclePersistence.backfillRunWorktreeId({
            projectId: identity.projectId,
            workspaceId: workspace.workspaceId,
            worktreeId: observedWorktreeId,
          });
          return this.getProjectWorkspace(workspace.workspaceId)!;
      }

      if (equivalentRows.length > 0) {
        throw Object.assign(new Error('project_workspace_repository_component_unanchored'), {
          code: 'project_workspace_repository_component_unanchored',
          projectId: identity.projectId,
          workspaceIds: [
            workspace.workspaceId,
            ...equivalentRows.map(({ workspaceId }) => workspaceId),
          ],
        });
      }
      const observedAt = now();
      workLifecyclePersistence.upsertProjectWorkspaceRecord({
        workspaceId: workspace.workspaceId,
        projectId: identity.projectId,
        canonicalRoot: observedCanonicalRoot,
        gitCommonDir: observedGitCommonDir,
        gitWorktreeDir: observedGitWorktreeDir,
        worktreeId: observedWorktreeId,
        identityJson: persistentJson(identity),
        createdAt: observedAt,
        lastSeenAt: observedAt,
      });
      return this.getProjectWorkspace(workspace.workspaceId)!;
      });
      return register();
    },

    getProjectWorkspace(workspaceId: string) {
      const row = workLifecyclePersistence.getProjectWorkspaceRecord(workspaceId);
      return row ? { ...row, identity: safeJsonParse<ProjectIdentityInput | null>(row.identityJson, null) } : null;
    },

    listActiveRuns({ projectId = null, worktreeId = null, workspaceId = null }: { projectId?: string | null; worktreeId?: string | null; workspaceId?: string | null } = {}) {
      return workLifecyclePersistence.listRunIds({
        projectId,
        worktreeId,
        workspaceId,
        statuses: ['active'],
      }).map((runId) => this.getRun(runId)).filter((run): run is KernelRun => Boolean(run));
    },

    acquireWorktreeMutationLease({ worktreeId, projectId, runId }: { worktreeId?: string; projectId?: string; runId?: string } = {}) {
      if (!worktreeId || !projectId || !runId) {
        throw Object.assign(new Error('worktree_mutation_lease_identity_missing'), {
          code: 'worktree_mutation_lease_identity_missing',
          errorCode: 'worktree_mutation_lease_identity_missing',
          nextAction: 'resolve-run-worktree-binding',
        });
      }
      return db.transaction(() => {
        const run = workLifecyclePersistence.getRunLifecycleIdentity(runId);
        if (!run || run.projectId !== projectId || run.worktreeId !== worktreeId) {
          throw Object.assign(new Error('run_worktree_mismatch'), {
            code: 'run_worktree_mismatch',
            errorCode: 'run_worktree_mismatch',
            nextAction: 'return-to-bound-worktree',
          });
        }
        if (run.status !== 'active') {
          throw Object.assign(new Error('terminal_run_cannot_acquire_worktree_lease'), {
            code: 'terminal_run_cannot_acquire_worktree_lease',
            errorCode: 'terminal_run_cannot_acquire_worktree_lease',
            nextAction: 'start-a-successor-run',
          });
        }
        return claimWorktreeLeaseInTransaction({ worktreeId, projectId, runId });
      })();
    },

    getWorktreeMutationLease(worktreeId: string) {
      if (!worktreeId) return null;
      return workLifecyclePersistence.getWorktreeMutationLease(worktreeId);
    },

    releaseWorktreeMutationLease({ worktreeId, runId }: { worktreeId?: string; runId?: string } = {}) {
      if (!worktreeId || !runId) {
        throw Object.assign(new Error('worktree_mutation_lease_identity_missing'), {
          code: 'worktree_mutation_lease_identity_missing',
          errorCode: 'worktree_mutation_lease_identity_missing',
        });
      }
      const release = db.transaction(() => {
        const current = workLifecyclePersistence.getWorktreeMutationLease(worktreeId);
        if (!current) return { released: false, lease: null };
        if (current.holderRunId !== runId) {
          throw Object.assign(new Error('worktree_mutation_lease_conflict'), {
            code: 'worktree_mutation_lease_conflict',
            errorCode: 'worktree_mutation_lease_conflict',
            nextAction: 'resume-the-lease-holder-run',
          });
        }
        const holder = workLifecyclePersistence.getRunLifecycleIdentity(runId);
        if (!holder || !worktreeLeaseTerminalStatuses.has(holder.status)) {
          throw Object.assign(new Error('worktree_mutation_lease_release_requires_terminal_run'), {
            code: 'worktree_mutation_lease_release_requires_terminal_run',
            errorCode: 'worktree_mutation_lease_release_requires_terminal_run',
            nextAction: 'complete-the-run',
          });
        }
        const deleted = workLifecyclePersistence.deleteWorktreeMutationLease({
          worktreeId,
          runId,
        });
        return { released: deleted, lease: current };
      });
      return release();
    },

    abandonRun(runId: string, { reason = 'user_requested' }: { reason?: string } = {}) {
      if (!runId) throw new Error('abandonRun requires runId');
      return db.transaction(() => {
        const run = workLifecyclePersistence.getRunLifecycleIdentity(runId);
        if (!run) throw Object.assign(new Error('run_not_found'), { code: 'run_not_found' });
        if (['completed', 'abandoned'].includes(run.status)) {
          return { status: run.status, runId, alreadyTerminal: true };
        }
        const observed = now();
        workLifecyclePersistence.updateRunLifecycle({
          runId,
          status: 'abandoned',
          updatedAt: observed,
        });
        // Deactivate every active binding for the abandoned Run in the
        // same transaction. Binding persistence owns the table-level CAS.
        for (const binding of workLifecyclePersistence.listSessionBindings({
          runId,
          status: 'active',
        })) {
          workLifecyclePersistence.updateSessionBinding({
            bindingId: binding.bindingId,
            expected: {
              runId,
              status: 'active',
            },
            changes: {
              status: 'inactive',
              closedAt: observed,
              closeReason: `abandoned:${reason}`,
              updatedAt: observed,
            },
          });
        }
        // Release worktree mutation lease if held
        if (run.worktreeId) {
          workLifecyclePersistence.deleteWorktreeMutationLease({
            worktreeId: run.worktreeId,
            runId,
          });
        }
        // Release workspace mutation lock if held
        if (run.workspaceId) {
          workLifecyclePersistence.deleteWorkspaceMutationLockV2({
            workspaceId: run.workspaceId,
            runId,
          });
        }
        return { status: 'abandoned', runId, alreadyTerminal: false };
      })();
    },

    listRuns({ projectId = null, worktreeId = null, workspaceId = null, statuses = null }: { projectId?: string | null; worktreeId?: (string | null) | undefined; workspaceId?: string | null; statuses?: string[] | null } = {}) {
      return workLifecyclePersistence.listRunIds({
        projectId,
        worktreeId,
        workspaceId,
        statuses,
      }).map((runId) => this.getRun(runId)).filter((run): run is KernelRun => Boolean(run));
    },

    // Read the existing successor edge stored on session_bindings. This is a
    // derived view only: no Goal/lineage table is introduced. The walk is
    // deliberately fail-closed when two predecessor edges or a cross-scope
    // edge are present.
    resolveSuccessorLineage(runId: string) {
      if (!runId) throw new Error('resolveSuccessorLineage requires runId');
      const seen = new Set();
      const runs = [];
      const edges = [];
      let cursor = String(runId);
      let terminalSuccessor = [...new Set(
        workLifecyclePersistence.listSessionBindings({ runId: cursor })
          .map((binding) => binding.successorRunId)
          .filter(Boolean),
      )];
      if (terminalSuccessor.length > 1) {
        throw Object.assign(new Error('SUCCESSOR_LINEAGE_AMBIGUOUS'), {
          code: 'SUCCESSOR_LINEAGE_AMBIGUOUS',
          errorCode: 'SUCCESSOR_LINEAGE_AMBIGUOUS',
          details: { runId: cursor, successorRunIds: terminalSuccessor },
        });
      }
      const isTerminal = terminalSuccessor.length === 0;

      while (cursor) {
        if (seen.has(cursor)) {
          throw Object.assign(new Error('SUCCESSOR_LINEAGE_CYCLE'), {
            code: 'SUCCESSOR_LINEAGE_CYCLE',
            errorCode: 'SUCCESSOR_LINEAGE_CYCLE',
            details: { runId: cursor },
          });
        }
        seen.add(cursor);
        const current = this.getRun(cursor);
        if (!current) {
          throw Object.assign(new Error('SUCCESSOR_LINEAGE_RUN_MISSING'), {
            code: 'SUCCESSOR_LINEAGE_RUN_MISSING',
            errorCode: 'SUCCESSOR_LINEAGE_RUN_MISSING',
            details: { runId: cursor },
          });
        }
        runs.unshift(current);
        const predecessors = workLifecyclePersistence.listSessionBindings({
          successorRunId: cursor,
        });
        if (predecessors.length === 0) break;
        const ownerPredecessors = predecessors.filter((binding) => binding.accessMode === 'owner');
        if (ownerPredecessors.length !== 1) {
          throw Object.assign(new Error('SUCCESSOR_LINEAGE_AMBIGUOUS'), {
            code: 'SUCCESSOR_LINEAGE_AMBIGUOUS',
            errorCode: 'SUCCESSOR_LINEAGE_AMBIGUOUS',
            details: { runId: cursor, predecessorBindingIds: ownerPredecessors.map((binding) => binding.bindingId) },
          });
        }
        const edge = requiredIndex(ownerPredecessors, 0);
        const predecessor = this.getRun(edge.runId);
        if (!predecessor
          || predecessor.projectId !== current.projectId
          || predecessor.workspaceId !== current.workspaceId
          || !predecessor.worktreeId
          || !current.worktreeId
          || predecessor.worktreeId !== current.worktreeId) {
          throw Object.assign(new Error('SUCCESSOR_LINEAGE_SCOPE_MISMATCH'), {
            code: 'SUCCESSOR_LINEAGE_SCOPE_MISMATCH',
            errorCode: 'SUCCESSOR_LINEAGE_SCOPE_MISMATCH',
            details: { predecessorRunId: edge.runId, successorRunId: cursor },
          });
        }
        const predecessorFinalWorkspaceIdentity = predecessor.currentWorkspaceIdentity || null;
        const successorStartWorkspaceIdentity = current.runStartWorkspaceIdentity || null;
        if (!predecessorFinalWorkspaceIdentity
          || !successorStartWorkspaceIdentity
          || predecessorFinalWorkspaceIdentity !== successorStartWorkspaceIdentity) {
          throw Object.assign(new Error('SUCCESSOR_WORKSPACE_CONTINUITY_MISMATCH'), {
            code: 'SUCCESSOR_WORKSPACE_CONTINUITY_MISMATCH',
            errorCode: 'SUCCESSOR_WORKSPACE_CONTINUITY_MISMATCH',
            details: {
              predecessorRunId: edge.runId,
              successorRunId: cursor,
              predecessorFinalWorkspaceIdentity,
              successorStartWorkspaceIdentity,
            },
          });
        }
        edges.unshift({
          predecessorRunId: edge.runId,
          successorRunId: cursor,
          binding: edge,
          predecessorFinalWorkspaceIdentity,
          successorStartWorkspaceIdentity,
        });
        cursor = edge.runId;
        terminalSuccessor = [];
      }
      return {
        runIds: runs.map((run) => run.runId),
        runs,
        edges,
        terminalRunId: String(runId),
        isTerminal,
      };
    },

    getLatestRunForWorktree({ projectId, worktreeId, workspaceId = null }: { projectId?: string; worktreeId?: string | null; workspaceId?: string | null } = {}) {
      if (!projectId || (!worktreeId && !workspaceId)) return null;
      // Discovery needs only the newest scoped record. Do not materialize
      // unrelated historical Runs: their old schemas must not block a new task.
      // The selected Run still passes the normal strict getRun validation.
      const runId = workLifecyclePersistence.listRunIds({ projectId, worktreeId: worktreeId ?? null, workspaceId })[0];
      return runId ? this.getRun(runId) : null;
    },

    acquireWorkspaceMutationLockV2({ workspaceId, projectId, runId, sessionToken, ttlMs = 60000 }: { workspaceId?: string; projectId?: (string) | undefined; runId?: string; sessionToken?: string; ttlMs?: number } = {}) {
      if (!workspaceId || !projectId || !runId || !sessionToken) throw new Error('workspace mutation lock requires workspaceId, projectId, runId, and sessionToken');
      const workspace = this.getProjectWorkspace(workspaceId);
      const run = this.getRunMetadata(runId);
      if (!workspace || workspace.projectId !== projectId || !run || run.projectId !== projectId) {
        throw Object.assign(new Error('run_project_mismatch'), {
          code: 'run_project_mismatch',
          errorCode: 'run_project_mismatch',
          nextAction: 'register-a-project-worktree',
        });
      }
      const isBoundWorkerWorkspace = run.workspaceId !== workspaceId
        && this.getRunSteps(runId).some((step) => step.executionWorkspaceId === workspaceId);
      if (run.workspaceId && run.workspaceId !== workspaceId && !isBoundWorkerWorkspace) {
        throw Object.assign(new Error('run_workspace_mismatch'), {
          code: 'run_workspace_mismatch',
          errorCode: 'run_workspace_mismatch',
          nextAction: 'return-to-bound-workspace',
        });
      }
      const acquiredAt = now();
      const expiresAt = new Date(Date.now() + ttlMs).toISOString();
      return db.transaction(() => {
        const current = workLifecyclePersistence.getWorkspaceMutationLockV2(workspaceId);
        if (current && Date.parse(current.expiresAt) > Date.now() && (current.holderRunId !== runId || current.sessionToken !== sessionToken)) {
          return { acquired: false, lock: current };
        }
        // Releasing a transient lock must not reset the workspace's fencing
        // epoch. Keep its monotonic counter in the existing workspace binding.
        const epoch = workLifecyclePersistence.getWorkspaceMutationEpoch(workspaceId);
        const fencingToken = Math.max(Number(epoch || 0), Number(current?.fencingToken || 0)) + 1;
        if (!workLifecyclePersistence.setWorkspaceMutationEpoch(workspaceId, fencingToken)) {
          throw Object.assign(new Error('workspace_not_found'), {
            code: 'workspace_not_found',
            workspaceId,
          });
        }
        const lock = workLifecyclePersistence.upsertWorkspaceMutationLockV2({
          workspaceId,
          projectId,
          holderRunId: runId,
          sessionToken,
          fencingToken,
          acquiredAt,
          expiresAt,
        });
        return { acquired: true, lock };
      })();
    },

    getWorkspaceMutationLockV2(workspaceId: string) {
      const row = workLifecyclePersistence.getWorkspaceMutationLockV2(workspaceId);
      return !row || Date.parse(row.expiresAt) <= Date.now() ? null : row;
    },

    renewWorkspaceMutationLockV2({ workspaceId, projectId, runId, sessionToken, fencingToken, ttlMs = 120000 }: { workspaceId?: string; projectId?: string; runId?: string; sessionToken?: string; fencingToken?: (number) | undefined; ttlMs?: number } = {}) {
      if (!workspaceId || !projectId || !runId || !sessionToken || fencingToken === null || fencingToken === undefined) {
        throw new Error('renewWorkspaceMutationLockV2 requires workspaceId, projectId, runId, sessionToken, and fencingToken');
      }
      const expiresAt = new Date(Date.now() + ttlMs).toISOString();
      const observedAt = new Date().toISOString();
      return db.transaction(() => {
        const current = workLifecyclePersistence.getWorkspaceMutationLockV2(workspaceId);
        if (!current
          || current.projectId !== projectId
          || current.holderRunId !== runId
          || current.sessionToken !== sessionToken
          || Number(current.fencingToken) !== Number(fencingToken)
          || Date.parse(current.expiresAt) <= Date.now()) {
          return { renewed: false, lock: current || null };
        }
        const updated = workLifecyclePersistence.renewWorkspaceMutationLockV2({
          workspaceId,
          projectId,
          runId,
          sessionToken,
          fencingToken: Number(fencingToken),
          expiresAt,
          observedAt,
        });
        if (!updated) {
          return { renewed: false, lock: current };
        }
        return { renewed: true, lock: { ...current, expiresAt } };
      })();
    },

    releaseWorkspaceMutationLockV2({
      workspaceId,
      runId,
      sessionToken,
      fencingToken,
    }: { workspaceId?: (string) | undefined; runId?: string; sessionToken?: string; fencingToken?: (number) | undefined } = {}) {
      const fail: () => never = () => {
        throw Object.assign(new Error('workspace_lock_handoff_failed'), {
          code: 'workspace_lock_handoff_failed',
          errorCode: 'workspace_lock_handoff_failed',
          nextAction: 'reacquire-workspace-lock',
        });
      };
      if (!workspaceId || !runId || !sessionToken || !Number.isInteger(Number(fencingToken))) {
        fail();
      }
      const release = db.transaction(() => {
        const current = workLifecyclePersistence.getWorkspaceMutationLockV2(workspaceId);
        if (
          !current
          || current.holderRunId !== runId
          || current.sessionToken !== sessionToken
          || Number(current.fencingToken) !== Number(fencingToken)
        ) {
          fail();
        }
        const released = workLifecyclePersistence.deleteWorkspaceMutationLockV2({
          workspaceId,
          runId,
          sessionToken,
          fencingToken: Number(fencingToken),
        });
        if (!released) fail();
        return { released: true, lock: current };
      });
      return release();
    },

    ensureRunObligation(runId: string, { obligationId, sourceType = 'ontology_constraint', sourceRef = null, evidenceClass = 'hard', verificationMethod = null, allowedCommandRefs = [], acceptanceIds = [], status = 'required' }: { obligationId: string; sourceType?: string; sourceRef?: string | null; evidenceClass?: string; verificationMethod?: string | null; allowedCommandRefs?: string[]; acceptanceIds?: string[]; status?: string }) {
      const run = this.getRun(runId);
      trustPersistence.ensureRunObligation({
        runId,
        obligationId,
        sourceType,
        sourceRef: sourceRef || null,
        status,
        evidenceClass,
        verificationMethod,
        allowedCommandRefs,
        acceptanceIds,
        protected: isProtectedObligation(obligationId),
        contractRevision: Number(run?.contractRevision || 1),
      });
    },

    markRunObligationPassed(runId: string, obligationId: string) {
      trustPersistence.markRunObligationPassed(runId, obligationId);
    },

    getRunObligations(runId: string) {
      return trustPersistence.getRunObligations(runId);
    },

    getRunObligation(runId: string, obligationId: string | null | undefined) {
      return this.getRunObligations(runId).find((obligation) => obligation.obligationId === obligationId) || null;
    },

    recordCompletionDecision(runId: string, { decision, sourceIdentity, mutationRevision, evidenceDigest, decisionJson }: { decision: string; sourceIdentity: string; mutationRevision: number; evidenceDigest: string; decisionJson: UnknownRecord }) {
      trustPersistence.recordCompletionDecision({
        runId,
        decision,
        sourceIdentity,
        mutationRevision,
        evidenceDigest,
        decisionJson,
      });
    },

    getCompletionDecision(runId: string) {
      return trustPersistence.getCompletionDecision(runId);
    },

    recordGitCloseoutReceipt(runId: string, { projectId, mode, commitSha, branch, remote = 'origin', pushStatus, parity, status = 'completed', beforeHeadSha = null, selectedPaths = [], errorCode = null, errorMessage = null, receiptJson }: { projectId?: string | null; mode?: string | null; commitSha?: string | null; branch?: string | null; remote?: string; pushStatus?: (string | null) | undefined; parity?: unknown; status?: string; beforeHeadSha?: string | null; selectedPaths?: string[]; errorCode?: string | null; errorMessage?: string | null; receiptJson?: UnknownRecord }) {
      hostExecutionPersistence.recordGitCloseoutReceipt(runId, {
        projectId,
        mode,
        commitSha,
        branch,
        remote,
        pushStatus,
        parity,
        status,
        beforeHeadSha,
        selectedPaths,
        errorCode,
        errorMessage,
        receiptJson,
      });
    },

    getGitCloseoutReceipt(runId: string) {
      return hostExecutionPersistence.getGitCloseoutReceipt(runId);
    },

    recordFinalizationReceipt(runId: string, receipt: ReviewReceiptInput = {}) {
      finalizationPersistence.recordFinalizationReceipt(runId, receipt);
    },

    getFinalizationReceipt(runId: string) {
      return finalizationPersistence.getFinalizationReceipt(runId);
    },

    // Model routing evidence (§7). The decision is written BEFORE the Host
    // dispatches, so a crashed turn leaves an interrupted decision rather than
    // an invisible one; the receipt is what proves the Host actually complied.
    recordModelRouteDecision(runId: string, decision: ModelRouteDecisionInput) {
      const normalized = normalizeModelRouteDecision(decision);
      if (normalized.runId !== runId) throw new Error(`model route decision runId ${normalized.runId} does not match run ${runId}`);
      if (!this.getRun(runId)) throw new Error(`Run ${runId} not found`);
      hostExecutionPersistence.persistModelRouteDecision(runId, normalized);
      return normalized;
    },

    getModelRouteDecision(decisionId: string, { runId = null }: { runId?: string | null } = {}) {
      return hostExecutionPersistence.getModelRouteDecision(decisionId, runId);
    },

    listModelRouteDecisions(runId: string) {
      return hostExecutionPersistence.listModelRouteDecisions(runId);
    },

    recordModelUsageReceipt(runId: string, receipt: ModelUsageReceiptInput) {
      const normalized = normalizeModelUsageReceipt(receipt);
      if (normalized.runId !== runId) throw new Error(`model usage receipt runId ${normalized.runId} does not match run ${runId}`);
      const decision = this.getModelRouteDecision(String(normalized.decisionId), { runId });
      if (!decision) throw new Error(`model usage receipt references decision ${normalized.decisionId}, which does not belong to run ${runId}`);
      const attempt = normalized.attemptId ? this.getStepAttemptByAttemptId(normalized.attemptId, { runId }) : null;
      if (normalized.attemptId && !attempt) throw new Error(`model usage receipt references attempt ${normalized.attemptId}, which does not belong to run ${runId}`);
      if (attempt) {
        assertAttemptLineage(attempt, {
          runId,
          stepId: normalized.stepId,
          bindingId: normalized.bindingId,
          capsuleId: normalized.capsuleId,
          admissionId: normalized.admissionId,
          planRevision: decision.planRevision,
        });
      }
      hostExecutionPersistence.persistModelUsageReceipt(runId, normalized);
      if (attempt) {
        this.attachAttemptLineage(attempt.attemptId!, {
          usageReceiptId: normalized.receiptId,
          actorSessionId: normalized.actorSessionId,
          status: normalized.resultStatus === 'failed' ? 'interrupted' : undefined,
          failureCategory: normalized.resultStatus === 'failed' ? 'provider/infrastructure' : undefined,
        });
      }
      return normalized;
    },

    getModelUsageReceipt(receiptId: string, { runId = null }: { runId?: string | null } = {}) {
      return hostExecutionPersistence.getModelUsageReceipt(receiptId, runId);
    },

    listModelUsageReceipts(runId: string) {
      return hostExecutionPersistence.listModelUsageReceipts(runId);
    },

    // Route admissions (K3). Recorded whatever the outcome: a blocked admission
    // is the evidence that a dispatch was refused, and losing it would make a
    // refusal indistinguishable from a turn that never happened.
    recordRouteAdmission(runId: string, admission: UnknownRecord) {
      if (!admission?.admissionId) throw new Error('recordRouteAdmission requires a built admission');
      if (admission.runId !== runId) throw new Error(`route admission runId ${admission.runId} does not match run ${runId}`);
      if (!this.getRun(runId)) throw new Error(`Run ${runId} not found`);
      const attempt = admission.attemptId ? this.getStepAttemptByAttemptId(admission.attemptId, { runId }) : null;
      if (admission.attemptId && !attempt) throw new Error(`route admission references attempt ${admission.attemptId}, which does not belong to run ${runId}`);
      if (attempt) assertAttemptLineage(attempt, { runId, stepId: admission.stepId, capsuleId: admission.capsuleId, planRevision: admission.planRevision });
      hostExecutionPersistence.persistRouteAdmission(runId, admission);
      if (attempt) {
        this.attachAttemptLineage(attempt.attemptId!, {
          admissionId: admission.admissionId,
          status: admission.decision === 'blocked' || admission.decision === 'redecision_required' ? 'interrupted' : undefined,
          failureCategory: admission.rejectionCode || undefined,
        });
      }
      return admission;
    },

    getRouteAdmission(admissionId: string, { runId = null }: { runId?: string | null } = {}) {
      return hostExecutionPersistence.getRouteAdmission(admissionId, runId);
    },

    listRouteAdmissions(runId: string, { decisionId = null }: { decisionId?: string | null } = {}) {
      return hostExecutionPersistence.listRouteAdmissions(runId, decisionId);
    },

    // A worker result is an execution fact attached to the Step and its
    // canonical attempt. It does not open a second lifecycle or require a
    // group identity to become recoverable. Once an attempt has a result,
    // replay is exact-only: a different worker receipt cannot overwrite the
    // bytes or lineage that the recovery path relies on.
    recordStepResult(runId: string, stepId: string, result: UnknownRecord = {}) {
      const step = this.getRunStep(runId, stepId);
      if (!step) throw Object.assign(new Error('step-not-found'), { code: 'STEP_NOT_FOUND' });

      const attempts = this.getStepAttempts(runId, { stepId });
      const attempt = result.attemptId
        ? this.getStepAttemptByAttemptId(result.attemptId, { runId })
        : this.getActiveStepAttempt(runId, { stepId }) || attempts.at(-1) || null;
      if (result.attemptId && (!attempt || attempt.stepId !== stepId)) {
        throw Object.assign(new Error(`worker result attempt ${result.attemptId} does not belong to step ${stepId}`), {
          code: 'STEP_RESULT_ATTEMPT_MISMATCH',
          errorCode: 'STEP_RESULT_ATTEMPT_MISMATCH',
        });
      }
      const latestAttempt = attempts.at(-1) || null;
      if (result.attemptId && latestAttempt && attempt && attempt.id !== latestAttempt.id) {
        throw Object.assign(new Error(`worker result attempt ${result.attemptId} is not the current canonical attempt`), {
          code: 'STEP_RESULT_IMMUTABLE_CONFLICT',
          errorCode: 'STEP_RESULT_IMMUTABLE_CONFLICT',
          field: 'attemptId',
        });
      }

      const resultDigest = result.receiptDigest || result.resultDigest;
      const attemptResult = {
        changedPaths: result.changedPaths,
        mutationRevision: result.mutationRevision,
        workspaceIdentityEnd: result.resultWorkspaceIdentity,
        resultWorkspaceIdentity: result.resultWorkspaceIdentity,
        resultCommitSha: result.resultCommitSha,
        patchDigest: result.patchDigest,
        resultDigest,
        verificationRefs: result.verificationRefs,
        knowledgeObservationRefs: result.knowledgeObservationRefs,
        workerReport: result.workerReport,
      };
      const canonicalAttemptId = result.attemptId || attempt?.attemptId || null;
      const replacingStepReceipt = Boolean(
        canonicalAttemptId
        && step.resultAttemptId
        && step.resultAttemptId !== canonicalAttemptId,
      );
      if (replacingStepReceipt && step.state === 'passed') {
        throw Object.assign(new Error(`step ${stepId} already has an immutable passed result`), {
          code: 'STEP_RESULT_IMMUTABLE_CONFLICT',
          errorCode: 'STEP_RESULT_IMMUTABLE_CONFLICT',
          field: 'resultAttemptId',
        });
      }
      let updatedAttempt = attempt;
      if (attempt) {
        const attemptPatch = mergeImmutableReceiptFields(attempt, attemptResult, [
          'changedPaths',
          'mutationRevision',
          'workspaceIdentityEnd',
          'resultWorkspaceIdentity',
          'resultCommitSha',
          'patchDigest',
          'resultDigest',
          'verificationRefs',
          'knowledgeObservationRefs',
          'workerReport',
        ]);
        updatedAttempt = Object.keys(attemptPatch).length > 0
          ? this.updateStepAttempt(attempt.id, attemptPatch)
          : attempt;
      }

      const stepResult = {
        resultAttemptId: canonicalAttemptId,
        resultWorkspaceIdentity: result.resultWorkspaceIdentity,
        resultCommitSha: result.resultCommitSha,
        patchDigest: result.patchDigest,
        resultDigest,
        workspaceIdentityEnd: result.resultWorkspaceIdentity,
      };
      const stepPatch = replacingStepReceipt
        ? Object.fromEntries(Object.entries(stepResult).filter(([, value]) => value !== null && value !== undefined))
        : mergeImmutableReceiptFields(step, stepResult, [
          'resultAttemptId',
          'resultWorkspaceIdentity',
          'resultCommitSha',
          'patchDigest',
          'resultDigest',
          'workspaceIdentityEnd',
        ]);
      const updated = Object.keys(stepPatch).length > 0
        ? this.updateRunStep(runId, stepId, stepPatch)
        : step;

      if (result.recordMutationProvenance !== false
        && updatedAttempt && Array.isArray(updatedAttempt.changedPaths) && updatedAttempt.changedPaths.length > 0 && updatedAttempt.resultWorkspaceIdentity) {
        const run = this.getRun(runId);
        const mutationRevision = result.mutationRevision ?? updatedAttempt.mutationRevision ?? run?.mutationRevision ?? 0;
        this.recordMutationProvenance(runId, {
          projectId: run?.projectId,
          workspaceId: result.executionWorkspaceId || updatedAttempt.workspaceId || run?.workspaceId || null,
          sourceIdentity: run?.sourceIdentity,
          baseSourceIdentity: run?.sourceIdentity,
          mutationRevision,
          changedPaths: updatedAttempt.changedPaths,
          workspaceIdentity: updatedAttempt.resultWorkspaceIdentity,
          mutationDigest: result.patchDigest || result.receiptDigest || result.resultDigest || updatedAttempt.resultWorkspaceIdentity,
          attemptId: updatedAttempt.attemptId || null,
        });
      }
      return updated;
    },

    getActiveStepAttempt(runId: string, { stepId = null, attemptId = null, capsuleId = null }: { stepId?: string | null; attemptId?: (string | null) | undefined; capsuleId?: (unknown | null) | undefined } = {}) {
      const activeStatuses = ['started', 'reported', 'verifying'];
      if (attemptId) {
        const requested = this.getStepAttemptByAttemptId(attemptId, { runId });
        return requested && activeStatuses.includes(requested.status) ? requested : null;
      }
      const candidates = this.getStepAttempts(runId, { stepId })
        .filter((attempt) => !capsuleId || (attempt.capsuleId || attempt.capsuleDigest) === capsuleId)
        .filter((attempt) => activeStatuses.includes(attempt.status));
      return candidates.at(-1) || null;
    },

    getLatestImplementationAttempt(runId: string, { stepId = null }: { stepId?: string | null } = {}) {
      return this.getStepAttempts(runId, { stepId })
        .filter((attempt) => attempt.provenanceKind !== 'legacy-unattributed')
        .filter((attempt) => {
          if (attempt.provenanceKind === 'owner-session') return true;
          if (attempt.provenanceKind !== 'routed') return false;
          // Routed reviewer turns use the same canonical attempt table as
          // implementations. Only the route decision's role can distinguish
          // those rows; legacy routed rows without a decision remain eligible
          // for backward-compatible implementation provenance.
          const decision = attempt.routeDecisionId
            ? this.getModelRouteDecision(attempt.routeDecisionId, { runId })
            : null;
          return !decision || decision.role === 'implementer';
        })
        .at(-1) || null;
    },

    // Review receipts (K0). A judgment obligation is proven by a receipt whose
    // reviewer lineage and reviewed subject are both persisted, so a later
    // completion check can re-derive whether the review still holds.
    recordReviewReceipt(runId: string, receipt: ReviewReceiptInput) {
      const normalized = normalizeReviewReceipt(asRecord(sanitizePersistentPayload({ ...receipt, runId: receipt?.runId || runId })));
      if (normalized.runId !== runId) throw new Error(`review receipt runId ${normalized.runId} does not match run ${runId}`);
      if (!this.getRun(runId)) throw new Error(`Run ${runId} not found`);
      const implementerAttempt = normalized.implementerAttemptId
        ? this.getStepAttemptByAttemptId(normalized.implementerAttemptId, { runId })
        : null;
      if (normalized.implementerAttemptId && !implementerAttempt) {
        throw new Error(`review receipt references implementer attempt ${normalized.implementerAttemptId}, which does not belong to run ${runId}`);
      }
      if (implementerAttempt && normalized.stepId && implementerAttempt.stepId !== normalized.stepId) {
        throw new Error(`review receipt step ${normalized.stepId} does not match implementer attempt step ${implementerAttempt.stepId}`);
      }
      const reviewerUsage = normalized.reviewer.usageReceiptId
        ? this.getModelUsageReceipt(normalized.reviewer.usageReceiptId, { runId })
        : null;
      if (reviewerUsage?.stepId && normalized.stepId && reviewerUsage.stepId !== normalized.stepId) {
        throw new Error(`review receipt step ${normalized.stepId} does not match reviewer usage step ${reviewerUsage.stepId || '<legacy>'}`);
      }
      if (reviewerUsage?.bindingId && normalized.reviewerBindingId && reviewerUsage.bindingId !== normalized.reviewerBindingId) {
        throw new Error(`review receipt reviewer binding ${normalized.reviewerBindingId} does not match reviewer usage binding ${reviewerUsage.bindingId || '<missing>'}`);
      }
      const subjectKey = reviewSubjectAdoptionEligible(normalized) ? reviewSubjectKey(normalized) : null;
      return trustPersistence.settleReviewReceipt({
        runId,
        subjectKey,
        receipt: normalized,
        rationale: sanitizePersistentText(normalized.rationale),
      });
    },

    getReviewReceipt(receiptId: string, { runId = null }: { runId?: string | null } = {}) {
      return trustPersistence.getReviewReceipt(receiptId, runId);
    },

    listReviewReceipts(runId: string, { obligationId = null }: { obligationId?: string | null } = {}) {
      return trustPersistence.listReviewReceipts(runId, obligationId);
    },

    // Reviewer independence at T3 is checked against the session that actually
    // implemented, not against a caller-supplied string (§9.2).
    getLatestImplementationSession(runId: string) {
      return hostExecutionPersistence.getLatestImplementationSession(runId);
    },

    // The two-command CLI path has no provider usage receipt for the model
    // that owns and reports the mutation. Its Host-created owner binding is
    // nevertheless durable implementation provenance: every mutating report
    // is preflighted against this exact binding. Use it only as a fallback;
    // a routed implementation receipt remains the stronger authority.
    getImplementationPrincipal(runId: string) {
      const routed = this.getLatestImplementationSession(runId);
      if (routed) return routed;
      const owner = this.getRunOwnerBinding(runId);
      if (!owner?.sessionId || owner.status !== 'active') return null;
      return {
        receiptId: null,
        actorSessionId: `sha256:${createHash('sha256').update(String(owner.sessionId)).digest('hex')}`,
        decisionId: null,
        attemptId: null,
        capsuleId: null,
        capsuleDigest: null,
        resolvedModel: null,
        modelClass: 'owner-session',
        actionKind: 'manual-implementation',
        bindingId: owner.bindingId,
      };
    },

    getDeferredKnowledgeRuns(
      projectId: string,
      { limit = 1, excludeRunId = null, retryableOnly = false }: { limit?: number; excludeRunId?: string | null; retryableOnly?: boolean } = {},
    ) {
      return knowledgeLifecyclePersistence.getDeferredKnowledgeRuns(projectId, {
        limit,
        excludeRunId,
        retryableOnly,
      });
    },

    transition(runId: string, nextState: string, { expectedState, expectedRevision }: { expectedState?: string; expectedRevision?: number } = {}) {
      return db.transaction(() => {
        const run = this.getRun(runId);
        if (!run) throw new Error(`Run ${runId} not found`);
        if (run.status === 'completed') throw new Error(`Cannot transition run ${runId} in completed state`);

        if (expectedState && run.state !== expectedState) {
          throw new Error(`STATE_CONFLICT: Expected state ${expectedState} but found ${run.state} for run ${runId}`);
        }
        if (expectedRevision !== undefined && run.revision !== expectedRevision) {
          throw new Error(`STALE_RUN_REVISION: Expected revision ${expectedRevision} but found ${run.revision} for run ${runId}`);
        }

        if (!canTransition(run.state, nextState)) {
          throw new Error(`Invalid Kernel transition ${run.state} -> ${nextState}`);
        }

        const updated = workLifecyclePersistence.compareAndSetRunState({
          runId,
          expectedState: run.state,
          expectedRevision: run.revision,
          nextState,
        });

        if (!updated) {
          throw new Error(`STATE_CONFLICT: Concurrent state or revision modification for run ${runId}`);
        }

        return this.getRun(runId)!;
      })();
    },

    recordVerification(runId: string, { obligationId = 'default', status, evidenceRef, sourceIdentity, command, commandRef = null, exitCode = 0, evidenceDigest, acceptanceCoverage = [], verifiedSourceIdentity = null, executor = 'caller-attested', networkIsolation = null, evidenceClass = null, evidenceIdentity = null, reuseOfVerificationId = null, reuseReceipt = null }: { obligationId?: string; status: string; evidenceRef: string | null; sourceIdentity?: string; command: string; commandRef?: (string | null) | undefined; exitCode?: (number) | undefined; evidenceDigest: string; acceptanceCoverage?: string[]; verifiedSourceIdentity?: string | null; executor?: string; networkIsolation?: string | null; evidenceClass?: string | null; evidenceIdentity?: UnknownRecord | null; reuseOfVerificationId?: number | null; reuseReceipt?: UnknownRecord | null }) {
      const run = this.getRun(runId);
      if (!run) throw new Error(`Run ${runId} not found`);
      if (run.status === 'completed') throw new Error(`Cannot add verification to completed run ${runId}`);
      if (run.state !== 'PROVE') throw new Error(`Verification can only be recorded in PROVE state for run ${runId}`);
      if (status !== 'passed' && status !== 'failed') throw new Error(`Invalid verification status: ${status}`);
      sourceIdentity = sourceIdentity || run.sourceIdentity;
      if (!sourceIdentity || typeof sourceIdentity !== 'string' || !sourceIdentityRegex.test(sourceIdentity) || sourceIdentity !== run.sourceIdentity) {
        throw new Error('sourceIdentity is required and must be a valid candidate identity string for verification');
      }
      if (verifiedSourceIdentity !== null && !sha256Regex.test(verifiedSourceIdentity)) {
        throw new Error('verifiedSourceIdentity must be a sha256:<hex> workspace identity when provided');
      }
      if (!['kernel-runtime', 'caller-attested'].includes(executor)) {
        throw new Error(`Invalid verification executor: ${executor}`);
      }
      if (executor === 'kernel-runtime' && !verifiedSourceIdentity) {
        throw new Error('kernel-runtime verification requires the verifiedSourceIdentity it was executed against');
      }

      // Obligation binding (P0-2). A declared obligation fixes HOW it may be
      // satisfied; a Kernel execution may only be recorded against it when the
      // command it ran is bound to that obligation. Undeclared obligation names
      // are recorded as ad-hoc evidence that can never satisfy a required one.
      const declared = this.getRunObligation(runId, obligationId);
      const normalizedAcceptanceCoverage = normalizeAcceptanceCoverage({
        contract: run.taskContract || {},
        acceptanceCriteria: run.acceptanceCriteria || [],
        obligation: declared,
        coverage: acceptanceCoverage,
      });
      if (declared && declared.sourceType !== 'ad-hoc' && executor === 'kernel-runtime') {
        assertCommandBinding(declared, commandRef);
      }
      if (!declared) {
        this.ensureRunObligation(runId, {
          obligationId,
          sourceType: 'ad-hoc',
          sourceRef: 'reported-verification',
          evidenceClass: executor === 'kernel-runtime' ? 'hard' : 'attested',
          status: 'optional',
        });
      }
      // The class is a fact about how this evidence was produced, never a
      // caller assertion: only the Kernel running a bound command is `hard`.
      const resolvedEvidenceClass = executor === 'kernel-runtime'
        ? 'hard'
        : (evidenceClass === 'judgment' ? 'judgment' : 'attested');

      trustPersistence.persistVerification({
        runId,
        obligationId,
        status,
        evidenceRef: evidenceRef || null,
        verifiedRuntimeRevision: Number(run.revision),
        verifiedMutationRevision: Number(run.mutationRevision),
        sourceIdentity,
        verifiedSourceIdentity,
        executor,
        networkIsolation,
        commandRef: commandRef || null,
        command: command || null,
        exitCode,
        evidenceDigest: evidenceDigest || null,
        acceptanceCoverage: normalizedAcceptanceCoverage,
        evidenceClass: resolvedEvidenceClass,
        contractRevision: Number(run.contractRevision || 1),
        evidenceIdentity: evidenceIdentity || {},
        reuseOfVerificationId: reuseOfVerificationId || null,
        reuseReceipt: reuseReceipt || null,
      });

      return this.getRun(runId)!;
    },

    recordEvidencePack(runId: string, { tier, pack, digest, mutationRevision }: { tier: string; pack: UnknownRecord; digest: string; mutationRevision: number }) {
      const run = this.getRun(runId);
      if (!run) throw new Error(`Run ${runId} not found`);
      if (!tier || !pack || !digest || !sha256Regex.test(digest) || mutationRevision !== run.mutationRevision) throw new Error('Evidence pack requires a tier, pack, sha256 digest, and current mutation revision');
      if (tier === 'E2' && !Array.isArray(asRecord(pack.qaReport).checks)) throw new Error('E2 release evidence must persist its QA checks');
      trustPersistence.recordEvidencePack({ runId, tier, digest, pack, mutationRevision });
      return { runId, tier, digest, mutationRevision };
    },

    getVerifications(runId: string) {
      return trustPersistence.getVerifications(runId);
    },

    // Review capsules need the complete current-revision evidence trail, not
    // only the latest row per obligation. The completion gate continues to use
    // getVerifications()'s latest-row projection; this history is presentation
    // evidence for an independent reviewer and is never itself authoritative.
    getVerificationHistory(runId: string) {
      return trustPersistence.getVerificationHistory(runId);
    },

    findExactReusableVerification({
      projectId,
      obligationId,
      evidenceIdentity,
      contractRevision = null,
    }: { projectId?: string | null; obligationId?: string; evidenceIdentity?: UnknownRecord; contractRevision?: number | null } = {}) {
      if (!projectId || !obligationId || !evidenceIdentity) return null;
      const candidates = trustPersistence.listReusableVerificationCandidates({
        projectId,
        obligationId,
        contractRevision,
      });
      for (const candidate of candidates) {
        if (exactEvidenceIdentityMatch(candidate.evidenceIdentity, evidenceIdentity)) {
          return candidate;
        }
      }
      return null;
    },

    addWaiver(runId: string, { obligationId, approvedBy, reason, approvalReceipt, acceptanceCoverage = [] }: { obligationId: string; approvedBy: string; reason: string; approvalReceipt: string; acceptanceCoverage?: string[] }) {
      if (!this.getRun(runId)) throw new Error(`Run ${runId} not found`);
      if (!obligationId || !approvedBy || !reason || !approvalReceipt) throw new Error('Waiver requires obligation, approver, reason, and approval receipt');
      if (isProtectedObligation(obligationId)) {
        throw new Error(`PROTECTED_OBLIGATION_WAIVER_FORBIDDEN: ${obligationId} (auth/payment/migration/data-loss/security/core-scenario) requires real evidence and cannot be waived`);
      }
      return trustPersistence.addWaiver({
        runId,
        obligationId,
        approvedBy,
        reason,
        approvalReceipt,
        acceptanceCoverage,
      });
    },

    getWaivers(runId: string) {
      return trustPersistence.getWaivers(runId);
    },

    recordLease(runId: string, { holder, expiresAt, fencingToken, ownerPid = null }: { holder: string; expiresAt: string; fencingToken: number; ownerPid?: number | null }) {
      return workLifecyclePersistence.recordLease({
        runId,
        holder,
        expiresAt,
        fencingToken: Number(fencingToken) || 1,
        ownerPid: Number(ownerPid) || null,
      });
    },

    getLease(runId: string) {
      return workLifecyclePersistence.getLease(runId);
    },

    // Detects a still-valid lease held by a different runner, so a resumed
    // session does not silently stomp another live process's run. Each
    // acquisition mints a monotonically increasing fencing token, so a runner
    // that was superseded while paused can be rejected even if it still holds
    // the same holder string (P0-6).
    acquireLease(runId: string, {
      holder,
      ttlMs = 15 * 60 * 1000,
      currentPid = null,
      isProcessAlive = null,
    }: { holder?: string; ttlMs?: number; currentPid?: number | null; isProcessAlive?: ((pid: number) => boolean) | null } = {}) {
      const existing = this.getLease(runId);
      const nowMs = Date.now();
      const live = Boolean(existing?.expiresAt && Date.parse(existing.expiresAt) > nowMs);
      if (existing && existing.holder !== holder && live) {
        return { acquired: false, lease: existing, conflict: true };
      }
      // Two sessions in the same project share the fallback holder when the
      // host exports no session id. Matching holders are therefore not enough
      // to prove same-owner: a live lease whose owning process is still running
      // and is not us belongs to a genuinely concurrent runner.
      if (existing && existing.holder === holder && live && existing.ownerPid) {
        const sameProcess = Number.isInteger(Number(currentPid))
          && Number(existing.ownerPid) === Number(currentPid);
        const ownerAlive = sameProcess
          ? true
          : (typeof isProcessAlive === 'function'
            ? Boolean(isProcessAlive(Number(existing.ownerPid)))
            : true);
        if (!sameProcess && ownerAlive) {
          return { acquired: false, lease: existing, conflict: true };
        }
      }
      if (!holder) throw new Error('acquireLease requires holder');
      const lease = this.recordLease(runId, {
        holder,
        expiresAt: new Date(nowMs + ttlMs).toISOString(),
        fencingToken: (existing?.fencingToken || 0) + 1,
        ownerPid: Number.isInteger(Number(currentPid)) ? Number(currentPid) : null,
      });
      return { acquired: true, lease, conflict: false };
    },

    // A command that finishes releases its lease, so the next CLI invocation
    // (a new process) is never blocked by a lease its predecessor abandoned.
    releaseLease(runId: string, { holder, fencingToken = null }: { holder?: string; fencingToken?: number | null } = {}) {
      const existing = this.getLease(runId);
      if (!existing || existing.holder !== holder) return false;
      if (fencingToken !== null && existing.fencingToken !== Number(fencingToken)) return false;
      return workLifecyclePersistence.deleteLease(runId, holder);
    },

    // True when the caller still owns the lease it acquired; a superseded
    // holder must not be allowed to finalize.
    isLeaseHeld(runId: string, { holder, fencingToken = null }: { holder?: string; fencingToken?: (number | null) | undefined } = {}) {
      const existing = this.getLease(runId);
      if (!existing) return false;
      if (existing.holder !== holder) return false;
      if (fencingToken !== null && existing.fencingToken !== Number(fencingToken)) return false;
      return Date.parse(existing.expiresAt) > Date.now();
    },

    getEvidenceLineage(runId: string) {
      return trustPersistence.getEvidenceLineage(runId);
    },

    evaluateCompletion(runId: string, { expectedSourceIdentity = null, verificationScopeIdentities = null }: { expectedSourceIdentity?: string | null; verificationScopeIdentities?: Record<string, { status?: string; identity?: string | null; reason?: string | null }> | null } = {}) {
      const run = this.getRun(runId);
      if (!run) {
        return { decision: 'blocked', run: null, verifications: [] };
      }

      const verifications = this.getVerifications(runId);

      const isClosed = Boolean(run.state === 'CLOSE');
      const mutationProvenanceAssessment = assessMutationProvenance({
        run,
        mutationProvenance: this.getMutationProvenance(runId),
      });

      const normalizedCoverageFor = (v: PersistedVerification | null | undefined) => {
        try {
          return normalizeAcceptanceCoverage({
            contract: run.taskContract || {},
            acceptanceCriteria: run.acceptanceCriteria || [],
            obligation: this.getRunObligation(runId, v?.obligationId),
            coverage: v?.acceptanceCoverage || [],
          });
        } catch {
          return null;
        }
      };

      const isVerificationValid = (v: PersistedVerification | null | undefined) => {
        if (!v) return false;
        if (v.status !== 'passed') return false;
        if (Number(v.exitCode) !== 0) return false;
        if (!v.command) return false;
        if (!v.evidenceRef) return false;
        // Historical builds briefly allowed operator approval to mint synthetic
        // executable proof. Preserve those rows for audit, but never let them
        // satisfy a hard-evidence gate during inspection or reevaluation.
        if (v.command === 'operator-override' || String(v.evidenceRef).startsWith('operator-override://')) return false;
        if (!v.evidenceDigest || !sha256Regex.test(v.evidenceDigest)) return false;

        if (!v.sourceIdentity || v.sourceIdentity !== run.sourceIdentity) return false;
        if (expectedSourceIdentity && v.sourceIdentity !== expectedSourceIdentity) return false;

        // A scoped proof is fresh only when the authoritative verification
        // scope still hashes to the same file contents. The full workspace
        // identity may change for an unrelated Step, so it is deliberately not
        // used for this case. Missing scope observations fail closed.
        const scopedDigest = asRecord(v.evidenceIdentity?.values).verificationScopeDigest || null;
        if (scopedDigest) {
          const currentScope = verificationScopeIdentities?.[v.obligationId];
          const currentScopeDigest = typeof currentScope === 'string' ? currentScope : currentScope?.identity;
          if (!currentScopeDigest || currentScopeDigest !== scopedDigest) return false;
        } else {
          const verifiedMutation = v.verifiedMutationRevision ?? v.verifiedRuntimeRevision;
          if (verifiedMutation !== run.mutationRevision) return false;
        }
        if (!scopedDigest && v.verifiedSourceIdentity && run.currentWorkspaceIdentity && v.verifiedSourceIdentity !== run.currentWorkspaceIdentity) {
          // Evidence proven against a different full workspace state is stale.
          return false;
        }

        // A contract revision changes the evidence authority. Proof recorded
        // before a plan/binding revision must be rerun, even when its other
        // receipt fields still look fresh.
        if (Number(v.contractRevision || 1) !== Number(run.contractRevision || 1)) return false;

        // Revalidate the persisted command against the CURRENT obligation. A
        // plan may have narrowed or changed its command after an older proof
        // was written; that older row cannot be reused at finalization. Legacy
        // rows without commandRef are accepted only for broad, non-explicit
        // obligations where the old contract did not specify a command.
        const declared = this.getRunObligation(runId, v.obligationId);
        const explicitCommandBinding = declared?.metadata?.evidencePlanCommandBinding === true;
        if (declared && declared.evidenceClass !== 'judgment') {
          if (explicitCommandBinding && !v.commandRef) return false;
          if (v.commandRef) {
            try {
              assertCommandBinding(declared, v.commandRef);
            } catch {
              return false;
            }
          }
        }

        // Re-derive coverage at completion as well as at write time. This keeps
        // legacy or directly-mutated rows from turning an unrelated passing
        // command into proof for a different acceptance criterion.
        if (normalizedCoverageFor(v) === null) return false;

        return true;
      };

      const requiredObligations = run.requiredObligations.length > 0 ? run.requiredObligations : ['default'];
      const declaredObligations = this.getRunObligations(runId);
      const declaredById = new Map(declaredObligations.map((obligation) => [obligation.obligationId, obligation]));
      const dynamicObligationRows = declaredObligations.filter((obligation) => obligation.status === 'required' && obligation.sourceType !== 'ad-hoc');

      const waivers = this.getWaivers(runId);
      const waivedObligations = new Set(waivers.filter((w) => w.approvalReceipt).map((w) => w.obligationId));
      const latestByObligation = new Map(verifications.map((v) => [v.obligationId, v]));

      // Evidence class is not substitutable (P0-3): a `hard` obligation needs
      // executable evidence, a `judgment` obligation needs a structured
      // verdict, and neither can stand in for the other. A run that actually
      // mutated the workspace tightens `hard` further — only the Kernel
      // executing the bound command counts. A protected obligation can never
      // be waived.
      const runMutatedWorkspace = run.mutationRevision > 0;

      // K0: a judgment that stands in for a protected obligation, or any
      // judgment in a T3 run, must be backed by a Review Receipt whose reviewer
      // lineage and reviewed subject still hold. Two different reviewer strings
      // are not evidence that an independent review happened.
      const reviewLineageFor = (obligationId: string, verification: PersistedVerification, declared: PersistedRunObligation | null | undefined) => {
        const protectedObligation = Boolean(declared?.protected || isProtectedObligation(obligationId));
        const independenceRequired = run.proofTier === 'T3';
        if (!protectedObligation && !independenceRequired) {
          return { required: false, usable: true, receiptId: null, reasons: [] };
        }
        const parsed = parseReviewEvidenceRef(verification?.evidenceRef);
        if (!parsed || parsed.runId !== runId) {
          return { required: true, usable: false, receiptId: null, reasons: ['review-receipt-not-referenced'] };
        }
        const receipt = this.getReviewReceipt(parsed.receiptId, { runId });
        const reasons = [];
        if (receipt) {
          if (receipt.obligationId !== obligationId) reasons.push('review-receipt-obligation-mismatch');
          if (verification.evidenceDigest !== receipt.digest) reasons.push('review-receipt-digest-mismatch');
        }
        const evaluation = evaluateReviewReceipt({
          receipt,
          run,
          requireIndependentSession: independenceRequired,
          requireFrontierClass: independenceRequired,
          requireTrustedEnforcement: true,
          // The verdict must describe the evidence set the run has NOW; a check
          // rerun after the review changes nothing about the workspace.
          currentEvidenceDigest: digestOfEvidence(verifications, { excludeObligationId: obligationId }),
        });
        const allReasons = [...reasons, ...evaluation.reasons];
        return { required: true, usable: allReasons.length === 0, receiptId: parsed.receiptId, reasons: allReasons };
      };

      const obligationSatisfied = (obligationId: string) => {
        const declared = declaredById.get(obligationId);
        const expectedClass = declared?.evidenceClass || 'hard';
        const verification = latestByObligation.get(obligationId);
        if (verification && isVerificationValid(verification)) {
          if (expectedClass === 'judgment') {
            if (verification.evidenceClass === 'judgment') return reviewLineageFor(obligationId, verification, declared).usable;
          } else if (verification.executor === 'kernel-runtime' && verification.evidenceClass === 'hard') {
            return true;
          } else if (!runMutatedWorkspace && verification.evidenceClass !== 'judgment') {
            // Nothing changed, so attested evidence is still an honest record;
            // a judgment verdict is never accepted for an executable obligation.
            return true;
          }
        }
        if (waivedObligations.has(obligationId) && !(declared?.protected || isProtectedObligation(obligationId))) return true;
        return false;
      };

      const obligationStatuses = [...new Set([...requiredObligations, ...dynamicObligationRows.map((row) => row.obligationId)])]
        .map((obligationId) => {
          const declared = declaredById.get(obligationId);
          const verification = latestByObligation.get(obligationId);
          const requiredEvidenceClass = declared?.evidenceClass || 'hard';
          const reviewLineage = requiredEvidenceClass === 'judgment' && verification
            ? reviewLineageFor(obligationId, verification, declared)
            : null;
          return {
            obligationId,
            evidenceLevel: deriveEvidenceLevel(declared),
            requiredEvidenceClass,
            observedEvidenceClass: verification?.evidenceClass || null,
            executor: verification?.executor || null,
            reviewLineage,
            satisfied: obligationSatisfied(obligationId),
            waived: waivedObligations.has(obligationId),
          };
        });

      const staticPassed = requiredObligations.every((ob) => obligationSatisfied(ob));
      const dynamicPassed = dynamicObligationRows.every((row) => row.status === 'passed' || row.status === 'waived' || obligationSatisfied(row.obligationId));

      // Work-level proof may settle one bounded Work Unit, but it cannot by
      // itself close the Goal. Goal completion requires at least one current,
      // non-waived Goal-level verification. Integration-level obligations stay
      // mandatory when declared, but do not substitute for root Goal proof.
      const integrationEvidenceObligations = obligationStatuses.filter((entry) => entry.evidenceLevel === 'integration');
      const requiredIntegrationEvidence = integrationEvidenceObligations.filter((entry) => !entry.waived);
      const integrationEvidenceCount = requiredIntegrationEvidence.filter((entry) => {
        if (!entry.satisfied) return false;
        const verification = latestByObligation.get(entry.obligationId);
        return Boolean(verification && isVerificationValid(verification));
      }).length;
      const integrationEvidenceSatisfied = requiredIntegrationEvidence.length === 0
        || integrationEvidenceCount === requiredIntegrationEvidence.length;
      const goalEvidenceObligations = obligationStatuses.filter((entry) => entry.evidenceLevel === 'goal');
      const requiredGoalEvidence = goalEvidenceObligations.filter((entry) => !entry.waived);
      const goalEvidenceCount = requiredGoalEvidence.filter((entry) => {
        if (!entry.satisfied) return false;
        const verification = latestByObligation.get(entry.obligationId);
        return Boolean(verification && isVerificationValid(verification));
      }).length;
      const goalEvidenceSatisfied = goalEvidenceObligations.length > 0
        && (requiredGoalEvidence.length === 0 || goalEvidenceCount > 0);

      const coveredAcceptance = new Set([
        ...verifications.filter(isVerificationValid).flatMap((v) => normalizedCoverageFor(v) || []),
        ...waivers.flatMap((w) => w.acceptanceCoverage || []),
      ]);
      // Coverage may be declared by acceptance id (AC-1) or by statement.
      const contractAcceptance = Array.isArray(run.taskContract?.acceptance) ? run.taskContract.acceptance : [];
      // Completion must not trust a legacy verification row merely because it
      // contains coverage. The persisted acceptance statement still has to
      // match the current contract, while an explicit evidence plan remains
      // optional and unplanned criteria use the compiled policy obligation.
      const persistedAcceptance = Array.isArray(run.acceptanceCriteria) ? run.acceptanceCriteria : [];
      const evidencePlansComplete = persistedAcceptance.length === 0
        ? true
        : Boolean(run.taskContract)
          && contractAcceptance.length === persistedAcceptance.length
          && contractAcceptance.every((criterion, index) => (
            Boolean(criterion?.statement)
            && criterion.statement === persistedAcceptance[index]
          ));
      const acceptanceCovered = evidencePlansComplete && persistedAcceptance.every((criterion, index) => {
        const declared = contractAcceptance[index];
        return coveredAcceptance.has(criterion) || (declared?.id && coveredAcceptance.has(declared.id));
      });
      const releaseEvidence = trustPersistence.getLatestEvidencePack(runId);

      const releaseEvidencePresent = !run.releaseEvidenceRequired || (releaseEvidence?.tier === 'E2' && releaseEvidence.mutationRevision === run.mutationRevision && sha256Regex.test(releaseEvidence.digest));

      // A run that actually mutated the workspace cannot complete on
      // caller-attested proofs alone; at least one verification must have been
      // executed by the Kernel runtime itself.
      const hardEvidenceRequired = run.mutationRevision > 0;
      const hardEvidenceCount = verifications.filter((v) => isVerificationValid(v) && v.executor === 'kernel-runtime').length;
      const hardEvidenceSatisfied = !hardEvidenceRequired || hardEvidenceCount > 0;

      const requiredLifecycleOutcomes = new Set(run.taskContract?.completionPredicate?.requiredOutcomes || []);
      const outcomesFor = (obligation: PersistedRunObligation | null | undefined) => new Set([
        ...(Array.isArray(obligation?.metadata?.outcomes) ? obligation.metadata.outcomes : []),
        ...(obligation?.metadata?.outcome ? [obligation.metadata.outcome] : []),
      ]);
      const lifecycleOutcomes = [...requiredLifecycleOutcomes].map((outcome) => {
        if (outcome === 'implemented') {
          return { outcome, satisfied: run.mutationRevision > 0, obligationIds: [] };
        }
        const matching = dynamicObligationRows.filter((obligation) => outcomesFor(obligation).has(outcome));
        return {
          outcome,
          satisfied: matching.length > 0 && matching.every((obligation) => obligationSatisfied(obligation.obligationId)),
          obligationIds: matching.map((obligation) => obligation.obligationId),
        };
      });
      const lifecycleOutcomesSatisfied = lifecycleOutcomes.every((outcome) => outcome.satisfied);

      // All completion gates except the CLOSE-state requirement. Callers use
      // this to decide whether it is SAFE to transition to CLOSE, so a run is
      // never closed into an unrecoverable blocked state.
      const mutationProvenanceCurrent = mutationProvenanceAssessment.current;
      const readyExceptClose = staticPassed && dynamicPassed && integrationEvidenceSatisfied && goalEvidenceSatisfied && evidencePlansComplete && acceptanceCovered && releaseEvidencePresent && hardEvidenceSatisfied && lifecycleOutcomesSatisfied && mutationProvenanceCurrent;
      const gates = { isClosed, staticPassed, dynamicPassed, integrationEvidenceSatisfied, goalEvidenceSatisfied, evidencePlansComplete, acceptanceCovered, releaseEvidencePresent, hardEvidenceSatisfied, lifecycleOutcomesSatisfied, mutationProvenanceCurrent };
      const unsatisfiedObligations = obligationStatuses.filter((entry) => !entry.satisfied);

      const accepted = isClosed && readyExceptClose;

      const decision = accepted ? 'accepted' : 'blocked';
      // A run that leaned on any waiver to pass is completed but degraded
      // (§17.5), never silently clean.
      const completionQuality = accepted && waivers.length > 0 ? 'degraded' : (accepted ? 'clean' : 'none');
      const decisionPayload = {
        runId,
        decision,
        completionQuality,
        sourceIdentity: run.sourceIdentity,
        currentWorkspaceIdentity: run.currentWorkspaceIdentity,
        mutationRevision: run.mutationRevision,
        hardEvidence: { required: hardEvidenceRequired, count: hardEvidenceCount },
        integrationEvidence: { required: integrationEvidenceObligations.length > 0, count: integrationEvidenceCount },
        goalEvidence: { required: goalEvidenceObligations.length > 0, count: goalEvidenceCount },
        lifecycleOutcomes,
        evidenceDigest: releaseEvidence?.digest || verifications[0]?.evidenceDigest || `sha256:${'0'.repeat(64)}`,
        verifications,
      };
      const decisionDigest = `sha256:${createHash('sha256').update(JSON.stringify(decisionPayload)).digest('hex')}`;

      return {
        decision,
        completionQuality,
        digest: decisionDigest,
        run,
        verifications,
        waivers,
        releaseEvidence: releaseEvidence || null,
        evidencePlansComplete,
        acceptanceCovered: [...coveredAcceptance],
        hardEvidence: { required: hardEvidenceRequired, count: hardEvidenceCount },
        integrationEvidence: { required: integrationEvidenceObligations.length > 0, count: integrationEvidenceCount },
        goalEvidence: { required: goalEvidenceObligations.length > 0, count: goalEvidenceCount },
        lifecycleOutcomes,
        obligationStatuses,
        unsatisfiedObligations,
        gates,
        readyExceptClose,
        decisionPayload,
      };
    },

    persistCompletionDecision(runId: string, evaluation: CompletionEvaluation) {
      if (!evaluation || !evaluation.run) {
        throw new Error(`Cannot persist completion decision for missing evaluation/run: ${runId}`);
      }
      const { decision, digest, run, decisionPayload } = evaluation;
      return db.transaction(() => {
        trustPersistence.recordCompletionDecision({
          runId,
          decision,
          sourceIdentity: run.sourceIdentity,
          mutationRevision: run.mutationRevision,
          evidenceDigest: digest,
          decisionJson: { ...(decisionPayload || {}), digest },
        });

        workLifecyclePersistence.updateRunLifecycle({
          runId,
          status: decision === 'accepted' ? 'completed' : 'blocked',
          incrementRevision: true,
        });

        reconcileTerminalLifecycleInTransaction({ projectId: run.projectId, runId });

        return this.getRun(runId)!;
      })();
    },

    assessCompletion(runId: string, options: UnknownRecord = {}) {
      return this.evaluateCompletion(runId, options);
    },


    close() {
      db.close();
    },
  };

  return store;
  } catch (error) {
    try { db.close(); } catch { /* A guarded migration may already have closed it. */ }
    throw error;
  }
};
