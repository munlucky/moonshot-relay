import { createHash, randomUUID } from 'node:crypto';
import type { SqliteDatabase } from '../sqlite-adapter.js';
import { mapCandidateToCanonicalRecord } from '../knowledge/canonical-record-mapper.js';
import { canonicalKnowledgeIdentity } from '../knowledge/identity.js';

type UnknownRecord = Record<string, unknown>;

const knowledgeIdentity = canonicalKnowledgeIdentity;
// Persisted records and submitted candidates must use the same full semantic
// identity. A shared statement/scope cannot collapse distinct proof commands.
const persistedRecordIdentity = (record: UnknownRecord, recordType: unknown): string => knowledgeIdentity({
  recordType,
  statement: record.statement,
  scope: strings(record.scope),
  practiceJson: record.practiceJson,
  verification: record.verification,
  obligation: record.obligation,
  obligationId: record.obligationId,
  obligationIds: record.obligationIds,
});

export interface KnowledgeRunLike extends UnknownRecord {
  runId?: string;
  projectId?: string | null;
}

export interface CompletionDecisionLike extends UnknownRecord {
  decision?: unknown;
  evidenceDigest?: unknown;
}

export interface KnowledgeLifecycleStoreDeps {
  db: SqliteDatabase;
  now?: () => string;
  serialize?: (value: unknown) => string;
  getRun: (runId: string) => KnowledgeRunLike | null;
  getCompletionDecision: (runId: string) => CompletionDecisionLike | null;
}

interface KnowledgeContextRow {
  runId: string;
  stage: string;
  knowledgeRevision: string | number | null;
  digest: string | null;
  receiptJson: string | null;
  createdAt: string;
}

interface KnowledgeCandidateRow {
  candidateId: string;
  runId: string;
  projectId: string;
  proposedType: string;
  status: string;
  candidateJson: string | null;
  createdAt: string;
}

interface KnowledgeReviewRow {
  runId: string;
  projectId: string;
  status: string;
  candidateCount: number;
  verifiedCount: number;
  rejectedCount: number;
  waitingApprovalCount: number;
  waitingVerificationCount: number;
  reviewDigest: string | null;
  receiptJson: string | null;
  createdAt: string;
  updatedAt: string;
}

interface KnowledgeCommitRow {
  runId: string;
  projectId: string;
  revisionBefore: string | null;
  revisionAfter: string | null;
  status: string;
  receiptJson: string | null;
  createdAt: string;
}

interface RevisionRow {
  revision?: number | string | null;
}

interface ChangeResult {
  changes?: number;
}

interface KnowledgeRecordRow {
  recordJson?: string | null;
  record_id?: string;
  record_type?: string;
}

export interface KnowledgeLifecycleStore {
  setRunKnowledgeStatus(runId: string, status: string): void;
  recordKnowledgeContextReceipt(runId: string, input: UnknownRecord): void;
  getKnowledgeContextReceipt(runId: string, stage: string): (Omit<KnowledgeContextRow, 'receiptJson'> & { receiptJson: UnknownRecord }) | null;
  recordKnowledgeCandidate(candidateId: string, runId: string, input: UnknownRecord): void;
  getKnowledgeCandidates(runId: string): UnknownRecord[];
  recordCandidateEvidenceBinding(input: {
    candidateId: string;
    runId: string;
    evidenceDigest: string;
    obligationId?: string;
    sourceIdentity: string;
    mutationRevision: number;
    bindingType?: string;
  }): void;
  getCandidateEvidenceBindings(runId: string, candidateId?: string | null): UnknownRecord[];
  recordKnowledgeReviewReceipt(runId: string, input: UnknownRecord): void;
  getKnowledgeReviewReceipt(runId: string): UnknownRecord | null;
  recordKnowledgeCommitReceipt(runId: string, input: UnknownRecord): void;
  getKnowledgeCommitReceipt(runId: string): UnknownRecord | null;
  listKnowledgeRecords(input?: { projectId?: string | null | undefined; statuses?: string[] }): UnknownRecord[];
  commitKnowledgeTransaction(input: UnknownRecord): UnknownRecord & { revisionBefore: string; revisionAfter: string };
  getProjectKnowledgeRevision(projectId: string): number;
  getProjectKnowledgeDoctorCounts(projectId: string): { candidateCount: number; committedCount: number };
  updateProjectKnowledgeRevision(projectId: string, expectedRevision: number, nextRevision: number): boolean;
  saveKnowledgeRecord(projectId: string, recordId: string, input?: UnknownRecord): void;
  saveKnowledgeTransaction(transactionId: string, input: UnknownRecord): void;
  recordKnowledgeApproval(approvalId: string, input: UnknownRecord): void;
  getKnowledgeApproval(runId: string, candidateId: string): UnknownRecord | null;
  getKnowledgeApprovals(runId: string): UnknownRecord[];
  getDeferredKnowledgeRuns(
    projectId: string,
    options?: {
      limit?: number;
      excludeRunId?: string | null;
      retryableOnly?: boolean;
    },
  ): UnknownRecord[];
  createKnowledgeImport(input?: UnknownRecord): UnknownRecord;
  updateKnowledgeImport(importId: string, fields?: UnknownRecord): UnknownRecord;
  getKnowledgeImport(importId: string): UnknownRecord | null;
  listKnowledgeImports(input: { projectId: string; statuses?: string[] | null }): UnknownRecord[];
  findKnowledgeImportByDigest(input?: UnknownRecord): UnknownRecord | null;
  appendKnowledgeEvidence(input?: UnknownRecord): UnknownRecord;
  commitImportedKnowledgeTransaction(input?: UnknownRecord): UnknownRecord & { status: string; receipt: UnknownRecord };
}

