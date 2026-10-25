import type { SqliteDatabase } from '../sqlite-adapter.js';

export interface PersistedRunLease {
  runId: string;
  holder: string;
  acquiredAt: string;
  expiresAt: string;
  fencingToken: number;
  ownerPid: number | null;
}

export interface PersistRunLeaseInput {
  runId: string;
  holder: string;
  expiresAt: string;
  fencingToken: number;
  ownerPid: number | null;
}

export interface PersistedWorktreeMutationLease {
  worktreeId: string;
  projectId: string;
  holderRunId: string;
  acquiredAt: string;
}

export interface WorktreeMutationLeaseWithStatus extends PersistedWorktreeMutationLease {
  runStatus: string | null;
}

export interface PersistedWorkspaceMutationLock {
  workspaceId: string;
  projectId: string;
  holderRunId: string;
  sessionToken: string;
  fencingToken: number;
  acquiredAt: string;
  expiresAt: string;
}

export interface RunLifecycleIdentity {
  runId: string;
  projectId: string | null;
  worktreeId: string | null;
  workspaceId: string | null;
  ownerBindingId: string | null;
  status: string;
}

export interface RunInitializationIdentity extends RunLifecycleIdentity {
  sourceIdentity: string;
  mutationRevision: number;
}

export interface PersistedRunRecord {
  runId: string;
  objective: string;
  state: string;
  status: string;
  revision: number;
  mutationRevision: number;
  sourceIdentity: string;
  runStartGitCommitSha: string | null;
  runStartWorkspaceIdentity: string | null;
  currentWorkspaceIdentity: string | null;
  blockedReason: string | null;
  blockingClass: string | null;
  interventionCount: number | null;
  projectMode: string | null;
  baselineFailures: string | null;
  baselineStatus: string | null;
  replanCount: number | null;
  proofTier: string;
  evidenceTier: string;
  requiredObligations: string | null;
  acceptanceCriteria: string | null;
  releaseEvidenceRequired: number | boolean;
  projectId: string | null;
  knowledgeRevisionStart: string | null;
  knowledgeRevisionClose: string | null;
  knowledgeStatus: string | null;
  contextPackRef: string | null;
  baselineChangedPaths: string | null;
  baselineWorkspaceEntries: string | null;
  reportBaselineChangedPaths: string | null;
  reportBaselineWorkspaceEntries: string | null;
  workspaceBaselineStatus: string | null;
  taskContractJson: string | null;
  contractRevision: number | null;
  finalizationStatus: string | null;
  routeJson: string | null;
  implementationContextJson: string | null;
  planRevision: number | null;
  workspaceId: string | null;
  worktreeId: string | null;
  ownerBindingId: string | null;
  successorKey: string | null;
  runSignalsJson: string | null;
  updatedAt: string;
}

export interface PersistRunInput {
  runId: string;
  objective: string;
  sourceIdentity: string;
  runStartGitCommitSha: string | null;
  workspaceIdentity: string | null;
  projectMode: string | null;
  proofTier: string;
  evidenceTier: string;
  requiredObligationsJson: string;
  acceptanceCriteriaJson: string;
  requireReleaseEvidence: boolean;
  projectId: string | null;
  knowledgeRevisionStart: string | null;
  taskContractJson: string | null;
  contractRevision: number;
  routeJson: string | null;
  implementationContextJson: string | null;
  workspaceId: string | null;
  worktreeId: string | null;
  baselineChangedPathsJson: string;
  baselineWorkspaceEntriesJson: string;
  workspaceBaselineChangedPathsJson: string;
  workspaceBaselineEntriesJson: string;
  workspaceBaselineStatus: string;
  ownerBindingId: string | null;
  successorKey: string | null;
}

export interface RunQuery {
  projectId?: string | null;
  worktreeId?: string | null;
  workspaceId?: string | null;
  statuses?: string[] | null;
}

export interface StaleRunDiagnostic {
  runId: string;
  projectId: string | null;
  workspaceId: string | null;
  state: string;
  updatedAt: string;
  attemptCount: number;
  capsuleCount: number;
  verificationCount: number;
  completionReceiptCount: number;
  readyStepCount: number;
}

export interface ProjectRunCounts {
  completedRuns: number;
  mutationRuns: number;
}

export interface PersistedProjectWorkspace {
  workspaceId: string;
  projectId: string;
  canonicalRoot: string;
  gitCommonDir: string | null;
  gitWorktreeDir: string | null;
  worktreeId: string | null;
  identityJson: string;
  createdAt: string;
  lastSeenAt: string;
}

export interface PersistedSessionBinding {
  bindingId: string;
  sessionId: string;
  provider: string;
  surface: string | null;
  runId: string;
  projectId: string;
  workspaceId: string | null;
  workspaceRoot: string | null;
  accessMode: string;
  status: string;
  createdAt: string;
  expiresAt: string | null;
  closedAt: string | null;
  closeReason: string | null;
  successorRunId: string | null;
  updatedAt: string;
}

export interface SessionBindingQuery {
  bindingId?: string | null;
  projectId?: string | null;
  sessionId?: string | null;
  runId?: string | null;
  workspaceId?: string | null;
  successorRunId?: string | null;
  accessMode?: string | null;
  status?: string | null;
  limit?: number | null;
}

export interface SessionBindingUpdate {
  sessionId?: string;
  provider?: string;
  surface?: string | null;
  workspaceId?: string | null;
  workspaceRoot?: string | null;
  accessMode?: string;
  status?: string;
  expiresAt?: string | null;
  closedAt?: string | null;
  closeReason?: string | null;
  successorRunId?: string | null;
  updatedAt?: string;
}

