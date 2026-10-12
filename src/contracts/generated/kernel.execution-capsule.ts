// Generated from schemas/kernel.execution-capsule.schema.json. Edit the schema and run build:contracts.

export interface KernelExecutionCapsule {
  capsuleId: string;
  provenance: {
    capsuleDigest: string;
    workspaceIdentity: string;
    sourceIdentity: null | string;
    taskContractDigest: null | string;
    knowledgeContextDigest: null | string;
    routeDecisionId: null | string;
    createdByVersion: string;
    migrationOrigin: null | string;
  };
  createdAt: string;
  schemaVersion: 1;
  runId: string;
  stepId: null | string;
  role: 'implementer' | 'reviewer' | 'planner' | 'researcher';
  riskTier: string;
  planRevision: number;
  mutationRevision: number;
  objective: string;
  acceptance: {
    id: string;
    statement: string;
    obligationIds: string[];
  }[];
  constraints: string[];
  nonGoals: string[];
  workUnit: {
    objective: string;
    dependencies: string[];
    allowedPaths: string[];
    forbiddenPaths: string[];
    expectedOutputs: string[];
  };
  repositoryContext: {
    projectMode: null | string;
    entrypoints: string[];
    relevantFiles: {
      path: string;
      reason: string;
      digest: null | string;
    }[];
    relevantSymbols: {
      symbol: string;
      path: string;
    }[];
    manifests: string[];
    knownCommands: string[];
    architectureRecords: {
      recordId: string;
      summary: string;
    }[];
    knowledgeRecords: {
      recordId: string;
      summary: string;
      revision: null | number;
    }[];
    walkingSkeleton: {
      [k: string]: unknown | undefined;
    } | null;
    baseline: {
      status: string;
      digest: null | string;
      knownFailures: unknown[];
    };
  };
  verification: {
    obligations: {
      obligationId: string;
      evidenceClass: string;
      allowedCommandRefs: string[];
      acceptanceIds: string[];
    }[];
  };
  permissions: {
    filesystem: 'read_only' | 'plan_write' | 'workspace_write';
    network: string;
    canDelegate: boolean;
    canCommit: boolean;
  };
  budget: {
    reductions: unknown[];
    serializedBytes: null | number;
    withinBudget: boolean;
  };
}
