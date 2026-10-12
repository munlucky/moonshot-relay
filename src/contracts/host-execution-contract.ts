import type { ExecutionClass } from './execution-class.js';
import { normalizeExecutionClass } from './execution-class.js';

export const HOST_EXECUTION_CONTRACT_SCHEMA_VERSION = 2 as const;

export const HOST_SEMANTIC_CAPABILITY_KEYS = [
  'freshContext',
  'workspaceWrite',
  'workspaceIsolation',
  'parallelExecution',
  'independentReview',
  'modelSelection',
] as const;

export type HostSemanticCapabilityKey = typeof HOST_SEMANTIC_CAPABILITY_KEYS[number];

export interface HostSemanticRequirements extends Record<HostSemanticCapabilityKey, boolean> {}

export interface HostSemanticCapabilities {
  semantic?: Partial<Record<HostSemanticCapabilityKey, boolean>>;
}

export interface HostWorkUnitContract {
  objective: string;
  allowedPaths: string[];
  forbiddenPaths: string[];
  expectedOutputs: string[];
}

// Host input preserves the established defaulting behavior for explicit undefined fields.
export type HostWorkUnitInput = {
  [K in keyof HostWorkUnitContract]?: HostWorkUnitContract[K] | undefined;
};

interface WorkProfileLike {
  executionClass?: ExecutionClass | null;
  complexity?: unknown;
  independentContextRequired?: boolean;
  parallelizable?: boolean;
}

interface RouteDecisionLike {
  runId?: unknown;
  decisionId?: unknown;
  actionKind?: unknown;
  role?: unknown;
  permissions?: unknown;
  executionClass?: unknown;
  independentContextRequired?: boolean;
  workProfile?: WorkProfileLike | null;
  reasonCodes?: readonly string[];
}

interface AssignmentLike {
  workProfile?: WorkProfileLike | null;
  executionMode?: unknown;
  freshSessionRequired?: boolean;
  modelSelectionRequired?: boolean;
  delegation?: {
    mode?: unknown;
    requested?: boolean;
  } | null;
}

interface CapsuleLike {
  capsuleId?: unknown;
  stepId?: unknown;
  workUnit?: HostWorkUnitInput | null;
  provenance?: {
    capsuleDigest?: unknown;
  } | null;
}

export interface HostExecutionContract {
  schemaVersion: typeof HOST_EXECUTION_CONTRACT_SCHEMA_VERSION;
  runId: string | null;
  decisionId: string | null;
  actionKind: string | null;
  role: string | null;
  permissions: string | null;
  executionClass: ExecutionClass | null;
  workProfile: {
    executionClass: ExecutionClass | null;
    complexity: string | null;
    independentContextRequired: boolean;
    parallelizable: boolean;
  } | null;
  executionMode: string | null;
  requirements: HostSemanticRequirements;
  delegation: {
    mode: string | null;
    requested: boolean;
  } | null;
  freshSessionRequired: boolean;
  workUnit: HostWorkUnitContract;
  capsule: {
    capsuleId: string | null;
    capsuleDigest: string | null;
    stepId: string | null;
  } | null;
  attemptId: string | null;
}

export interface BuildHostExecutionContractInput {
  decision?: (RouteDecisionLike | null) | undefined;
  assignment?: (AssignmentLike | null) | undefined;
  capsule?: (CapsuleLike | null) | undefined;
  attemptId?: unknown;
  workUnit?: HostWorkUnitInput | null;
}

export const HOST_OWNED_CONCERNS = [
  'provider',
  'model',
  'reasoningEffort',
  'session',
  'process',
  'worktree',
  'git',
  'prompt',
  'cache',
  'package',
  'profile',
] as const;

const providerFieldNames = new Set([
  'provider', 'providerModel', 'model', 'modelClass', 'resolvedModel', 'requestedModel',
  'effort', 'reasoning', 'reasoningEffort', 'resolvedEffort', 'requestedEffort',
  'apiKey', 'credentials', 'authorization', 'prompt', 'promptText', 'messages',
  'sessionId', 'nativeSessionId', 'worktreeRoot', 'gitState', 'cacheKey',
]);

export class HostExecutionContractError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'HostExecutionContractError';
    this.code = code;
  }
}

const stringOrNull = (value: unknown) => (
  value === null || value === undefined || value === '' ? null : String(value)
);

const stringList = (value: unknown): string[] => (
  Array.isArray(value) ? value.map(String).filter(Boolean) : []
);

const assertProviderNeutral = (value: unknown, currentPath = 'contract'): void => {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertProviderNeutral(entry, `${currentPath}[${index}]`));
    return;
  }
  if (typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (providerFieldNames.has(key)) {
      throw new HostExecutionContractError(
        'host_execution_contract_provider_field',
        `host_execution_contract_provider_field:${currentPath}.${key}`,
      );
    }
    assertProviderNeutral(child, `${currentPath}.${key}`);
  }
};

