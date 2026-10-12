export interface CompletionProvenanceRun {
  runId?: unknown;
  projectId?: unknown;
  workspaceId?: unknown;
  sourceIdentity?: unknown;
  mutationRevision?: unknown;
  currentWorkspaceIdentity?: unknown;
  status?: unknown;
  currentState?: unknown;
  state?: unknown;
  finalizationStatus?: unknown;
}

export interface CompletionDecisionAuthority {
  runId?: unknown;
  decision?: unknown;
  sourceIdentity?: unknown;
  mutationRevision?: unknown;
  decisionJson?: {
    runId?: unknown;
    decision?: unknown;
    sourceIdentity?: unknown;
    mutationRevision?: unknown;
    currentWorkspaceIdentity?: unknown;
    [key: string]: unknown;
  } | null;
}

export interface MutationProvenanceAuthority {
  runId?: unknown;
  projectId?: unknown;
  workspaceId?: unknown;
  sourceIdentity?: unknown;
  mutationRevision?: unknown;
  workspaceIdentity?: unknown;
  mutationDigest?: unknown;
  attemptId?: unknown;
}

export interface CompletionProvenanceAssessment {
  current: boolean;
  mutated: boolean;
  reasons: string[];
  mutationRevision: number;
}

export class CompletionProvenanceError extends Error {
  readonly code: string;
  readonly errorCode: string;
  readonly reasons: string[];

  constructor(code: string, message: string, reasons: string[] = []) {
    super(message);
    this.name = 'CompletionProvenanceError';
    this.code = code;
    this.errorCode = code;
    this.reasons = reasons;
  }
}

const normalizedRevision = (value: unknown): number => {
  const revision = Number(value);
  return Number.isInteger(revision) && revision >= 0 ? revision : 0;
};

const sameOptionalString = (left: unknown, right: unknown): boolean => {
  if (left === null || left === undefined || left === '') return true;
  if (right === null || right === undefined || right === '') return false;
  return String(left) === String(right);
};

export const assessMutationProvenance = ({
  run,
  mutationProvenance,
}: {
  run?: (CompletionProvenanceRun | null) | undefined;
  mutationProvenance?: (MutationProvenanceAuthority | null) | undefined;
} = {}): CompletionProvenanceAssessment => {
  if (!run?.runId) {
    return {
      current: false,
      mutated: false,
      reasons: ['run-missing'],
      mutationRevision: 0,
    };
  }

  const mutationRevision = normalizedRevision(run.mutationRevision);
  if (mutationRevision === 0) {
    return {
      current: true,
      mutated: false,
      reasons: [],
      mutationRevision,
    };
  }

  const reasons: string[] = [];
  if (!mutationProvenance) {
    reasons.push('mutation-provenance-missing');
  } else {
    if (normalizedRevision(mutationProvenance.mutationRevision) !== mutationRevision) {
      reasons.push('mutation-revision-stale');
    }
    if (!sameOptionalString(run.projectId, mutationProvenance.projectId)) {
      reasons.push('project-id-mismatch');
    }
    if (!sameOptionalString(run.workspaceId, mutationProvenance.workspaceId)) {
      reasons.push('workspace-id-mismatch');
    }
    if (!sameOptionalString(run.sourceIdentity, mutationProvenance.sourceIdentity)) {
      reasons.push('source-identity-mismatch');
    }
    if (!sameOptionalString(run.currentWorkspaceIdentity, mutationProvenance.workspaceIdentity)) {
      reasons.push('workspace-identity-mismatch');
    }
  }

  return {
    current: reasons.length === 0,
    mutated: true,
    reasons,
    mutationRevision,
  };
};

export const assessCompletionProvenance = ({
  run,
  completionDecision,
  mutationProvenance,
  requireCompletion = true,
}: {
  run?: CompletionProvenanceRun | null;
  completionDecision?: CompletionDecisionAuthority | null;
  mutationProvenance?: MutationProvenanceAuthority | null;
  requireCompletion?: boolean;
} = {}): CompletionProvenanceAssessment => {
  const mutation = assessMutationProvenance({ run, mutationProvenance });
  const reasons = [...mutation.reasons];
  if (!run?.runId) return { ...mutation, current: false, reasons: [...new Set(reasons)] };

  if (requireCompletion) {
    if (!completionDecision) {
      reasons.push('completion-decision-missing');
    } else {
      if (completionDecision.decision !== 'accepted') reasons.push('completion-not-accepted');
      if (normalizedRevision(completionDecision.mutationRevision) !== mutation.mutationRevision) {
        reasons.push('completion-mutation-revision-stale');
      }
      if (!sameOptionalString(run.sourceIdentity, completionDecision.sourceIdentity)) {
        reasons.push('completion-source-identity-mismatch');
      }
      const decisionJson = completionDecision.decisionJson;
      if (decisionJson) {
        if (decisionJson.runId && String(decisionJson.runId) !== String(run.runId)) {
          reasons.push('completion-run-mismatch');
        }
        if (
          decisionJson.mutationRevision !== undefined
          && normalizedRevision(decisionJson.mutationRevision) !== mutation.mutationRevision
        ) {
          reasons.push('completion-payload-mutation-revision-stale');
        }
        if (!sameOptionalString(run.sourceIdentity, decisionJson.sourceIdentity)) {
          reasons.push('completion-payload-source-identity-mismatch');
        }
        if (!sameOptionalString(run.currentWorkspaceIdentity, decisionJson.currentWorkspaceIdentity)) {
          reasons.push('completion-payload-workspace-identity-mismatch');
        }
      }
    }
  }

  return {
    ...mutation,
    current: reasons.length === 0,
    reasons: [...new Set(reasons)],
  };
};

const errorForReasons = (reasons: readonly string[]): { code: string; message: string } => {
  if (reasons.includes('run-missing')) {
    return { code: 'RUN_NOT_FINALIZED', message: 'Run authority is missing' };
  }
  if (reasons.includes('completion-decision-missing') || reasons.includes('completion-not-accepted')) {
    return { code: 'RUN_NOT_FINALIZED', message: 'Run does not have an accepted completion decision' };
  }
  if (reasons.includes('mutation-provenance-missing')) {
    return { code: 'MUTATION_PROVENANCE_MISSING', message: 'Current Run mutation provenance is missing' };
  }
  if (reasons.some((reason) => reason.includes('mutation-revision-stale'))) {
    return { code: 'delivery_mutation_revision_stale', message: 'Completion and mutation provenance do not describe the current Run revision' };
  }
  if (reasons.some((reason) => reason.includes('source-identity-mismatch'))) {
    return { code: 'SOURCE_IDENTITY_MISMATCH', message: 'Completion or mutation provenance source identity does not match the Run' };
  }
  if (reasons.some((reason) => reason.includes('workspace-identity-mismatch') || reason === 'workspace-id-mismatch')) {
    return { code: 'delivery_workspace_drift', message: 'Mutation provenance workspace does not match the current Run workspace' };
  }
  return { code: 'RUN_NOT_FINALIZED', message: 'Run completion provenance is not current' };
};

export const assertCompletionProvenance = (
  input: Parameters<typeof assessCompletionProvenance>[0] = {},
): CompletionProvenanceAssessment => {
  const assessment = assessCompletionProvenance(input);
  if (assessment.current) return assessment;
  const error = errorForReasons(assessment.reasons);
  throw new CompletionProvenanceError(error.code, error.message, assessment.reasons);
};
