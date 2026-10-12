import type { SqliteDatabase } from '../sqlite-adapter.js';
import {
  ATTEMPT_PROVENANCE_KINDS,
  normalizeAttemptProvenance,
} from '../run/attempt-provenance.js';
import {
  canonicalReceiptPaths,
  mergeImmutableReceiptFields,
  receiptValueIsMissing,
} from '../run/receipt-fields.js';

interface InsertResult {
  lastInsertRowid: number | bigint;
}

interface ChangeResult {
  changes: number;
}

interface IdRow {
  id: number;
}

interface MaxAttemptRow {
  maxAttempt?: number | null;
}

interface WorkRunLike {
  runId?: unknown;
  projectId?: unknown;
  workspaceId?: unknown;
  sourceIdentity?: unknown;
  mutationRevision?: unknown;
  planRevision?: unknown;
  [key: string]: unknown;
}

interface WorkStepLike {
  stepId?: unknown;
  planRevision?: unknown;
  [key: string]: unknown;
}

interface AttemptRow {
  id: number;
  attempt_id: string | null;
  run_id: string;
  step_id: string;
  attempt_number: number;
  binding_id: string | null;
  actor_session_id: string | null;
  capsule_id: string | null;
  capsule_digest: string | null;
  admission_id: string | null;
  route_decision_id: string | null;
  usage_receipt_id: string | null;
  parent_attempt_id: string | null;
  provenance_kind: string | null;
  plan_revision: number | null;
  mutation_revision: number | null;
  retry_reason: string | null;
  failure_category: string | null;
  report_key: string | null;
  report_payload_digest: string | null;
  report_result_json: string | null;
  report_checkpoint_json: string | null;
  review_claim_key: string | null;
  review_claim_holder: string | null;
  review_claim_expires_at: string | null;
  status: string;
  workspace_identity_start: string | null;
  workspace_identity_end: string | null;
  summary: string | null;
  changed_paths_json: string | null;
  result_digest: string | null;
  failure_reasons_json: string | null;
  workspace_id: string | null;
  workspace_root_hash: string | null;
  base_workspace_identity: string | null;
  result_workspace_identity: string | null;
  result_commit_sha: string | null;
  patch_digest: string | null;
  worker_report_json: string | null;
  verification_refs_json: string | null;
  knowledge_observation_refs_json: string | null;
  started_at: string;
  finished_at: string | null;
}

export interface WorkAttempt extends Record<string, unknown> {
  id: number;
  attemptId: string | null;
  runId: string;
  stepId: string;
  attemptNumber: number;
  bindingId: string | null;
  actorSessionId: string | null;
  capsuleId: string | null;
  capsuleDigest: string | null;
  admissionId: string | null;
  routeDecisionId: string | null;
  usageReceiptId: string | null;
  parentAttemptId: string | null;
  provenanceKind: string;
  planRevision: number | null;
  mutationRevision: number | null;
  retryReason: string | null;
  failureCategory: string | null;
  reportKey: string | null;
  reportPayloadDigest: string | null;
  reportResult: unknown;
  reportCheckpoint: unknown;
  reviewClaimKey: string | null;
  reviewClaimHolder: string | null;
  reviewClaimExpiresAt: string | null;
  status: string;
  workspaceIdentityStart: string | null;
  workspaceIdentityEnd: string | null;
  summary: string | null;
  changedPaths: string[];
  resultDigest: string | null;
  failureReasons: unknown[];
  workspaceId: string | null;
  workspaceRootHash: string | null;
  baseWorkspaceIdentity: string | null;
  resultWorkspaceIdentity: string | null;
  resultCommitSha: string | null;
  patchDigest: string | null;
  workerReport: unknown;
  verificationRefs: unknown[];
  knowledgeObservationRefs: unknown[];
  startedAt: string;
  finishedAt: string | null;
}

export interface RecordStepAttemptInput {
  stepId: string;
  attemptId?: unknown;
  bindingId?: unknown;
  actorSessionId?: unknown;
  capsuleDigest?: unknown;
  capsuleId?: unknown;
  admissionId?: unknown;
  routeDecisionId?: unknown;
  usageReceiptId?: unknown;
  parentAttemptId?: unknown;
  provenanceKind?: unknown;
  planRevision?: unknown;
  mutationRevision?: unknown;
  retryReason?: unknown;
  failureCategory?: unknown;
  workspaceIdentityStart?: unknown;
  summary?: unknown;
  changedPaths?: unknown[];
  workspaceId?: unknown;
  workspaceRootHash?: unknown;
  baseWorkspaceIdentity?: unknown;
  verificationRefs?: unknown[];
  knowledgeObservationRefs?: unknown[];
}

export interface FinishStepAttemptInput {
  status?: string;
  workspaceIdentityEnd?: unknown;
  resultWorkspaceIdentity?: unknown;
  resultCommitSha?: unknown;
  patchDigest?: unknown;
  verificationRefs?: unknown[] | null;
  knowledgeObservationRefs?: unknown[] | null;
  resultDigest?: unknown;
  failureReasons?: unknown[];
  failureCategory?: unknown;
  retryReason?: unknown;
  changedPaths?: unknown[] | null;
}

export interface WorkAttemptStoreDeps {
  db: SqliteDatabase;
  now?: () => string;
  getRun: (runId: string) => WorkRunLike | null;
  getRunStep: (runId: string, stepId: string) => WorkStepLike | null;
  hashActorSessionId: (value: unknown) => string | null;
  serialize?: (value: unknown) => string;
  finishAttemptForReport?: (
    attemptId: number | string | bigint,
    input?: FinishStepAttemptInput,
  ) => WorkAttempt | null;
}