const semanticRequirements = ({
  decision = {},
  assignment = null,
}: {
  decision?: RouteDecisionLike;
  assignment?: AssignmentLike | null;
} = {}): HostSemanticRequirements => {
  const resolvedAssignment = assignment || {};
  return Object.freeze({
    freshContext: resolvedAssignment.freshSessionRequired === true || decision.independentContextRequired === true,
    workspaceWrite: decision.permissions === 'workspace_write',
    workspaceIsolation: resolvedAssignment.workProfile?.parallelizable === true || resolvedAssignment.executionMode === 'parallel',
    parallelExecution: resolvedAssignment.executionMode === 'parallel',
    independentReview: decision.role === 'reviewer'
      && (resolvedAssignment.freshSessionRequired === true || decision.independentContextRequired === true),
    modelSelection: resolvedAssignment.modelSelectionRequired === true,
  });
};

const normalizeWorkUnit = (workUnit: HostWorkUnitInput = {}): HostWorkUnitContract => ({
  objective: String(workUnit.objective || ''),
  allowedPaths: stringList(workUnit.allowedPaths),
  forbiddenPaths: stringList(workUnit.forbiddenPaths),
  expectedOutputs: stringList(workUnit.expectedOutputs),
});

export const buildHostExecutionContract = ({
  decision = null,
  assignment = null,
  capsule = null,
  attemptId = null,
  workUnit = null,
}: BuildHostExecutionContractInput = {}): Readonly<HostExecutionContract> => {
  if (!decision || typeof decision !== 'object') {
    throw new TypeError('host execution contract requires a route decision');
  }

  const executionClass = decision.executionClass === null || decision.executionClass === undefined
    ? null
    : normalizeExecutionClass(decision.executionClass);

  const assignmentWorkProfile = assignment?.workProfile || decision.workProfile || null;
  const contract: HostExecutionContract = {
    schemaVersion: HOST_EXECUTION_CONTRACT_SCHEMA_VERSION,
    runId: stringOrNull(decision.runId),
    decisionId: stringOrNull(decision.decisionId),
    actionKind: stringOrNull(decision.actionKind),
    role: stringOrNull(decision.role),
    permissions: stringOrNull(decision.permissions),
    executionClass,
    workProfile: assignmentWorkProfile
      ? {
        executionClass: assignmentWorkProfile.executionClass ?? executionClass,
        complexity: stringOrNull(assignmentWorkProfile.complexity),
        independentContextRequired: assignmentWorkProfile.independentContextRequired === true,
        parallelizable: assignmentWorkProfile.parallelizable === true,
      }
      : null,
    executionMode: stringOrNull(assignment?.executionMode),
    requirements: semanticRequirements({ decision, assignment }),
    delegation: assignment?.delegation
      ? {
        mode: stringOrNull(assignment.delegation.mode),
        requested: assignment.delegation.requested === true,
      }
      : null,
    freshSessionRequired: assignment?.freshSessionRequired === true
      || decision.independentContextRequired === true,
    workUnit: normalizeWorkUnit(workUnit || capsule?.workUnit || {}),
    capsule: capsule
      ? {
        capsuleId: stringOrNull(capsule.capsuleId),
        capsuleDigest: stringOrNull(capsule.provenance?.capsuleDigest),
        stepId: stringOrNull(capsule.stepId),
      }
      : null,
    attemptId: stringOrNull(attemptId),
  };

  assertProviderNeutral(contract);
  return Object.freeze(contract);
};

export const validateHostExecutionContract = (contract: unknown): HostExecutionContract => {
  if (!contract || typeof contract !== 'object' || Array.isArray(contract)) {
    throw new TypeError('host execution contract must be an object');
  }
  const candidate = contract as Partial<HostExecutionContract>;
  if (candidate.schemaVersion !== HOST_EXECUTION_CONTRACT_SCHEMA_VERSION) {
    throw new HostExecutionContractError(
      'host_execution_contract_schema_invalid',
      `host_execution_contract_schema_invalid:${String(candidate.schemaVersion)}`,
    );
  }
  if (!candidate.runId || !candidate.decisionId || !candidate.actionKind) {
    throw new HostExecutionContractError(
      'host_execution_contract_identity_missing',
      'host_execution_contract_identity_missing',
    );
  }
  if (candidate.executionClass !== null) normalizeExecutionClass(candidate.executionClass);
  for (const key of HOST_SEMANTIC_CAPABILITY_KEYS) {
    if (typeof candidate.requirements?.[key] !== 'boolean') {
      throw new HostExecutionContractError(
        'host_execution_contract_requirement_invalid',
        `host_execution_contract_requirement_invalid:${key}`,
      );
    }
  }
  assertProviderNeutral(candidate);
  return candidate as HostExecutionContract;
};

export const admitHostExecutionContract = (
  contract: unknown,
  hostCapabilities: HostSemanticCapabilities = {},
) => {
  const validated = validateHostExecutionContract(contract);
  const semantic = hostCapabilities.semantic || {};
  const missing = HOST_SEMANTIC_CAPABILITY_KEYS.filter((key) => (
    validated.requirements[key] === true && semantic[key] !== true
  ));
  return Object.freeze({
    schemaVersion: 1 as const,
    decision: missing.length === 0 ? 'admitted' as const : 'blocked' as const,
    missingCapabilities: missing,
    rejectionCode: missing.length === 0 ? null : 'host_capability_unavailable',
  });
};