export interface WorkLifecyclePersistence {
  recordLease(input: PersistRunLeaseInput): PersistedRunLease;
  getLease(runId: string): PersistedRunLease | null;
  deleteLease(runId: string, holder: string): boolean;
  getRunLifecycleIdentity(runId: string): RunLifecycleIdentity | null;
  getRunRecord(runId: string): PersistedRunRecord | null;
  getRunRecordBySuccessorKey(successorKey: string): PersistedRunRecord | null;
  getRunInitializationIdentity(runId: string): RunInitializationIdentity | null;
  insertRun(input: PersistRunInput): void;
  rollbackRunInitialization(input: {
    runId: string;
    projectId?: string | null;
    sourceIdentity?: string | null;
  }): { status: 'not-found' | 'rolled-back'; runId: string; rolledBack: boolean };
  listRunIds(query?: RunQuery): string[];
  listStaleRunDiagnostics(input: {
    staleBefore: string;
    projectId?: string | null;
  }): StaleRunDiagnostic[];
  getProjectRunCounts(projectId: string): ProjectRunCounts;
  getProjectWorkspaceRecord(workspaceId: string): PersistedProjectWorkspace | null;
  listProjectWorkspaceRecords(projectId: string): PersistedProjectWorkspace[];
  listRunWorkspaceIds(projectId: string): string[];
  hasRunForProjectCanonicalRoot(input: {
    projectId: string;
    canonicalRoot: string;
  }): boolean;
  upsertProjectWorkspaceRecord(input: PersistedProjectWorkspace): void;
  deleteProjectWorkspaceRecord(workspaceId: string): boolean;
  mergeProjectWorkspaceReferences(input: {
    sourceWorkspaceId: string;
    targetWorkspaceId: string;
    canonicalRoot: string;
    withinTransaction?: boolean;
  }): {
    updatedReferences: number;
    updatedBindings: number;
    deletedWorkspace: boolean;
  };
  backfillRunWorktreeId(input: {
    projectId: string;
    workspaceId: string;
    worktreeId: string;
  }): number;
  rebindRunWorktreeId(input: {
    projectId: string;
    workspaceId: string;
    worktreeId: string;
  }): number;
  getWorktreeMutationLease(worktreeId: string): PersistedWorktreeMutationLease | null;
  listWorktreeMutationLeases(input?: {
    projectId?: string | null;
    runId?: string | null;
  }): WorktreeMutationLeaseWithStatus[];
  insertWorktreeMutationLease(input: {
    worktreeId: string;
    projectId: string;
    runId: string;
  }): PersistedWorktreeMutationLease;
  deleteWorktreeMutationLease(input: {
    worktreeId: string;
    runId: string;
    projectId?: string | null;
  }): boolean;
  rebindWorktreeMutationLease(input: {
    worktreeId: string;
    nextWorktreeId: string;
    fromProjectId: string;
    toProjectId: string;
    runId: string;
  }): number;
  getWorkspaceMutationLockV2(workspaceId: string): PersistedWorkspaceMutationLock | null;
  listWorkspaceMutationLocksV2(input?: {
    projectId?: string | null;
  }): PersistedWorkspaceMutationLock[];
  getSessionBinding(bindingId: string): PersistedSessionBinding | null;
  listSessionBindings(query?: SessionBindingQuery): PersistedSessionBinding[];
  insertSessionBinding(input: PersistedSessionBinding): PersistedSessionBinding;
  updateSessionBinding(input: {
    bindingId: string;
    expected?: {
      projectId?: string | null;
      sessionId?: string | null;
      runId?: string | null;
      provider?: string | null;
      status?: string | null;
      accessMode?: string | null;
    };
    changes: SessionBindingUpdate;
  }): boolean;
  updateRunLifecycle(input: {
    runId: string;
    expectedStatus?: string | null;
    expectedOwnerBindingId?: string | null;
    status?: string;
    blockedReason?: string | null;
    blockingClass?: string | null;
    incrementIntervention?: boolean;
    incrementRevision?: boolean;
    updatedAt?: string;
  }): boolean;
  persistRunTaskContract(input: {
    runId: string;
    taskContractJson: string;
    contractRevision: number;
    acceptanceCriteriaJson: string;
    requiredObligationsJson?: string;
  }): boolean;
  updateRunWorkspaceIdentity(input: {
    runId: string;
    identity: string;
    incrementMutation: boolean;
  }): boolean;
  updateRunWorkspaceBaseline(input: {
    runId: string;
    changedPathsJson: string;
    entriesJson: string;
  }): boolean;
  compareAndSetRunState(input: {
    runId: string;
    expectedState: string;
    expectedRevision: number;
    nextState: string;
  }): boolean;
  compareAndSetRunWorkspaceIdentity(input: {
    runId: string;
    identity: string;
    expectedMutationRevision: number;
    expectedWorkspaceIdentity: string;
  }): boolean;
  setRunSignals(runId: string, runSignalsJson: string, updatedAt?: string): boolean;
  listProjectRunSignals(input: {
    projectId: string;
    excludeRunId?: string | null;
  }): Array<{ runId: string; runSignalsJson: string }>;
  compareAndSetRunOwnerBinding(input: {
    runId: string;
    projectId: string;
    expectedBindingId: string | null;
    bindingId: string | null;
    workspaceId?: string | null;
  }): boolean;
  getWorkspaceMutationEpoch(workspaceId: string): number;
  setWorkspaceMutationEpoch(workspaceId: string, fencingToken: number): boolean;
  upsertWorkspaceMutationLockV2(input: PersistedWorkspaceMutationLock): PersistedWorkspaceMutationLock;
  renewWorkspaceMutationLockV2(input: {
    workspaceId: string;
    projectId: string;
    runId: string;
    sessionToken: string;
    fencingToken: number;
    expiresAt: string;
    observedAt: string;
  }): boolean;
  deleteWorkspaceMutationLockV2(input: {
    workspaceId: string;
    projectId?: string | null;
    runId?: string | null;
    sessionToken?: string | null;
    fencingToken?: number | null;
    expiresAt?: string | null;
  }): boolean;
}

interface ChangeResult {
  changes?: number;
}

interface LeaseRow {
  runId: string;
  holder: string;
  acquiredAt: string;
  expiresAt: string;
  fencingToken: number | string | null;
  ownerPid: number | string | null;
}

interface WorktreeMutationLeaseRow {
  worktreeId: string;
  projectId: string;
  holderRunId: string;
  acquiredAt: string;
  runStatus?: string | null;
}

interface RunLifecycleRow {
  runId: string;
  projectId: string | null;
  worktreeId: string | null;
  workspaceId: string | null;
  ownerBindingId: string | null;
  status: string;
}

interface SessionBindingRow {
  binding_id: string;
  session_id: string;
  provider: string;
  surface: string | null;
  run_id: string;
  project_id: string;
  workspace_id: string | null;
  workspace_root: string | null;
  access_mode: string;
  status: string;
  created_at: string;
  expires_at: string | null;
  closed_at: string | null;
  close_reason: string | null;
  successor_run_id: string | null;
  updated_at: string;
}

interface WorkspaceMutationLockRow {
  workspaceId: string;
  projectId: string;
  holderRunId: string;
  sessionToken: string;
  fencingToken: number | string;
  acquiredAt: string;
  expiresAt: string;
}

const normalizeLease = (row: LeaseRow): PersistedRunLease => ({
  ...row,
  fencingToken: Number(row.fencingToken || 0),
  ownerPid: row.ownerPid ? Number(row.ownerPid) : null,
});

const normalizeWorkspaceMutationLock = (
  row: WorkspaceMutationLockRow,
): PersistedWorkspaceMutationLock => ({
  ...row,
  fencingToken: Number(row.fencingToken || 0),
});

const mapSessionBinding = (row: SessionBindingRow): PersistedSessionBinding => ({
  bindingId: row.binding_id,
  sessionId: row.session_id,
  provider: row.provider,
  surface: row.surface,
  runId: row.run_id,
  projectId: row.project_id,
  workspaceId: row.workspace_id,
  workspaceRoot: row.workspace_root,
  accessMode: row.access_mode,
  status: row.status,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
  closedAt: row.closed_at,
  closeReason: row.close_reason,
  successorRunId: row.successor_run_id,
  updatedAt: row.updated_at,
});