const parseJson = <T>(value: unknown, fallback: T): T => {
  if (typeof value !== 'string' || !value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

const asRecord = (value: unknown): UnknownRecord => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : {}
);

const strings = (value: unknown): string[] => (
  Array.isArray(value) ? value.map(String) : value ? [String(value)] : []
);

const changeCount = (value: unknown): number => (
  value && typeof value === 'object' && 'changes' in value
    ? Number((value as ChangeResult).changes || 0)
    : 0
);

export const createKnowledgeLifecycleStore = ({
  db,
  now = () => new Date().toISOString(),
  serialize = (value) => JSON.stringify(value),
  getRun,
  getCompletionDecision,
}: KnowledgeLifecycleStoreDeps): KnowledgeLifecycleStore => {
  const getKnowledgeCandidates: KnowledgeLifecycleStore['getKnowledgeCandidates'] = (runId) => (
    db.prepare(`
      SELECT candidate_id as candidateId, run_id as runId, project_id as projectId,
        proposed_type as proposedType, status, candidate_json as candidateJson, created_at as createdAt
      FROM knowledge_candidates WHERE run_id=?
    `).all(runId).map((raw) => {
      const row = raw as KnowledgeCandidateRow;
      return { ...row, candidateJson: parseJson<UnknownRecord>(row.candidateJson, {}) };
    })
  );

  const getKnowledgeReviewReceipt: KnowledgeLifecycleStore['getKnowledgeReviewReceipt'] = (runId) => {
    const row = db.prepare(`
      SELECT run_id as runId, project_id as projectId, status,
        candidate_count as candidateCount, verified_count as verifiedCount,
        rejected_count as rejectedCount, waiting_approval_count as waitingApprovalCount,
        waiting_verification_count as waitingVerificationCount, review_digest as reviewDigest,
        receipt_json as receiptJson, created_at as createdAt, updated_at as updatedAt
      FROM knowledge_review_receipts WHERE run_id=?
    `).get(runId) as KnowledgeReviewRow | undefined;
    return row ? { ...row, receiptJson: parseJson<UnknownRecord>(row.receiptJson, {}) } : null;
  };

  const getProjectKnowledgeRevision: KnowledgeLifecycleStore['getProjectKnowledgeRevision'] = (projectId) => {
    const row = db.prepare(
      'SELECT revision FROM knowledge_revisions WHERE project_id=?',
    ).get(projectId) as RevisionRow | undefined;
    return row?.revision === undefined || row.revision === null ? 1 : Number(row.revision);
  };

  const updateProjectKnowledgeRevision: KnowledgeLifecycleStore['updateProjectKnowledgeRevision'] = (
    projectId,
    expectedRevision,
    nextRevision,
  ) => {
    const existing = db.prepare(
      'SELECT revision FROM knowledge_revisions WHERE project_id=?',
    ).get(projectId) as RevisionRow | undefined;
    if (!existing) {
      db.prepare(
        'INSERT INTO knowledge_revisions(project_id, revision, updated_at) VALUES(?, ?, ?)',
      ).run(projectId, nextRevision, now());
      return true;
    }
    return changeCount(db.prepare(
      'UPDATE knowledge_revisions SET revision=?, updated_at=? WHERE project_id=? AND revision=?',
    ).run(nextRevision, now(), projectId, expectedRevision)) === 1;
  };

  const listKnowledgeRecords: KnowledgeLifecycleStore['listKnowledgeRecords'] = ({
    projectId = null,
    statuses = ['verified', 'committed'],
  } = {}) => {
    if (!projectId) return [];
    const normalizedStatuses = statuses.map(String);
    if (normalizedStatuses.length === 0) return [];
    const placeholders = normalizedStatuses.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT record_json as recordJson FROM knowledge_records WHERE project_id=? AND status IN (${placeholders})`,
    ).all(projectId, ...normalizedStatuses) as Array<{ recordJson?: string | null }>;
    return rows
      .map((row) => parseJson<UnknownRecord | null>(row.recordJson, null))
      .filter((record): record is UnknownRecord => Boolean(record));
  };


  const getKnowledgeImport: KnowledgeLifecycleStore['getKnowledgeImport'] = (importId) => {
    const row = db.prepare(`
      SELECT import_id as importId, project_id as projectId, source_type as sourceType,
        source_identity as sourceIdentity, source_digest as sourceDigest,
        source_snapshot_ref as sourceSnapshotRef, status,
        candidate_count as candidateCount, accepted_count as acceptedCount,
        rejected_count as rejectedCount, approval_ref as approvalRef,
        revision_before as revisionBefore, revision_after as revisionAfter,
        receipt_json as receiptJson, created_at as createdAt, completed_at as completedAt
      FROM knowledge_imports WHERE import_id=?
    `).get(importId) as (UnknownRecord & { receiptJson?: string | null }) | undefined;
    if (!row) return null;
    return { ...row, receiptJson: parseJson<UnknownRecord>(row.receiptJson, {}) };
  };

  const findKnowledgeImportByDigest: KnowledgeLifecycleStore['findKnowledgeImportByDigest'] = (
    input = {},
  ) => {
    const projectId = String(input.projectId || '');
    const sourceType = String(input.sourceType || '');
    const sourceIdentity = String(input.sourceIdentity || '');
    const sourceDigest = String(input.sourceDigest || '');
    const row = db.prepare(`
      SELECT import_id as importId
      FROM knowledge_imports
      WHERE project_id=? AND source_type=? AND source_identity=? AND source_digest=?
    `).get(projectId, sourceType, sourceIdentity, sourceDigest) as { importId?: string } | undefined;
    return row?.importId ? getKnowledgeImport(row.importId) : null;
  };

  const createKnowledgeImport: KnowledgeLifecycleStore['createKnowledgeImport'] = (
    input = {},
  ) => {
    const importId = String(input.importId || `import-${randomUUID()}`);
    const projectId = String(input.projectId || '');
    const sourceType = String(input.sourceType || '');
    const sourceIdentity = String(input.sourceIdentity || '');
    const sourceDigest = String(input.sourceDigest || '');
    const sourceSnapshotRef = input.sourceSnapshotRef ? String(input.sourceSnapshotRef) : null;
    const status = String(input.status || 'discovered');
    const candidateCount = Number(input.candidateCount || 0);
    const approvalRef = input.approvalRef ? String(input.approvalRef) : null;
    if (!projectId || !sourceType || !sourceIdentity || !sourceDigest) {
      throw new Error(
        'createKnowledgeImport requires projectId, sourceType, sourceIdentity, and sourceDigest',
      );
    }
    const existing = findKnowledgeImportByDigest({
      projectId,
      sourceType,
      sourceIdentity,
      sourceDigest,
    });
    if (existing) return existing;
    db.prepare(`
      INSERT INTO knowledge_imports(
        import_id, project_id, source_type, source_identity, source_digest,
        source_snapshot_ref, status, candidate_count, approval_ref, created_at
      )
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      importId,
      projectId,
      sourceType,
      sourceIdentity,
      sourceDigest,
      sourceSnapshotRef,
      status,
      candidateCount,
      approvalRef,
      now(),
    );
    return getKnowledgeImport(importId) || {};
  };

  const updateKnowledgeImport: KnowledgeLifecycleStore['updateKnowledgeImport'] = (
    importId,
    fields = {},
  ) => {
    const current = getKnowledgeImport(importId);
    if (!current) throw new Error(`KNOWLEDGE_IMPORT_NOT_FOUND: ${importId}`);
    const allowed: Readonly<Record<string, unknown>> = {
      status: fields.status,
      candidateCount: fields.candidateCount,
      acceptedCount: fields.acceptedCount,
      rejectedCount: fields.rejectedCount,
      approvalRef: fields.approvalRef,
      revisionBefore: fields.revisionBefore,
      revisionAfter: fields.revisionAfter,
      receiptJson: fields.receiptJson,
      completedAt: fields.completedAt,
      sourceSnapshotRef: fields.sourceSnapshotRef,
    };
    const columnMap: Readonly<Record<string, string>> = {
      candidateCount: 'candidate_count',
      acceptedCount: 'accepted_count',
      rejectedCount: 'rejected_count',
      approvalRef: 'approval_ref',
      revisionBefore: 'revision_before',
      revisionAfter: 'revision_after',
      receiptJson: 'receipt_json',
      completedAt: 'completed_at',
      sourceSnapshotRef: 'source_snapshot_ref',
    };
    const assignments: string[] = [];
    const values: unknown[] = [];
    if (allowed.status !== undefined) {
      assignments.push('status=?');
      values.push(String(allowed.status));
    }
    for (const [key, column] of Object.entries(columnMap)) {
      if (allowed[key] === undefined) continue;
      assignments.push(`${column}=?`);
      values.push(
        key === 'receiptJson' && typeof allowed[key] !== 'string'
          ? serialize(allowed[key])
          : allowed[key],
      );
    }
    if (assignments.length === 0) return current;
    values.push(importId);
    db.prepare(
      `UPDATE knowledge_imports SET ${assignments.join(', ')} WHERE import_id=?`,
    ).run(...values);
    return getKnowledgeImport(importId) || current;
  };

  const listKnowledgeImports: KnowledgeLifecycleStore['listKnowledgeImports'] = ({
    projectId,
    statuses = null,
  }) => {
    const where = ['project_id=?'];
    const values: unknown[] = [projectId];
    if (Array.isArray(statuses) && statuses.length > 0) {
      where.push(`status IN (${statuses.map(() => '?').join(',')})`);
      values.push(...statuses.map(String));
    }
    const rows = db.prepare(`
      SELECT import_id as importId, project_id as projectId, source_type as sourceType,
        source_identity as sourceIdentity, source_digest as sourceDigest,
        source_snapshot_ref as sourceSnapshotRef, status,
        candidate_count as candidateCount, accepted_count as acceptedCount,
        rejected_count as rejectedCount, approval_ref as approvalRef,
        revision_before as revisionBefore, revision_after as revisionAfter,
        receipt_json as receiptJson, created_at as createdAt, completed_at as completedAt
      FROM knowledge_imports
      WHERE ${where.join(' AND ')}
      ORDER BY created_at DESC
    `).all(...values) as Array<UnknownRecord & { receiptJson?: string | null }>;
    return rows.map((row) => ({
      ...row,
      receiptJson: parseJson<UnknownRecord>(row.receiptJson, {}),
    }));
  };

  const appendKnowledgeEvidence: KnowledgeLifecycleStore['appendKnowledgeEvidence'] = (
    input = {},
  ) => {
    const projectId = String(input.projectId || '');
    const recordId = String(input.recordId || '');
    const refs = [...new Set(strings(input.evidenceRefs).filter(Boolean))];
    const expectedKnowledgeRevision = input.expectedKnowledgeRevision ?? null;
    const revisionBefore = getProjectKnowledgeRevision(projectId);
    if (!projectId || !recordId || refs.length === 0) {
      return {
        status: 'no_op',
        revisionBefore,
        revisionAfter: revisionBefore,
      };
    }
    db.exec('BEGIN IMMEDIATE TRANSACTION');
    try {
      const currentRevision = getProjectKnowledgeRevision(projectId);
      if (
        expectedKnowledgeRevision !== null
        && Number(expectedKnowledgeRevision) !== Number(currentRevision)
      ) {
        throw new Error(
          `STALE_KNOWLEDGE_REVISION: Expected revision ${expectedKnowledgeRevision} but found ${currentRevision}`,
        );
      }
      const row = db.prepare(
        'SELECT record_json as recordJson FROM knowledge_records WHERE project_id=? AND record_id=?',
      ).get(projectId, recordId) as { recordJson?: string | null } | undefined;
      if (!row) throw new Error(`KNOWLEDGE_RECORD_NOT_FOUND: ${recordId}`);
      const record = parseJson<UnknownRecord>(row.recordJson, {});
      const evidence = asRecord(record.evidence);
      const oldRefs = strings(evidence.refs ?? record.evidence);
      const merged = [...new Set([...oldRefs, ...refs])];
      if (merged.length === oldRefs.length) {
        db.exec('COMMIT');
        return {
          status: 'no_op',
          revisionBefore: currentRevision,
          revisionAfter: currentRevision,
        };
      }
      const nextRevision = currentRevision + 1;
      const updated = {
        ...record,
        evidence: { ...evidence, refs: merged },
        revision: nextRevision,
        updatedAt: now(),
      };
      db.prepare(`
        UPDATE knowledge_records
        SET record_json=?, revision=?, updated_at=?
        WHERE project_id=? AND record_id=?
      `).run(serialize(updated), nextRevision, now(), projectId, recordId);
      if (!updateProjectKnowledgeRevision(projectId, currentRevision, nextRevision)) {
        throw new Error(
          `STALE_KNOWLEDGE_REVISION: Revision CAS increment failed for ${projectId}`,
        );
      }
      db.exec('COMMIT');
      return {
        status: 'committed',
        revisionBefore: currentRevision,
        revisionAfter: nextRevision,
        recordId,
      };
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  };

  const commitImportedKnowledgeTransaction:
    KnowledgeLifecycleStore['commitImportedKnowledgeTransaction'] = (input = {}) => {
      const importId = String(input.importId || `import-${randomUUID()}`);
      const projectId = String(input.projectId || '');
      const expectedKnowledgeRevision = input.expectedKnowledgeRevision ?? null;
      const candidates = Array.isArray(input.candidates)
        ? input.candidates.map((value) => asRecord(value))
        : [];
      const supersessionProposals = Array.isArray(input.supersessionProposals)
        ? input.supersessionProposals
        : [];
      const sourceReceipt = asRecord(input.sourceReceipt);
      const userApprovalRef = input.userApprovalRef ? String(input.userApprovalRef) : null;
      if (!projectId) throw new Error('PROJECT_ID_REQUIRED');
      if (!userApprovalRef) throw new Error('USER_APPROVAL_REQUIRED');
      const sourceType = String(sourceReceipt.sourceType || 'manual_statement');
      const sourceIdentity = String(
        sourceReceipt.sourceIdentity || sourceReceipt.sourceIdentityDigest || '',
      );
      const sourceDigest = String(sourceReceipt.sourceDigest || '');
      if (!sourceIdentity || !sourceDigest) throw new Error('SOURCE_RECEIPT_REQUIRED');

      const prior = findKnowledgeImportByDigest({
        projectId,
        sourceType,
        sourceIdentity,
        sourceDigest,
      });
      if (prior && ['committed', 'no_op'].includes(String(prior.status || ''))) {
        return { status: 'no_op', import: prior, receipt: asRecord(prior.receiptJson) };
      }

      const importRow = prior || createKnowledgeImport({
        importId,
        projectId,
        sourceType,
        sourceIdentity,
        sourceDigest,
        sourceSnapshotRef: sourceReceipt.sourceSnapshotRef || null,
        status: 'approved',
        candidateCount: candidates.length,
        approvalRef: userApprovalRef,
      });

      db.exec('BEGIN IMMEDIATE TRANSACTION');
      try {
        const currentRevision = getProjectKnowledgeRevision(projectId);
        if (
          expectedKnowledgeRevision !== null
          && Number(expectedKnowledgeRevision) !== Number(currentRevision)
        ) {
          throw new Error(
            `STALE_KNOWLEDGE_REVISION: Expected revision ${expectedKnowledgeRevision} but found ${currentRevision}`,
          );
        }
        const existing = listKnowledgeRecords({
          projectId,
          statuses: ['committed', 'verified'],
        });
        const knowledgeKey = (record: UnknownRecord): string => {
          const type = String(record.type || record.recordType || '');
          const statement = String(record.statement || '').trim().toLowerCase();
          return `${type}|${statement}|${JSON.stringify([...strings(record.scope)].sort())}`;
        };
        const byKey = new Map(existing.map((record) => [knowledgeKey(record), record]));
        const records: UnknownRecord[] = [];
        const evidenceUpdates: Array<{ record: UnknownRecord; refs: string[] }> = [];
        const conflicts: UnknownRecord[] = [];
        let rejectedCount = 0;

        for (const candidate of candidates) {
          if (candidate.status === 'rejected' || candidate.selected === false) {
            rejectedCount += 1;
            continue;
          }
          const statement = String(candidate.statement || '').trim();
          if (
            !statement
            || /(?:api[_ -]?key|secret|credential|system prompt|developer prompt|raw transcript)/i
              .test(statement)
          ) {
            rejectedCount += 1;
            continue;
          }
          const type = String(candidate.type || candidate.proposedType || 'semantic_fact');
          const scope = strings(candidate.scope);
          const key = `${type}|${statement.toLowerCase()}|${JSON.stringify([...scope].sort())}`;
          const priorRecord = byKey.get(key);
          const refs = [...new Set([
            sourceDigest,
            ...strings(candidate.evidenceRefs),
            ...strings(candidate.sourceRefs),
          ].filter(Boolean))];
          if (priorRecord) {
            evidenceUpdates.push({ record: priorRecord, refs });
            continue;
          }
          const conflicting = existing.find((record) => (
            String(record.type || record.recordType) === type
            && JSON.stringify([...strings(record.scope)].sort())
              === JSON.stringify([...scope].sort())
            && String(record.statement || '').trim().toLowerCase()
              !== statement.toLowerCase()
          ));
          if (conflicting) {
            conflicts.push({
              candidateId: candidate.candidateId || candidate.id || null,
              recordId: conflicting.id,
              statement,
            });
            rejectedCount += 1;
            continue;
          }
          const recordId = String(
            candidate.recordId
            || candidate.candidateId
            || `rec-import-${createHash('sha256')
              .update(`${projectId}:${sourceIdentity}:${type}:${statement}:${JSON.stringify(scope)}`)
              .digest('hex')
              .slice(0, 24)}`,
          );
          records.push({
            id: recordId,
            candidateId: candidate.candidateId || candidate.id || recordId,
            projectId,
            type,
            statement,
            scope,
            status: 'committed',
            trustTier: ['authoritative', 'verified'].includes(String(candidate.trustTier || ''))
              ? candidate.trustTier
              : 'verified',
            evidence: { refs },
            provenance: { sourceType, sourceIdentity, sourceDigest, importId },
            createdAt: now(),
            updatedAt: now(),
          });
        }

        const validSupersessions: string[] = [];
        for (const rawProposal of supersessionProposals) {
          const proposal = asRecord(rawProposal);
          const targetId = String(
            proposal.targetId || proposal.id
            || (typeof rawProposal === 'string' ? rawProposal : ''),
          );
          const target = existing.find((record) => String(record.id || '') === targetId);
          if (target && String(target.projectId || '') === projectId) {
            validSupersessions.push(targetId);
          } else {
            rejectedCount += 1;
          }
        }

        const evidenceChanged = ({ record, refs }: { record: UnknownRecord; refs: string[] }) => {
          const oldRefs = strings(asRecord(record.evidence).refs);
          return refs.some((ref) => !oldRefs.includes(ref));
        };
        const nextRevision = (
          records.length > 0
          || evidenceUpdates.some(evidenceChanged)
          || validSupersessions.length > 0
        ) ? currentRevision + 1 : currentRevision;

        for (const record of records) {
          const payload = { ...record, revision: nextRevision };
          db.prepare(`
            INSERT INTO knowledge_records(
              project_id, record_id, record_type, status, trust_tier,
              record_json, revision, created_at, updated_at
            )
            VALUES(?, ?, ?, 'committed', ?, ?, ?, ?, ?)
            ON CONFLICT(project_id, record_id) DO UPDATE SET
              record_type=excluded.record_type,
              status='committed',
              trust_tier=excluded.trust_tier,
              record_json=excluded.record_json,
              revision=excluded.revision,
              updated_at=excluded.updated_at
          `).run(
            projectId,
            String(record.id),
            String(record.type),
            String(record.trustTier),
            serialize(payload),
            nextRevision,
            now(),
            now(),
          );
        }

        for (const { record, refs } of evidenceUpdates) {
          const evidence = asRecord(record.evidence);
          const oldRefs = strings(evidence.refs);
          const merged = [...new Set([...oldRefs, ...refs])];
          if (merged.length !== oldRefs.length) {
            const updated = {
              ...record,
              evidence: { ...evidence, refs: merged },
              revision: nextRevision,
              updatedAt: now(),
            };
            db.prepare(`
              UPDATE knowledge_records
              SET record_json=?, revision=?, updated_at=?
              WHERE project_id=? AND record_id=?
            `).run(
              serialize(updated),
              nextRevision,
              now(),
              projectId,
              String(record.id),
            );
          }
        }

        for (const targetId of validSupersessions) {
          db.prepare(
            "UPDATE knowledge_records SET status='superseded', updated_at=? WHERE project_id=? AND record_id=?",
          ).run(now(), projectId, targetId);
        }

        if (
          nextRevision !== currentRevision
          && !updateProjectKnowledgeRevision(projectId, currentRevision, nextRevision)
        ) {
          throw new Error(
            `STALE_KNOWLEDGE_REVISION: Revision CAS increment failed for ${projectId}`,
          );
        }

        const acceptedCount = records.length + evidenceUpdates.filter(evidenceChanged).length;
        const status = acceptedCount > 0 || validSupersessions.length > 0
          ? (conflicts.length > 0 ? 'partial' : 'committed')
          : 'no_op';
        const receipt = {
          schemaVersion: 1,
          importId: String(importRow.importId || importId),
          projectId,
          authorityType: 'user_approved_import',
          sourceType,
          sourceIdentityDigest: sourceIdentity,
          sourceDigest,
          candidateCount: candidates.length,
          acceptedCount,
          rejectedCount: rejectedCount + conflicts.length,
          supersededCount: validSupersessions.length,
          conflictCount: conflicts.length,
          knowledgeRevisionBefore: currentRevision,
          knowledgeRevisionAfter: nextRevision,
          approvalRef: userApprovalRef,
          status,
          createdAt: now(),
          conflicts,
        };
        updateKnowledgeImport(String(importRow.importId || importId), {
          status,
          candidateCount: candidates.length,
          acceptedCount,
          rejectedCount: rejectedCount + conflicts.length,
          approvalRef: userApprovalRef,
          revisionBefore: currentRevision,
          revisionAfter: nextRevision,
          receiptJson: receipt,
          completedAt: now(),
        });
        db.exec('COMMIT');
        return {
          status,
          import: getKnowledgeImport(String(importRow.importId || importId)),
          receipt,
        };
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch {}
        throw error;
      }
    };

  const store: KnowledgeLifecycleStore = {
    setRunKnowledgeStatus(runId, status) {
      db.prepare(
        'UPDATE runs SET knowledge_status=?, updated_at=? WHERE run_id=?',
      ).run(String(status || 'no_candidates_submitted'), now(), runId);
    },

    createKnowledgeImport,
    updateKnowledgeImport,
    getKnowledgeImport,
    listKnowledgeImports,
    findKnowledgeImportByDigest,
    appendKnowledgeEvidence,
    commitImportedKnowledgeTransaction,

    recordKnowledgeContextReceipt(runId, input) {
      const stage = String(input.stage || '');
      const knowledgeRevision = input.knowledgeRevision ?? null;
      const digest = input.digest ?? null;
      const receiptJson = input.receiptJson ?? {};
      db.prepare(`
        INSERT INTO knowledge_context_receipts(run_id, stage, knowledge_revision, digest, receipt_json, created_at)
        VALUES(?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id, stage) DO UPDATE SET
          knowledge_revision=excluded.knowledge_revision,
          digest=excluded.digest,
          receipt_json=excluded.receipt_json,
          created_at=excluded.created_at
      `).run(runId, stage, knowledgeRevision, digest, serialize(receiptJson), now());
      db.prepare(
        'UPDATE runs SET context_pack_ref=?, updated_at=? WHERE run_id=?',
      ).run(`context-packs/${runId}/${stage}.json`, now(), runId);
    },

    getKnowledgeContextReceipt(runId, stage) {
      const row = db.prepare(`
        SELECT run_id as runId, stage, knowledge_revision as knowledgeRevision,
          digest, receipt_json as receiptJson, created_at as createdAt
        FROM knowledge_context_receipts WHERE run_id=? AND stage=?
      `).get(runId, stage) as KnowledgeContextRow | undefined;
      return row ? { ...row, receiptJson: parseJson<UnknownRecord>(row.receiptJson, {}) } : null;
    },

    recordKnowledgeCandidate(candidateId, runId, input) {
      const projectId = String(input.projectId || '');
      const proposedType = String(input.proposedType || 'semantic_fact');
      const status = String(input.status || 'pending');
      db.prepare(`
        INSERT INTO knowledge_candidates(candidate_id, run_id, project_id, proposed_type, status, candidate_json, created_at)
        VALUES(?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(candidate_id) DO UPDATE SET
          status=excluded.status,
          candidate_json=excluded.candidate_json,
          created_at=excluded.created_at
      `).run(
        candidateId,
        runId,
        projectId,
        proposedType,
        status,
        serialize(input.candidateJson ?? {}),
        now(),
      );
    },

    getKnowledgeCandidates,

    recordCandidateEvidenceBinding({
      candidateId,
      runId,
      evidenceDigest,
      obligationId = 'default',
      sourceIdentity,
      mutationRevision,
      bindingType = 'verification',
    }) {
      db.prepare(`
        INSERT INTO candidate_evidence_bindings(
          candidate_id, run_id, evidence_digest, obligation_id,
          source_identity, mutation_revision, binding_type, created_at
        )
        VALUES(?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(candidate_id, evidence_digest) DO NOTHING
      `).run(
        candidateId,
        runId,
        evidenceDigest,
        obligationId,
        sourceIdentity,
        mutationRevision,
        bindingType,
        now(),
      );
    },

    getCandidateEvidenceBindings(runId, candidateId = null) {
      if (candidateId) {
        return db.prepare(`
          SELECT candidate_id as candidateId,
            run_id as runId,
            evidence_digest as evidenceDigest,
            obligation_id as obligationId,
            source_identity as sourceIdentity,
            mutation_revision as mutationRevision,
            binding_type as bindingType,
            created_at as createdAt
          FROM candidate_evidence_bindings
          WHERE run_id=? AND candidate_id=?
        `).all(runId, candidateId) as UnknownRecord[];
      }
      return db.prepare(`
        SELECT candidate_id as candidateId,
          run_id as runId,
          evidence_digest as evidenceDigest,
          obligation_id as obligationId,
          source_identity as sourceIdentity,
          mutation_revision as mutationRevision,
          binding_type as bindingType,
          created_at as createdAt
        FROM candidate_evidence_bindings
        WHERE run_id=?
      `).all(runId) as UnknownRecord[];
    },

    recordKnowledgeReviewReceipt(runId, input) {
      db.prepare(`
        INSERT INTO knowledge_review_receipts(
          run_id, project_id, status, candidate_count, verified_count, rejected_count,
          waiting_approval_count, waiting_verification_count, review_digest,
          receipt_json, created_at, updated_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET
          project_id=excluded.project_id,
          status=excluded.status,
          candidate_count=excluded.candidate_count,
          verified_count=excluded.verified_count,
          rejected_count=excluded.rejected_count,
          waiting_approval_count=excluded.waiting_approval_count,
          waiting_verification_count=excluded.waiting_verification_count,
          review_digest=excluded.review_digest,
          receipt_json=excluded.receipt_json,
          updated_at=excluded.updated_at
      `).run(
        runId,
        String(input.projectId || ''),
        String(input.status || ''),
        Number(input.candidateCount || 0),
        Number(input.verifiedCount || 0),
        Number(input.rejectedCount || 0),
        Number(input.waitingApprovalCount || 0),
        Number(input.waitingVerificationCount || 0),
        input.reviewDigest ?? null,
        serialize(input.receiptJson ?? {}),
        now(),
        now(),
      );
    },

    getKnowledgeReviewReceipt,

    recordKnowledgeCommitReceipt(runId, input) {
      const projectId = String(input.projectId || '');
      const revisionBefore = input.revisionBefore ?? null;
      const revisionAfter = input.revisionAfter ?? null;
      const status = String(input.status || 'committed');
      db.prepare(`
        INSERT INTO knowledge_commit_receipts(
          run_id, project_id, revision_before, revision_after, status, receipt_json, created_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET
          revision_before=excluded.revision_before,
          revision_after=excluded.revision_after,
          status=excluded.status,
          receipt_json=excluded.receipt_json,
          created_at=excluded.created_at
      `).run(
        runId,
        projectId,
        revisionBefore,
        revisionAfter,
        status,
        serialize(input.receiptJson ?? {}),
        now(),
      );
      db.prepare(
        'UPDATE runs SET knowledge_revision_close=?, knowledge_status=?, updated_at=? WHERE run_id=?',
      ).run(revisionAfter, status, now(), runId);
    },

    getKnowledgeCommitReceipt(runId) {
      const row = db.prepare(`
        SELECT run_id as runId, project_id as projectId,
          revision_before as revisionBefore, revision_after as revisionAfter,
          status, receipt_json as receiptJson, created_at as createdAt
        FROM knowledge_commit_receipts WHERE run_id=?
      `).get(runId) as KnowledgeCommitRow | undefined;
      return row ? { ...row, receiptJson: parseJson<UnknownRecord>(row.receiptJson, {}) } : null;
    },

    listKnowledgeRecords,

    commitKnowledgeTransaction(input) {
      const transactionId = String(input.transactionId || '');
      const runId = String(input.runId || '');
      const projectId = String(input.projectId || '');
      const expectedRevision = input.expectedRevision ?? null;
      const supersessions = strings(input.supersessions);
      const provenance = asRecord(input.provenance);
      const faultInjection = input.faultInjection ?? null;
      const noChange = input.noChange === true;
      const declaredRecords = Array.isArray(input.records)
        ? input.records.filter((entry): entry is UnknownRecord => Boolean(entry) && typeof entry === 'object')
        : input.records === null || input.records === undefined
          ? null
          : [];

      db.exec('BEGIN IMMEDIATE TRANSACTION');
      try {
        const run = getRun(runId);
        if (!run) throw new Error(`RUN_NOT_FOUND: Run ${runId} not found`);
        const completion = getCompletionDecision(runId);
        if (!completion || completion.decision !== 'accepted') {
          throw new Error('COMPLETION_NOT_ACCEPTED: Transaction commit requires accepted completion decision');
        }
        if (run.projectId !== projectId) {
          throw new Error(`PROJECT_ID_MISMATCH: Run project ${run.projectId} != ${projectId}`);
        }

        const reviewReceipt = getKnowledgeReviewReceipt(runId);
        if (reviewReceipt && !['passed', 'no_candidates'].includes(String(reviewReceipt.status))) {
          throw new Error(
            `KNOWLEDGE_REVIEW_NOT_PASSED: Cannot commit knowledge when review status is ${reviewReceipt.status}`,
          );
        }

        const currentRev = getProjectKnowledgeRevision(projectId);
        if (
          expectedRevision !== null
          && expectedRevision !== undefined
          && Number(expectedRevision) !== Number(currentRev)
        ) {
          throw new Error(
            `STALE_KNOWLEDGE_REVISION: Expected revision ${expectedRevision} but found ${currentRev}`,
          );
        }

        if (faultInjection === 'after_records_before_revision') {
          throw new Error('FAULT_INJECTION_AFTER_RECORDS');
        }

        let recordsToCommit = declaredRecords;
        if (recordsToCommit === null) {
          recordsToCommit = getKnowledgeCandidates(runId)
            .filter((candidate) => candidate.status === 'verified')
            .map((candidate) => mapCandidateToCanonicalRecord(
              asRecord(candidate.candidateJson || candidate),
              { runId, projectId, revision: currentRev + 1 },
            ) as UnknownRecord);
        }

        const existingRows = db.prepare(`
          SELECT record_id, record_type, record_json AS recordJson
          FROM knowledge_records
          WHERE project_id=? AND status='committed'
        `).all(projectId) as KnowledgeRecordRow[];
        const existingIdentities = new Set(existingRows.map((row) => {
          const parsed = parseJson<UnknownRecord | null>(row.recordJson, null);
          return parsed ? persistedRecordIdentity(parsed, row.record_type) : null;
        }).filter((value): value is string => Boolean(value)));

        const seenBatchIdentities = new Set<string>();
        const deduplicatedRecords: UnknownRecord[] = [];
        for (const record of recordsToCommit || []) {
          const recordType = record.type || record.record_type || record.proposedType;
          const identity = persistedRecordIdentity(record, recordType);
          if (seenBatchIdentities.has(identity) || existingIdentities.has(identity)) continue;
          seenBatchIdentities.add(identity);
          deduplicatedRecords.push(record);
        }
        recordsToCommit = deduplicatedRecords;

        let activeSupersessions: string[] = [];
        if (supersessions.length > 0) {
          const placeholders = supersessions.map(() => '?').join(',');
          const rows = db.prepare(
            `SELECT record_id as recordId FROM knowledge_records
             WHERE project_id=? AND record_id IN (${placeholders}) AND status='committed'`,
          ).all(projectId, ...supersessions) as Array<{ recordId: string }>;
          activeSupersessions = rows.map((row) => String(row.recordId));
        }

        const isNoChange = noChange || (
          (recordsToCommit || []).length === 0
          && activeSupersessions.length === 0
        );

        if (isNoChange) {
          const receipt = {
            runId,
            projectId,
            revisionBefore: String(currentRev),
            revisionAfter: String(currentRev),
            status: 'no_change',
            committedCount: 0,
            completionDecisionRef: completion.evidenceDigest || null,
            knowledgeReviewRef: reviewReceipt?.reviewDigest || null,
          };
          db.prepare(`
            INSERT INTO knowledge_commit_receipts(
              run_id, project_id, revision_before, revision_after, status, receipt_json, created_at
            ) VALUES(?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(run_id) DO UPDATE SET
              revision_before=excluded.revision_before,
              revision_after=excluded.revision_after,
              status=excluded.status,
              receipt_json=excluded.receipt_json,
              created_at=excluded.created_at
          `).run(
            runId,
            projectId,
            String(currentRev),
            String(currentRev),
            'no_change',
            serialize(receipt),
            now(),
          );
          db.prepare(
            'UPDATE runs SET knowledge_revision_close=?, knowledge_status=?, updated_at=? WHERE run_id=?',
          ).run(String(currentRev), 'no_change', now(), runId);
          db.exec('COMMIT');
          return {
            revisionBefore: String(currentRev),
            revisionAfter: String(currentRev),
            status: 'no_change',
            receipt,
          };
        }

        const nextRev = currentRev + 1;
        for (const record of recordsToCommit || []) {
          const recordId = String(record.id || record.candidateId || '');
          const recordType = String(record.type || record.proposedType || 'semantic_fact');
          const payload = { ...record, status: 'committed', revision: nextRev };
          db.prepare(`
            INSERT INTO knowledge_records(
              project_id, record_id, record_type, status, trust_tier,
              record_json, revision, created_at, updated_at
            ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(project_id, record_id) DO UPDATE SET
              record_type=excluded.record_type,
              status=excluded.status,
              trust_tier=excluded.trust_tier,
              record_json=excluded.record_json,
              revision=excluded.revision,
              updated_at=excluded.updated_at
          `).run(
            projectId,
            recordId,
            recordType,
            'committed',
            String(record.trustTier || 'verified'),
            serialize(payload),
            nextRev,
            now(),
            now(),
          );
        }

        for (const recordId of activeSupersessions) {
          db.prepare(
            "UPDATE knowledge_records SET status='superseded', updated_at=? WHERE project_id=? AND record_id=?",
          ).run(now(), projectId, recordId);
        }

        if (!updateProjectKnowledgeRevision(projectId, currentRev, nextRev)) {
          throw new Error(
            `STALE_KNOWLEDGE_REVISION: Revision CAS increment failed for ${projectId}`,
          );
        }

        const transactionJson = serialize({
          transactionId,
          runId,
          projectId,
          expectedRevision: currentRev,
          targetRevision: nextRev,
          recordsCount: (recordsToCommit || []).length,
          provenance,
        });
        db.prepare(`
          INSERT INTO knowledge_transactions(
            transaction_id, project_id, run_id, expected_revision, target_revision,
            status, transaction_json, created_at, completed_at
          ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(transaction_id) DO UPDATE SET
            status='completed',
            completed_at=excluded.completed_at
        `).run(
          transactionId,
          projectId,
          runId,
          currentRev,
          nextRev,
          'completed',
          transactionJson,
          now(),
          now(),
        );

        const receipt = {
          runId,
          projectId,
          revisionBefore: String(currentRev),
          revisionAfter: String(nextRev),
          status: 'committed',
          committedCount: (recordsToCommit || []).length,
          completionDecisionRef: completion.evidenceDigest || null,
          knowledgeReviewRef: reviewReceipt?.reviewDigest || null,
        };
        db.prepare(`
          INSERT INTO knowledge_commit_receipts(
            run_id, project_id, revision_before, revision_after, status, receipt_json, created_at
          ) VALUES(?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(run_id) DO UPDATE SET
            revision_before=excluded.revision_before,
            revision_after=excluded.revision_after,
            status=excluded.status,
            receipt_json=excluded.receipt_json,
            created_at=excluded.created_at
        `).run(
          runId,
          projectId,
          String(currentRev),
          String(nextRev),
          'committed',
          serialize(receipt),
          now(),
        );
        db.prepare(
          'UPDATE runs SET knowledge_revision_close=?, knowledge_status=?, updated_at=? WHERE run_id=?',
        ).run(String(nextRev), 'committed', now(), runId);
        db.exec('COMMIT');
        return {
          revisionBefore: String(currentRev),
          revisionAfter: String(nextRev),
          status: 'committed',
          receipt,
        };
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch {}
        throw error;
      }
    },

    getProjectKnowledgeRevision,

    getProjectKnowledgeDoctorCounts(projectId) {
      const candidates = db.prepare(
        'SELECT COUNT(*) as count FROM knowledge_candidates WHERE project_id=?',
      ).get(projectId) as { count?: number | string | null } | undefined;
      const committed = db.prepare(
        "SELECT COUNT(*) as count FROM knowledge_records WHERE project_id=? AND status='committed'",
      ).get(projectId) as { count?: number | string | null } | undefined;
      return {
        candidateCount: Number(candidates?.count || 0),
        committedCount: Number(committed?.count || 0),
      };
    },

    updateProjectKnowledgeRevision,

    saveKnowledgeRecord(projectId, recordId, input = {}) {
      const recordType = String(input.recordType || 'semantic_fact');
      const status = String(input.status || 'committed');
      const trustTier = String(input.trustTier || 'verified');
      const revision = Number(input.revision || 1);
      const recordJson = input.recordJson ?? {};
      db.prepare(`
        INSERT INTO knowledge_records(
          project_id, record_id, record_type, status, trust_tier,
          record_json, revision, created_at, updated_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id, record_id) DO UPDATE SET
          record_type=excluded.record_type,
          status=excluded.status,
          trust_tier=excluded.trust_tier,
          record_json=excluded.record_json,
          revision=excluded.revision,
          updated_at=excluded.updated_at
      `).run(
        projectId,
        recordId,
        recordType,
        status,
        trustTier,
        typeof recordJson === 'string' ? recordJson : serialize(recordJson),
        revision,
        now(),
        now(),
      );
    },

    saveKnowledgeTransaction(transactionId, input) {
      db.prepare(`
        INSERT INTO knowledge_transactions(
          transaction_id, project_id, run_id, expected_revision, target_revision,
          status, transaction_json, created_at, completed_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(transaction_id) DO UPDATE SET
          status=excluded.status,
          completed_at=excluded.completed_at
      `).run(
        transactionId,
        input.projectId ?? null,
        input.runId ?? null,
        input.expectedRevision ?? null,
        input.targetRevision ?? null,
        input.status ?? null,
        typeof input.transactionJson === 'string'
          ? input.transactionJson
          : serialize(input.transactionJson ?? {}),
        now(),
        now(),
      );
    },

    recordKnowledgeApproval(approvalId, input) {
      const runId = String(input.runId || '');
      const candidateId = String(input.candidateId || '');
      const approvedBy = String(input.approvedBy || '');
      const approvalReceipt = String(input.approvalReceipt || '');
      if (!runId || !candidateId || !approvedBy || !approvalReceipt) {
        throw new Error(
          'recordKnowledgeApproval requires runId, candidateId, approvedBy, and approvalReceipt',
        );
      }
      db.prepare(`
        INSERT INTO knowledge_approvals(
          approval_id, run_id, candidate_id, approved_by, approval_receipt, created_at
        ) VALUES(?, ?, ?, ?, ?, ?)
        ON CONFLICT(approval_id) DO UPDATE SET
          approved_by=excluded.approved_by,
          approval_receipt=excluded.approval_receipt
      `).run(approvalId, runId, candidateId, approvedBy, approvalReceipt, now());
    },

    getKnowledgeApproval(runId, candidateId) {
      const row = db.prepare(`
        SELECT approval_id as approvalId, run_id as runId, candidate_id as candidateId,
          approved_by as approvedBy, approval_receipt as approvalReceipt, created_at as createdAt
        FROM knowledge_approvals WHERE run_id=? AND candidate_id=?
      `).get(runId, candidateId);
      return row && typeof row === 'object' ? row as UnknownRecord : null;
    },

    getKnowledgeApprovals(runId) {
      return db.prepare(`
        SELECT approval_id as approvalId, run_id as runId, candidate_id as candidateId,
          approved_by as approvedBy, approval_receipt as approvalReceipt, created_at as createdAt
        FROM knowledge_approvals WHERE run_id=?
      `).all(runId) as UnknownRecord[];
    },

    getDeferredKnowledgeRuns(
      projectId,
      { limit = 1, excludeRunId = null, retryableOnly = false } = {},
    ) {
      if (!projectId) return [];
      let query = `
        SELECT run_id as runId, project_id as projectId,
          receipt_json as receiptJson, created_at as createdAt
        FROM knowledge_commit_receipts
        WHERE project_id=? AND status='deferred'
      `;
      const params: Array<string | number> = [projectId];
      if (excludeRunId) {
        query += ' AND run_id != ?';
        params.push(excludeRunId);
      }
      query += ' ORDER BY created_at ASC LIMIT ?';
      params.push(retryableOnly ? Math.max(limit * 32, 64) : limit);

      const rows = db.prepare(query).all(...params) as Array<{
        runId: string;
        projectId: string;
        receiptJson: string | null;
        createdAt: string;
      }>;
      const mapped = rows.map((row) => ({
        runId: row.runId,
        projectId: row.projectId,
        receipt: parseJson<UnknownRecord | null>(row.receiptJson, null),
        createdAt: row.createdAt,
      }));
      if (!retryableOnly) return mapped;

      const retryableReasons = new Set([
        'cas_retry_exhausted',
        'concurrent_lock_timeout',
        'stale_revision',
      ]);
      return mapped.filter((row) => {
        const reason = row.receipt?.reason;
        return retryableReasons.has(String(reason))
          || (typeof reason === 'string'
            && (reason.includes('conflict') || reason.includes('exhausted')));
      }).slice(0, limit);
    },
  };

  return store;
};
