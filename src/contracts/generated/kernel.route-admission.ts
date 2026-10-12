// Generated from schemas/kernel.route-admission.schema.json. Edit the schema and run build:contracts.

/**
 * The check between a logical model route decision and the actual Host dispatch. Records what the Kernel requested, what the Host resolved, and the policy snapshot both were computed against, so configuration drift is detected before a worker runs. 'advisory_admitted' means the installed Host default ran and the requested class was NOT applied; it can never carry a T3 independent review.
 */
export interface KernelRouteAdmission {
  schemaVersion: 1;
  admissionId: string;
  runId: string;
  attemptId?: null | string;
  stepId?: string | null;
  decisionId: string;
  capsuleId?: null | string;
  capsuleDigest?: null | string;
  planRevision?: number;
  role: 'planner' | 'implementer' | 'reviewer' | 'kernel';
  riskTier: 'T0' | 'T1' | 'T2' | 'T3';
  requested: {
    modelClass: 'frontier_reasoning' | 'value_coding' | 'kernel';
    permissions: 'read_only' | 'plan_write' | 'workspace_write' | 'kernel_runtime';
    independentContextRequired: boolean;
    role?: string;
  };
  resolved: {
    surface?: string | null;
    model?: string | null;
    effort?: string | null;
    source: 'invocation-override' | 'environment' | 'profile-config' | 'host-default' | 'kernel-runtime';
    adapter?: string | null;
    adapterVersion?: string;
  };
  policy: {
    modelPolicyRevision: string;
    profileDigest: string;
    hostCapabilityDigest: string;
    toolPolicyDigest: string;
    permissionPolicyDigest: string;
  };
  economics: {
    costClass?: string;
    maxCostUnits?: number | null;
    estimatedCostUnits?: number | null;
  };
  decision: 'admitted' | 'fallback_admitted' | 'advisory_admitted' | 'blocked' | 'redecision_required';
  rejectionCode?: string | null;
  createdByVersion?: string;
  digest: string;
  createdAt: string;
}
