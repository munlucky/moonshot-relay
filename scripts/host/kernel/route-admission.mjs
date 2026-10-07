// Route Admission (K3). A route decision says which model CLASS must run the
// turn. Between that decision and the actual dispatch sits the Host's own
// configuration — profiles, capabilities, permission and tool policy — and any
// of it can change or simply fail to satisfy the class.
//
// Admission is the check in that gap: it records what the Kernel asked for, what
// the Host resolved, and whether the two are compatible, BEFORE a worker runs.
// Without it a T3 independent review can quietly execute on a host default.

import { canonicalDigest, digestWithout } from '../../kernel/canonical-digest.mjs';
import {
  executionClassFromLegacyModelClass,
  legacyModelClassForExecutionClass,
  normalizeExecutionClass,
} from '../../kernel/run/execution-class.mjs';

export const ADMISSION_SCHEMA_VERSION = 1;
export const ADMISSION_DECISIONS = Object.freeze(['admitted', 'fallback_admitted', 'advisory_admitted', 'blocked', 'redecision_required']);
export const ADMITTED_DECISIONS = Object.freeze(['admitted', 'fallback_admitted', 'advisory_admitted']);

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
});

export class RouteAdmissionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RouteAdmissionError';
    this.code = code;
  }
}

export const buildAdmissionId = (digest) => `admission-${String(digest).replace(/^sha256:/, '').slice(0, 24)}`;

// The Host's configuration, reduced to comparable digests. Comparing digests
// rather than whole objects is what makes drift detectable without the Kernel
// ever reading a provider credential.
export const policyDigests = ({
  modelPolicyRevision = 'kernel-model-policy.v1',
  profiles = {},
  capabilities = {},
  toolPolicy = {},
  permissionPolicy = {},
} = {}) => ({
  modelPolicyRevision: String(modelPolicyRevision),
  profileDigest: canonicalDigest(profiles),
  hostCapabilityDigest: canonicalDigest(capabilities),
  toolPolicyDigest: canonicalDigest(toolPolicy),
  permissionPolicyDigest: canonicalDigest(permissionPolicy),
});

const rank = { T0: 0, T1: 1, T2: 2, T3: 3 };

// Raw admission callers can arrive before the full model-route normalizer. Keep
// the compatibility modelClass field honest at this boundary as well: an
// explicit executionClass must map to the same legacy class, and the Host must
// resolve the same execution class the Kernel decided. A malformed or partial
// pair is a rejection, never an invitation to let role rules guess.
const comparableRouteClass = (route = {}) => {
  const hasExecutionClass = Object.hasOwn(route, 'executionClass');
  const hasModelClass = Object.hasOwn(route, 'modelClass');
  let executionClass = null;
  let modelClass = hasModelClass ? route.modelClass : null;

  try {
    if (hasExecutionClass) executionClass = normalizeExecutionClass(route.executionClass);
    if (hasModelClass) {
      const modelExecutionClass = executionClassFromLegacyModelClass(route.modelClass);
      if (hasExecutionClass && legacyModelClassForExecutionClass(executionClass) !== route.modelClass) {
        return { mismatch: true };
      }
      if (!hasExecutionClass) executionClass = modelExecutionClass;
    }
    if (!hasModelClass) modelClass = legacyModelClassForExecutionClass(executionClass);
    return { executionClass, modelClass, mismatch: false };
  } catch {
    return { mismatch: true };
  }
};

const routeClassRejection = ({ decision, resolution } = {}) => {
  const decided = comparableRouteClass(decision);
  const resolved = comparableRouteClass(resolution);
  if (decided.mismatch || resolved.mismatch || decided.executionClass !== resolved.executionClass) {
    return REJECTION_CODES.ROUTE_CLASS_MISMATCH;
  }
  return null;
};

// Role rules (§8.6). Each returns a rejection code or null.
const checkRoleRules = ({ decision, resolution, capabilities, capsule, riskTier }) => {
  const reviewer = decision.role === 'reviewer';
  const independent = decision.independentContextRequired === true;

  if (capsule) {
    if (reviewer && capsule.role !== 'reviewer') return REJECTION_CODES.CAPSULE_ROLE_MISMATCH;
    if (!reviewer && capsule.role === 'reviewer') return REJECTION_CODES.CAPSULE_ROLE_MISMATCH;
    if (capsule.permissions?.canCommit === true || capsule.permissions?.canDelegate === true) return REJECTION_CODES.CAPSULE_GRANTS_AUTHORITY;
    if (decision.permissions === 'read_only' && capsule.permissions?.filesystem !== 'read_only') return REJECTION_CODES.CAPSULE_PERMISSION_MISMATCH;
    if (decision.permissions === 'workspace_write' && capsule.permissions?.filesystem !== 'workspace_write') return REJECTION_CODES.CAPSULE_PERMISSION_MISMATCH;
  }

  if (reviewer) {
    if (decision.permissions !== 'read_only') return REJECTION_CODES.REVIEW_NOT_READ_ONLY;
    if (rank[riskTier] >= rank.T3 || independent) {
      if (decision.modelClass !== 'frontier_reasoning') return REJECTION_CODES.REVIEW_NOT_FRONTIER;
      if (capabilities.supportsIndependentContext !== true) return REJECTION_CODES.REVIEW_NO_INDEPENDENT_CONTEXT;
      if (resolution.source === 'host-default' || resolution.enforcementIntent !== 'enforced') return REJECTION_CODES.REVIEW_NOT_ADVISORY;
    }
    return null;
  }

  if (decision.role === 'implementer' && decision.permissions !== 'workspace_write') return REJECTION_CODES.IMPLEMENTER_NEEDS_WRITE;
  return null;
};

