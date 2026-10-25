export type ReusableVerification = Pick<PersistedVerification, 'id' | 'runId' | 'obligationId' | 'status' | 'evidenceRef' | 'verifiedMutationRevision' | 'sourceIdentity' | 'verifiedSourceIdentity' | 'executor' | 'command' | 'exitCode' | 'evidenceDigest' | 'contractRevision' | 'observedAt'> & { projectId: string; evidenceIdentity: UnknownRecord };
import type { ReviewReceipt } from '../proof/review-receipt.js';
import type { SqliteDatabase } from '../sqlite-adapter.js';

type UnknownRecord = Record<string, unknown>;

export interface PersistVerificationInput {
  runId: string;
  obligationId: string;
  status: 'passed' | 'failed';
  evidenceRef: string | null;
  verifiedRuntimeRevision: number;
  verifiedMutationRevision: number;
  sourceIdentity: string;
  verifiedSourceIdentity: string | null;
  executor: string;
  networkIsolation: string | null;
  commandRef: string | null;
  command: string | null;
  exitCode: number;
  evidenceDigest: string | null;
  acceptanceCoverage: string[];
  evidenceClass: string;
  contractRevision: number;
  evidenceIdentity: UnknownRecord;
  reuseOfVerificationId: number | null;
  reuseReceipt: UnknownRecord | null;
}

export interface EvidencePackInput {
  runId: string;
  tier: string;
  digest: string;
  pack: UnknownRecord;
  mutationRevision: number;
}

export interface CompletionDecisionInput {
  runId: string;
  decision: string;
  sourceIdentity: string;
  mutationRevision: number;
  evidenceDigest: string;
  decisionJson: UnknownRecord;
}

export interface ReviewReceiptPersistenceInput {
  runId: string;
  subjectKey: string | null;
  receipt: ReviewReceipt;
  rationale: string;
}

export interface RunObligationInput {
  runId: string;
  obligationId: string;
  sourceType: string;
  sourceRef: string | null;
  status: string;
  evidenceClass: string;
  verificationMethod: string | null;
  allowedCommandRefs: string[];
  acceptanceIds: string[];
  protected: boolean;
  contractRevision: number;
}

export interface DeclaredRunObligationInput {
  obligationId: string;
  sourceType?: string | null;
  sourceRef?: string | null;
  evidenceClass?: string | null;
  verificationMethod?: string | null;
  allowedCommandRefs?: string[];
  rejectedCommandRefs?: Array<{ commandRef: string; reason: string }>;
  acceptanceIds?: string[];
  protected?: boolean;
  contractRevision?: number;
  metadata?: UnknownRecord;
}

export interface WaiverPersistenceInput {
  runId: string;
  obligationId: string;
  approvedBy: string;
  reason: string;
  approvalReceipt: string;
  acceptanceCoverage: string[];
}

export interface PersistedVerification extends Omit<VerificationRow, 'acceptanceCoverage'>, UnknownRecord {
  acceptanceCoverage: string[];
  evidenceIdentity: UnknownRecord;
  reuseReceipt: UnknownRecord | null;
}
export interface PersistedRunObligation extends UnknownRecord {
  runId: string; obligationId: string; sourceType: string; sourceRef: string | null;
  status: string; evidenceClass: string; verificationMethod: string | null;
  allowedCommandRefs: string[]; rejectedCommandRefs: Array<{ commandRef: string; reason: string }>; acceptanceIds: string[];
  protected: boolean; contractRevision: number; metadata: UnknownRecord & { evidencePlanCommandBinding?: boolean; commandCandidates?: Array<{ sourceType?: string | null; sourceRef?: string | null; commandRefs?: string[] }>; scopeCandidates?: Array<{ sourceType?: string | null; sourceRef?: string | null; scope?: string[]; freshnessInputs?: string[] }> }; satisfiable: boolean;
}
export interface PersistedWaiver extends UnknownRecord {
  id: number; runId: string; obligationId: string; approvedBy: string; reason: string;
  approvedAt: string; approvalReceipt: string | null; acceptanceCoverage: string[];
}
export interface PersistedEvidencePack extends UnknownRecord { tier: string; digest: string; mutationRevision: number; packJson: string | null; pack: UnknownRecord }

