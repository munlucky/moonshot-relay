import type {
  FuturesAssessment,
  FuturesAssessmentActionCandidate,
  FuturesAssessmentInput,
  FuturesAssessmentSignals,
  FuturesEvidence,
} from '../../contracts/futures-evidence.js';
import { canonicalDigest } from '../../shared/canonical-digest.js';

const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const ASSESSMENT_REVISION = 'futures-assessment.v1' as const;

const invalid = (field: string): never => {
  throw new TypeError(`futures_assessment_invalid:${field}`);
};

const stale = (field: string): never => {
  throw new Error(`futures_assessment_stale:${field}`);
};

const requiredText = (value: unknown, field: string): string => {
  if (typeof value !== 'string') invalid(field);
  const text = (value as string).trim();
  if (!text) invalid(field);
  return text;
};

const revisionText = (value: unknown): string => {
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0) invalid('currentRevision');
    return String(value);
  }
  return requiredText(value, 'currentRevision');
};

const sortedUniqueText = (value: unknown, field: string): readonly string[] => {
  if (!Array.isArray(value)) invalid(field);
  const items = value as unknown[];
  return Object.freeze([
    ...new Set(items.map((entry) => requiredText(entry, field))),
  ].sort());
};

const validateSignal = <T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): T => {
  if (typeof value !== 'string' || !allowed.includes(value as T)) invalid(field);
  return value as T;
};

const normalizeSignals = (value: unknown): FuturesAssessmentSignals => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('signals');
  const signals = value as Record<string, unknown>;
  return Object.freeze({
    behavior: validateSignal(
      signals.behavior,
      ['preserved', 'regressed', 'unknown'] as const,
      'signals.behavior',
    ),
    scope: validateSignal(
      signals.scope,
      ['within', 'outside', 'unknown'] as const,
      'signals.scope',
    ),
    architecture: validateSignal(
      signals.architecture,
      ['not-required', 'required', 'unknown'] as const,
      'signals.architecture',
    ),
  });
};

const evidencePayload = (evidence: FuturesEvidence) => ({
  schemaVersion: evidence.schemaVersion,
  revision: evidence.revision,
  contentDigest: evidence.contentDigest,
  changeObservation: evidence.changeObservation,
  dependencyBoundaries: evidence.dependencyBoundaries,
  regressionScope: evidence.regressionScope,
  unknowns: evidence.unknowns,
  status: evidence.status,
  incompleteReasons: evidence.incompleteReasons,
});

const validateEvidenceIdentity = (
  evidence: FuturesEvidence,
  currentRevision: string,
  currentContentDigest: string,
): void => {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    invalid('evidence');
  }
  if (!SHA256.test(String(evidence.digest || ''))) invalid('evidence.digest');
  if (canonicalDigest(evidencePayload(evidence)) !== evidence.digest) {
    invalid('evidence.digest');
  }
  if (evidence.revision !== currentRevision) stale('revision');
  if (evidence.contentDigest !== currentContentDigest) stale('contentDigest');
};

const changedPaths = (evidence: FuturesEvidence): readonly string[] => (
  evidence.changeObservation.changedPaths ?? []
);

const incompleteAssessment = ({
  evidence,
  subject,
  reasons,
}: {
  evidence: FuturesEvidence;
  subject: FuturesAssessment['subject'];
  reasons: readonly string[];
}): Readonly<FuturesAssessment> => {
  const requirements = Object.freeze([...new Set(reasons)].sort());
  const actionCandidate: FuturesAssessmentActionCandidate = Object.freeze({
    kind: 'collect-evidence',
    requirements,
  });
  const assessmentWithoutDigest = {
    schemaVersion: 1 as const,
    assessmentRevision: ASSESSMENT_REVISION,
    subject,
    status: 'incomplete' as const,
    color: null,
    reasons: requirements,
    unknowns: Object.freeze([...evidence.unknowns]),
    actionCandidate,
  };
  return Object.freeze({
    ...assessmentWithoutDigest,
    digest: canonicalDigest(assessmentWithoutDigest),
  });
};

export const assessFuturesEvidence = (
  input: FuturesAssessmentInput,
): Readonly<FuturesAssessment> => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('input');

  const currentRevision = revisionText(input.currentRevision);
  const currentContentDigest = requiredText(input.currentContentDigest, 'currentContentDigest');
  if (!SHA256.test(currentContentDigest)) invalid('currentContentDigest');
  const signals = normalizeSignals(input.signals);
  const obligations = sortedUniqueText(input.existingObligations, 'existingObligations');

  validateEvidenceIdentity(input.evidence, currentRevision, currentContentDigest);

  const subject = Object.freeze({
    revision: input.evidence.revision,
    contentDigest: input.evidence.contentDigest,
    changedPathsDigest: canonicalDigest([...changedPaths(input.evidence)]),
    evidenceDigest: input.evidence.digest,
  });

  const incompleteReasons = [
    ...input.evidence.incompleteReasons.map((reason) => `evidence:${reason}`),
    ...(signals.behavior === 'unknown' ? ['signal:behavior-unknown'] : []),
    ...(signals.scope === 'unknown' ? ['signal:scope-unknown'] : []),
    ...(signals.architecture === 'unknown' ? ['signal:architecture-unknown'] : []),
  ];

  if (input.evidence.status !== 'complete' || incompleteReasons.length > 0) {
    return incompleteAssessment({
      evidence: input.evidence,
      subject,
      reasons: incompleteReasons,
    });
  }

  let color: Exclude<FuturesAssessment['color'], null>;
  let reasons: readonly string[];
  let actionCandidate: FuturesAssessmentActionCandidate;

  if (signals.scope === 'outside' || signals.architecture === 'required') {
    color = 'red';
    reasons = Object.freeze([
      ...(signals.scope === 'outside' ? ['scope-outside-bounded-work'] : []),
      ...(signals.architecture === 'required' ? ['architecture-decision-required'] : []),
    ]);
    actionCandidate = Object.freeze({
      kind: 'architecture-planning',
      affectedPaths: Object.freeze([...changedPaths(input.evidence)]),
    });
  } else if (signals.behavior === 'regressed') {
    const paths = changedPaths(input.evidence);
    if (paths.length === 0) {
      return incompleteAssessment({
        evidence: input.evidence,
        subject,
        reasons: ['restore-scope-empty'],
      });
    }
    color = 'yellow';
    reasons = Object.freeze(['behavior-regression-within-bounded-scope']);
    actionCandidate = Object.freeze({
      kind: 'bounded-restore',
      allowedPaths: Object.freeze([...paths]),
    });
  } else {
    if (obligations.length === 0) {
      return incompleteAssessment({
        evidence: input.evidence,
        subject,
        reasons: ['existing-obligation-missing'],
      });
    }
    color = 'green';
    reasons = Object.freeze(['evidence-complete', 'behavior-preserved', 'scope-within-bounds']);
    actionCandidate = Object.freeze({
      kind: 'existing-obligations',
      obligationIds: obligations,
    });
  }

  const assessmentWithoutDigest = {
    schemaVersion: 1 as const,
    assessmentRevision: ASSESSMENT_REVISION,
    subject,
    status: 'assessed' as const,
    color,
    reasons,
    unknowns: Object.freeze([...input.evidence.unknowns]),
    actionCandidate,
  };

  return Object.freeze({
    ...assessmentWithoutDigest,
    digest: canonicalDigest(assessmentWithoutDigest),
  });
};