// Admission decision. `admitted` means the requested class is actually applied;
// anything weaker says so in its own name rather than passing as success.
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
} = {}) => {
  if (!decision) throw new RouteAdmissionError('kernel_route_admission_invalid', 'admitRoute requires the route decision it answers');
  if (!resolution) throw new RouteAdmissionError('kernel_route_admission_invalid', 'admitRoute requires the Host model resolution');
  const riskTier = decision.riskTier || run.proofTier || 'T0';

  const requested = {
    modelClass: decision.modelClass,
    permissions: decision.permissions,
    independentContextRequired: decision.independentContextRequired === true,
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
  const cost = {
    costClass: decision.modelClass === 'frontier_reasoning' ? 'frontier' : 'value',
    maxCostUnits: Number.isFinite(economics.maxCostUnits) ? economics.maxCostUnits : null,
    estimatedCostUnits: Number.isFinite(economics.estimatedCostUnits) ? economics.estimatedCostUnits : null,
  };

  let admissionDecision = 'admitted';
  let rejectionCode = null;

  if (decision.modelClass === 'kernel') {
    admissionDecision = 'blocked';
    rejectionCode = REJECTION_CODES.KERNEL_OWNED;
  }

  if (!rejectionCode) {
    rejectionCode = routeClassRejection({ decision, resolution });
    if (rejectionCode) admissionDecision = 'blocked';
  }

  if (!rejectionCode) {
    rejectionCode = checkRoleRules({ decision, resolution, capabilities, capsule, riskTier });
    if (rejectionCode) admissionDecision = 'blocked';
  }

  if (!rejectionCode && cost.maxCostUnits !== null && cost.estimatedCostUnits !== null && cost.estimatedCostUnits > cost.maxCostUnits) {
    admissionDecision = 'blocked';
    rejectionCode = REJECTION_CODES.COST_CAP_EXCEEDED;
  }

  if (!rejectionCode) {
    const canSelectModel = capabilities.supportsSubagentModel === true || capabilities.supportsSessionModelOverride === true;
    const canProveIdentity = capabilities.supportsResolvedModelIdentity === true;
    if (resolved.source === 'host-default' || resolution.enforcementIntent !== 'enforced' || !canProveIdentity) {
      // The installed Host default runs. That is honest, but it is not the
      // Kernel applying a class, so it can never be reported as `admitted`.
      admissionDecision = 'advisory_admitted';
    } else if (!canSelectModel) {
      admissionDecision = 'blocked';
      rejectionCode = REJECTION_CODES.ADAPTER_CANNOT_SELECT_MODEL;
    } else if (requested.independentContextRequired && !capabilities.supportsSubagentModel) {
      // The model can be pinned, but only for the whole session rather than an
      // isolated one: a documented fallback, never silent.
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
    planRevision: Number(step?.planRevision || run.planRevision || decision.planRevision || 1),
    role: decision.role,
    riskTier,
    requested,
    resolved,
    policy: { ...policies },
    economics: cost,
    decision: admissionDecision,
    rejectionCode: rejectionCode || null,
    createdByVersion: 'kernel.route-admission.v1',
  };

  const digest = digestWithout(body, []);
  return Object.freeze({
    ...body,
    admissionId: buildAdmissionId(digest),
    digest,
    createdAt: createdAt ? String(createdAt) : new Date().toISOString(),
  });
};

export const admissionAllowsDispatch = (admission) => ADMITTED_DECISIONS.includes(admission?.decision);

// Dispatch-time revalidation (§8.5). The admission was computed against a
// snapshot of the Host's configuration; if that configuration moved in between,
// the admission describes a world that no longer exists.
export const revalidateAdmissionAtDispatch = ({ admission, policies } = {}) => {
  if (!admission) return { valid: false, decision: 'blocked', rejectionCode: 'admission-missing', drift: [] };
  const current = policies || policyDigests();
  const drift = [];

  const compare = (field, code, decision) => {
    if (admission.policy[field] === current[field]) return;
    drift.push({ field, expected: admission.policy[field], actual: current[field], rejectionCode: code, decision });
  };

  // A changed profile means the class may now resolve to a different model:
  // recompute the route rather than guess. A changed permission or tool policy
  // is a boundary change and blocks outright.
  compare('profileDigest', REJECTION_CODES.PROFILE_DRIFT, 'redecision_required');
  compare('hostCapabilityDigest', REJECTION_CODES.CAPABILITY_DRIFT, 'redecision_required');
  compare('modelPolicyRevision', REJECTION_CODES.PROFILE_DRIFT, 'redecision_required');
  compare('permissionPolicyDigest', REJECTION_CODES.PERMISSION_POLICY_DRIFT, 'blocked');
  compare('toolPolicyDigest', REJECTION_CODES.TOOL_POLICY_DRIFT, 'blocked');

  if (drift.length === 0) {
    return { valid: admissionAllowsDispatch(admission), decision: admission.decision, rejectionCode: admission.rejectionCode, drift: [] };
  }
  const blocking = drift.find((entry) => entry.decision === 'blocked');
  const chosen = blocking || drift[0];
  return { valid: false, decision: chosen.decision, rejectionCode: chosen.rejectionCode, drift };
};
