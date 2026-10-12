import type { NormalizedModelRouteDecision } from '../../contracts/model-route.js';
import type { normalizeModelUsageReceipt } from '../../contracts/model-execution.js';
type ModelUsageReceipt = ReturnType<typeof normalizeModelUsageReceipt>;
import type { SqliteDatabase } from '../sqlite-adapter.js';

type UnknownRecord = Record<string, unknown>;


export type StoredGitCloseoutReceipt = {
  runId: string; projectId: string | null; mode: string | null; commitSha: string | null;
  branch: string | null; remote: string; pushStatus: string | null; parity: string | null;
  status: string; beforeHeadSha: string | null; selectedPaths: string[];
  errorCode: string | null; errorMessage: string | null; receiptJson: UnknownRecord;
  createdAt: string; updatedAt: string;
};
export type ImplementationSession = {
  receiptId: string | null; actorSessionId: string; decisionId: string | null;
  attemptId: string | null; bindingId: string | null; stepId?: string | null;
  capsuleId: string | null; capsuleDigest: string | null; resolvedModel: string | null;
  modelClass: string; actionKind: string;
};

export interface HostExecutionPersistence {
  setRunRoute(runId: string, route: unknown): void;
  persistModelRouteDecision(runId: string, decision: NormalizedModelRouteDecision): void;
  getModelRouteDecision(decisionId: string, runId?: string | null): NormalizedModelRouteDecision | null;
  listModelRouteDecisions(runId: string): NormalizedModelRouteDecision[];
  persistModelUsageReceipt(runId: string, receipt: ModelUsageReceipt): void;
  getModelUsageReceipt(receiptId: string, runId?: string | null): ModelUsageReceipt | null;
  listModelUsageReceipts(runId: string): ModelUsageReceipt[];
  persistRouteAdmission(runId: string, admission: UnknownRecord): void;
  getRouteAdmission(admissionId: string, runId?: string | null): UnknownRecord | null;
  listRouteAdmissions(runId: string, decisionId?: string | null): UnknownRecord[];
  getLatestImplementationSession(runId: string): ImplementationSession | null;
  recordGitCloseoutReceipt(runId: string, receipt: UnknownRecord): void;
  getGitCloseoutReceipt(runId: string): StoredGitCloseoutReceipt | null;
}

