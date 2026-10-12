// Route Admission (K3). A route decision says which model CLASS must run the
// turn. Between that decision and the actual dispatch sits the Host's own
// configuration — profiles, capabilities, permission and tool policy — and any
// of it can change or simply fail to satisfy the class.

import {
  canonicalDigest,
  digestWithout,
} from '../../shared/canonical-digest.js';
import {
  executionClassFromLegacyModelClass,
  legacyModelClassForExecutionClass,
  normalizeExecutionClass,
  type ExecutionClass,
  type LegacyModelClass,
} from '../../contracts/execution-class.js';

type UnknownRecord = Record<string, unknown>;

interface RouteLike {
  executionClass?: unknown;
  modelClass?: unknown;
  role?: (unknown) | undefined;
  permissions?: (unknown) | undefined;
  independentContextRequired?: unknown;
  riskTier?: unknown;
  runId?: unknown;
  decisionId?: unknown;
  planRevision?: unknown;
}

interface ResolutionLike extends RouteLike {
  surface?: unknown;
  model?: unknown;
  effort?: unknown;
  source?: unknown;
  enforcementIntent?: unknown;
}

interface CapabilitiesLike extends UnknownRecord {
  surface?: unknown;
  adapterVersion?: unknown;
  supportsIndependentContext?: unknown;
  supportsSubagentModel?: unknown;
  supportsSessionModelOverride?: unknown;
  supportsResolvedModelIdentity?: unknown;
}

interface CapsulePermissionsLike extends UnknownRecord {
  canCommit?: unknown;
  canDelegate?: unknown;
  filesystem?: unknown;
}

interface CapsuleProvenanceLike extends UnknownRecord {
  capsuleDigest?: unknown;
}

interface CapsuleLike extends UnknownRecord {
  role?: (unknown) | undefined;
  permissions?: CapsulePermissionsLike | null;
  stepId?: unknown;
  capsuleId?: unknown;
  provenance?: CapsuleProvenanceLike | null;
}

interface RunLike extends UnknownRecord {
  proofTier?: unknown;
  planRevision?: unknown;
}

interface StepLike extends UnknownRecord {
  stepId?: unknown;
  planRevision?: unknown;
}

interface EconomicsLike extends UnknownRecord {
  maxCostUnits?: unknown;
  estimatedCostUnits?: unknown;
}

export interface AdmissionPolicyDigests {
  modelPolicyRevision: string;
  profileDigest: string;
  hostCapabilityDigest: string;
  toolPolicyDigest: string;
  permissionPolicyDigest: string;
}

export interface AdmissionLike extends UnknownRecord {
  policy?: Partial<AdmissionPolicyDigests> | null;
  decision?: unknown;
  rejectionCode?: unknown;
}

interface AdmissionDrift {
  field: keyof AdmissionPolicyDigests;
  expected: unknown;
  actual: unknown;
  rejectionCode: string;
  decision: 'blocked' | 'redecision_required';
}

type ComparableRouteClass =
  | {
      executionClass: ExecutionClass | null;
      modelClass: LegacyModelClass;
      mismatch: false;
    }
  | {
      mismatch: true;
      executionClass?: undefined;
      modelClass?: undefined;
    };

export const ADMISSION_SCHEMA_VERSION = 1;
export const ADMISSION_DECISIONS = Object.freeze([
  'admitted',
  'fallback_admitted',
  'advisory_admitted',
  'blocked',
  'redecision_required',
] as const);
export const ADMITTED_DECISIONS = Object.freeze([
  'admitted',
  'fallback_admitted',
  'advisory_admitted',
] as const);

