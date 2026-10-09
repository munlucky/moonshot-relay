import { createHash } from 'node:crypto';
import { canonicalJson } from '../canonical-digest.mjs';

export const REPORT_OPERATION_SCHEMA_VERSION = 1;

const digest = (value) => createHash('sha256').update(canonicalJson(value)).digest('hex');

export const reportPayloadDigest = (normalizedReport = {}) => digest({
  schemaVersion: REPORT_OPERATION_SCHEMA_VERSION,
  report: normalizedReport,
});

export const buildReportOperationKey = ({
  runId,
  stepId,
  planRevision,
  attemptId,
  operation = 'report',
} = {}) => {
  if (!runId || !stepId || !attemptId) {
    const error = new Error('report_operation_identity_incomplete');
    error.code = 'report_operation_identity_incomplete';
    throw error;
  }
  return `report-op-${digest({
    schemaVersion: REPORT_OPERATION_SCHEMA_VERSION,
    operation: String(operation),
    runId: String(runId),
    stepId: String(stepId),
    planRevision: Number(planRevision || 1),
    attemptId: String(attemptId),
  })}`;
};

export const compareReportOperation = (stored = null, payloadDigest = null) => {
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
