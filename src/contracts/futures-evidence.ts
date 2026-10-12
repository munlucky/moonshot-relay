export type FuturesEvidenceStatus = 'complete' | 'incomplete';

export type FuturesEvidenceIncompleteReason =
  | 'changed-paths-unavailable'
  | 'dependency-boundaries-unavailable'
  | 'regression-scope-unavailable'
  | 'unresolved-unknowns';

export interface FuturesDependencyBoundary {
  fromPath: string;
  toPath: string;
}

export interface FuturesChangeSetInput {
  status: 'observed' | 'unavailable';
  reason?: string | null;
  actualChangedPaths: readonly string[] | null;
}

export interface FuturesEvidenceInput {
  revision: string | number;
  contentDigest: string;
  changeSet: FuturesChangeSetInput;
  dependencyBoundaries: readonly FuturesDependencyBoundary[] | null;
  regressionScope: readonly string[] | null;
  unknowns: readonly string[];
}

export interface FuturesEvidence {
  schemaVersion: 1;
  revision: string;
  contentDigest: string;
  changeObservation: Readonly<{
    status: 'observed' | 'unavailable';
    reason: string | null;
    changedPaths: readonly string[] | null;
  }>;
  dependencyBoundaries: readonly Readonly<FuturesDependencyBoundary>[] | null;
  regressionScope: readonly string[] | null;
  unknowns: readonly string[];
  status: FuturesEvidenceStatus;
  incompleteReasons: readonly FuturesEvidenceIncompleteReason[];
  digest: string;
}


export type FuturesAssessmentColor = 'green' | 'yellow' | 'red' | null;

export type FuturesAssessmentBehaviorSignal = 'preserved' | 'regressed' | 'unknown';
export type FuturesAssessmentScopeSignal = 'within' | 'outside' | 'unknown';
export type FuturesAssessmentArchitectureSignal = 'not-required' | 'required' | 'unknown';

export interface FuturesAssessmentSignals {
  behavior: FuturesAssessmentBehaviorSignal;
  scope: FuturesAssessmentScopeSignal;
  architecture: FuturesAssessmentArchitectureSignal;
}

export type FuturesAssessmentActionCandidate =
  | Readonly<{
    kind: 'existing-obligations';
    obligationIds: readonly string[];
  }>
  | Readonly<{
    kind: 'bounded-restore';
    allowedPaths: readonly string[];
  }>
  | Readonly<{
    kind: 'architecture-planning';
    affectedPaths: readonly string[];
  }>
  | Readonly<{
    kind: 'collect-evidence';
    requirements: readonly string[];
  }>;

export interface FuturesAssessmentInput {
  evidence: FuturesEvidence;
  currentRevision: string | number;
  currentContentDigest: string;
  existingObligations: readonly string[];
  signals: FuturesAssessmentSignals;
}

export interface FuturesAssessment {
  schemaVersion: 1;
  assessmentRevision: 'futures-assessment.v1';
  subject: Readonly<{
    revision: string;
    contentDigest: string;
    changedPathsDigest: string;
    evidenceDigest: string;
  }>;
  status: 'assessed' | 'incomplete';
  color: FuturesAssessmentColor;
  reasons: readonly string[];
  unknowns: readonly string[];
  actionCandidate: FuturesAssessmentActionCandidate;
  digest: string;
}
