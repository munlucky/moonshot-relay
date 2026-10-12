import { createHash } from 'node:crypto';
import { canonicalJson } from '../../shared/canonical-digest.js';

export const REPORT_OPERATION_SCHEMA_VERSION = 1;

type JsonRecord = Record<string, unknown>;

export interface ReportOperationIdentityInput {
  runId?: unknown;
  stepId?: unknown;
  planRevision?: unknown;
  attemptId?: unknown;
  operation?: unknown;
}

export interface StoredReportOperation {
  reportPayloadDigest?: unknown;
  reportResult?: unknown;
}

export type ReportOperationComparison =
  | { state: 'unseen' }
  | {
      state: 'conflict';
      errorCode: 'REPORT_OPERATION_PAYLOAD_CONFLICT';
      storedDigest: unknown;
      incomingDigest: unknown;
    }
  | { state: 'replay'; reportResult: unknown }
  | { state: 'in-progress' };

export class ReportOperationIdentityError extends Error {
  readonly code = 'report_operation_identity_incomplete';

  constructor() {
    super('report_operation_identity_incomplete');
    this.name = 'ReportOperationIdentityError';
  }
}

const digest = (value: unknown): string => (
  createHash('sha256').update(canonicalJson(value)).digest('hex')
);

export const reportPayloadDigest = (normalizedReport: JsonRecord = {}): string => digest({
  schemaVersion: REPORT_OPERATION_SCHEMA_VERSION,
  report: normalizedReport,
});

export const buildReportOperationKey = ({
  runId,
  stepId,
  planRevision,
  attemptId,
  operation = 'report',
}: ReportOperationIdentityInput = {}): string => {
  if (!runId || !stepId || !attemptId) throw new ReportOperationIdentityError();
  return `report-op-${digest({
    schemaVersion: REPORT_OPERATION_SCHEMA_VERSION,
    operation: String(operation),
    runId: String(runId),
    stepId: String(stepId),
    planRevision: Number(planRevision || 1),
    attemptId: String(attemptId),
  })}`;
};

export const compareReportOperation = (
  stored: StoredReportOperation | null = null,
  payloadDigest: string | null = null,
): ReportOperationComparison => {
  if (!stored) return { state: 'unseen' };
  if (!payloadDigest || stored.reportPayloadDigest !== payloadDigest) {
    return {
      state: 'conflict',
      errorCode: 'REPORT_OPERATION_PAYLOAD_CONFLICT',
      storedDigest: stored.reportPayloadDigest || null,
      incomingDigest: payloadDigest || null,
    };
  }
  return stored.reportResult
    ? { state: 'replay', reportResult: stored.reportResult }
    : { state: 'in-progress' };
};
