// Generated from schemas/kernel.task-snapshot.schema.json. Edit the schema and run build:contracts.

export interface KernelTaskSnapshot {
  schemaVersion: 1;
  objective: string;
  acceptance: {
    id: string;
    statement: string;
    evidencePlan: null | {
      class: null | 'hard' | 'judgment';
      method: null | string;
      commandRefs: string[];
      obligationId: null | string;
      evidenceLevel: null | 'work' | 'integration' | 'goal';
      scope: string[];
      freshnessInputs: string[];
      outcome: null | 'implemented' | 'verified' | 'deployed' | 'observed' | 'resolved';
    };
    structured: boolean;
  }[];
  constraints: string[];
  nonGoals: string[];
  risks: string[];
  surfaces: string[];
  taskClass: string;
  requestedTier?: unknown;
  changeClass: null | string;
  scopeExtension: boolean;
  defectWithinScope: boolean;
  replacement: boolean;
  requiredObligations: string[];
  requiredVerifications: unknown[];
  completionPredicate: {
    requiredOutcomes: string[];
  };
  seedProvenance?: unknown;
  steps: {
    stepId?: unknown;
    acceptanceIds?: unknown;
    acceptanceCoverage?: unknown;
    coverage?: unknown;
    acceptanceMapping?: unknown;
    obligationIds?: unknown;
    [k: string]: unknown | undefined;
  }[];
  supersededStepIds: string[];
  allowedPaths: string[];
  forbiddenPaths: string[];
  filesChanged: number;
  strictBoundedScope: boolean;
  flags: {
    [k: string]: unknown | undefined;
  };
  changedPaths?: unknown;
  digest: string;
  [k: string]: unknown | undefined;
}