export const REJECTION_CODES = Object.freeze({
  KERNEL_OWNED: 'kernel-owned-action-not-dispatchable',
  REVIEW_NOT_FRONTIER: 'independent-review-requires-frontier-class',
  REVIEW_NOT_ADVISORY: 'independent-review-cannot-run-on-host-default',
  REVIEW_NOT_READ_ONLY: 'reviewer-must-be-read-only',
  REVIEW_NO_INDEPENDENT_CONTEXT: 'host-cannot-provide-independent-context',
  IMPLEMENTER_NEEDS_WRITE: 'implementer-requires-workspace-write',
  CAPSULE_ROLE_MISMATCH: 'capsule-role-does-not-match-route-role',
  CAPSULE_PERMISSION_MISMATCH: 'capsule-permission-does-not-match-route-permission',
  CAPSULE_GRANTS_AUTHORITY: 'capsule-must-not-grant-commit-or-delegation',
  ADAPTER_CANNOT_SELECT_MODEL: 'adapter-cannot-apply-the-requested-model',
  ROUTE_CLASS_MISMATCH: 'route-execution-class-mismatch',
  COST_CAP_EXCEEDED: 'cost-cap-exceeded',
  PROFILE_DRIFT: 'profile-changed-after-the-route-decision',
  PERMISSION_POLICY_DRIFT: 'permission-policy-changed-after-the-route-decision',
  TOOL_POLICY_DRIFT: 'tool-policy-changed-after-the-route-decision',
  CAPABILITY_DRIFT: 'host-capabilities-changed-after-the-route-decision',
} as const);

export class RouteAdmissionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'RouteAdmissionError';
    this.code = code;
  }
}

export const buildAdmissionId = (digest: unknown): string =>
  `admission-${String(digest).replace(/^sha256:/, '').slice(0, 24)}`;

export const policyDigests = ({
  modelPolicyRevision = 'kernel-model-policy.v1',
  profiles = {},
  capabilities = {},
  toolPolicy = {},
  permissionPolicy = {},
}: {
  modelPolicyRevision?: unknown;
  profiles?: unknown;
  capabilities?: unknown;
  toolPolicy?: unknown;
  permissionPolicy?: unknown;
} = {}): AdmissionPolicyDigests => ({
  modelPolicyRevision: String(modelPolicyRevision),
  profileDigest: canonicalDigest(profiles),
  hostCapabilityDigest: canonicalDigest(capabilities),
  toolPolicyDigest: canonicalDigest(toolPolicy),
  permissionPolicyDigest: canonicalDigest(permissionPolicy),
});

const riskRank = new Map<string, number>([
  ['T0', 0],
  ['T1', 1],
  ['T2', 2],
  ['T3', 3],
]);

const comparableRouteClass = (
  route: RouteLike = {},
): ComparableRouteClass => {
  const hasExecutionClass = Object.hasOwn(route, 'executionClass');
  const hasModelClass = Object.hasOwn(route, 'modelClass');
  let executionClass: ExecutionClass | null = null;
  let modelClass: LegacyModelClass = 'kernel';

  try {
    if (hasExecutionClass) {
      executionClass = normalizeExecutionClass(route.executionClass);
    }
    if (hasModelClass) {
      const modelExecutionClass = executionClassFromLegacyModelClass(
        route.modelClass,
      );
      const requestedModelClass = String(route.modelClass);
      if (
        hasExecutionClass
        && legacyModelClassForExecutionClass(executionClass)
          !== requestedModelClass
      ) {
        return { mismatch: true };
      }
      if (!hasExecutionClass) {
        executionClass = modelExecutionClass;
      }
      modelClass = legacyModelClassForExecutionClass(modelExecutionClass);
    }
    if (!hasModelClass) {
      modelClass = legacyModelClassForExecutionClass(executionClass);
    }
    return {
      executionClass,
      modelClass,
      mismatch: false,
    };
  } catch {
    return { mismatch: true };
  }
};

const routeClassRejection = ({
  decision = {},
  resolution = {},
}: {
  decision?: RouteLike;
  resolution?: RouteLike;
} = {}): string | null => {
  const decided = comparableRouteClass(decision);
  const resolved = comparableRouteClass(resolution);
  if (
    decided.mismatch
    || resolved.mismatch
    || decided.executionClass !== resolved.executionClass
  ) {
    return REJECTION_CODES.ROUTE_CLASS_MISMATCH;
  }
  return null;
};