const quoteIdentifier = (value: string): string => (
  `"${String(value).replaceAll('"', '""')}"`
);

export const createWorkLifecyclePersistence = ({
  db,
  now = () => new Date().toISOString(),
}: {
  db: SqliteDatabase;
  now?: () => string;
}): WorkLifecyclePersistence => {
  const getLease: WorkLifecyclePersistence['getLease'] = (runId) => {
    const row = db.prepare(`
      SELECT run_id as runId, holder, acquired_at as acquiredAt,
        expires_at as expiresAt, fencing_token as fencingToken, owner_pid as ownerPid
      FROM leases
      WHERE run_id=?
    `).get(runId) as LeaseRow | undefined;
    return row ? normalizeLease(row) : null;
  };

  const getRunLifecycleIdentity: WorkLifecyclePersistence['getRunLifecycleIdentity'] = (runId) => {
    const row = db.prepare(`
      SELECT run_id AS runId, project_id AS projectId, worktree_id AS worktreeId,
        workspace_id AS workspaceId, owner_binding_id AS ownerBindingId, status
      FROM runs
      WHERE run_id=?
    `).get(runId) as RunLifecycleRow | undefined;
    return row ?? null;
  };

  const runRecordSelect = `
    SELECT run_id as runId, objective, state, status, revision,
      mutation_revision as mutationRevision, source_identity as sourceIdentity,
      run_start_git_commit_sha as runStartGitCommitSha,
      run_start_workspace_identity as runStartWorkspaceIdentity,
      current_workspace_identity as currentWorkspaceIdentity,
      blocked_reason as blockedReason, blocking_class as blockingClass,
      intervention_count as interventionCount, project_mode as projectMode,
      baseline_failures as baselineFailures, baseline_status as baselineStatus,
      replan_count as replanCount, proof_tier as proofTier,
      evidence_tier as evidenceTier, required_obligations as requiredObligations,
      acceptance_criteria as acceptanceCriteria,
      release_evidence_required as releaseEvidenceRequired,
      project_id as projectId, knowledge_revision_start as knowledgeRevisionStart,
      knowledge_revision_close as knowledgeRevisionClose,
      knowledge_status as knowledgeStatus, context_pack_ref as contextPackRef,
      baseline_changed_paths as baselineChangedPaths,
      baseline_workspace_entries as baselineWorkspaceEntries,
      workspace_baseline_changed_paths as reportBaselineChangedPaths,
      workspace_baseline_entries as reportBaselineWorkspaceEntries,
      workspace_baseline_status as workspaceBaselineStatus,
      task_contract_json as taskContractJson,
      contract_revision as contractRevision,
      finalization_status as finalizationStatus,
      route_json as routeJson,
      implementation_context_json as implementationContextJson,
      plan_revision as planRevision, workspace_id as workspaceId,
      worktree_id as worktreeId, owner_binding_id as ownerBindingId,
      successor_key as successorKey, run_signals_json as runSignalsJson,
      updated_at as updatedAt
    FROM runs
  `;

  const selectRunRecord = (
    column: 'run_id' | 'successor_key',
    value: string,
  ): PersistedRunRecord | null => {
    const row = db.prepare(
      `${runRecordSelect} WHERE ${column}=?`,
    ).get(value) as PersistedRunRecord | undefined;
    return row ?? null;
  };

  const getRunRecord: WorkLifecyclePersistence['getRunRecord'] = (runId) => (
    selectRunRecord('run_id', runId)
  );

  const getRunRecordBySuccessorKey:
    WorkLifecyclePersistence['getRunRecordBySuccessorKey'] = (successorKey) => (
      selectRunRecord('successor_key', successorKey)
    );

  const getRunInitializationIdentity:
    WorkLifecyclePersistence['getRunInitializationIdentity'] = (runId) => {
      const row = db.prepare(`
        SELECT run_id AS runId, project_id AS projectId, worktree_id AS worktreeId,
          workspace_id AS workspaceId, owner_binding_id AS ownerBindingId, status,
          source_identity AS sourceIdentity, mutation_revision AS mutationRevision
        FROM runs
        WHERE run_id=?
      `).get(runId) as (RunLifecycleRow & {
        sourceIdentity: string;
        mutationRevision: number | string;
      }) | undefined;
      return row
        ? {
            ...row,
            mutationRevision: Number(row.mutationRevision || 0),
          }
        : null;
    };

  const listRunIds: WorkLifecyclePersistence['listRunIds'] = ({
    projectId = null,
    worktreeId = null,
    workspaceId = null,
    statuses = null,
  } = {}) => {
    const clauses: string[] = [];
    const values: string[] = [];
    if (projectId) {
      clauses.push('project_id=?');
      values.push(projectId);
    }
    if (worktreeId) {
      clauses.push('worktree_id=?');
      values.push(worktreeId);
    } else if (workspaceId) {
      clauses.push('workspace_id=?');
      values.push(workspaceId);
    }
    if (Array.isArray(statuses) && statuses.length > 0) {
      clauses.push(`status IN (${statuses.map(() => '?').join(',')})`);
      values.push(...statuses.map(String));
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = db.prepare(
      `SELECT run_id AS runId FROM runs ${where} ORDER BY updated_at DESC`,
    ).all(...values) as Array<{ runId: string }>;
    return rows.map((row) => row.runId);
  };

  const listStaleRunDiagnostics:
    WorkLifecyclePersistence['listStaleRunDiagnostics'] = ({
      staleBefore,
      projectId = null,
    }) => {
      const projectClause = projectId ? 'AND r.project_id=?' : '';
      const values = projectId ? [staleBefore, projectId] : [staleBefore];
      const rows = db.prepare(`
        SELECT r.run_id as runId, r.project_id as projectId,
          r.workspace_id as workspaceId, r.state, r.updated_at as updatedAt,
          (SELECT COUNT(*) FROM run_step_attempts a WHERE a.run_id=r.run_id) as attemptCount,
          (SELECT COUNT(*) FROM run_capsules c WHERE c.run_id=r.run_id) as capsuleCount,
          (SELECT COUNT(*) FROM verifications v WHERE v.run_id=r.run_id) as verificationCount,
          (SELECT COUNT(*) FROM completion_decisions d WHERE d.run_id=r.run_id) as completionReceiptCount,
          (SELECT COUNT(*) FROM run_steps s WHERE s.run_id=r.run_id AND s.state='ready') as readyStepCount
        FROM runs r
        WHERE r.status='active' AND r.updated_at<=?
          ${projectClause}
      `).all(...values) as Array<{
        runId: string;
        projectId: string | null;
        workspaceId: string | null;
        state: string;
        updatedAt: string;
        attemptCount: number | string | null;
        capsuleCount: number | string | null;
        verificationCount: number | string | null;
        completionReceiptCount: number | string | null;
        readyStepCount: number | string | null;
      }>;
      return rows.map((row) => ({
        runId: row.runId,
        projectId: row.projectId,
        workspaceId: row.workspaceId,
        state: row.state,
        updatedAt: row.updatedAt,
        attemptCount: Number(row.attemptCount || 0),
        capsuleCount: Number(row.capsuleCount || 0),
        verificationCount: Number(row.verificationCount || 0),
        completionReceiptCount: Number(row.completionReceiptCount || 0),
        readyStepCount: Number(row.readyStepCount || 0),
      }));
    };

  const getProjectRunCounts:
    WorkLifecyclePersistence['getProjectRunCounts'] = (projectId) => {
      const completed = db.prepare(
        "SELECT COUNT(*) as count FROM runs WHERE project_id=? AND status='completed'",
      ).get(projectId) as { count?: number | string | null } | undefined;
      const mutated = db.prepare(
        "SELECT COUNT(*) as count FROM runs WHERE project_id=? AND status='completed' AND mutation_revision>0",
      ).get(projectId) as { count?: number | string | null } | undefined;
      return {
        completedRuns: Number(completed?.count || 0),
        mutationRuns: Number(mutated?.count || 0),
      };
    };

  const getProjectWorkspaceRecord:
    WorkLifecyclePersistence['getProjectWorkspaceRecord'] = (workspaceId) => {
      const row = db.prepare(`
        SELECT workspace_id as workspaceId, project_id as projectId,
          canonical_root as canonicalRoot, git_common_dir as gitCommonDir,
          git_worktree_dir as gitWorktreeDir, worktree_id as worktreeId,
          identity_json as identityJson, created_at as createdAt,
          last_seen_at as lastSeenAt
        FROM project_workspaces
        WHERE workspace_id=?
      `).get(workspaceId) as PersistedProjectWorkspace | undefined;
      return row ?? null;
    };

  const listProjectWorkspaceRecords:
    WorkLifecyclePersistence['listProjectWorkspaceRecords'] = (projectId) => (
      db.prepare(`
        SELECT workspace_id as workspaceId, project_id as projectId,
          canonical_root as canonicalRoot, git_common_dir as gitCommonDir,
          git_worktree_dir as gitWorktreeDir, worktree_id as worktreeId,
          identity_json as identityJson, created_at as createdAt,
          last_seen_at as lastSeenAt
        FROM project_workspaces
        WHERE project_id=?
        ORDER BY created_at, workspace_id
      `).all(projectId) as PersistedProjectWorkspace[]
    );

  const listRunWorkspaceIds:
    WorkLifecyclePersistence['listRunWorkspaceIds'] = (projectId) => {
      const rows = db.prepare(`
        SELECT workspace_id as workspaceId
        FROM runs
        WHERE project_id=? AND workspace_id IS NOT NULL
      `).all(projectId) as Array<{ workspaceId: string }>;
      return rows.map((row) => row.workspaceId);
    };

  const hasRunForProjectCanonicalRoot:
    WorkLifecyclePersistence['hasRunForProjectCanonicalRoot'] = ({
      projectId,
      canonicalRoot,
    }) => Boolean(db.prepare(`
      SELECT 1
      FROM runs r
      JOIN project_workspaces w ON w.workspace_id=r.workspace_id
      WHERE r.project_id=? AND w.canonical_root=?
      LIMIT 1
    `).get(projectId, canonicalRoot));

  const getWorktreeMutationLease:
    WorkLifecyclePersistence['getWorktreeMutationLease'] = (worktreeId) => {
      const row = db.prepare(`
        SELECT worktree_id AS worktreeId, project_id AS projectId,
          holder_run_id AS holderRunId, acquired_at AS acquiredAt
        FROM worktree_mutation_leases
        WHERE worktree_id=?
      `).get(worktreeId) as WorktreeMutationLeaseRow | undefined;
      return row ?? null;
    };

  const getWorkspaceMutationLockV2:
    WorkLifecyclePersistence['getWorkspaceMutationLockV2'] = (workspaceId) => {
      const row = db.prepare(`
        SELECT workspace_id AS workspaceId, project_id AS projectId,
          holder_run_id AS holderRunId, session_token AS sessionToken,
          fencing_token AS fencingToken, acquired_at AS acquiredAt,
          expires_at AS expiresAt
        FROM workspace_mutation_locks_v2
        WHERE workspace_id=?
      `).get(workspaceId) as WorkspaceMutationLockRow | undefined;
      return row ? normalizeWorkspaceMutationLock(row) : null;
    };

  const listSessionBindings: WorkLifecyclePersistence['listSessionBindings'] = (query = {}) => {
    const clauses: string[] = [];
    const values: string[] = [];
    const add = (column: string, value: string | null | undefined) => {
      if (value === null || value === undefined || value === '') return;
      clauses.push(`${column}=?`);
      values.push(String(value));
    };
    add('binding_id', query.bindingId);
    add('project_id', query.projectId);
    add('session_id', query.sessionId);
    add('run_id', query.runId);
    add('workspace_id', query.workspaceId);
    add('successor_run_id', query.successorRunId);
    add('access_mode', query.accessMode);
    add('status', query.status);
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Number.isInteger(Number(query.limit)) && Number(query.limit) > 0
      ? `LIMIT ${Number(query.limit)}`
      : '';
    const rows = db.prepare(`
      SELECT *
      FROM session_bindings
      ${where}
      ORDER BY updated_at DESC
      ${limit}
    `).all(...values) as SessionBindingRow[];
    return rows.map(mapSessionBinding);
  };

  const getSessionBinding: WorkLifecyclePersistence['getSessionBinding'] = (bindingId) => (
    listSessionBindings({ bindingId, limit: 1 })[0] ?? null
  );

  return {
    recordLease({ runId, holder, expiresAt, fencingToken, ownerPid }) {
      const run = db.prepare('SELECT 1 as present FROM runs WHERE run_id=?').get(runId);
      if (!run) throw new Error(`Run ${runId} not found`);
      db.prepare(`
        INSERT INTO leases(
          run_id, holder, acquired_at, expires_at, fencing_token, owner_pid
        )
        VALUES(?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET
          holder=excluded.holder,
          acquired_at=excluded.acquired_at,
          expires_at=excluded.expires_at,
          fencing_token=excluded.fencing_token,
          owner_pid=excluded.owner_pid
      `).run(
        runId,
        holder,
        now(),
        expiresAt,
        Number(fencingToken) || 1,
        ownerPid === null ? null : Number(ownerPid),
      );
      const lease = getLease(runId);
      if (!lease) throw new Error(`Run lease ${runId} was not persisted`);
      return lease;
    },

    getLease,

    deleteLease(runId, holder) {
      const result = db.prepare(
        'DELETE FROM leases WHERE run_id=? AND holder=?',
      ).run(runId, holder) as ChangeResult;
      return Number(result.changes || 0) === 1;
    },

    getRunLifecycleIdentity,

    getRunRecord,

    getRunRecordBySuccessorKey,

    getRunInitializationIdentity,

    insertRun(input) {
      db.prepare(`
        INSERT INTO runs(
          run_id, objective, state, status, revision, mutation_revision,
          source_identity, run_start_git_commit_sha, run_start_workspace_identity, current_workspace_identity,
          project_mode, proof_tier, evidence_tier, required_obligations,
          acceptance_criteria, release_evidence_required, project_id,
          knowledge_revision_start, knowledge_status, task_contract_json,
          contract_revision, finalization_status, route_json,
          implementation_context_json, workspace_id, worktree_id,
          baseline_changed_paths, baseline_workspace_entries,
          workspace_baseline_changed_paths, workspace_baseline_entries,
          workspace_baseline_status, owner_binding_id, successor_key, updated_at
        )
        VALUES(
          ?, ?, 'FRAME', 'active', 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          'active', ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )
      `).run(
        input.runId,
        input.objective,
        input.sourceIdentity,
        input.runStartGitCommitSha,
        input.workspaceIdentity,
        input.workspaceIdentity,
        input.projectMode,
        input.proofTier,
        input.evidenceTier,
        input.requiredObligationsJson,
        input.acceptanceCriteriaJson,
        input.requireReleaseEvidence ? 1 : 0,
        input.projectId,
        input.knowledgeRevisionStart,
        input.taskContractJson,
        Number(input.contractRevision) || 1,
        input.routeJson,
        input.implementationContextJson,
        input.workspaceId,
        input.worktreeId,
        input.baselineChangedPathsJson,
        input.baselineWorkspaceEntriesJson,
        input.workspaceBaselineChangedPathsJson,
        input.workspaceBaselineEntriesJson,
        input.workspaceBaselineStatus,
        input.ownerBindingId,
        input.successorKey,
        now(),
      );
    },

    rollbackRunInitialization({ runId, projectId = null, sourceIdentity = null }) {
      const run = getRunInitializationIdentity(runId);
      if (!run) return { status: 'not-found', runId, rolledBack: false };
      if (projectId && run.projectId !== projectId) {
        throw Object.assign(new Error('run_project_mismatch'), {
          code: 'run_project_mismatch',
          errorCode: 'run_project_mismatch',
        });
      }
      if (sourceIdentity && run.sourceIdentity !== sourceIdentity) {
        throw Object.assign(new Error('run_source_identity_mismatch'), {
          code: 'run_source_identity_mismatch',
          errorCode: 'run_source_identity_mismatch',
        });
      }
      if (!['active', 'blocked'].includes(run.status) || run.mutationRevision !== 0) {
        throw Object.assign(new Error('run_initialization_rollback_not_safe'), {
          code: 'run_initialization_rollback_not_safe',
          errorCode: 'run_initialization_rollback_not_safe',
          nextAction: 'preserve-run-and-resolve-lifecycle-state',
          details: {
            runId,
            status: run.status,
            mutationRevision: run.mutationRevision,
          },
        });
      }

      const tableRows = db.prepare(`
        SELECT name FROM sqlite_master
        WHERE type='table' AND name NOT LIKE 'sqlite_%'
      `).all() as Array<{ name: string }>;
      const tables = tableRows
        .map((row) => row.name)
        .filter((name) => name !== 'runs' && name !== 'run_journal')
        .map((name) => {
          const quoted = quoteIdentifier(name);
          const columns = db.prepare(`PRAGMA table_info(${quoted})`).all() as Array<{ name: string }>;
          const references = db.prepare(`PRAGMA foreign_key_list(${quoted})`).all() as Array<{ table: string }>;
          return {
            name,
            hasRunId: columns.some((column) => column.name === 'run_id'),
            hasHolderRunId: columns.some((column) => column.name === 'holder_run_id'),
            references: references.map((foreignKey) => foreignKey.table),
          };
        })
        .filter((table) => table.hasRunId || table.hasHolderRunId);

      const pending = new Map(tables.map((table) => [table.name, table]));
      while (pending.size > 0) {
        const deletable = [...pending.values()].find((candidate) => (
          ![...pending.values()].some(
            (other) => other.name !== candidate.name && other.references.includes(candidate.name),
          )
        ));
        const table = deletable || pending.values().next().value;
        if (!table) break;
        const clauses: string[] = [];
        const values: string[] = [];
        if (table.hasRunId) {
          clauses.push('run_id=?');
          values.push(runId);
        }
        if (table.hasHolderRunId) {
          clauses.push('holder_run_id=?');
          values.push(runId);
        }
        db.prepare(
          `DELETE FROM ${quoteIdentifier(table.name)} WHERE ${clauses.join(' OR ')}`,
        ).run(...values);
        pending.delete(table.name);
      }

      const deleted = db.prepare(
        "DELETE FROM runs WHERE run_id=? AND status IN ('active', 'blocked') AND mutation_revision=0",
      ).run(runId) as ChangeResult;
      if (Number(deleted.changes || 0) !== 1) {
        throw Object.assign(new Error('run_initialization_rollback_race'), {
          code: 'run_initialization_rollback_race',
          errorCode: 'run_initialization_rollback_race',
        });
      }
      return { status: 'rolled-back', runId, rolledBack: true };
    },

    listRunIds,

    listStaleRunDiagnostics,

    getProjectRunCounts,

    getProjectWorkspaceRecord,

    listProjectWorkspaceRecords,

    listRunWorkspaceIds,

    hasRunForProjectCanonicalRoot,

    upsertProjectWorkspaceRecord(input) {
      db.prepare(`
        INSERT INTO project_workspaces(
          workspace_id, project_id, canonical_root, git_common_dir,
          git_worktree_dir, worktree_id, identity_json, created_at, last_seen_at
        )
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(workspace_id) DO UPDATE SET
          project_id=excluded.project_id,
          canonical_root=excluded.canonical_root,
          git_common_dir=excluded.git_common_dir,
          git_worktree_dir=excluded.git_worktree_dir,
          worktree_id=excluded.worktree_id,
          identity_json=excluded.identity_json,
          last_seen_at=excluded.last_seen_at
      `).run(
        input.workspaceId,
        input.projectId,
        input.canonicalRoot,
        input.gitCommonDir,
        input.gitWorktreeDir,
        input.worktreeId,
        input.identityJson,
        input.createdAt,
        input.lastSeenAt,
      );
    },

    deleteProjectWorkspaceRecord(workspaceId) {
      const result = db.prepare(
        'DELETE FROM project_workspaces WHERE workspace_id=?',
      ).run(workspaceId) as ChangeResult;
      return Number(result.changes || 0) === 1;
    },

    mergeProjectWorkspaceReferences({
      sourceWorkspaceId,
      targetWorkspaceId,
      canonicalRoot,
      withinTransaction = false,
    }) {
      const merge = () => {
        if (sourceWorkspaceId === targetWorkspaceId) {
          return {
            updatedReferences: 0,
            updatedBindings: 0,
            deletedWorkspace: false,
          };
        }

        const bindingUpdate = db.prepare(`
          UPDATE session_bindings
          SET workspace_root=?, updated_at=?
          WHERE workspace_id=?
        `).run(canonicalRoot, now(), sourceWorkspaceId) as ChangeResult;

        const sourceWorkspaceEpoch = Number((db.prepare(
          'SELECT mutation_epoch AS epoch FROM project_workspaces WHERE workspace_id=?',
        ).get(sourceWorkspaceId) as { epoch?: number | string | null } | undefined)?.epoch || 0);
        const targetWorkspaceEpoch = Number((db.prepare(
          'SELECT mutation_epoch AS epoch FROM project_workspaces WHERE workspace_id=?',
        ).get(targetWorkspaceId) as { epoch?: number | string | null } | undefined)?.epoch || 0);
        const sourceWorkspaceLock = getWorkspaceMutationLockV2(sourceWorkspaceId);
        const targetWorkspaceLock = getWorkspaceMutationLockV2(targetWorkspaceId);
        const mergedWorkspaceEpoch = Math.max(
          sourceWorkspaceEpoch,
          targetWorkspaceEpoch,
          Number(sourceWorkspaceLock?.fencingToken || 0),
          Number(targetWorkspaceLock?.fencingToken || 0),
        );
        if (mergedWorkspaceEpoch > targetWorkspaceEpoch) {
          db.prepare(
            'UPDATE project_workspaces SET mutation_epoch=? WHERE workspace_id=?',
          ).run(mergedWorkspaceEpoch, targetWorkspaceId);
        }

        if (sourceWorkspaceLock) {
          // A fencing token is scoped to the workspace history that issued it.
          // Once two workspace histories collapse, source credentials could be
          // indistinguishable from a retained target lock. Retire both active
          // rows and preserve their maximum token in mutation_epoch; the next
          // owner must reacquire with a strictly newer target token.
          db.prepare(`
            DELETE FROM workspace_mutation_locks_v2
            WHERE workspace_id=? AND project_id=? AND holder_run_id=?
              AND session_token=? AND fencing_token=?
          `).run(
            sourceWorkspaceLock.workspaceId,
            sourceWorkspaceLock.projectId,
            sourceWorkspaceLock.holderRunId,
            sourceWorkspaceLock.sessionToken,
            Number(sourceWorkspaceLock.fencingToken),
          );
          if (targetWorkspaceLock) {
            db.prepare(`
              DELETE FROM workspace_mutation_locks_v2
              WHERE workspace_id=? AND project_id=? AND holder_run_id=?
                AND session_token=? AND fencing_token=?
            `).run(
              targetWorkspaceLock.workspaceId,
              targetWorkspaceLock.projectId,
              targetWorkspaceLock.holderRunId,
              targetWorkspaceLock.sessionToken,
              Number(targetWorkspaceLock.fencingToken),
            );
          }
        }

        const referenceColumns = new Set([
          'workspace_id',
          'execution_workspace_id',
          'integration_workspace_id',
        ]);
        const tables = db.prepare(`
          SELECT name
          FROM sqlite_master
          WHERE type='table' AND name NOT LIKE 'sqlite_%'
          ORDER BY name
        `).all() as Array<{ name: string }>;

        let updatedReferences = 0;
        for (const { name } of tables) {
          if (name === 'project_workspaces' || name === 'workspace_mutation_locks_v2') continue;
          const quotedTable = quoteIdentifier(name);
          const columns = db.prepare(
            `PRAGMA table_info(${quotedTable})`,
          ).all() as Array<{ name: string }>;
          for (const column of columns) {
            if (!referenceColumns.has(column.name)) continue;
            const result = db.prepare(
              `UPDATE ${quotedTable}
               SET ${quoteIdentifier(column.name)}=?
               WHERE ${quoteIdentifier(column.name)}=?`,
            ).run(targetWorkspaceId, sourceWorkspaceId) as ChangeResult;
            updatedReferences += Number(result.changes || 0);
          }
        }

        const deleted = db.prepare(
          'DELETE FROM project_workspaces WHERE workspace_id=?',
        ).run(sourceWorkspaceId) as ChangeResult;

        return {
          updatedReferences,
          updatedBindings: Number(bindingUpdate.changes || 0),
          deletedWorkspace: Number(deleted.changes || 0) === 1,
        };
      };
      return withinTransaction ? merge() : db.transaction(merge)();
    },

    backfillRunWorktreeId({ projectId, workspaceId, worktreeId }) {
      const result = db.prepare(`
        UPDATE runs
        SET worktree_id=?
        WHERE project_id=? AND workspace_id=? AND worktree_id IS NULL
      `).run(worktreeId, projectId, workspaceId) as ChangeResult;
      return Number(result.changes || 0);
    },

    rebindRunWorktreeId({ projectId, workspaceId, worktreeId }) {
      const result = db.prepare(`
        UPDATE runs
        SET worktree_id=?
        WHERE project_id=? AND workspace_id=?
      `).run(worktreeId, projectId, workspaceId) as ChangeResult;
      return Number(result.changes || 0);
    },

    getWorktreeMutationLease,

    listWorktreeMutationLeases({ projectId = null, runId = null } = {}) {
      const clauses: string[] = [];
      const values: string[] = [];
      if (projectId) {
        clauses.push('l.project_id=?');
        values.push(projectId);
      }
      if (runId) {
        clauses.push('l.holder_run_id=?');
        values.push(runId);
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
      const rows = db.prepare(`
        SELECT l.worktree_id AS worktreeId, l.project_id AS projectId,
          l.holder_run_id AS holderRunId, l.acquired_at AS acquiredAt,
          r.status AS runStatus
        FROM worktree_mutation_leases l
        LEFT JOIN runs r ON r.run_id=l.holder_run_id
        ${where}
      `).all(...values) as WorktreeMutationLeaseRow[];
      return rows.map((row) => ({
        worktreeId: row.worktreeId,
        projectId: row.projectId,
        holderRunId: row.holderRunId,
        acquiredAt: row.acquiredAt,
        runStatus: row.runStatus ?? null,
      }));
    },

    insertWorktreeMutationLease({ worktreeId, projectId, runId }) {
      const acquiredAt = now();
      db.prepare(`
        INSERT INTO worktree_mutation_leases(
          worktree_id, project_id, holder_run_id, acquired_at
        )
        VALUES(?, ?, ?, ?)
      `).run(worktreeId, projectId, runId, acquiredAt);
      return { worktreeId, projectId, holderRunId: runId, acquiredAt };
    },

    deleteWorktreeMutationLease({ worktreeId, runId, projectId = null }) {
      const result = projectId
        ? db.prepare(`
            DELETE FROM worktree_mutation_leases
            WHERE worktree_id=? AND project_id=? AND holder_run_id=?
          `).run(worktreeId, projectId, runId)
        : db.prepare(`
            DELETE FROM worktree_mutation_leases
            WHERE worktree_id=? AND holder_run_id=?
          `).run(worktreeId, runId);
      return Number((result as ChangeResult).changes || 0) === 1;
    },

    rebindWorktreeMutationLease({
      worktreeId,
      nextWorktreeId,
      fromProjectId,
      toProjectId,
      runId,
    }) {
      const result = db.prepare(`
        UPDATE worktree_mutation_leases
        SET worktree_id=?, project_id=?
        WHERE worktree_id=? AND project_id=? AND holder_run_id=?
      `).run(nextWorktreeId, toProjectId, worktreeId, fromProjectId, runId) as ChangeResult;
      return Number(result.changes || 0);
    },

    getSessionBinding,

    listSessionBindings,

    insertSessionBinding(input) {
      db.prepare(`
        INSERT INTO session_bindings(
          binding_id, session_id, provider, surface, run_id, project_id,
          workspace_id, workspace_root, access_mode, status, created_at,
          expires_at, closed_at, close_reason, successor_run_id, updated_at
        )
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.bindingId,
        input.sessionId,
        input.provider,
        input.surface,
        input.runId,
        input.projectId,
        input.workspaceId,
        input.workspaceRoot,
        input.accessMode,
        input.status,
        input.createdAt,
        input.expiresAt,
        input.closedAt,
        input.closeReason,
        input.successorRunId,
        input.updatedAt,
      );
      const persisted = getSessionBinding(input.bindingId);
      if (!persisted) throw new Error(`Session binding ${input.bindingId} was not persisted`);
      return persisted;
    },

    updateSessionBinding({ bindingId, expected = {}, changes }) {
      const assignments: string[] = [];
      const values: Array<string | null> = [];
      const updateColumns: Readonly<Record<keyof SessionBindingUpdate, string>> = {
        sessionId: 'session_id',
        provider: 'provider',
        surface: 'surface',
        workspaceId: 'workspace_id',
        workspaceRoot: 'workspace_root',
        accessMode: 'access_mode',
        status: 'status',
        expiresAt: 'expires_at',
        closedAt: 'closed_at',
        closeReason: 'close_reason',
        successorRunId: 'successor_run_id',
        updatedAt: 'updated_at',
      };
      for (const [key, column] of Object.entries(updateColumns) as Array<
        [keyof SessionBindingUpdate, string]
      >) {
        if (!Object.hasOwn(changes, key)) continue;
        assignments.push(`${column}=?`);
        const value = changes[key];
        values.push(value === undefined ? null : value);
      }
      if (assignments.length === 0) return false;

      const clauses = ['binding_id=?'];
      values.push(bindingId);
      const expectedColumns: Readonly<Record<string, string>> = {
        projectId: 'project_id',
        sessionId: 'session_id',
        runId: 'run_id',
        provider: 'provider',
        status: 'status',
        accessMode: 'access_mode',
      };
      for (const [key, column] of Object.entries(expectedColumns)) {
        if (!Object.hasOwn(expected, key)) continue;
        const value = expected[key as keyof typeof expected];
        if (value === null) clauses.push(`${column} IS NULL`);
        else {
          clauses.push(`${column}=?`);
          values.push(String(value));
        }
      }
      const result = db.prepare(
        `UPDATE session_bindings SET ${assignments.join(', ')} WHERE ${clauses.join(' AND ')}`,
      ).run(...values) as ChangeResult;
      return Number(result.changes || 0) === 1;
    },

    updateRunLifecycle(input) {
      const assignments: string[] = [];
      const values: Array<string | number | null> = [];
      if (input.status !== undefined) {
        assignments.push('status=?');
        values.push(String(input.status));
      }
      if (Object.hasOwn(input, 'blockedReason')) {
        assignments.push('blocked_reason=?');
        values.push(input.blockedReason ?? null);
      }
      if (Object.hasOwn(input, 'blockingClass')) {
        assignments.push('blocking_class=?');
        values.push(input.blockingClass ?? null);
      }
      if (input.incrementIntervention) {
        assignments.push('intervention_count=intervention_count+1');
      }
      if (input.incrementRevision) {
        assignments.push('revision=revision+1');
      }
      assignments.push('updated_at=?');
      values.push(input.updatedAt || now());

      const clauses = ['run_id=?'];
      const whereValues: Array<string | null> = [input.runId];
      if (Object.hasOwn(input, 'expectedStatus')) {
        if (input.expectedStatus === null) clauses.push('status IS NULL');
        else {
          clauses.push('status=?');
          whereValues.push(String(input.expectedStatus));
        }
      }
      if (Object.hasOwn(input, 'expectedOwnerBindingId')) {
        if (input.expectedOwnerBindingId === null) clauses.push('owner_binding_id IS NULL');
        else {
          clauses.push('owner_binding_id=?');
          whereValues.push(String(input.expectedOwnerBindingId));
        }
      }

      const result = db.prepare(
        `UPDATE runs SET ${assignments.join(', ')} WHERE ${clauses.join(' AND ')}`,
      ).run(...values, ...whereValues) as ChangeResult;
      return Number(result.changes || 0) === 1;
    },

    persistRunTaskContract({
      runId,
      taskContractJson,
      contractRevision,
      acceptanceCriteriaJson,
      requiredObligationsJson,
    }) {
      const result = requiredObligationsJson === undefined
        ? db.prepare(`
            UPDATE runs
            SET task_contract_json=?, contract_revision=?, acceptance_criteria=?,
                revision=revision+1, updated_at=?
            WHERE run_id=?
          `).run(
            taskContractJson,
            Number(contractRevision),
            acceptanceCriteriaJson,
            now(),
            runId,
          )
        : db.prepare(`
            UPDATE runs
            SET task_contract_json=?, contract_revision=?, acceptance_criteria=?,
                required_obligations=?, revision=revision+1, updated_at=?
            WHERE run_id=?
          `).run(
            taskContractJson,
            Number(contractRevision),
            acceptanceCriteriaJson,
            requiredObligationsJson,
            now(),
            runId,
          );
      return Number((result as ChangeResult).changes || 0) === 1;
    },

    updateRunWorkspaceIdentity({ runId, identity, incrementMutation }) {
      const result = db.prepare(`
        UPDATE runs
        SET current_workspace_identity=?,
            run_start_workspace_identity=COALESCE(run_start_workspace_identity, ?),
            mutation_revision=mutation_revision+?,
            revision=revision+1,
            updated_at=?
        WHERE run_id=?
      `).run(identity, identity, incrementMutation ? 1 : 0, now(), runId) as ChangeResult;
      return Number(result.changes || 0) === 1;
    },

    updateRunWorkspaceBaseline({ runId, changedPathsJson, entriesJson }) {
      const result = db.prepare(`
        UPDATE runs
        SET workspace_baseline_changed_paths=?, workspace_baseline_entries=?, updated_at=?
        WHERE run_id=?
      `).run(changedPathsJson, entriesJson, now(), runId) as ChangeResult;
      return Number(result.changes || 0) === 1;
    },

    compareAndSetRunState({
      runId,
      expectedState,
      expectedRevision,
      nextState,
    }) {
      const result = db.prepare(`
        UPDATE runs
        SET state=?, revision=revision+1, updated_at=?
        WHERE run_id=? AND state=? AND revision=?
      `).run(nextState, now(), runId, expectedState, Number(expectedRevision)) as ChangeResult;
      return Number(result.changes || 0) === 1;
    },

    compareAndSetRunWorkspaceIdentity({
      runId,
      identity,
      expectedMutationRevision,
      expectedWorkspaceIdentity,
    }) {
      const result = db.prepare(`
        UPDATE runs
        SET current_workspace_identity=?,
            run_start_workspace_identity=COALESCE(run_start_workspace_identity, ?),
            mutation_revision=mutation_revision+1,
            revision=revision+1,
            updated_at=?
        WHERE run_id=? AND mutation_revision=? AND current_workspace_identity=?
      `).run(
        identity,
        identity,
        now(),
        runId,
        Number(expectedMutationRevision),
        expectedWorkspaceIdentity,
      ) as ChangeResult;
      return Number(result.changes || 0) === 1;
    },

    setRunSignals(runId, runSignalsJson, updatedAt = now()) {
      const result = db.prepare(
        'UPDATE runs SET run_signals_json=?, updated_at=? WHERE run_id=?',
      ).run(runSignalsJson, updatedAt, runId) as ChangeResult;
      return Number(result.changes || 0) === 1;
    },

    listProjectRunSignals({ projectId, excludeRunId = null }) {
      const sql = `
        SELECT run_id as runId, run_signals_json as runSignalsJson
        FROM runs
        WHERE project_id=? AND run_signals_json IS NOT NULL
          ${excludeRunId ? 'AND run_id<>?' : ''}
        ORDER BY updated_at ASC
      `;
      return db.prepare(sql)
        .all(...(excludeRunId ? [projectId, excludeRunId] : [projectId])) as Array<{
          runId: string;
          runSignalsJson: string;
        }>;
    },

    compareAndSetRunOwnerBinding({
      runId,
      projectId,
      expectedBindingId,
      bindingId,
      workspaceId = null,
    }) {
      const result = db.prepare(`
        UPDATE runs
        SET owner_binding_id=?,
            workspace_id=COALESCE(workspace_id, ?),
            updated_at=?
        WHERE run_id=? AND project_id=?
          AND owner_binding_id IS ?
          AND (workspace_id IS NULL OR workspace_id=?)
      `).run(
        bindingId,
        workspaceId,
        now(),
        runId,
        projectId,
        expectedBindingId,
        workspaceId,
      ) as ChangeResult;
      return Number(result.changes || 0) === 1;
    },

    getWorkspaceMutationLockV2,

    listWorkspaceMutationLocksV2({ projectId = null } = {}) {
      const where = projectId ? 'WHERE project_id=?' : '';
      const values = projectId ? [projectId] : [];
      const rows = db.prepare(`
        SELECT workspace_id AS workspaceId, project_id AS projectId,
          holder_run_id AS holderRunId, session_token AS sessionToken,
          fencing_token AS fencingToken, acquired_at AS acquiredAt,
          expires_at AS expiresAt
        FROM workspace_mutation_locks_v2
        ${where}
      `).all(...values) as WorkspaceMutationLockRow[];
      return rows.map(normalizeWorkspaceMutationLock);
    },

    getWorkspaceMutationEpoch(workspaceId) {
      const row = db.prepare(
        'SELECT mutation_epoch AS epoch FROM project_workspaces WHERE workspace_id=?',
      ).get(workspaceId) as { epoch?: number | string | null } | undefined;
      return Number(row?.epoch || 0);
    },

    setWorkspaceMutationEpoch(workspaceId, fencingToken) {
      const result = db.prepare(
        'UPDATE project_workspaces SET mutation_epoch=? WHERE workspace_id=?',
      ).run(Number(fencingToken), workspaceId) as ChangeResult;
      return Number(result.changes || 0) === 1;
    },

    upsertWorkspaceMutationLockV2(input) {
      db.prepare(`
        INSERT INTO workspace_mutation_locks_v2(
          workspace_id, project_id, holder_run_id, session_token,
          fencing_token, acquired_at, expires_at
        )
        VALUES(?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(workspace_id) DO UPDATE SET
          holder_run_id=excluded.holder_run_id,
          session_token=excluded.session_token,
          fencing_token=excluded.fencing_token,
          acquired_at=excluded.acquired_at,
          expires_at=excluded.expires_at
      `).run(
        input.workspaceId,
        input.projectId,
        input.holderRunId,
        input.sessionToken,
        Number(input.fencingToken),
        input.acquiredAt,
        input.expiresAt,
      );
      const persisted = getWorkspaceMutationLockV2(input.workspaceId);
      if (!persisted) {
        throw new Error(`Workspace mutation lock ${input.workspaceId} was not persisted`);
      }
      return persisted;
    },

    renewWorkspaceMutationLockV2({
      workspaceId,
      projectId,
      runId,
      sessionToken,
      fencingToken,
      expiresAt,
      observedAt,
    }) {
      const result = db.prepare(`
        UPDATE workspace_mutation_locks_v2
        SET expires_at=?
        WHERE workspace_id=? AND project_id=? AND holder_run_id=?
          AND session_token=? AND fencing_token=? AND expires_at>?
      `).run(
        expiresAt,
        workspaceId,
        projectId,
        runId,
        sessionToken,
        Number(fencingToken),
        observedAt,
      ) as ChangeResult;
      return Number(result.changes || 0) === 1;
    },

    deleteWorkspaceMutationLockV2({
      workspaceId,
      projectId = null,
      runId = null,
      sessionToken = null,
      fencingToken = null,
      expiresAt = null,
    }) {
      const clauses = ['workspace_id=?'];
      const values: Array<string | number> = [workspaceId];
      if (projectId) {
        clauses.push('project_id=?');
        values.push(projectId);
      }
      if (runId) {
        clauses.push('holder_run_id=?');
        values.push(runId);
      }
      if (sessionToken) {
        clauses.push('session_token=?');
        values.push(sessionToken);
      }
      if (fencingToken !== null && fencingToken !== undefined) {
        clauses.push('fencing_token=?');
        values.push(Number(fencingToken));
      }
      if (expiresAt) {
        clauses.push('expires_at=?');
        values.push(expiresAt);
      }
      if (clauses.length < 2) {
        throw new Error('workspace_mutation_lock_delete_requires_authority_filter');
      }
      const result = db.prepare(
        `DELETE FROM workspace_mutation_locks_v2 WHERE ${clauses.join(' AND ')}`,
      ).run(...values) as ChangeResult;
      return Number(result.changes || 0) === 1;
    },
  };
};