export interface WorkAttemptStore {
  recordStepAttempt(runId: string, input: RecordStepAttemptInput): WorkAttempt | null;
  finishStepAttempt(attemptId: number | string | bigint, input?: FinishStepAttemptInput): WorkAttempt | null;
  finishStepAttemptWithReportResult(
    attemptId: number | string | bigint,
    finishOptions?: FinishStepAttemptInput,
    reportResult?: unknown,
  ): WorkAttempt | null;
  updateStepAttempt(attemptId: number | string | bigint, patch?: Record<string, unknown>): WorkAttempt | null;
  updateOwnerAttemptMutationRevision(
    attemptId: number | string | bigint,
    input?: { expectedMutationRevision?: unknown; mutationRevision?: unknown },
  ): WorkAttempt | null;
  recordMutationProvenance(runId: string, input?: Record<string, unknown>): Record<string, unknown>;
  getMutationProvenance(runId: string): Record<string, unknown> | null;
  reconcileOwnerMutationProvenance(runId: string): Record<string, unknown> | null;
  recordExecutionCapsule<T extends Record<string, unknown>>(runId: string, capsule: T): T;
  getExecutionCapsule(capsuleId: string, options?: { runId?: string | null }): Record<string, unknown> | null;
  latestExecutionCapsule(
    runId: string,
    options?: { role?: string; stepId?: string | null },
  ): Record<string, unknown> | null;
  listExecutionCapsules(runId: string): Record<string, unknown>[];
  attachAttemptLineage(attemptId: number | string | bigint, patch?: Record<string, unknown>): WorkAttempt;
  getStepAttempt(id: number | string | bigint): WorkAttempt | null;
  getStepAttemptByAttemptId(
    attemptId: unknown,
    options?: { runId?: string | null },
  ): WorkAttempt | null;
  getStepAttempts(runId: string, options?: { stepId?: string | null }): WorkAttempt[];
  findStepAttemptByReportKey(runId: string, reportKey: string): WorkAttempt | null;
  bindStepAttemptReportOperation(
    attemptId: string,
    input: {
      reportKey: string;
      reportPayloadDigest: string;
    },
  ): WorkAttempt | null;
  checkpointStepReport(attemptId: string, checkpoint: unknown): WorkAttempt | null;
  setStepAttemptReportResult(attemptId: string, reportResult: unknown): WorkAttempt | null;
  claimReviewAttempt(input: {
    runId: string;
    stepId: string;
    claimKey: string;
    holder: string;
    expiresAt: string;
    role?: (string | null) | undefined;
    actionKind?: (string | null) | undefined;
    obligationId?: (string | null) | undefined;
    planRevision?: number | null;
    mutationRevision?: number | null;
  }): { claimed: boolean; reason?: string; existing?: WorkAttempt | null };
  releaseReviewClaim(
    claimKey: string,
    holder: string,
    options?: { runId?: string | null; stepId?: (string | null) | undefined; planRevision?: number | null },
  ): boolean;
  nextStepAttemptNumber(runId: string, stepId: string): number;
}

const safeJsonParse = <T>(value: string | null | undefined, fallback: T): T => {
  try {
    return value ? JSON.parse(value) as T : fallback;
  } catch {
    return fallback;
  }
};

const asRecord = (value: unknown): Record<string, unknown> => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
);

const asInsertResult = (value: unknown): InsertResult => (
  value && typeof value === 'object' && 'lastInsertRowid' in value
    ? value as InsertResult
    : { lastInsertRowid: 0 }
);

const asChangeResult = (value: unknown): ChangeResult => (
  value && typeof value === 'object' && 'changes' in value
    ? value as ChangeResult
    : { changes: 0 }
);

const toAttempt = (row: AttemptRow): WorkAttempt => {
  const provenanceKind = row.attempt_id
    && (ATTEMPT_PROVENANCE_KINDS as readonly string[]).includes(String(row.provenance_kind))
    ? String(row.provenance_kind)
    : 'legacy-unattributed';
  const legacy = provenanceKind === 'legacy-unattributed';
  return {
    id: row.id,
    attemptId: row.attempt_id || null,
    runId: row.run_id,
    stepId: row.step_id,
    attemptNumber: row.attempt_number,
    bindingId: row.binding_id || null,
    actorSessionId: row.actor_session_id || null,
    capsuleId: row.capsule_id || null,
    capsuleDigest: row.capsule_digest || null,
    admissionId: row.admission_id || null,
    routeDecisionId: row.route_decision_id || null,
    usageReceiptId: row.usage_receipt_id || null,
    parentAttemptId: row.parent_attempt_id || null,
    provenanceKind,
    planRevision: legacy || row.plan_revision === null ? null : Number(row.plan_revision),
    mutationRevision: legacy || row.mutation_revision === null ? null : Number(row.mutation_revision),
    retryReason: row.retry_reason || null,
    failureCategory: row.failure_category || null,
    reportKey: row.report_key || null,
    reportPayloadDigest: row.report_payload_digest || null,
    reportResult: row.report_result_json ? safeJsonParse(row.report_result_json, null) : null,
    reportCheckpoint: row.report_checkpoint_json ? safeJsonParse(row.report_checkpoint_json, null) : null,
    reviewClaimKey: row.review_claim_key || null,
    reviewClaimHolder: row.review_claim_holder || null,
    reviewClaimExpiresAt: row.review_claim_expires_at || null,
    status: row.status,
    workspaceIdentityStart: row.workspace_identity_start || null,
    workspaceIdentityEnd: row.workspace_identity_end || null,
    summary: row.summary || null,
    changedPaths: safeJsonParse<string[]>(row.changed_paths_json, []),
    resultDigest: row.result_digest || null,
    failureReasons: safeJsonParse<unknown[]>(row.failure_reasons_json, []),
    workspaceId: row.workspace_id || null,
    workspaceRootHash: row.workspace_root_hash || null,
    baseWorkspaceIdentity: row.base_workspace_identity || null,
    resultWorkspaceIdentity: row.result_workspace_identity || null,
    resultCommitSha: row.result_commit_sha || null,
    patchDigest: row.patch_digest || null,
    workerReport: row.worker_report_json ? safeJsonParse(row.worker_report_json, null) : null,
    verificationRefs: safeJsonParse<unknown[]>(row.verification_refs_json, []),
    knowledgeObservationRefs: safeJsonParse<unknown[]>(row.knowledge_observation_refs_json, []),
    startedAt: row.started_at,
    finishedAt: row.finished_at || null,
  };
};

const executionReceiptFields = [
  'workspaceIdentityEnd',
  'resultWorkspaceIdentity',
  'resultCommitSha',
  'patchDigest',
  'resultDigest',
  'workerReport',
] as const;