const checkRoleRules = ({
  decision,
  resolution,
  capabilities,
  capsule,
  riskTier,
}: {
  decision: RouteLike;
  resolution: ResolutionLike;
  capabilities: CapabilitiesLike;
  capsule: CapsuleLike | null;
  riskTier: unknown;
}): string | null => {
  const reviewer = decision.role === 'reviewer';
  const independent = decision.independentContextRequired === true;

  if (capsule) {
    if (reviewer && capsule.role !== 'reviewer') {
      return REJECTION_CODES.CAPSULE_ROLE_MISMATCH;
    }
    if (!reviewer && capsule.role === 'reviewer') {
      return REJECTION_CODES.CAPSULE_ROLE_MISMATCH;
    }
    if (
      capsule.permissions?.canCommit === true
      || capsule.permissions?.canDelegate === true
    ) {
      return REJECTION_CODES.CAPSULE_GRANTS_AUTHORITY;
    }
    if (
      decision.permissions === 'read_only'
      && capsule.permissions?.filesystem !== 'read_only'
    ) {
      return REJECTION_CODES.CAPSULE_PERMISSION_MISMATCH;
    }
    if (
      decision.permissions === 'workspace_write'
      && capsule.permissions?.filesystem !== 'workspace_write'
    ) {
      return REJECTION_CODES.CAPSULE_PERMISSION_MISMATCH;
    }
  }

  if (reviewer) {
    if (decision.permissions !== 'read_only') {
      return REJECTION_CODES.REVIEW_NOT_READ_ONLY;
    }
    if ((riskRank.get(String(riskTier)) ?? -1) >= 3 || independent) {
      if (decision.modelClass !== 'frontier_reasoning') {
        return REJECTION_CODES.REVIEW_NOT_FRONTIER;
      }
      if (capabilities.supportsIndependentContext !== true) {
        return REJECTION_CODES.REVIEW_NO_INDEPENDENT_CONTEXT;
      }
      if (
        resolution.source === 'host-default'
        || resolution.enforcementIntent !== 'enforced'
      ) {
        return REJECTION_CODES.REVIEW_NOT_ADVISORY;
      }
    }
    return null;
  }

  if (
    decision.role === 'implementer'
    && decision.permissions !== 'workspace_write'
  ) {
    return REJECTION_CODES.IMPLEMENTER_NEEDS_WRITE;
  }
  return null;
};

export const admitRoute = ({
  run = {},
  step = null,
  attemptId = null,
  decision,
  resolution,
  capabilities = {},
  capsule = null,
  policies = policyDigests(),
  economics = {},
  createdAt = null,
}: {
  run?: (RunLike) | undefined;
  step?: StepLike | null;
  attemptId?: unknown;
  decision?: RouteLike | null;
  resolution?: ResolutionLike | null;
  capabilities?: (CapabilitiesLike) | undefined;
  capsule?: CapsuleLike | null;
  policies?: AdmissionPolicyDigests;
  economics?: EconomicsLike;
  createdAt?: unknown;
} = {}) => {
  if (!decision) {
    throw new RouteAdmissionError(
      'kernel_route_admission_invalid',
      'admitRoute requires the route decision it answers',
    );
  }
  if (!resolution) {
    throw new RouteAdmissionError(
      'kernel_route_admission_invalid',
      'admitRoute requires the Host model resolution',
    );
  }
  const riskTier = decision.riskTier || run.proofTier || 'T0';

  const requested = {
    modelClass: decision.modelClass,
    permissions: decision.permissions,
    independentContextRequired:
      decision.independentContextRequired === true,
    role: decision.role,
  };
  const resolved = {
    surface: resolution.surface || capabilities.surface || null,
    model: resolution.model || null,
    effort: resolution.effort || null,
    source: resolution.source || 'host-default',
    adapter: capabilities.surface || null,
    adapterVersion: String(capabilities.adapterVersion || '1'),
  };
  const maxCostUnits = Number(economics.maxCostUnits);
  const estimatedCostUnits = Number(economics.estimatedCostUnits);
  const cost = {
    costClass: decision.modelClass === 'frontier_reasoning'
      ? 'frontier'
      : 'value',
    maxCostUnits: Number.isFinite(maxCostUnits)
      ? maxCostUnits
      : null,
    estimatedCostUnits: Number.isFinite(estimatedCostUnits)
      ? estimatedCostUnits
      : null,
  };

  let admissionDecision: (typeof ADMISSION_DECISIONS)[number] = 'admitted';
  let rejectionCode: string | null = null;

  if (decision.modelClass === 'kernel') {
    admissionDecision = 'blocked';
    rejectionCode = REJECTION_CODES.KERNEL_OWNED;
  }

  if (!rejectionCode) {
    rejectionCode = routeClassRejection({ decision, resolution });
    if (rejectionCode) admissionDecision = 'blocked';
  }

  if (!rejectionCode) {
    rejectionCode = checkRoleRules({
      decision,
      resolution,
      capabilities,
      capsule,
      riskTier,
    });
    if (rejectionCode) admissionDecision = 'blocked';
  }

  if (
    !rejectionCode
    && cost.maxCostUnits !== null
    && cost.estimatedCostUnits !== null
    && cost.estimatedCostUnits > cost.maxCostUnits
  ) {
    admissionDecision = 'blocked';
    rejectionCode = REJECTION_CODES.COST_CAP_EXCEEDED;
  }

  if (!rejectionCode) {
    const canSelectModel = (
      capabilities.supportsSubagentModel === true
      || capabilities.supportsSessionModelOverride === true
    );
    const canProveIdentity = (
      capabilities.supportsResolvedModelIdentity === true
    );
    if (
      resolved.source === 'host-default'
      || resolution.enforcementIntent !== 'enforced'
      || !canProveIdentity
    ) {
      admissionDecision = 'advisory_admitted';
    } else if (!canSelectModel) {
      admissionDecision = 'blocked';
      rejectionCode = REJECTION_CODES.ADAPTER_CANNOT_SELECT_MODEL;
    } else if (
      requested.independentContextRequired
      && !capabilities.supportsSubagentModel
    ) {
      admissionDecision = 'fallback_admitted';
    }
  }

  const body = {
    schemaVersion: ADMISSION_SCHEMA_VERSION,
    runId: decision.runId,
    attemptId: attemptId || null,
    stepId: step?.stepId || capsule?.stepId || null,
    decisionId: decision.decisionId,
    capsuleId: capsule?.capsuleId || null,
    capsuleDigest: capsule?.provenance?.capsuleDigest || null,
    planRevision: Number(
      step?.planRevision
      || run.planRevision
      || decision.planRevision
      || 1,
    ),
    role: decision.role,
    riskTier,
    requested,
    resolved,
    policy: { ...policies },
    economics: cost,
    decision: admissionDecision,
    rejectionCode,
    createdByVersion: 'kernel.route-admission.v1',
  };

  const digest = digestWithout(body, []);
  return Object.freeze({
    ...body,
    admissionId: buildAdmissionId(digest),
    digest,
    createdAt: createdAt
      ? String(createdAt)
      : new Date().toISOString(),
  });
};

