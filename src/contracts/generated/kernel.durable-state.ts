// Generated from schemas/kernel.durable-state.schema.json. Edit the schema and run build:contracts.

export interface KernelDurableState {
  schemaVersion: 1;
  authority: {
    source: 'sqlite';
    durable: true;
  };
  project: {
    projectId: null | string;
    workspaceId: null | string;
    worktreeId: null | string;
  };
  task: {
    runId: string;
    objective: string;
    taskClass: string;
    contractRevision: number;
    acceptanceCriteria: string[];
    constraints: string[];
    nonGoals: string[];
  };
  work: {
    status: string;
    state: string;
    planRevision: number;
    mutationRevision: number;
    cursor: null | {
      planRevision: number;
      currentStepId: null | string;
      currentSequence: null | number;
      stepCount: number;
    };
    currentWorkUnit: null | {
      stepId: string;
      sequence: number;
      planRevision: number;
      objective: string;
      state: string;
      synthetic: boolean;
      acceptanceIds: string[];
      obligationIds: string[];
      allowedPaths: string[];
      forbiddenPaths: string[];
    };
    progress: null | {
      completedWorkUnitIds: string[];
      completedCurrentPlanWorkUnitIds: string[];
      remainingWorkUnitIds: string[];
      completedCount: number;
      completedCurrentPlanCount: number;
      remainingCount: number;
    };
    resume: null | {
      status: string;
      action: 'none' | 'continue-current-work-unit' | 'continue-work' | 'rebuild-work-cursor';
      stepId: null | string;
    };
  };
  execution: {
    executionClass: null | 'planning' | 'complex_implementation' | 'review' | 'standard';
  };
  evidence: {
    requiredObligations: {
      obligationId: string;
      evidenceClass: string;
      acceptanceIds: string[];
    }[];
    verifications: {
      obligationId: string;
      status: string;
      evidenceDigest: unknown;
      acceptanceCoverage: string[];
      verifiedMutationRevision: null | number;
    }[];
  };
  completion: {
    decision: unknown;
    overall: unknown;
    finalizationStatus: null | string;
  };
  knowledge: {
    revisionStart: null | string | number;
    revisionClose: null | string | number;
    status: null | string;
  };
}