const parseJson = <T>(value: unknown, fallback: T): T => {
  if (typeof value !== 'string' || !value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

export const createHostExecutionPersistence = ({
  db,
  now = () => new Date().toISOString(),
  serialize = (value: unknown) => JSON.stringify(value),
}: {
  db: SqliteDatabase;
  now?: () => string;
  serialize?: (value: unknown) => string;
}): HostExecutionPersistence => ({
  setRunRoute(runId, route) {
    db.prepare(
      'UPDATE runs SET route_json=?, revision=revision+1, updated_at=? WHERE run_id=?',
    ).run(JSON.stringify(route), now(), runId);
  },

  persistModelRouteDecision(runId, decision) {
    db.prepare(`
      INSERT INTO model_route_decisions(
        decision_id, run_id, attempt_number, replan_count, plan_revision,
        obligation_id, action_kind, role, model_class, risk_tier,
        independent_context_required, permissions, reason_codes_json,
        policy_revision, decision_json, created_at
      )
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(decision_id) DO UPDATE SET
        decision_json=excluded.decision_json,
        reason_codes_json=excluded.reason_codes_json,
        model_class=excluded.model_class,
        action_kind=excluded.action_kind,
        independent_context_required=excluded.independent_context_required
    `).run(
      String(decision.decisionId),
      runId,
      Number(decision.attemptNumber),
      Number(decision.replanCount),
      Number(decision.planRevision),
      decision.obligationId ? String(decision.obligationId) : null,
      String(decision.actionKind),
      String(decision.role),
      decision.modelClass ? String(decision.modelClass) : null,
      decision.riskTier ? String(decision.riskTier) : null,
      decision.independentContextRequired ? 1 : 0,
      decision.permissions ? String(decision.permissions) : null,
      JSON.stringify(Array.isArray(decision.reasonCodes) ? decision.reasonCodes : []),
      decision.policyRevision ? String(decision.policyRevision) : null,
      serialize(decision),
      decision.createdAt ? String(decision.createdAt) : new Date().toISOString(),
    );
  },

  getModelRouteDecision(decisionId, runId = null) {
    const row = db.prepare(`
      SELECT run_id as runId, decision_json as decisionJson
      FROM model_route_decisions
      WHERE decision_id=?
    `).get(decisionId) as { runId?: string; decisionJson?: string | null } | undefined;
    if (!row) return null;
    if (runId && row.runId !== runId) return null;
    return parseJson<NormalizedModelRouteDecision | null>(row.decisionJson, null);
  },

  listModelRouteDecisions(runId) {
    const rows = db.prepare(`
      SELECT decision_json as decisionJson
      FROM model_route_decisions
      WHERE run_id=?
      ORDER BY rowid ASC
    `).all(runId) as Array<{ decisionJson?: string | null }>;
    return rows
      .map((row) => parseJson<NormalizedModelRouteDecision | null>(row.decisionJson, null))
      .filter((value): value is NormalizedModelRouteDecision => Boolean(value));
  },

  persistModelUsageReceipt(runId, receipt) {
    db.prepare(`
      INSERT INTO model_usage_receipts(
        receipt_id, decision_id, run_id, attempt_id, binding_id, host_surface,
        actor_session_id, parent_session_id, resolved_model, resolved_effort,
        enforcement_status, input_tokens, cached_input_tokens, output_tokens,
        cost_micros, wall_clock_ms, result_status, capsule_id, capsule_digest,
        admission_id, admission_digest, step_id, provider, surface, speed_mode,
        reasoning_context, reasoning_mode, delegation_mode, session_lineage_id,
        previous_response_id_digest, prompt_prefix_digest, prompt_cache_key_digest,
        cache_mode, cache_ttl, cache_miss_reason, model_escalation_reason,
        eligible_prefix_tokens, uncached_input_tokens, cache_read_input_tokens,
        cache_write_input_tokens, reasoning_tokens, receipt_json, created_at
      )
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(receipt_id) DO UPDATE SET
        attempt_id=excluded.attempt_id,
        binding_id=excluded.binding_id,
        enforcement_status=excluded.enforcement_status,
        resolved_model=excluded.resolved_model,
        resolved_effort=excluded.resolved_effort,
        input_tokens=excluded.input_tokens,
        cached_input_tokens=excluded.cached_input_tokens,
        output_tokens=excluded.output_tokens,
        cost_micros=excluded.cost_micros,
        wall_clock_ms=excluded.wall_clock_ms,
        result_status=excluded.result_status,
        capsule_id=excluded.capsule_id,
        capsule_digest=excluded.capsule_digest,
        admission_id=excluded.admission_id,
        admission_digest=excluded.admission_digest,
        step_id=excluded.step_id,
        provider=excluded.provider,
        surface=excluded.surface,
        speed_mode=excluded.speed_mode,
        reasoning_context=excluded.reasoning_context,
        reasoning_mode=excluded.reasoning_mode,
        delegation_mode=excluded.delegation_mode,
        session_lineage_id=excluded.session_lineage_id,
        previous_response_id_digest=excluded.previous_response_id_digest,
        prompt_prefix_digest=excluded.prompt_prefix_digest,
        prompt_cache_key_digest=excluded.prompt_cache_key_digest,
        cache_mode=excluded.cache_mode,
        cache_ttl=excluded.cache_ttl,
        cache_miss_reason=excluded.cache_miss_reason,
        model_escalation_reason=excluded.model_escalation_reason,
        eligible_prefix_tokens=excluded.eligible_prefix_tokens,
        uncached_input_tokens=excluded.uncached_input_tokens,
        cache_read_input_tokens=excluded.cache_read_input_tokens,
        cache_write_input_tokens=excluded.cache_write_input_tokens,
        reasoning_tokens=excluded.reasoning_tokens,
        receipt_json=excluded.receipt_json
    `).run(
      String(receipt.receiptId),
      String(receipt.decisionId),
      runId,
      receipt.attemptId ? String(receipt.attemptId) : null,
      receipt.bindingId ? String(receipt.bindingId) : null,
      String(receipt.hostSurface),
      String(receipt.actorSessionId),
      receipt.parentSessionId ? String(receipt.parentSessionId) : null,
      receipt.resolvedModel ? String(receipt.resolvedModel) : null,
      receipt.resolvedEffort ? String(receipt.resolvedEffort) : null,
      String(receipt.enforcementStatus),
      receipt.inputTokens ?? null,
      receipt.cachedInputTokens ?? null,
      receipt.outputTokens ?? null,
      receipt.costMicros ?? null,
      receipt.wallClockMs ?? null,
      String(receipt.resultStatus),
      receipt.capsuleId ? String(receipt.capsuleId) : null,
      receipt.capsuleDigest ? String(receipt.capsuleDigest) : null,
      receipt.admissionId ? String(receipt.admissionId) : null,
      receipt.admissionDigest ? String(receipt.admissionDigest) : null,
      receipt.stepId ? String(receipt.stepId) : null,
      receipt.provider ? String(receipt.provider) : null,
      receipt.surface ? String(receipt.surface) : null,
      receipt.speedMode ? String(receipt.speedMode) : null,
      receipt.reasoningContext ? String(receipt.reasoningContext) : null,
      receipt.reasoningMode ? String(receipt.reasoningMode) : null,
      receipt.delegationMode ? String(receipt.delegationMode) : null,
      receipt.sessionLineageId ? String(receipt.sessionLineageId) : null,
      receipt.previousResponseIdDigest ? String(receipt.previousResponseIdDigest) : null,
      receipt.promptPrefixDigest ? String(receipt.promptPrefixDigest) : null,
      receipt.promptCacheKeyDigest ? String(receipt.promptCacheKeyDigest) : null,
      receipt.cacheMode ? String(receipt.cacheMode) : null,
      receipt.cacheTtl ? String(receipt.cacheTtl) : null,
      receipt.cacheMissReason ? String(receipt.cacheMissReason) : null,
      receipt.modelEscalationReason ? String(receipt.modelEscalationReason) : null,
      receipt.eligiblePrefixTokens ?? null,
      receipt.uncachedInputTokens ?? null,
      receipt.cacheReadInputTokens ?? null,
      receipt.cacheWriteInputTokens ?? null,
      receipt.reasoningTokens ?? null,
      serialize(receipt),
      receipt.createdAt ? String(receipt.createdAt) : new Date().toISOString(),
    );
  },

  getModelUsageReceipt(receiptId, runId = null) {
    const row = db.prepare(`
      SELECT run_id as runId, receipt_json as receiptJson
      FROM model_usage_receipts
      WHERE receipt_id=?
    `).get(receiptId) as { runId?: string; receiptJson?: string | null } | undefined;
    if (!row) return null;
    if (runId && row.runId !== runId) return null;
    return parseJson<ModelUsageReceipt | null>(row.receiptJson, null);
  },

  listModelUsageReceipts(runId) {
    const rows = db.prepare(`
      SELECT receipt_json as receiptJson
      FROM model_usage_receipts
      WHERE run_id=?
      ORDER BY rowid ASC
    `).all(runId) as Array<{ receiptJson?: string | null }>;
    return rows
      .map((row) => parseJson<ModelUsageReceipt | null>(row.receiptJson, null))
      .filter((value): value is ModelUsageReceipt => Boolean(value));
  },

  persistRouteAdmission(runId, admission) {
    db.prepare(`
      INSERT INTO route_admissions(
        admission_id, run_id, attempt_id, step_id, decision_id, capsule_id,
        requested_json, resolved_json, policy_json, economics_json, decision,
        rejection_code, digest, admission_json, created_at
      )
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(admission_id) DO NOTHING
    `).run(
      String(admission.admissionId),
      runId,
      admission.attemptId ? String(admission.attemptId) : null,
      admission.stepId ? String(admission.stepId) : null,
      admission.decisionId ? String(admission.decisionId) : null,
      admission.capsuleId ? String(admission.capsuleId) : null,
      JSON.stringify(admission.requested ?? null),
      JSON.stringify(admission.resolved ?? null),
      JSON.stringify(admission.policy ?? null),
      JSON.stringify(admission.economics ?? null),
      admission.decision ? String(admission.decision) : null,
      admission.rejectionCode ? String(admission.rejectionCode) : null,
      admission.digest ? String(admission.digest) : null,
      serialize(admission),
      admission.createdAt ? String(admission.createdAt) : new Date().toISOString(),
    );
  },

  getRouteAdmission(admissionId, runId = null) {
    const row = db.prepare(`
      SELECT run_id as runId, admission_json as admissionJson
      FROM route_admissions
      WHERE admission_id=?
    `).get(admissionId) as { runId?: string; admissionJson?: string | null } | undefined;
    if (!row) return null;
    if (runId && row.runId !== runId) return null;
    return parseJson<UnknownRecord | null>(row.admissionJson, null);
  },

  listRouteAdmissions(runId, decisionId = null) {
    const rows = (decisionId
      ? db.prepare(`
          SELECT admission_json as admissionJson
          FROM route_admissions
          WHERE run_id=? AND decision_id=?
          ORDER BY rowid ASC
        `).all(runId, decisionId)
      : db.prepare(`
          SELECT admission_json as admissionJson
          FROM route_admissions
          WHERE run_id=?
          ORDER BY rowid ASC
        `).all(runId)) as Array<{ admissionJson?: string | null }>;
    return rows
      .map((row) => parseJson<UnknownRecord | null>(row.admissionJson, null))
      .filter((value): value is UnknownRecord => Boolean(value));
  },

  recordGitCloseoutReceipt(runId, receipt) {
    const createdAt = now();
    db.prepare(`
      INSERT INTO git_closeout_receipts(
        run_id, project_id, mode, commit_sha, branch, remote,
        push_status, parity, status, before_head_sha, selected_paths_json,
        error_code, error_message, receipt_json, created_at, updated_at
      )
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET
        mode=excluded.mode,
        commit_sha=excluded.commit_sha,
        branch=excluded.branch,
        remote=excluded.remote,
        push_status=excluded.push_status,
        parity=excluded.parity,
        status=excluded.status,
        before_head_sha=excluded.before_head_sha,
        selected_paths_json=excluded.selected_paths_json,
        error_code=excluded.error_code,
        error_message=excluded.error_message,
        receipt_json=excluded.receipt_json,
        updated_at=excluded.updated_at
    `).run(
      runId,
      receipt.projectId ? String(receipt.projectId) : null,
      receipt.mode ? String(receipt.mode) : null,
      receipt.commitSha ? String(receipt.commitSha) : null,
      receipt.branch ? String(receipt.branch) : null,
      receipt.remote ? String(receipt.remote) : 'origin',
      receipt.pushStatus ? String(receipt.pushStatus) : null,
      receipt.parity ? String(receipt.parity) : null,
      receipt.status ? String(receipt.status) : 'completed',
      receipt.beforeHeadSha ? String(receipt.beforeHeadSha) : null,
      JSON.stringify(Array.isArray(receipt.selectedPaths) ? receipt.selectedPaths : []),
      receipt.errorCode ? String(receipt.errorCode) : null,
      receipt.errorMessage ? String(receipt.errorMessage) : null,
      typeof receipt.receiptJson === 'string'
        ? receipt.receiptJson
        : serialize(receipt.receiptJson || {}),
      createdAt,
      createdAt,
    );
  },

  getGitCloseoutReceipt(runId) {
    const row = db.prepare(`
      SELECT run_id as runId,
        project_id as projectId,
        mode,
        commit_sha as commitSha,
        branch,
        remote,
        push_status as pushStatus,
        parity,
        status,
        before_head_sha as beforeHeadSha,
        selected_paths_json as selectedPathsJson,
        error_code as errorCode,
        error_message as errorMessage,
        receipt_json as receiptJson,
        created_at as createdAt,
        updated_at as updatedAt
      FROM git_closeout_receipts
      WHERE run_id=?
    `).get(runId) as (Omit<StoredGitCloseoutReceipt, 'selectedPaths' | 'receiptJson'> & { selectedPathsJson: string | null; receiptJson: string | null }) | undefined;
    if (!row) return null;
    return {
      ...row,
      receiptJson: parseJson<UnknownRecord>(row.receiptJson, {}),
      selectedPaths: parseJson<string[]>(row.selectedPathsJson, []),
    };
  },

  getLatestImplementationSession(runId) {
    const row = db.prepare(`
      SELECT u.receipt_id as receiptId,
        u.actor_session_id as actorSessionId,
        u.decision_id as decisionId,
        u.attempt_id as attemptId,
        u.binding_id as bindingId,
        u.step_id as stepId,
        u.capsule_id as capsuleId,
        u.capsule_digest as capsuleDigest,
        u.resolved_model as resolvedModel,
        d.model_class as modelClass,
        d.action_kind as actionKind
      FROM model_usage_receipts u
      JOIN model_route_decisions d ON d.decision_id=u.decision_id
      WHERE u.run_id=? AND d.role='implementer'
      ORDER BY u.rowid DESC
      LIMIT 1
    `).get(runId) as ImplementationSession | undefined;
    return row || null;
  },
});
