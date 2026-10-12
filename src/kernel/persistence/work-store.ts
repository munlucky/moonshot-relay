import type { SqliteDatabase } from '../sqlite-adapter.js';
import type { RunStep, StepState } from '../run/run-step-ledger.js';

export interface PersistedWorkStep extends RunStep {
  runId?: string;
  expectedOutputs?: string[];
  assignedRole?: string;
  migrationOrigin?: string | null;
  attemptCount?: number;
  capsuleDigest?: string | null;
  resultDigest?: string | null;
  workspaceIdentityStart?: string | null;
  workspaceIdentityEnd?: string | null;
  blockedReason?: string | null;
  resultWorkspaceIdentity?: string | null;
  resultCommitSha?: string | null;
  patchDigest?: string | null;
  resultAttemptId?: string | null;
  createdAt?: string;
  startedAt?: string | null;
  completedAt?: string | null;
  updatedAt?: string;
}

interface StepRow {
  step_id: string;
  run_id: string;
  sequence: number;
  objective: string;
  state: StepState;
  plan_revision: number;
  dependency_ids_json: string | null;
  allowed_paths_json: string | null;
  forbidden_paths_json: string | null;
  acceptance_ids_json: string | null;
  obligation_ids_json: string | null;
  expected_outputs_json: string | null;
  assigned_role: string;
  synthetic: number;
  migration_origin: string | null;
  attempt_count: number;
  capsule_digest: string | null;
  result_digest: string | null;
  workspace_identity_start: string | null;
  workspace_identity_end: string | null;
  blocked_reason: string | null;
  execution_workspace_id: string | null;
  base_workspace_identity: string | null;
  result_workspace_identity: string | null;
  result_commit_sha: string | null;
  patch_digest: string | null;
  result_attempt_id: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
}

interface PlanRow {
  planRevision: number;
  status: string;
  blockedReason: string | null;
}

interface StepIdRow {
  stepId: string;
}

export interface WorkRunLike {
  runId?: string;
  [key: string]: unknown;
}

export interface WorkStepStoreDeps {
  db: SqliteDatabase;
  now?: () => string;
  getRun: (runId: string) => WorkRunLike | null;
}

export interface ReplaceRunPlanInput {
  currentPlanRevision: number;
  nextPlanRevision: number;
  steps?: PersistedWorkStep[];
  resumeBlockedReason?: string | null;
}

export interface WorkStepStore {
  createRunSteps(runId: string, steps?: PersistedWorkStep[]): PersistedWorkStep[];
  getRunSteps(runId: string, options?: { planRevision?: number | null }): PersistedWorkStep[];
  getRunStep(runId: string, stepId: string): PersistedWorkStep | null;
  updateRunStep(runId: string, stepId: string, patch?: Record<string, unknown>): PersistedWorkStep | null;
  supersedeRunSteps(runId: string, options: { planRevision: number }): PersistedWorkStep[];
  setPlanRevision(runId: string, planRevision: number): WorkRunLike | null;
  replaceRunPlanAtomic(runId: string, input: ReplaceRunPlanInput): {
    run: WorkRunLike | null;
    steps: PersistedWorkStep[];
  };
}

