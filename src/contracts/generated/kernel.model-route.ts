// Generated from schemas/kernel.model-route.schema.json. Edit the schema and run build:contracts.

export interface KernelModelRoute {
  schemaVersion: 1;
  decisionId: string;
  runId: string;
  attemptNumber: number;
  replanCount: number;
  planRevision: number;
  obligationId: null | string;
  actionKind:
    | 'understand'
    | 'design'
    | 'plan'
    | 'implement'
    | 'debug'
    | 'review_contract'
    | 'review_engineering'
    | 'replan'
    | 'prove'
    | 'close';
  role: 'planner' | 'implementer' | 'reviewer' | 'kernel';
  executionClass: null | 'planning' | 'complex_implementation' | 'review' | 'standard';
  modelClass: 'kernel' | 'frontier_reasoning' | 'value_coding';
  riskTier: 'T0' | 'T1' | 'T2' | 'T3';
  independentContextRequired: boolean;
  workProfile: null | {
    executionClass: null | 'planning' | 'complex_implementation' | 'review' | 'standard';
    complexity: 'standard' | 'routine' | 'complex' | 'large-refactor';
    repeatedFailure: boolean;
    independentContextRequired: boolean;
    parallelizable: boolean;
  };
  permissions: 'read_only' | 'plan_write' | 'workspace_write' | 'kernel_runtime';
  reasonCodes: string[];
  policyRevision: string;
  createdAt: string;
}