export const admissionAllowsDispatch = (
  admission: AdmissionLike | null | undefined,
): boolean => (
  (ADMITTED_DECISIONS as readonly unknown[])
    .includes(admission?.decision)
);

export const revalidateAdmissionAtDispatch = ({
  admission,
  policies,
}: {
  admission?: (AdmissionLike | null) | undefined;
  policies?: AdmissionPolicyDigests | null;
} = {}) => {
  if (!admission) {
    return {
      valid: false,
      decision: 'blocked',
      rejectionCode: 'admission-missing',
      drift: [] as AdmissionDrift[],
    };
  }
  const current = policies || policyDigests();
  const prior = admission.policy || {};
  const drift: AdmissionDrift[] = [];

  const compare = (
    field: keyof AdmissionPolicyDigests,
    code: string,
    decision: AdmissionDrift['decision'],
  ): void => {
    if (prior[field] === current[field]) return;
    drift.push({
      field,
      expected: prior[field],
      actual: current[field],
      rejectionCode: code,
      decision,
    });
  };

  compare(
    'profileDigest',
    REJECTION_CODES.PROFILE_DRIFT,
    'redecision_required',
  );
  compare(
    'hostCapabilityDigest',
    REJECTION_CODES.CAPABILITY_DRIFT,
    'redecision_required',
  );
  compare(
    'modelPolicyRevision',
    REJECTION_CODES.PROFILE_DRIFT,
    'redecision_required',
  );
  compare(
    'permissionPolicyDigest',
    REJECTION_CODES.PERMISSION_POLICY_DRIFT,
    'blocked',
  );
  compare(
    'toolPolicyDigest',
    REJECTION_CODES.TOOL_POLICY_DRIFT,
    'blocked',
  );

  if (drift.length === 0) {
    return {
      valid: admissionAllowsDispatch(admission),
      decision: admission.decision,
      rejectionCode: admission.rejectionCode,
      drift: [],
    };
  }
  const blocking = drift.find(
    (entry) => entry.decision === 'blocked',
  );
  const chosen = blocking || drift[0];
  if (!chosen) throw new Error('Admission drift selection is empty');
  return {
    valid: false,
    decision: chosen.decision,
    rejectionCode: chosen.rejectionCode,
    drift,
  };
};