const parseJsonArray = (value: string | null): string[] => {
  try {
    const parsed: unknown = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
};

const toStep = (row: StepRow): PersistedWorkStep => ({
  stepId: row.step_id,
  runId: row.run_id,
  sequence: row.sequence,
  objective: row.objective,
  state: row.state,
  planRevision: row.plan_revision,
  dependencyIds: parseJsonArray(row.dependency_ids_json),
  allowedPaths: parseJsonArray(row.allowed_paths_json),
  forbiddenPaths: parseJsonArray(row.forbidden_paths_json),
  acceptanceIds: parseJsonArray(row.acceptance_ids_json),
  obligationIds: parseJsonArray(row.obligation_ids_json),
  expectedOutputs: parseJsonArray(row.expected_outputs_json),
  assignedRole: row.assigned_role,
  synthetic: Boolean(row.synthetic),
  migrationOrigin: row.migration_origin || null,
  attemptCount: row.attempt_count,
  capsuleDigest: row.capsule_digest || null,
  resultDigest: row.result_digest || null,
  workspaceIdentityStart: row.workspace_identity_start || null,
  workspaceIdentityEnd: row.workspace_identity_end || null,
  blockedReason: row.blocked_reason || null,
  executionWorkspaceId: row.execution_workspace_id || null,
  baseWorkspaceIdentity: row.base_workspace_identity || null,
  resultWorkspaceIdentity: row.result_workspace_identity || null,
  resultCommitSha: row.result_commit_sha || null,
  patchDigest: row.patch_digest || null,
  resultAttemptId: row.result_attempt_id || null,
  createdAt: row.created_at,
  startedAt: row.started_at || null,
  completedAt: row.completed_at || null,
  updatedAt: row.updated_at,
});

export const createWorkStepStore = ({
  db,
  now = () => new Date().toISOString(),
  getRun,
}: WorkStepStoreDeps): WorkStepStore => {
  const getRunSteps: WorkStepStore['getRunSteps'] = (
    runId,
    { planRevision = null } = {},
  ) => {
    const rows = (planRevision === null
      ? db.prepare('SELECT * FROM run_steps WHERE run_id=? ORDER BY plan_revision ASC, sequence ASC').all(runId)
      : db.prepare('SELECT * FROM run_steps WHERE run_id=? AND plan_revision=? ORDER BY sequence ASC').all(runId, planRevision)
    ) as StepRow[];
    return rows.map(toStep);
  };

  const getRunStep: WorkStepStore['getRunStep'] = (runId, stepId) => (
    getRunSteps(runId).find((step) => step.stepId === stepId) || null
  );

  const createRunSteps: WorkStepStore['createRunSteps'] = (runId, steps = []) => {
    if (!getRun(runId)) throw new Error(`Run ${runId} not found`);
    const existing = new Map(getRunSteps(runId).map((step) => [step.stepId, step.planRevision]));
    for (const step of steps) {
      const collidesWith = existing.get(step.stepId);
      if (collidesWith !== undefined && collidesWith !== Number(step.planRevision || 1)) {
        throw new Error(
          `STEP_ID_COLLISION: step "${step.stepId}" already exists at plan revision ${collidesWith}; a replacement plan needs its own ids`,
        );
      }
    }

    const insert = db.prepare(`
      INSERT INTO run_steps(step_id, run_id, sequence, objective, state, plan_revision, dependency_ids_json, allowed_paths_json, forbidden_paths_json, acceptance_ids_json, obligation_ids_json, expected_outputs_json, assigned_role, synthetic, migration_origin, execution_workspace_id, base_workspace_identity, result_workspace_identity, result_commit_sha, patch_digest, created_at, updated_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, step_id) DO NOTHING
    `);
    for (const step of steps) {
      insert.run(
        step.stepId,
        runId,
        Number(step.sequence) || 1,
        String(step.objective || ''),
        String(step.state || 'planned'),
        Number(step.planRevision) || 1,
        JSON.stringify(step.dependencyIds || []),
        JSON.stringify(step.allowedPaths || []),
        JSON.stringify(step.forbiddenPaths || []),
        JSON.stringify(step.acceptanceIds || []),
        JSON.stringify(step.obligationIds || []),
        JSON.stringify(step.expectedOutputs || []),
        String(step.assignedRole || 'implementer'),
        step.synthetic ? 1 : 0,
        step.migrationOrigin || null,
        step.executionWorkspaceId || null,
        step.baseWorkspaceIdentity || null,
        step.resultWorkspaceIdentity || null,
        step.resultCommitSha || null,
        step.patchDigest || null,
        now(),
        now(),
      );
    }
    return getRunSteps(runId);
  };

  const updateRunStep: WorkStepStore['updateRunStep'] = (runId, stepId, patch = {}) => {
    const columns: Readonly<Record<string, string>> = Object.freeze({
      state: 'state',
      attemptCount: 'attempt_count',
      capsuleDigest: 'capsule_digest',
      resultDigest: 'result_digest',
      workspaceIdentityStart: 'workspace_identity_start',
      workspaceIdentityEnd: 'workspace_identity_end',
      blockedReason: 'blocked_reason',
      executionWorkspaceId: 'execution_workspace_id',
      baseWorkspaceIdentity: 'base_workspace_identity',
      resultWorkspaceIdentity: 'result_workspace_identity',
      resultCommitSha: 'result_commit_sha',
      patchDigest: 'patch_digest',
      resultAttemptId: 'result_attempt_id',
      startedAt: 'started_at',
      completedAt: 'completed_at',
    });
    const assignments: string[] = [];
    const values: unknown[] = [];
    for (const [key, column] of Object.entries(columns)) {
      if (patch[key] === undefined) continue;
      assignments.push(`${column}=?`);
      values.push(patch[key]);
    }
    if (assignments.length === 0) return getRunStep(runId, stepId);
    db.prepare(
      `UPDATE run_steps SET ${assignments.join(', ')}, updated_at=? WHERE run_id=? AND step_id=?`,
    ).run(...values, now(), runId, stepId);
    return getRunStep(runId, stepId);
  };

  const supersedeRunSteps: WorkStepStore['supersedeRunSteps'] = (
    runId,
    { planRevision },
  ) => {
    db.prepare(
      "UPDATE run_steps SET state='superseded', updated_at=? WHERE run_id=? AND plan_revision=? AND state NOT IN ('passed','superseded','cancelled')",
    ).run(now(), runId, planRevision);
    return getRunSteps(runId);
  };

  const setPlanRevision: WorkStepStore['setPlanRevision'] = (runId, planRevision) => {
    db.prepare(
      'UPDATE runs SET plan_revision=?, revision=revision+1, updated_at=? WHERE run_id=?',
    ).run(Number(planRevision), now(), runId);
    return getRun(runId);
  };

  const replaceRunPlanAtomic: WorkStepStore['replaceRunPlanAtomic'] = (
    runId,
    {
      currentPlanRevision,
      nextPlanRevision,
      steps = [],
      resumeBlockedReason = null,
    },
  ) => {
    const replace = db.transaction(() => {
      const run = db.prepare(`
        SELECT plan_revision as planRevision, status, blocked_reason as blockedReason
        FROM runs WHERE run_id=?
      `).get(runId) as PlanRow | undefined;
      if (!run) throw new Error(`Run ${runId} not found`);
      if (Number(run.planRevision) !== Number(currentPlanRevision)) {
        throw new Error(
          `PLAN_REVISION_CONFLICT: expected ${currentPlanRevision}, found ${run.planRevision}`,
        );
      }

      const existingIds = new Set(
        (db.prepare('SELECT step_id as stepId FROM run_steps WHERE run_id=?').all(runId) as StepIdRow[])
          .map((row) => row.stepId),
      );
      for (const step of steps) {
        if (existingIds.has(step.stepId)) {
          throw new Error(`STEP_ID_COLLISION: step "${step.stepId}" already exists`);
        }
      }

      db.prepare(`
        UPDATE run_steps SET state='superseded', updated_at=?
        WHERE run_id=? AND plan_revision=? AND state NOT IN ('passed','superseded','cancelled')
      `).run(now(), runId, currentPlanRevision);

      const insert = db.prepare(`
        INSERT INTO run_steps(
          step_id, run_id, sequence, objective, state, plan_revision,
          dependency_ids_json, allowed_paths_json, forbidden_paths_json,
          acceptance_ids_json, obligation_ids_json, expected_outputs_json,
          assigned_role, synthetic, migration_origin, created_at, updated_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const step of steps) {
        insert.run(
          step.stepId,
          runId,
          Number(step.sequence) || 1,
          String(step.objective || ''),
          String(step.state || 'planned'),
          Number(step.planRevision) || nextPlanRevision,
          JSON.stringify(step.dependencyIds || []),
          JSON.stringify(step.allowedPaths || []),
          JSON.stringify(step.forbiddenPaths || []),
          JSON.stringify(step.acceptanceIds || []),
          JSON.stringify(step.obligationIds || []),
          JSON.stringify(step.expectedOutputs || []),
          String(step.assignedRole || 'implementer'),
          step.synthetic ? 1 : 0,
          step.migrationOrigin || null,
          now(),
          now(),
        );
      }

      db.prepare(`
        UPDATE runs
        SET plan_revision=?,
            replan_count=replan_count+1,
            intervention_count=intervention_count + CASE
              WHEN ? IS NOT NULL AND status='blocked' AND blocked_reason=? THEN 1 ELSE 0 END,
            status=CASE
              WHEN ? IS NOT NULL AND status='blocked' AND blocked_reason=? THEN 'active' ELSE status END,
            blocked_reason=CASE
              WHEN ? IS NOT NULL AND status='blocked' AND blocked_reason=? THEN NULL ELSE blocked_reason END,
            blocking_class=CASE
              WHEN ? IS NOT NULL AND status='blocked' AND blocked_reason=? THEN NULL ELSE blocking_class END,
            revision=revision+1,
            updated_at=?
        WHERE run_id=?
      `).run(
        nextPlanRevision,
        resumeBlockedReason,
        resumeBlockedReason,
        resumeBlockedReason,
        resumeBlockedReason,
        resumeBlockedReason,
        resumeBlockedReason,
        resumeBlockedReason,
        resumeBlockedReason,
        now(),
        runId,
      );
    });

    replace();
    return {
      run: getRun(runId),
      steps: getRunSteps(runId, { planRevision: nextPlanRevision }),
    };
  };

  return {
    createRunSteps,
    getRunSteps,
    getRunStep,
    updateRunStep,
    supersedeRunSteps,
    setPlanRevision,
    replaceRunPlanAtomic,
  };
};
