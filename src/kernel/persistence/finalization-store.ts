import type { SqliteDatabase } from '../sqlite-adapter.js';

type UnknownRecord = Record<string, unknown>;

export interface FinalizationReceiptInput {
  projectId?: unknown;
  completionStatus?: unknown;
  knowledgeStatus?: unknown;
  projectionStatus?: unknown;
  gitCloseoutStatus?: unknown;
  finalizationStatus?: unknown;
  receiptJson?: unknown;
  [key: string]: unknown;
}

export interface FinalizationPersistence {
  setRunFinalizationStatus(runId: string, finalizationStatus: string): void;
  recordFinalizationReceipt(runId: string, receipt?: FinalizationReceiptInput): void;
  getFinalizationReceipt(runId: string): UnknownRecord | null;
}

const parseJson = <T>(value: unknown, fallback: T): T => {
  if (typeof value !== 'string' || !value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

export const createFinalizationPersistence = ({
  db,
  now = () => new Date().toISOString(),
  serialize = (value: unknown) => JSON.stringify(value),
}: {
  db: SqliteDatabase;
  now?: () => string;
  serialize?: (value: unknown) => string;
}): FinalizationPersistence => ({
  setRunFinalizationStatus(runId, finalizationStatus) {
    db.prepare(
      'UPDATE runs SET finalization_status=?, revision=revision+1, updated_at=? WHERE run_id=?',
    ).run(String(finalizationStatus), now(), runId);
  },

  recordFinalizationReceipt(runId, receipt = {}) {
    const createdAt = now();
    const receiptJson = receipt.receiptJson ?? receipt;
    db.prepare(`
      INSERT INTO finalization_receipts(
        run_id, project_id, completion_status, knowledge_status,
        projection_status, git_closeout_status, finalization_status,
        receipt_json, created_at, updated_at
      )
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET
        completion_status=excluded.completion_status,
        knowledge_status=excluded.knowledge_status,
        projection_status=excluded.projection_status,
        git_closeout_status=excluded.git_closeout_status,
        finalization_status=excluded.finalization_status,
        receipt_json=excluded.receipt_json,
        updated_at=excluded.updated_at
    `).run(
      runId,
      receipt.projectId ? String(receipt.projectId) : 'unknown',
      receipt.completionStatus ? String(receipt.completionStatus) : 'unknown',
      receipt.knowledgeStatus ? String(receipt.knowledgeStatus) : 'unknown',
      receipt.projectionStatus ? String(receipt.projectionStatus) : 'completed',
      receipt.gitCloseoutStatus ? String(receipt.gitCloseoutStatus) : 'skipped',
      receipt.finalizationStatus ? String(receipt.finalizationStatus) : 'unknown',
      serialize(receiptJson || {}),
      createdAt,
      createdAt,
    );
  },

  getFinalizationReceipt(runId) {
    const row = db.prepare(`
      SELECT run_id as runId,
        project_id as projectId,
        completion_status as completionStatus,
        knowledge_status as knowledgeStatus,
        projection_status as projectionStatus,
        git_closeout_status as gitCloseoutStatus,
        finalization_status as finalizationStatus,
        receipt_json as receiptJson,
        created_at as createdAt,
        updated_at as updatedAt
      FROM finalization_receipts
      WHERE run_id=?
    `).get(runId) as (UnknownRecord & { receiptJson?: string | null }) | undefined;
    if (!row) return null;
    return {
      ...row,
      receiptJson: parseJson<UnknownRecord>(row.receiptJson, {}),
    };
  },
});