export interface TrustPersistence {
  setRunProofPolicy(runId: string, input: {
    proofTier: string;
    evidenceTier: string;
    requiredObligations: string[];
    releaseEvidenceRequired: boolean;
  }): void;
  setRunBaselineFailures(runId: string, failures: unknown[]): void;
  setRunBaselineStatus(runId: string, status: string): void;
  persistVerification(input: PersistVerificationInput): void;
  recordEvidencePack(input: EvidencePackInput): void;
  recordCompletionDecision(input: CompletionDecisionInput): void;
  getCompletionDecision(runId: string): UnknownRecord | null;
  settleReviewReceipt(input: ReviewReceiptPersistenceInput): ReviewReceipt;
  getReviewReceipt(receiptId: string, runId?: string | null): ReviewReceipt | null;
  listReviewReceipts(runId: string, obligationId?: string | null): ReviewReceipt[];
  ensureRunObligation(input: RunObligationInput): void;
  declareRunObligations(runId: string, obligations: DeclaredRunObligationInput[]): PersistedRunObligation[];
  supersedeRunObligations(runId: string, obligationIds: string[]): void;
  updateVerificationAcceptanceCoverage(id: number, coverage: string[]): void;
  updateWaiverAcceptanceCoverage(id: number, coverage: string[]): void;
  updateReviewReceiptAcceptanceCoverage(
    receiptId: string,
    coverage: string[],
    receipt: UnknownRecord,
  ): void;
  markRunObligationPassed(runId: string, obligationId: string): void;
  getRunObligations(runId: string): PersistedRunObligation[];
  addWaiver(input: WaiverPersistenceInput): UnknownRecord;
  getWaivers(runId: string): PersistedWaiver[];
  getVerifications(runId: string): PersistedVerification[];
  getVerificationHistory(runId: string): PersistedVerification[];
  listReusableVerificationCandidates(input: {
    projectId: string;
    obligationId: string;
    contractRevision?: number | null;
  }): ReusableVerification[];
  getEvidenceLineage(runId: string): UnknownRecord[];
  getLatestEvidencePack(runId: string): PersistedEvidencePack | null;
}

interface VerificationRow {
  id: number;
  runId: string;
  obligationId: string;
  status: string;
  evidenceRef: string | null;
  verifiedRuntimeRevision: number;
  verifiedMutationRevision: number;
  sourceIdentity: string;
  verifiedSourceIdentity: string | null;
  executor: string;
  networkIsolation: string | null;
  commandRef: string | null;
  command: string | null;
  exitCode: number;
  evidenceDigest: string | null;
  acceptanceCoverage: string | null;
  evidenceClass: string | null;
  contractRevision: number | null;
  evidenceIdentityJson: string | null;
  reuseOfVerificationId: number | null;
  reuseReceiptJson: string | null;
  observedAt: string;
}

const asRecord = (value: unknown): UnknownRecord => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : {}
);

