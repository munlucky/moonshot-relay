// Generated from schemas/kernel.work-authority.schema.json. Edit the schema and run build:contracts.

export interface KernelWorkAuthority {
  schemaVersion: 1;
  task: {
    runId: string;
    objective: string;
    taskClass: string;
    contractRevision: number;
    acceptanceCriteria: string[];
  };
  run: {
    runId: string;
    projectId: null | string;
    status: string;
    state: string;
    planRevision: number;
    mutationRevision: number;
  };
  workUnitStatus: 'active' | 'blocked' | 'complete';
  goalStatus: 'active' | 'blocked' | 'complete';
  goal: {
    status: 'active' | 'blocked' | 'complete';
    objective: string;
    coverage: {
      completedAcceptanceCount: number;
      totalAcceptanceCount: number;
      summary: string;
    };
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
  progress: {
    completedWorkUnitIds: string[];
    completedCurrentPlanWorkUnitIds: string[];
    remainingWorkUnitIds: string[];
    completedCount: number;
    completedCurrentPlanCount: number;
    remainingCount: number;
  };
  cursor: {
    planRevision: number;
    currentStepId: null | string;
    currentSequence: null | number;
    stepCount: number;
  };
  executionClass: null | 'planning' | 'complex_implementation' | 'review' | 'standard';
  resume: {
    status: string;
    action: 'none' | 'continue-current-work-unit' | 'continue-work' | 'rebuild-work-cursor';
    stepId: null | string;
  };
}