export const createWorkAttemptStore = ({
  db,
  now = () => new Date().toISOString(),
  getRun,
  getRunStep,
  hashActorSessionId,
  serialize = (value) => JSON.stringify(value),
  finishAttemptForReport,
}: WorkAttemptStoreDeps): WorkAttemptStore => {
  const getStepAttempt: WorkAttemptStore['getStepAttempt'] = (id) => {
    const row = db.prepare('SELECT * FROM run_step_attempts WHERE id=?').get(id) as AttemptRow | undefined;
    return row ? toAttempt(row) : null;
  };

  const getStepAttemptByAttemptId: WorkAttemptStore['getStepAttemptByAttemptId'] = (
    attemptId,
    { runId = null } = {},
  ) => {
    if (!attemptId) return null;
    const row = (runId
      ? db.prepare('SELECT id FROM run_step_attempts WHERE attempt_id=? AND run_id=? LIMIT 1')
        .get(String(attemptId), runId)
      : db.prepare('SELECT id FROM run_step_attempts WHERE attempt_id=? LIMIT 1')
        .get(String(attemptId))) as IdRow | undefined;
    return row ? getStepAttempt(row.id) : null;
  };

  const getStepAttempts: WorkAttemptStore['getStepAttempts'] = (
    runId,
    { stepId = null } = {},
  ) => {
    const rows = (stepId
      ? db.prepare('SELECT id FROM run_step_attempts WHERE run_id=? AND step_id=? ORDER BY id ASC')
        .all(runId, stepId)
      : db.prepare('SELECT id FROM run_step_attempts WHERE run_id=? ORDER BY id ASC')
        .all(runId)) as IdRow[];
    return rows.map((row) => getStepAttempt(row.id)).filter((attempt): attempt is WorkAttempt => Boolean(attempt));
  };

  const findStepAttemptByReportKey: WorkAttemptStore['findStepAttemptByReportKey'] = (
    runId,
    reportKey,
  ) => {
    if (!runId || !reportKey) return null;
    const row = db.prepare(
      'SELECT id FROM run_step_attempts WHERE run_id=? AND report_key=? LIMIT 1',
    ).get(runId, reportKey) as IdRow | undefined;
    return row ? getStepAttempt(row.id) : null;
  };

  const bindStepAttemptReportOperation:
    WorkAttemptStore['bindStepAttemptReportOperation'] = (
      attemptId,
      { reportKey, reportPayloadDigest },
    ) => {
      if (!attemptId || !reportKey || !reportPayloadDigest) return null;
      const current = getStepAttemptByAttemptId(attemptId);
      if (!current) return null;
      if (current.reportKey && current.reportKey !== reportKey) {
        throw Object.assign(new Error('canonical report operation key changed'), {
          code: 'REPORT_OPERATION_KEY_CONFLICT',
          errorCode: 'REPORT_OPERATION_KEY_CONFLICT',
        });
      }
      if (current.reportPayloadDigest && current.reportPayloadDigest !== reportPayloadDigest) {
        throw Object.assign(new Error('canonical report payload changed for the same operation'), {
          code: 'REPORT_OPERATION_PAYLOAD_CONFLICT',
          errorCode: 'REPORT_OPERATION_PAYLOAD_CONFLICT',
        });
      }
      try {
        const updated = asChangeResult(db.prepare(`
          UPDATE run_step_attempts
          SET report_key=COALESCE(report_key, ?),
              report_payload_digest=COALESCE(report_payload_digest, ?)
          WHERE attempt_id=?
            AND (report_key IS NULL OR report_key=?)
            AND (report_payload_digest IS NULL OR report_payload_digest=?)
        `).run(
          reportKey,
          reportPayloadDigest,
          String(attemptId),
          reportKey,
          reportPayloadDigest,
        ));
        if (updated.changes !== 1) {
          throw Object.assign(new Error('canonical report operation changed concurrently'), {
            code: 'REPORT_OPERATION_PAYLOAD_CONFLICT',
            errorCode: 'REPORT_OPERATION_PAYLOAD_CONFLICT',
          });
        }
      } catch (error) {
        if (String((error as Error)?.message || '').includes('UNIQUE constraint failed')) {
          throw Object.assign(
            new Error('canonical report operation key is already owned by another attempt'),
            {
              code: 'REPORT_OPERATION_KEY_CONFLICT',
              errorCode: 'REPORT_OPERATION_KEY_CONFLICT',
            },
          );
        }
        throw error;
      }
      return getStepAttemptByAttemptId(attemptId);
    };

  const checkpointStepReport: WorkAttemptStore['checkpointStepReport'] = (
    attemptId,
    checkpoint,
  ) => {
    const checkpointJson = JSON.stringify(checkpoint);
    const changed = asChangeResult(db.prepare(`
      UPDATE run_step_attempts
      SET report_checkpoint_json=?
      WHERE attempt_id=? AND (report_checkpoint_json IS NULL OR report_checkpoint_json=?)
    `).run(checkpointJson, String(attemptId), checkpointJson));
    if (changed.changes !== 1) {
      throw Object.assign(
        new Error('report settlement checkpoint changed'),
        { code: 'REPORT_CHECKPOINT_CONFLICT' },
      );
    }
    return getStepAttemptByAttemptId(attemptId);
  };

  const setStepAttemptReportResult:
    WorkAttemptStore['setStepAttemptReportResult'] = (attemptId, reportResult) => {
      if (!attemptId || !reportResult) return null;
      const reportResultJson = JSON.stringify(reportResult);
      const persisted = asChangeResult(db.prepare(`
        UPDATE run_step_attempts
        SET report_result_json=?
        WHERE attempt_id=? AND (report_result_json IS NULL OR report_result_json=?)
      `).run(reportResultJson, String(attemptId), reportResultJson));
      if (persisted.changes !== 1) {
        const current = getStepAttemptByAttemptId(attemptId);
        if (current?.reportResult && JSON.stringify(current.reportResult) === reportResultJson) {
          return current;
        }
        throw Object.assign(
          new Error('canonical report result changed concurrently'),
          {
            code: 'STEP_REPORT_RESULT_IMMUTABLE_CONFLICT',
            errorCode: 'STEP_REPORT_RESULT_IMMUTABLE_CONFLICT',
          },
        );
      }
      return getStepAttemptByAttemptId(attemptId);
    };

  const claimReviewAttempt: WorkAttemptStore['claimReviewAttempt'] = ({
    runId,
    stepId,
    claimKey,
    holder,
    expiresAt,
    role = null,
    actionKind = null,
    obligationId = null,
    planRevision = null,
    mutationRevision = null,
  }) => {
    if (!runId || !stepId || !claimKey || !holder || !expiresAt) {
      return { claimed: false, reason: 'invalid-claim' };
    }
    if (
      role !== 'reviewer'
      || !['review', 'review_engineering', 'review_contract'].includes(String(actionKind))
      || !obligationId
    ) {
      return { claimed: false, reason: 'review-route-required' };
    }

    try {
      return db.transaction(() => {
        const nowIso = now();
        const run = getRun(runId);
        const subjectPlanRevision = Number(planRevision ?? run?.planRevision);
        const subjectMutationRevision = Number(mutationRevision ?? run?.mutationRevision);
        if (
          !run
          || Number(run.planRevision) !== subjectPlanRevision
          || Number(run.mutationRevision) !== subjectMutationRevision
        ) {
          return { claimed: false, reason: 'review-subject-stale' };
        }

        const existing = db.prepare(`
          SELECT a.id, a.review_claim_holder AS reviewClaimHolder,
                 a.review_claim_expires_at AS reviewClaimExpiresAt
          FROM run_step_attempts a
          JOIN model_route_decisions d ON d.decision_id=a.route_decision_id
          WHERE a.run_id=? AND a.step_id=?
            AND a.plan_revision=? AND a.mutation_revision=?
            AND a.review_claim_key=?
            AND d.run_id=? AND d.role='reviewer'
            AND d.action_kind IN ('review','review_engineering','review_contract')
            AND d.obligation_id=? AND d.plan_revision=?
          LIMIT 1
        `).get(
          runId,
          stepId,
          subjectPlanRevision,
          subjectMutationRevision,
          claimKey,
          runId,
          obligationId,
          subjectPlanRevision,
        ) as {
          id: number;
          reviewClaimHolder?: string | null;
          reviewClaimExpiresAt?: string | null;
        } | undefined;

        if (existing && existing.reviewClaimHolder === holder) {
          return { claimed: true, existing: getStepAttempt(existing.id) };
        }
        if (
          existing
          && existing.reviewClaimExpiresAt
          && existing.reviewClaimExpiresAt > nowIso
        ) {
          return {
            claimed: false,
            existing: getStepAttempt(existing.id),
            reason: 'already-claimed',
          };
        }

        db.prepare(`
          UPDATE run_step_attempts
          SET review_claim_key=NULL, review_claim_holder=NULL, review_claim_expires_at=NULL
          WHERE id IN (
            SELECT a.id
            FROM run_step_attempts a
            JOIN model_route_decisions d ON d.decision_id=a.route_decision_id
            WHERE a.run_id=? AND a.step_id=?
              AND a.plan_revision=? AND a.mutation_revision=?
              AND a.review_claim_key IS NOT NULL
              AND a.review_claim_expires_at IS NOT NULL
              AND a.review_claim_expires_at<=?
              AND d.run_id=? AND d.role='reviewer'
              AND d.action_kind IN ('review','review_engineering','review_contract')
              AND d.obligation_id=? AND d.plan_revision=?
          )
        `).run(
          runId,
          stepId,
          subjectPlanRevision,
          subjectMutationRevision,
          nowIso,
          runId,
          obligationId,
          subjectPlanRevision,
        );

        const candidate = db.prepare(`
          SELECT a.id
          FROM run_step_attempts a
          JOIN model_route_decisions d ON d.decision_id=a.route_decision_id
          WHERE a.run_id=? AND a.step_id=?
            AND a.plan_revision=? AND a.mutation_revision=?
            AND a.provenance_kind='routed'
            AND a.status IN ('started','verifying','reported')
            AND a.review_claim_key IS NULL
            AND d.run_id=? AND d.role='reviewer'
            AND d.action_kind IN ('review','review_engineering','review_contract')
            AND d.obligation_id=? AND d.plan_revision=?
          ORDER BY a.id ASC
          LIMIT 1
        `).get(
          runId,
          stepId,
          subjectPlanRevision,
          subjectMutationRevision,
          runId,
          obligationId,
          subjectPlanRevision,
        ) as IdRow | undefined;
        if (!candidate) return { claimed: false, reason: 'no-review-attempt' };

        const updated = asChangeResult(db.prepare(`
          UPDATE run_step_attempts
          SET review_claim_key=?, review_claim_holder=?, review_claim_expires_at=?
          WHERE id=? AND run_id=? AND step_id=? AND plan_revision=?
            AND mutation_revision=? AND review_claim_key IS NULL
        `).run(
          claimKey,
          holder,
          expiresAt,
          candidate.id,
          runId,
          stepId,
          subjectPlanRevision,
          subjectMutationRevision,
        ));
        if (updated.changes !== 1) {
          return {
            claimed: false,
            existing: getStepAttempt(candidate.id),
            reason: 'already-claimed',
          };
        }
        return { claimed: true, existing: getStepAttempt(candidate.id) };
      })();
    } catch (error) {
      if (!String((error as Error)?.message || '').includes('review_claim')) throw error;
      const run = getRun(runId);
      const currentPlanRevision = Number(planRevision ?? run?.planRevision);
      const row = db.prepare(`
        SELECT id FROM run_step_attempts
        WHERE run_id=? AND step_id=? AND plan_revision=? AND review_claim_key=?
        LIMIT 1
      `).get(runId, stepId, currentPlanRevision, claimKey) as IdRow | undefined;
      return {
        claimed: false,
        existing: row ? getStepAttempt(row.id) : null,
        reason: 'already-claimed',
      };
    }
  };

  const releaseReviewClaim: WorkAttemptStore['releaseReviewClaim'] = (
    claimKey,
    holder,
    { runId = null, stepId = null, planRevision = null } = {},
  ) => {
    if (!claimKey || !holder) return false;
    const scope = [
      runId ? 'run_id=?' : null,
      stepId ? 'step_id=?' : null,
      planRevision === null || planRevision === undefined ? null : 'plan_revision=?',
    ].filter((value): value is string => Boolean(value));
    const values: Array<string | number> = [
      claimKey,
      holder,
      ...(runId ? [runId] : []),
      ...(stepId ? [stepId] : []),
      ...(planRevision === null || planRevision === undefined ? [] : [Number(planRevision)]),
    ];
    const result = asChangeResult(db.prepare(
      `UPDATE run_step_attempts
       SET review_claim_key=NULL, review_claim_holder=NULL, review_claim_expires_at=NULL
       WHERE review_claim_key=? AND review_claim_holder=?
       ${scope.length ? ` AND ${scope.join(' AND ')}` : ''}`,
    ).run(...values));
    return result.changes === 1;
  };

  const nextStepAttemptNumber: WorkAttemptStore['nextStepAttemptNumber'] = (runId, stepId) => {
    const row = db.prepare(
      'SELECT MAX(attempt_number) as maxAttempt FROM run_step_attempts WHERE run_id=? AND step_id=?',
    ).get(runId, stepId) as MaxAttemptRow | undefined;
    return Number(row?.maxAttempt || 0) + 1;
  };

  const getMutationProvenance: WorkAttemptStore['getMutationProvenance'] = (runId) => {
    const row = db.prepare(`
      SELECT run_id as runId,
        project_id as projectId,
        workspace_id as workspaceId,
        source_identity as sourceIdentity,
        base_source_identity as baseSourceIdentity,
        mutation_revision as mutationRevision,
        changed_paths_json as changedPathsJson,
        workspace_identity as workspaceIdentity,
        mutation_digest as mutationDigest,
        attempt_id as attemptId,
        created_at as createdAt,
        updated_at as updatedAt
      FROM mutation_provenance
      WHERE run_id=?
    `).get(runId) as (Record<string, unknown> & { changedPathsJson?: string | null }) | undefined;
    if (!row) return null;
    return {
      ...row,
      changedPaths: canonicalReceiptPaths(
        safeJsonParse<unknown[]>(row.changedPathsJson, []),
      ),
    };
  };

  // Link only a settled canonical owner report. A prepared parallel mutation
  // has no matching owner receipt and must retain its recovery marker.
  const reconcileOwnerMutationProvenanceUnderTransaction = (runId: string): Record<string, unknown> | null => {
    const provenance = getMutationProvenance(runId);
    const run = getRun(runId);
    if (!provenance || provenance.attemptId || !run
      || provenance.projectId !== run.projectId
      || provenance.sourceIdentity !== run.sourceIdentity
      || Number(provenance.mutationRevision) !== Number(run.mutationRevision)
      || provenance.workspaceIdentity !== run.currentWorkspaceIdentity
      || (provenance.workspaceId || null) !== (run.workspaceId || null)) return provenance;
    const paths = canonicalReceiptPaths(provenance.changedPaths);
    if (paths.length === 0) return provenance;
    const candidates = getStepAttempts(runId).filter((attempt) => {
      const result = attempt.reportResult;
      if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
      const receipt = result as Record<string, unknown>;
      return attempt.provenanceKind === 'owner-session'
        && ['passed', 'failed'].includes(attempt.status)
        && Boolean(attempt.attemptId && attempt.reportKey && attempt.reportPayloadDigest && attempt.finishedAt)
        && (!run.ownerBindingId || attempt.bindingId === run.ownerBindingId)
        && Number(attempt.planRevision) === Number(run.planRevision)
        && Number(attempt.mutationRevision) === Number(run.mutationRevision)
        && (attempt.workspaceId || run.workspaceId || null) === (run.workspaceId || null)
        && attempt.workspaceIdentityEnd === provenance.workspaceIdentity
        && attempt.resultWorkspaceIdentity === provenance.workspaceIdentity
        && receipt.runId === runId && receipt.reportKey === attempt.reportKey
        && JSON.stringify(canonicalReceiptPaths(attempt.changedPaths)) === JSON.stringify(paths)
        && JSON.stringify(canonicalReceiptPaths(receipt.actualChangedPaths)) === JSON.stringify(paths);
    });
    if (candidates.length !== 1) return provenance;
    db.prepare(`UPDATE mutation_provenance SET attempt_id=?, updated_at=?
      WHERE run_id=? AND attempt_id IS NULL AND mutation_revision=?
        AND workspace_identity=? AND project_id=? AND source_identity=?`).run(
      candidates[0]!.attemptId, now(), runId, Number(run.mutationRevision),
      provenance.workspaceIdentity, run.projectId, run.sourceIdentity,
    );
    return getMutationProvenance(runId);
  };
  const reconcileOwnerMutationProvenance: WorkAttemptStore['reconcileOwnerMutationProvenance'] = (runId) => (
    db.transaction(() => reconcileOwnerMutationProvenanceUnderTransaction(runId))()
  );

  const recordMutationProvenance: WorkAttemptStore['recordMutationProvenance'] = (
    runId,
    input = {},
  ) => {
    const projectId = input.projectId ? String(input.projectId) : '';
    const workspaceId = input.workspaceId ? String(input.workspaceId) : null;
    const sourceIdentity = input.sourceIdentity ? String(input.sourceIdentity) : '';
    const baseSourceIdentity = input.baseSourceIdentity
      ? String(input.baseSourceIdentity)
      : null;
    const mutationRevision = Number(input.mutationRevision);
    const changedPaths = canonicalReceiptPaths(input.changedPaths || []);
    const workspaceIdentity = input.workspaceIdentity ? String(input.workspaceIdentity) : '';
    const mutationDigest = input.mutationDigest ? String(input.mutationDigest) : '';
    const attemptId = input.attemptId ? String(input.attemptId) : null;
    if (!runId || !projectId || !sourceIdentity || !workspaceIdentity || !mutationDigest) {
      throw new Error('mutation_provenance_incomplete');
    }

    db.prepare(`
      INSERT INTO mutation_provenance(
        run_id, project_id, workspace_id, source_identity, base_source_identity,
        mutation_revision, changed_paths_json, workspace_identity,
        mutation_digest, attempt_id, created_at, updated_at
      )
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET
        project_id=excluded.project_id,
        workspace_id=excluded.workspace_id,
        source_identity=excluded.source_identity,
        base_source_identity=excluded.base_source_identity,
        mutation_revision=excluded.mutation_revision,
        changed_paths_json=excluded.changed_paths_json,
        workspace_identity=excluded.workspace_identity,
        mutation_digest=excluded.mutation_digest,
        attempt_id=excluded.attempt_id,
        updated_at=excluded.updated_at
    `).run(
      runId,
      projectId,
      workspaceId,
      sourceIdentity,
      baseSourceIdentity,
      mutationRevision,
      JSON.stringify(changedPaths),
      workspaceIdentity,
      mutationDigest,
      attemptId,
      now(),
      now(),
    );
    const recorded = getMutationProvenance(runId);
    if (!recorded) throw new Error('mutation_provenance_write_failed');
    return recorded;
  };

  const getExecutionCapsule: WorkAttemptStore['getExecutionCapsule'] = (
    capsuleId,
    { runId = null } = {},
  ) => {
    const row = db.prepare(`
      SELECT run_id as runId, capsule_json as capsuleJson
      FROM run_capsules
      WHERE capsule_id=?
    `).get(capsuleId) as { runId?: string; capsuleJson?: string | null } | undefined;
    if (!row) return null;
    if (runId && row.runId !== runId) return null;
    return safeJsonParse<Record<string, unknown> | null>(row.capsuleJson, null);
  };

  const recordExecutionCapsule: WorkAttemptStore['recordExecutionCapsule'] = <T extends Record<string, unknown>>(
    runId: string,
    capsule: T,
  ) => {
    const capsuleId = capsule.capsuleId ? String(capsule.capsuleId) : '';
    if (!capsuleId) throw new Error('recordExecutionCapsule requires a normalized capsule');
    if (String(capsule.runId || '') !== runId) {
      throw new Error(`capsule runId ${String(capsule.runId || '')} does not match run ${runId}`);
    }
    if (!getRun(runId)) throw new Error(`Run ${runId} not found`);
    const provenance = asRecord(capsule.provenance);
    const subject = asRecord(capsule.subject);
    db.prepare(`
      INSERT INTO run_capsules(
        capsule_id, run_id, step_id, role, plan_revision, mutation_revision,
        workspace_identity, route_decision_id, digest, capsule_json, created_at
      )
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(capsule_id) DO NOTHING
    `).run(
      capsuleId,
      runId,
      capsule.stepId ? String(capsule.stepId) : null,
      capsule.role ? String(capsule.role) : null,
      Number(capsule.planRevision || 1),
      Number(capsule.mutationRevision ?? subject.mutationRevision ?? 0),
      provenance.workspaceIdentity ? String(provenance.workspaceIdentity) : null,
      provenance.routeDecisionId ? String(provenance.routeDecisionId) : null,
      provenance.capsuleDigest ? String(provenance.capsuleDigest) : null,
      serialize(capsule),
      capsule.createdAt ? String(capsule.createdAt) : now(),
    );
    return capsule;
  };

  const latestExecutionCapsule: WorkAttemptStore['latestExecutionCapsule'] = (
    runId,
    { role = 'implementer', stepId = null } = {},
  ) => {
    const row = (stepId
      ? db.prepare(`
          SELECT capsule_json as capsuleJson
          FROM run_capsules
          WHERE run_id=? AND role=? AND step_id=?
          ORDER BY rowid DESC
          LIMIT 1
        `).get(runId, role, stepId)
      : db.prepare(`
          SELECT capsule_json as capsuleJson
          FROM run_capsules
          WHERE run_id=? AND role=?
          ORDER BY rowid DESC
          LIMIT 1
        `).get(runId, role)) as { capsuleJson?: string | null } | undefined;
    return row?.capsuleJson
      ? safeJsonParse<Record<string, unknown> | null>(row.capsuleJson, null)
      : null;
  };

  const listExecutionCapsules: WorkAttemptStore['listExecutionCapsules'] = (runId) => {
    const rows = db.prepare(`
      SELECT capsule_json as capsuleJson
      FROM run_capsules
      WHERE run_id=?
      ORDER BY rowid ASC
    `).all(runId) as Array<{ capsuleJson?: string | null }>;
    return rows
      .map((row) => safeJsonParse<Record<string, unknown> | null>(row.capsuleJson, null))
      .filter((value): value is Record<string, unknown> => Boolean(value));
  };

  const recordStepAttempt: WorkAttemptStore['recordStepAttempt'] = (runId, {
    stepId,
    attemptId = null,
    bindingId = null,
    actorSessionId = null,
    capsuleDigest = null,
    capsuleId = null,
    admissionId = null,
    routeDecisionId = null,
    usageReceiptId = null,
    parentAttemptId = null,
    provenanceKind = 'owner-session',
    planRevision = null,
    mutationRevision = null,
    retryReason = null,
    failureCategory = null,
    workspaceIdentityStart = null,
    summary = null,
    changedPaths = [],
    workspaceId = null,
    workspaceRootHash = null,
    baseWorkspaceIdentity = null,
    verificationRefs = [],
    knowledgeObservationRefs = [],
  }) => {
    const run = getRun(runId);
    if (!run) throw new Error(`Run ${runId} not found`);
    const step = stepId ? getRunStep(runId, stepId) : null;
    if (!step) throw new Error(`Run ${runId} step ${stepId || '<missing>'} not found`);
    const provenance = normalizeAttemptProvenance({
      attemptId,
      bindingId,
      capsuleId,
      capsuleDigest,
      admissionId,
      parentAttemptId,
      provenanceKind,
      planRevision: provenanceKind === 'legacy-unattributed'
        ? null
        : planRevision ?? step.planRevision ?? run.planRevision ?? 1,
      mutationRevision: provenanceKind === 'legacy-unattributed'
        ? null
        : mutationRevision ?? run.mutationRevision ?? 0,
      retryReason,
      failureCategory,
    });
    const attemptNumber = nextStepAttemptNumber(runId, stepId);
    const result = asInsertResult(db.prepare(`
      INSERT INTO run_step_attempts(attempt_id, run_id, step_id, attempt_number, binding_id, actor_session_id, capsule_id, capsule_digest, admission_id, route_decision_id, usage_receipt_id, parent_attempt_id, provenance_kind, plan_revision, mutation_revision, retry_reason, failure_category, status, workspace_identity_start, summary, changed_paths_json, workspace_id, workspace_root_hash, base_workspace_identity, verification_refs_json, knowledge_observation_refs_json, started_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'started', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      provenance.attemptId,
      runId,
      stepId,
      attemptNumber,
      provenance.bindingId,
      hashActorSessionId(actorSessionId),
      provenance.capsuleId,
      provenance.capsuleDigest,
      provenance.admissionId,
      routeDecisionId,
      usageReceiptId,
      provenance.parentAttemptId,
      provenance.provenanceKind,
      provenance.planRevision,
      provenance.mutationRevision,
      provenance.retryReason,
      provenance.failureCategory,
      workspaceIdentityStart,
      summary,
      JSON.stringify(changedPaths),
      workspaceId,
      workspaceRootHash,
      baseWorkspaceIdentity,
      JSON.stringify(verificationRefs),
      JSON.stringify(knowledgeObservationRefs),
      now(),
    ));
    db.prepare(
      'UPDATE run_steps SET attempt_count=attempt_count+1, updated_at=? WHERE run_id=? AND step_id=?',
    ).run(now(), runId, stepId);
    return getStepAttempt(result.lastInsertRowid);
  };

  const finishStepAttempt: WorkAttemptStore['finishStepAttempt'] = (
    attemptId,
    {
      status = 'passed',
      workspaceIdentityEnd = null,
      resultWorkspaceIdentity = null,
      resultCommitSha = null,
      patchDigest = null,
      verificationRefs = null,
      knowledgeObservationRefs = null,
      resultDigest = null,
      failureReasons = [],
      failureCategory = null,
      retryReason = null,
      changedPaths = null,
    } = {},
  ) => {
    const current = getStepAttempt(attemptId);
    if (!current) return null;
    const immutableResult = mergeImmutableReceiptFields(current, {
      workspaceIdentityEnd,
      resultWorkspaceIdentity: resultWorkspaceIdentity || workspaceIdentityEnd,
      resultCommitSha,
      patchDigest,
      resultDigest,
      changedPaths,
      verificationRefs,
      knowledgeObservationRefs,
    }, [
      'workspaceIdentityEnd',
      'resultWorkspaceIdentity',
      'resultCommitSha',
      'patchDigest',
      'resultDigest',
      'changedPaths',
      'verificationRefs',
      'knowledgeObservationRefs',
    ]) as Record<string, unknown>;

    const assignments = ['status=?', 'finished_at=?', 'failure_reasons_json=?'];
    const values: unknown[] = [status, now(), JSON.stringify(failureReasons)];
    const immutableColumns: Readonly<Record<string, string>> = Object.freeze({
      workspaceIdentityEnd: 'workspace_identity_end',
      resultWorkspaceIdentity: 'result_workspace_identity',
      resultCommitSha: 'result_commit_sha',
      patchDigest: 'patch_digest',
      resultDigest: 'result_digest',
      changedPaths: 'changed_paths_json',
      verificationRefs: 'verification_refs_json',
      knowledgeObservationRefs: 'knowledge_observation_refs_json',
    });
    for (const [key, column] of Object.entries(immutableColumns)) {
      if (immutableResult[key] === undefined) continue;
      assignments.push(`${column}=?`);
      values.push(column.endsWith('_json') ? JSON.stringify(immutableResult[key]) : immutableResult[key]);
    }
    if (failureCategory !== null) {
      assignments.push('failure_category=?');
      values.push(failureCategory);
    }
    if (retryReason !== null) {
      assignments.push('retry_reason=?');
      values.push(retryReason);
    }
    db.prepare(
      `UPDATE run_step_attempts SET ${assignments.join(', ')} WHERE id=?`,
    ).run(...values, attemptId);

    const finished = getStepAttempt(attemptId);
    const run = finished ? getRun(finished.runId) : null;
    const attemptOwnsCurrentRevision = finished
      && (finished.mutationRevision === null
        || finished.mutationRevision === undefined
        || Number(finished.mutationRevision) === Number(run?.mutationRevision));
    const currentProvenance = finished ? getMutationProvenance(finished.runId) : null;
    const hasCurrentProvenance = Boolean(
      currentProvenance
      && Number(currentProvenance.mutationRevision) === Number(run?.mutationRevision)
      && String(currentProvenance.workspaceIdentity || '') === String(
        finished?.workspaceIdentityEnd || finished?.resultWorkspaceIdentity || '',
      )
    );
    if (
      finished
      && attemptOwnsCurrentRevision
      && !hasCurrentProvenance
      && status === 'passed'
      && Array.isArray(finished.changedPaths)
      && finished.changedPaths.length > 0
      && workspaceIdentityEnd
    ) {
      recordMutationProvenance(finished.runId, {
        projectId: run?.projectId,
        workspaceId: finished.workspaceId || run?.workspaceId || null,
        sourceIdentity: run?.sourceIdentity,
        baseSourceIdentity: run?.sourceIdentity,
        mutationRevision: run?.mutationRevision || finished.mutationRevision || 0,
        changedPaths: finished.changedPaths,
        workspaceIdentity: finished.workspaceIdentityEnd || finished.resultWorkspaceIdentity,
        mutationDigest: finished.patchDigest
          || finished.resultDigest
          || finished.workspaceIdentityEnd
          || finished.resultWorkspaceIdentity,
        attemptId: finished.attemptId || null,
      });
    }
    return finished;
  };

  const finishStepAttemptWithReportResult: WorkAttemptStore['finishStepAttemptWithReportResult'] = (
    attemptId,
    finishOptions = {},
    reportResult = null,
  ) => {
    if (!attemptId || !reportResult) return null;
    return db.transaction(() => {
      const current = getStepAttemptByAttemptId(attemptId) || getStepAttempt(attemptId);
      if (!current) return null;
      const serialized = JSON.stringify(reportResult);
      if (current.reportResult) {
        if (JSON.stringify(current.reportResult) !== serialized) {
          throw Object.assign(new Error('canonical report result changed concurrently'), {
            code: 'STEP_REPORT_RESULT_IMMUTABLE_CONFLICT',
            errorCode: 'STEP_REPORT_RESULT_IMMUTABLE_CONFLICT',
          });
        }
        if (!['started', 'reported', 'verifying'].includes(current.status)) {
          reconcileOwnerMutationProvenanceUnderTransaction(current.runId);
          return current;
        }
        const finished = (finishAttemptForReport || finishStepAttempt)(current.id, finishOptions);
        reconcileOwnerMutationProvenanceUnderTransaction(current.runId);
        return finished;
      }

      const finished = (finishAttemptForReport || finishStepAttempt)(current.id, finishOptions);
      if (!finished) return null;
      const persisted = asChangeResult(db.prepare(`
        UPDATE run_step_attempts
        SET report_result_json=?
        WHERE id=? AND report_result_json IS NULL
      `).run(serialized, current.id));
      if (persisted.changes !== 1) {
        throw Object.assign(new Error('canonical report result changed concurrently'), {
          code: 'STEP_REPORT_RESULT_IMMUTABLE_CONFLICT',
          errorCode: 'STEP_REPORT_RESULT_IMMUTABLE_CONFLICT',
        });
      }
      reconcileOwnerMutationProvenanceUnderTransaction(current.runId);
      return getStepAttempt(current.id);
    })();
  };

  const updateStepAttempt: WorkAttemptStore['updateStepAttempt'] = (attemptId, patch = {}) => {
    const current = getStepAttempt(attemptId);
    if (!current) return null;
    const columns: Readonly<Record<string, string>> = Object.freeze({
      actorSessionId: 'actor_session_id',
      bindingId: 'binding_id',
      capsuleId: 'capsule_id',
      capsuleDigest: 'capsule_digest',
      admissionId: 'admission_id',
      routeDecisionId: 'route_decision_id',
      usageReceiptId: 'usage_receipt_id',
      parentAttemptId: 'parent_attempt_id',
      provenanceKind: 'provenance_kind',
      planRevision: 'plan_revision',
      mutationRevision: 'mutation_revision',
      retryReason: 'retry_reason',
      failureCategory: 'failure_category',
      status: 'status',
      finishedAt: 'finished_at',
      workspaceId: 'workspace_id',
      workspaceRootHash: 'workspace_root_hash',
      baseWorkspaceIdentity: 'base_workspace_identity',
      workspaceIdentityEnd: 'workspace_identity_end',
      changedPaths: 'changed_paths_json',
      resultWorkspaceIdentity: 'result_workspace_identity',
      resultCommitSha: 'result_commit_sha',
      patchDigest: 'patch_digest',
      resultDigest: 'result_digest',
      workerReport: 'worker_report_json',
      verificationRefs: 'verification_refs_json',
      knowledgeObservationRefs: 'knowledge_observation_refs_json',
    });
    const immutableFields = [
      'mutationRevision',
      'workspaceId',
      'workspaceRootHash',
      'baseWorkspaceIdentity',
      'workspaceIdentityEnd',
      'changedPaths',
      'resultWorkspaceIdentity',
      'resultCommitSha',
      'patchDigest',
      'resultDigest',
      'workerReport',
      'verificationRefs',
      'knowledgeObservationRefs',
    ];
    const hasExecutionReceipt = executionReceiptFields.some(
      (field) => !receiptValueIsMissing(field, current[field]),
    );
    const ownerPreReceiptRevisionAttach = patch.mutationRevision !== undefined
      && current.provenanceKind !== 'routed'
      && !hasExecutionReceipt;
    const immutableInput = { ...patch };
    if (ownerPreReceiptRevisionAttach) delete immutableInput.mutationRevision;
    const immutablePatch = mergeImmutableReceiptFields(
      current,
      immutableInput,
      immutableFields,
    ) as Record<string, unknown>;
    const normalizedPatch = { ...patch };
    for (const field of immutableFields) delete normalizedPatch[field];
    if (ownerPreReceiptRevisionAttach) {
      normalizedPatch.mutationRevision = patch.mutationRevision;
    }
    Object.assign(normalizedPatch, immutablePatch);

    const assignments: string[] = [];
    const values: unknown[] = [];
    for (const [key, column] of Object.entries(columns)) {
      if (normalizedPatch[key] === undefined) continue;
      assignments.push(`${column}=?`);
      values.push(
        column.endsWith('_json')
          ? JSON.stringify(normalizedPatch[key])
          : key === 'actorSessionId'
            ? hashActorSessionId(normalizedPatch[key])
            : normalizedPatch[key],
      );
    }
    if (assignments.length === 0) return getStepAttempt(attemptId);
    db.prepare(
      `UPDATE run_step_attempts SET ${assignments.join(', ')} WHERE id=?`,
    ).run(...values, attemptId);
    return getStepAttempt(attemptId);
  };

  const updateOwnerAttemptMutationRevision: WorkAttemptStore['updateOwnerAttemptMutationRevision'] = (
    attemptId,
    { expectedMutationRevision, mutationRevision } = {},
  ) => {
    const current = getStepAttemptByAttemptId(attemptId) || getStepAttempt(attemptId);
    if (!current) return null;
    const hasExecutionReceipt = executionReceiptFields.some(
      (field) => !receiptValueIsMissing(field, current[field]),
    );
    if (
      hasExecutionReceipt
      || Number(current.mutationRevision) !== Number(expectedMutationRevision)
    ) {
      throw Object.assign(
        new Error('step result field mutationRevision is immutable for the canonical attempt'),
        {
          code: 'STEP_RESULT_IMMUTABLE_CONFLICT',
          errorCode: 'STEP_RESULT_IMMUTABLE_CONFLICT',
          field: 'mutationRevision',
        },
      );
    }
    if (
      !Number.isInteger(Number(mutationRevision))
      || Number(mutationRevision) < Number(expectedMutationRevision)
    ) {
      throw Object.assign(new Error('owner attempt mutation revision must advance monotonically'), {
        code: 'STEP_RESULT_IMMUTABLE_CONFLICT',
        errorCode: 'STEP_RESULT_IMMUTABLE_CONFLICT',
        field: 'mutationRevision',
      });
    }
    const updated = asChangeResult(db.prepare(
      'UPDATE run_step_attempts SET mutation_revision=? WHERE id=? AND mutation_revision=?',
    ).run(Number(mutationRevision), current.id, Number(expectedMutationRevision)));
    if (updated.changes !== 1) {
      throw Object.assign(new Error('owner attempt mutation revision changed concurrently'), {
        code: 'STEP_RESULT_IMMUTABLE_CONFLICT',
        errorCode: 'STEP_RESULT_IMMUTABLE_CONFLICT',
        field: 'mutationRevision',
      });
    }
    return getStepAttempt(current.id);
  };

  const attachAttemptLineage: WorkAttemptStore['attachAttemptLineage'] = (
    attemptId,
    patch = {},
  ) => {
    const attempt = getStepAttemptByAttemptId(attemptId) || getStepAttempt(attemptId);
    if (!attempt) throw new Error(`attempt ${attemptId} not found`);
    const updated = updateStepAttempt(attempt.id, patch);
    if (!updated) throw new Error(`attempt ${attemptId} not found`);
    return updated;
  };

  return {
    recordStepAttempt,
    finishStepAttempt,
    finishStepAttemptWithReportResult,
    updateStepAttempt,
    updateOwnerAttemptMutationRevision,
    recordMutationProvenance,
    getMutationProvenance,
    reconcileOwnerMutationProvenance,
    recordExecutionCapsule,
    getExecutionCapsule,
    latestExecutionCapsule,
    listExecutionCapsules,
    attachAttemptLineage,
    getStepAttempt,
    getStepAttemptByAttemptId,
    getStepAttempts,
    findStepAttemptByReportKey,
    bindStepAttemptReportOperation,
    checkpointStepReport,
    setStepAttemptReportResult,
    claimReviewAttempt,
    releaseReviewClaim,
    nextStepAttemptNumber,
  };
};