const parseJson = <T>(value: unknown, fallback: T): T => {
  if (typeof value !== 'string' || !value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

const verificationProjection = (row: VerificationRow): PersistedVerification => ({
  ...row,
  acceptanceCoverage: parseJson<string[]>(row.acceptanceCoverage, []),
  evidenceIdentity: parseJson<UnknownRecord>(row.evidenceIdentityJson, {}),
  reuseReceipt: row.reuseReceiptJson
    ? parseJson<UnknownRecord | null>(row.reuseReceiptJson, null)
    : null,
});

type VerificationSelectionRecord = {
  id: number;
  runId: string;
  obligationId: string;
  executor?: unknown;
  evidenceIdentity?: unknown;
};

const evidenceIdentityDigest = (verification: VerificationSelectionRecord): string | null => {
  const identity = asRecord(verification.evidenceIdentity);
  const digest = typeof identity.digest === 'string' ? identity.digest : '';
  const freshnessInputs = Array.isArray(identity.freshnessInputs) ? identity.freshnessInputs : [];
  const values = asRecord(identity.values);
  return /^sha256:[a-f0-9]{64}$/u.test(digest)
    && freshnessInputs.length > 0
    && Object.keys(values).length > 0
    ? digest
    : null;
};

const verificationAuthority = (verification: VerificationSelectionRecord): number => (
  verification.executor === 'kernel-runtime' ? 2 : 1
);

const preferCurrentVerification = <T extends VerificationSelectionRecord>(
  current: T,
  candidate: T,
): T => {
  const currentIdentity = evidenceIdentityDigest(current);
  const candidateIdentity = evidenceIdentityDigest(candidate);

  // Evidence generations are comparable only when they share one normalized
  // Evidence Identity. A newly observed identity becomes the current
  // generation; Trust Authority then decides whether it is fresh enough to
  // satisfy completion.
  if (currentIdentity && candidateIdentity && currentIdentity !== candidateIdentity) {
    return candidate;
  }

  // Missing identity is a weaker/unobserved statement. Once an identity-bound
  // generation exists, it cannot be replaced by a row that cannot establish
  // which evidence generation it describes.
  if (currentIdentity && !candidateIdentity) return current;
  if (!currentIdentity && candidateIdentity) return candidate;

  // Within one Evidence Identity (or the legacy identity-less generation),
  // only equal-or-stronger authority may advance the current projection.
  return verificationAuthority(candidate) >= verificationAuthority(current)
    ? candidate
    : current;
};

const selectCurrentVerifications = <T extends VerificationSelectionRecord>(rows: T[]): T[] => {
  const current = new Map<string, T>();
  for (const row of rows) {
    const key = JSON.stringify([row.runId, row.obligationId]);
    const previous = current.get(key);
    current.set(key, previous ? preferCurrentVerification(previous, row) : row);
  }
  return [...current.values()].sort((left, right) => left.id - right.id);
};

const verificationSelect = `
  SELECT id,
    run_id as runId,
    obligation_id as obligationId,
    status,
    evidence_ref as evidenceRef,
    verified_runtime_revision as verifiedRuntimeRevision,
    verified_mutation_revision as verifiedMutationRevision,
    source_identity as sourceIdentity,
    verified_source_identity as verifiedSourceIdentity,
    executor,
    network_isolation as networkIsolation,
    command_ref as commandRef,
    command,
    exit_code as exitCode,
    evidence_digest as evidenceDigest,
    acceptance_coverage as acceptanceCoverage,
    evidence_class as evidenceClass,
    contract_revision as contractRevision,
    evidence_identity_json as evidenceIdentityJson,
    reuse_of_verification_id as reuseOfVerificationId,
    reuse_receipt_json as reuseReceiptJson,
    observed_at as observedAt
  FROM verifications
`;

export const createTrustPersistence = ({
  db,
  now = () => new Date().toISOString(),
  serialize = (value: unknown) => JSON.stringify(value),
}: {
  db: SqliteDatabase;
  now?: () => string;
  serialize?: (value: unknown) => string;
}): TrustPersistence => {
  const persistVerification = db.transaction((input: PersistVerificationInput) => {
    const observedAt = now();
    db.prepare(`
      INSERT INTO verifications(
        run_id, obligation_id, status, evidence_ref,
        verified_runtime_revision, verified_mutation_revision,
        source_identity, verified_source_identity, executor, network_isolation,
        command_ref, command, exit_code, evidence_digest, acceptance_coverage,
        evidence_class, contract_revision, evidence_identity_json,
        reuse_of_verification_id, reuse_receipt_json, observed_at
      )
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.runId,
      input.obligationId,
      input.status,
      input.evidenceRef,
      input.verifiedRuntimeRevision,
      input.verifiedMutationRevision,
      input.sourceIdentity,
      input.verifiedSourceIdentity,
      input.executor,
      input.networkIsolation,
      input.commandRef,
      input.command,
      input.exitCode,
      input.evidenceDigest,
      JSON.stringify(input.acceptanceCoverage),
      input.evidenceClass,
      input.contractRevision,
      serialize(input.evidenceIdentity),
      input.reuseOfVerificationId,
      input.reuseReceipt ? serialize(input.reuseReceipt) : null,
      observedAt,
    );

    if (input.evidenceDigest && /^sha256:[a-f0-9]{64}$/i.test(input.evidenceDigest)) {
      db.prepare(
        'INSERT INTO evidence_lineage(run_id, evidence_digest, created_at) VALUES(?, ?, ?)',
      ).run(input.runId, input.evidenceDigest, observedAt);
    }

    if (input.status === 'passed') {
      db.prepare(
        'UPDATE run_obligations SET status=\'passed\', updated_at=? WHERE run_id=? AND obligation_id=?',
      ).run(observedAt, input.runId, input.obligationId);
    }

    db.prepare(
      'UPDATE runs SET revision=revision+1, updated_at=? WHERE run_id=?',
    ).run(observedAt, input.runId);
  });

  const getVerifications = (runId: string): PersistedVerification[] => (
    selectCurrentVerifications(
      db.prepare(`
        ${verificationSelect}
        WHERE run_id=?
        ORDER BY id ASC
      `).all(runId)
        .map((row) => verificationProjection(row as VerificationRow)),
    )
  );

  const getVerificationHistory = (runId: string): PersistedVerification[] => (
    db.prepare(`${verificationSelect} WHERE run_id=? ORDER BY id ASC`)
      .all(runId)
      .map((row) => verificationProjection(row as VerificationRow))
  );

  const listReusableVerificationCandidates:
    TrustPersistence['listReusableVerificationCandidates'] = ({
      projectId,
      obligationId,
      contractRevision = null,
    }) => {
      const contractClause = contractRevision === null || contractRevision === undefined
        ? ''
        : ' AND v.contract_revision=?';
      const params: Array<string | number> = contractRevision === null || contractRevision === undefined
        ? [projectId, obligationId]
        : [projectId, obligationId, Number(contractRevision)];
      const rows = db.prepare(`
        SELECT v.id, v.run_id as runId, v.obligation_id as obligationId, v.status,
          v.evidence_ref as evidenceRef,
          v.verified_mutation_revision as verifiedMutationRevision,
          v.source_identity as sourceIdentity,
          v.verified_source_identity as verifiedSourceIdentity,
          v.executor, v.command, v.exit_code as exitCode,
          v.evidence_digest as evidenceDigest,
          v.evidence_identity_json as evidenceIdentityJson,
          v.contract_revision as contractRevision,
          v.observed_at as observedAt,
          r.project_id as projectId
        FROM verifications v
        JOIN runs r ON r.run_id=v.run_id
        WHERE r.project_id=? AND v.obligation_id=?
          ${contractClause}
        ORDER BY v.id ASC
      `).all(...params) as Array<Omit<ReusableVerification, 'evidenceIdentity'> & {
        evidenceIdentityJson?: string | null;
      }>;
      return selectCurrentVerifications(rows.map((row) => ({
        ...row,
        evidenceIdentity: parseJson<UnknownRecord>(row.evidenceIdentityJson, {}),
      })))
        .filter((row) => (
          row.status === 'passed'
          && row.exitCode === 0
          && Boolean(row.evidenceDigest)
        ))
        .sort((left, right) => right.id - left.id);
    };

  return {
    setRunProofPolicy(runId, input) {
      db.prepare(`
        UPDATE runs
        SET proof_tier=?, evidence_tier=?, required_obligations=?,
            release_evidence_required=?, revision=revision+1, updated_at=?
        WHERE run_id=?
      `).run(
        input.proofTier,
        input.evidenceTier,
        JSON.stringify(input.requiredObligations),
        input.releaseEvidenceRequired ? 1 : 0,
        now(),
        runId,
      );
    },

    setRunBaselineFailures(runId, failures) {
      db.prepare(
        'UPDATE runs SET baseline_failures=?, updated_at=? WHERE run_id=?',
      ).run(JSON.stringify(failures), now(), runId);
    },

    setRunBaselineStatus(runId, status) {
      db.prepare(
        'UPDATE runs SET baseline_status=?, updated_at=? WHERE run_id=?',
      ).run(String(status), now(), runId);
    },

    persistVerification,

    recordEvidencePack({ runId, tier, digest, pack, mutationRevision }) {
      db.prepare(`
        INSERT INTO evidence_packs(run_id, tier, digest, pack_json, mutation_revision, created_at)
        VALUES(?, ?, ?, ?, ?, ?)
      `).run(runId, tier, digest, JSON.stringify(pack), mutationRevision, now());
    },

    recordCompletionDecision({
      runId,
      decision,
      sourceIdentity,
      mutationRevision,
      evidenceDigest,
      decisionJson,
    }) {
      db.prepare(`
        INSERT INTO completion_decisions(
          run_id, decision, source_identity, mutation_revision,
          evidence_digest, decision_json, created_at
        )
        VALUES(?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET
          decision=excluded.decision,
          source_identity=excluded.source_identity,
          mutation_revision=excluded.mutation_revision,
          evidence_digest=excluded.evidence_digest,
          decision_json=excluded.decision_json,
          created_at=excluded.created_at
      `).run(
        runId,
        decision,
        sourceIdentity,
        mutationRevision,
        evidenceDigest,
        serialize(decisionJson),
        now(),
      );
    },

    getCompletionDecision(runId) {
      const row = db.prepare(`
        SELECT run_id as runId,
          decision,
          source_identity as sourceIdentity,
          mutation_revision as mutationRevision,
          evidence_digest as evidenceDigest,
          decision_json as decisionJson,
          created_at as createdAt
        FROM completion_decisions
        WHERE run_id=?
      `).get(runId) as (UnknownRecord & { decisionJson?: string | null }) | undefined;
      if (!row) return null;
      return {
        ...row,
        decisionJson: parseJson<UnknownRecord>(row.decisionJson, {}),
      };
    },

    settleReviewReceipt({ runId, subjectKey, receipt, rationale }) {
      const reviewer = asRecord(receipt.reviewer);
      const implementer = asRecord(receipt.implementer);
      const subject = asRecord(receipt.subject);

      if (subjectKey) {
        const adopted = db.prepare(`
          SELECT receipt_json as receiptJson
          FROM review_receipts
          WHERE run_id=? AND review_subject_key=?
          LIMIT 1
        `).get(runId, subjectKey) as { receiptJson?: string | null } | undefined;
        if (adopted?.receiptJson) {
          return parseJson<ReviewReceipt>(adopted.receiptJson, receipt);
        }
      }

      db.prepare(`
        INSERT INTO review_receipts(
          receipt_id, run_id, obligation_id, review_subject_key, step_id,
          reviewer_binding_id, implementer_attempt_id, review_stage, verdict,
          finding_class, plan_revision, reviewer_usage_receipt_id,
          implementer_usage_receipt_id, reviewer_session_id,
          implementer_session_id, route_decision_id, model_class,
          resolved_model, enforcement_status, workspace_identity,
          mutation_revision, changed_paths_digest, evidence_digest,
          acceptance_coverage_json, findings_json, rationale, digest,
          receipt_json, created_by_version, migration_origin, created_at
        )
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT DO NOTHING
      `).run(
        String(receipt.receiptId),
        runId,
        String(receipt.obligationId),
        subjectKey,
        receipt.stepId ? String(receipt.stepId) : null,
        receipt.reviewerBindingId ? String(receipt.reviewerBindingId) : null,
        receipt.implementerAttemptId ? String(receipt.implementerAttemptId) : null,
        String(receipt.reviewStage),
        String(receipt.verdict),
        String(receipt.findingClass),
        Number(receipt.planRevision),
        reviewer.usageReceiptId ? String(reviewer.usageReceiptId) : null,
        implementer.usageReceiptId ? String(implementer.usageReceiptId) : null,
        reviewer.actorSessionId ? String(reviewer.actorSessionId) : null,
        implementer.actorSessionId ? String(implementer.actorSessionId) : null,
        reviewer.routeDecisionId ? String(reviewer.routeDecisionId) : null,
        reviewer.modelClass ? String(reviewer.modelClass) : null,
        reviewer.resolvedModel ? String(reviewer.resolvedModel) : null,
        reviewer.enforcementStatus ? String(reviewer.enforcementStatus) : null,
        subject.workspaceIdentity ? String(subject.workspaceIdentity) : null,
        Number(subject.mutationRevision),
        subject.changedPathsDigest ? String(subject.changedPathsDigest) : null,
        subject.evidenceDigest ? String(subject.evidenceDigest) : null,
        JSON.stringify(Array.isArray(receipt.acceptanceCoverage) ? receipt.acceptanceCoverage : []),
        JSON.stringify(Array.isArray(receipt.findings) ? receipt.findings : []),
        rationale,
        String(receipt.digest),
        serialize(receipt),
        receipt.createdByVersion ? String(receipt.createdByVersion) : null,
        receipt.migrationOrigin ? String(receipt.migrationOrigin) : null,
        receipt.createdAt ? String(receipt.createdAt) : now(),
      );

      const settled = subjectKey
        ? db.prepare(`
            SELECT receipt_json as receiptJson
            FROM review_receipts
            WHERE run_id=? AND review_subject_key=?
            LIMIT 1
          `).get(runId, subjectKey)
        : db.prepare(`
            SELECT receipt_json as receiptJson
            FROM review_receipts
            WHERE receipt_id=?
            LIMIT 1
          `).get(String(receipt.receiptId));
      const row = settled as { receiptJson?: string | null } | undefined;
      return row?.receiptJson
        ? parseJson<ReviewReceipt>(row.receiptJson, receipt)
        : receipt;
    },

    getReviewReceipt(receiptId, runId = null) {
      const row = db.prepare(`
        SELECT run_id as runId, receipt_json as receiptJson
        FROM review_receipts
        WHERE receipt_id=?
      `).get(receiptId) as { runId?: string; receiptJson?: string | null } | undefined;
      if (!row) return null;
      if (runId && row.runId !== runId) return null;
      return parseJson<ReviewReceipt | null>(row.receiptJson, null);
    },

    listReviewReceipts(runId, obligationId = null) {
      const rows = obligationId
        ? db.prepare(`
            SELECT receipt_json as receiptJson
            FROM review_receipts
            WHERE run_id=? AND obligation_id=?
            ORDER BY rowid ASC
          `).all(runId, obligationId)
        : db.prepare(`
            SELECT receipt_json as receiptJson
            FROM review_receipts
            WHERE run_id=?
            ORDER BY rowid ASC
          `).all(runId);
      return rows
        .map((row) => parseJson<ReviewReceipt | null>(
          (row as { receiptJson?: string | null }).receiptJson,
          null,
        ))
        .filter((receipt): receipt is ReviewReceipt => Boolean(receipt && Object.keys(receipt).length > 0));
    },

    ensureRunObligation({
      runId,
      obligationId,
      sourceType,
      sourceRef,
      status,
      evidenceClass,
      verificationMethod,
      allowedCommandRefs,
      acceptanceIds,
      protected: isProtected,
      contractRevision,
    }) {
      db.prepare(`
        INSERT INTO run_obligations(
          run_id, obligation_id, source_type, source_ref, status,
          evidence_class, verification_method, allowed_command_refs,
          acceptance_ids, protected, contract_revision, created_at, updated_at
        )
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id, obligation_id) DO NOTHING
      `).run(
        runId,
        obligationId,
        sourceType,
        sourceRef,
        status,
        evidenceClass,
        verificationMethod,
        JSON.stringify(allowedCommandRefs),
        JSON.stringify(acceptanceIds),
        isProtected ? 1 : 0,
        contractRevision,
        now(),
        now(),
      );
    },

    declareRunObligations(runId, obligations) {
      const upsert = db.prepare(`
        INSERT INTO run_obligations(
          run_id, obligation_id, source_type, source_ref, status,
          evidence_class, verification_method, allowed_command_refs,
          rejected_command_refs, acceptance_ids, protected,
          contract_revision, metadata_json, created_at, updated_at
        )
        VALUES(?, ?, ?, ?, 'required', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id, obligation_id) DO UPDATE SET
          source_type=excluded.source_type,
          source_ref=excluded.source_ref,
          status='required',
          evidence_class=excluded.evidence_class,
          verification_method=excluded.verification_method,
          allowed_command_refs=excluded.allowed_command_refs,
          rejected_command_refs=excluded.rejected_command_refs,
          acceptance_ids=excluded.acceptance_ids,
          protected=excluded.protected,
          contract_revision=excluded.contract_revision,
          metadata_json=excluded.metadata_json,
          updated_at=excluded.updated_at
      `);
      for (const obligation of obligations) {
        upsert.run(
          runId,
          obligation.obligationId,
          obligation.sourceType || 'proof-policy',
          obligation.sourceRef || null,
          obligation.evidenceClass || 'hard',
          obligation.verificationMethod || null,
          JSON.stringify(obligation.allowedCommandRefs || []),
          JSON.stringify(obligation.rejectedCommandRefs || []),
          JSON.stringify(obligation.acceptanceIds || []),
          obligation.protected ? 1 : 0,
          Number(obligation.contractRevision) || 1,
          JSON.stringify(obligation.metadata || {}),
          now(),
          now(),
        );
      }
      return this.getRunObligations(runId);
    },

    supersedeRunObligations(runId, obligationIds) {
      if (!Array.isArray(obligationIds) || obligationIds.length === 0) return;
      const placeholders = obligationIds.map(() => '?').join(', ');
      db.prepare(
        `UPDATE run_obligations
         SET status='superseded', updated_at=?
         WHERE run_id=? AND obligation_id IN (${placeholders})`,
      ).run(now(), runId, ...obligationIds);
    },

    updateVerificationAcceptanceCoverage(id, coverage) {
      db.prepare(
        'UPDATE verifications SET acceptance_coverage=? WHERE id=?',
      ).run(JSON.stringify(coverage), Number(id));
    },

    updateWaiverAcceptanceCoverage(id, coverage) {
      db.prepare(
        'UPDATE waivers SET acceptance_coverage=? WHERE id=?',
      ).run(JSON.stringify(coverage), Number(id));
    },

    updateReviewReceiptAcceptanceCoverage(receiptId, coverage, receipt) {
      db.prepare(
        'UPDATE review_receipts SET acceptance_coverage_json=?, receipt_json=? WHERE receipt_id=?',
      ).run(JSON.stringify(coverage), serialize(receipt), receiptId);
    },

    markRunObligationPassed(runId, obligationId) {
      db.prepare(`
        UPDATE run_obligations
        SET status='passed', updated_at=?
        WHERE run_id=? AND obligation_id=?
      `).run(now(), runId, obligationId);
    },

    getRunObligations(runId) {
      const rows = db.prepare(`
        SELECT run_id as runId,
          obligation_id as obligationId,
          source_type as sourceType,
          source_ref as sourceRef,
          status,
          evidence_class as evidenceClass,
          verification_method as verificationMethod,
          allowed_command_refs as allowedCommandRefs,
          rejected_command_refs as rejectedCommandRefs,
          acceptance_ids as acceptanceIds,
          protected,
          contract_revision as contractRevision,
          metadata_json as metadataJson,
          created_at as createdAt,
          updated_at as updatedAt
        FROM run_obligations
        WHERE run_id=?
      `).all(runId) as Array<Pick<PersistedRunObligation, 'runId' | 'obligationId' | 'sourceType' | 'sourceRef' | 'status' | 'evidenceClass' | 'verificationMethod' | 'contractRevision'> & { allowedCommandRefs: string | null; rejectedCommandRefs: string | null; acceptanceIds: string | null; metadataJson: string | null; protected: number }>;

      return rows.map((row) => {
        const allowedCommandRefs = parseJson<string[]>(row.allowedCommandRefs, []);
        const evidenceClass = String(row.evidenceClass || '');
        return {
          ...row,
          allowedCommandRefs,
          rejectedCommandRefs: parseJson<Array<{ commandRef: string; reason: string }>>(row.rejectedCommandRefs, []),
          acceptanceIds: parseJson<string[]>(row.acceptanceIds, []),
          metadata: parseJson<UnknownRecord>(row.metadataJson, {}),
          protected: Boolean(row.protected),
          satisfiable: evidenceClass === 'judgment' || allowedCommandRefs.length > 0,
        };
      });
    },

    addWaiver({
      runId,
      obligationId,
      approvedBy,
      reason,
      approvalReceipt,
      acceptanceCoverage,
    }) {
      db.prepare(`
        INSERT INTO waivers(
          run_id, obligation_id, approved_by, reason,
          approved_at, approval_receipt, acceptance_coverage
        )
        VALUES(?, ?, ?, ?, ?, ?, ?)
      `).run(
        runId,
        obligationId,
        approvedBy,
        reason,
        now(),
        approvalReceipt,
        JSON.stringify(acceptanceCoverage),
      );
      return this.getWaivers(runId).at(-1) || {};
    },

    getWaivers(runId) {
      return db.prepare(`
        SELECT id,
          run_id as runId,
          obligation_id as obligationId,
          approved_by as approvedBy,
          reason,
          approved_at as approvedAt,
          approval_receipt as approvalReceipt,
          acceptance_coverage as acceptanceCoverage
        FROM waivers
        WHERE run_id=?
        ORDER BY id ASC
      `).all(runId).map((row) => {
        const waiver = row as Pick<PersistedWaiver, 'id' | 'runId' | 'obligationId' | 'approvedBy' | 'reason' | 'approvedAt' | 'approvalReceipt'> & { acceptanceCoverage: string | null };
        return {
          ...waiver,
          acceptanceCoverage: parseJson<string[]>(waiver.acceptanceCoverage, []),
        };
      });
    },

    getVerifications,
    getVerificationHistory,
    listReusableVerificationCandidates,

    getEvidenceLineage(runId) {
      return db.prepare(`
        SELECT id, run_id as runId, evidence_digest as evidenceDigest,
          parent_digest as parentDigest, created_at as createdAt
        FROM evidence_lineage WHERE run_id=? ORDER BY id ASC
      `).all(runId) as UnknownRecord[];
    },

    getLatestEvidencePack(runId) {
      const row = db.prepare(`
        SELECT tier, digest, mutation_revision as mutationRevision, pack_json as packJson
        FROM evidence_packs WHERE run_id=? ORDER BY id DESC LIMIT 1
      `).get(runId) as Pick<PersistedEvidencePack, 'tier' | 'digest' | 'mutationRevision' | 'packJson'> | undefined;
      if (!row) return null;
      return {
        ...row,
        packJson: row.packJson,
        pack: parseJson<UnknownRecord>(row.packJson, {}),
      };
    },
  };
};
