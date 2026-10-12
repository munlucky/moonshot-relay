import { KERNEL_CONTRACT_ENUMS } from './schema-definitions.generated.js';
import { parseKernelContract } from './schema-codec.js';
import type { KernelModelRoute } from './generated/kernel.model-route.js';
// Kernel→Host model route contract (§6.1). The Kernel decides a LOGICAL model
// class and records the decision; the Host maps that class onto a provider
// model. Nothing provider-shaped — credentials, prompt text, reasoning, raw
// output — may cross this boundary, so the decision is a closed, checked record.

import { createHash } from 'node:crypto';
import { REVIEW_ACTIONS } from './review.js';
import type {
  ExecutionClass,
  LegacyModelClass,
} from './execution-class.js';
import {
  EXECUTION_CLASSES,
  LEGACY_MODEL_CLASSES,
  executionClassForAction,
  executionClassFromLegacyModelClass,
  legacyModelClassForExecutionClass,
  normalizeExecutionClass,
} from './execution-class.js';
import {
  ModelRouteContractError,
  normalizeWorkProfile,
  type WorkProfile,
} from './model-execution.js';

export const ACTION_KINDS = Object.freeze(KERNEL_CONTRACT_ENUMS['kernel.model-route']['actionKind']);

export type ActionKind = typeof ACTION_KINDS[number];

// Deprecated compatibility export. New Kernel contracts use executionClass;
// this name remains readable until the Host consumers are migrated in the
// later decomplexification waves.
export const MODEL_CLASSES = LEGACY_MODEL_CLASSES;
export { EXECUTION_CLASSES };

export const ROLES = Object.freeze(KERNEL_CONTRACT_ENUMS['kernel.model-route']['role']);
export type ModelRouteRole = typeof ROLES[number];

export const PERMISSIONS = Object.freeze(KERNEL_CONTRACT_ENUMS['kernel.model-route']['permissions']);
export type ModelRoutePermission = typeof PERMISSIONS[number];

export const RISK_TIERS = Object.freeze(KERNEL_CONTRACT_ENUMS['kernel.model-route']['riskTier']);
export type RiskTier = typeof RISK_TIERS[number];

export const BUILD_ACTIONS = ['implement', 'debug'] as const;
export { REVIEW_ACTIONS };

// Host-only or secret-bearing fields. A decision carrying any of them is
// rejected rather than trimmed, so a leak fails closed instead of silently.
const FORBIDDEN_DECISION_FIELDS = [
  'apiKey',
  'apiKeys',
  'authorization',
  'credentials',
  'secret',
  'secrets',
  'prompt',
  'promptText',
  'messages',
  'transcript',
  'chainOfThought',
  'reasoning',
  'requestBody',
  'stdout',
  'stderr',
  'env',
  'environment',
  'providerModel',
  'resolvedModel',
] as const;

type UnknownRecord = Record<string, unknown>;

export interface ModelRouteDecisionInput extends UnknownRecord {
  decisionId?: unknown;
  runId?: unknown;
  attemptNumber?: unknown;
  replanCount?: unknown;
  planRevision?: unknown;
  obligationId?: unknown;
  actionKind?: unknown;
  role?: unknown;
  executionClass?: unknown;
  modelClass?: unknown;
  riskTier?: unknown;
  independentContextRequired?: unknown;
  workProfile?: unknown;
  permissions?: unknown;
  reasonCodes?: unknown;
  policyRevision?: unknown;
  createdAt?: unknown;
}

export type NormalizedModelRouteDecision = Omit<KernelModelRoute, 'reasonCodes'> & { reasonCodes: readonly string[] };

const fail = (code: string, message: string): never => {
  throw new ModelRouteContractError(code, message);
};

const isMember = <T extends readonly string[]>(
  values: T,
  value: unknown,
): value is T[number] => (
  typeof value === 'string'
  && values.includes(value)
);

const positiveInt = (value: unknown, fallbackValue: number): number => (
  Number.isInteger(value) && Number(value) >= 0
    ? Number(value)
    : fallbackValue
);

export const buildDecisionId = ({
  runId = 'run',
  attemptNumber = 1,
  sequence = 0,
  actionKind = 'implement',
}: {
  runId?: unknown;
  attemptNumber?: unknown;
  sequence?: unknown;
  actionKind?: unknown;
} = {}): string => (
  'route-'
  + createHash('sha256')
    .update(`${runId}|${attemptNumber}|${sequence}|${actionKind}`)
    .digest('hex')
    .slice(0, 24)
);

// A route decision is only usable once it is closed and provider-free.
export const normalizeModelRouteDecision = (
  decision: ModelRouteDecisionInput = {},
): Readonly<NormalizedModelRouteDecision> => {
  if (!decision || typeof decision !== 'object' || Array.isArray(decision)) {
    fail('kernel_model_route_invalid', 'model route decision must be an object');
  }

  for (const field of FORBIDDEN_DECISION_FIELDS) {
    if (Object.hasOwn(decision, field)) {
      fail(
        'kernel_model_route_forbidden_field',
        `model route decision must not carry host/provider field: ${field}`,
      );
    }
  }

  if (
    !decision.decisionId
    || !/^route-[a-f0-9]{8,64}$/.test(String(decision.decisionId))
  ) {
    fail(
      'kernel_model_route_invalid',
      'model route decision requires a route-<hex> decisionId',
    );
  }
  if (!decision.runId) {
    fail('kernel_model_route_invalid', 'model route decision requires a runId');
  }
  if (!isMember(ACTION_KINDS, decision.actionKind)) {
    fail(
      'kernel_model_action_invalid',
      `actionKind must be one of: ${ACTION_KINDS.join(', ')}`,
    );
  }
  const actionKind = decision.actionKind as ActionKind;
  if (
    Object.hasOwn(decision, 'modelClass')
    && !isMember(MODEL_CLASSES as readonly string[], decision.modelClass)
  ) {
    fail(
      'kernel_model_class_invalid',
      `modelClass must be one of: ${MODEL_CLASSES.join(', ')}`,
    );
  }

  let executionClass: ExecutionClass | null = null;
  if (Object.hasOwn(decision, 'executionClass')) {
    try {
      executionClass = normalizeExecutionClass(decision.executionClass);
    } catch (error: unknown) {
      fail(
        'kernel_execution_class_invalid',
        error instanceof Error ? error.message : String(error),
      );
    }
  } else if (Object.hasOwn(decision, 'modelClass')) {
    try {
      executionClass = executionClassFromLegacyModelClass(decision.modelClass);
    } catch (error: unknown) {
      fail(
        'kernel_model_class_invalid',
        error instanceof Error ? error.message : String(error),
      );
    }
  } else {
    const profile = decision.workProfile;
    const complexity = profile
      && typeof profile === 'object'
      && !Array.isArray(profile)
      ? (profile as UnknownRecord).complexity
      : null;
    executionClass = executionClassForAction(
      decision.actionKind,
      { complexity },
    );
  }

  const modelClass = (
    Object.hasOwn(decision, 'modelClass')
      ? String(decision.modelClass)
      : legacyModelClassForExecutionClass(executionClass)
  ) as LegacyModelClass;

  if (
    Object.hasOwn(decision, 'executionClass')
    && Object.hasOwn(decision, 'modelClass')
    && legacyModelClassForExecutionClass(executionClass) !== modelClass
  ) {
    fail(
      'kernel_model_route_invalid',
      'executionClass and modelClass are incongruent',
    );
  }

  if (!isMember(ROLES, decision.role)) {
    fail(
      'kernel_model_route_invalid',
      `role must be one of: ${ROLES.join(', ')}`,
    );
  }
  const role = decision.role as ModelRouteRole;

  if (!isMember(PERMISSIONS, decision.permissions)) {
    fail(
      'kernel_model_route_invalid',
      `permissions must be one of: ${PERMISSIONS.join(', ')}`,
    );
  }
  const permissions = decision.permissions as ModelRoutePermission;

  if (!isMember(RISK_TIERS, decision.riskTier)) {
    fail(
      'kernel_model_route_invalid',
      `riskTier must be one of: ${RISK_TIERS.join(', ')}`,
    );
  }
  const riskTier = decision.riskTier as RiskTier;

  const reasonCodes = Array.isArray(decision.reasonCodes)
    ? decision.reasonCodes.map(String).filter(Boolean)
    : [];
  if (reasonCodes.length === 0) {
    fail(
      'kernel_model_route_invalid',
      'model route decision requires at least one reason code',
    );
  }
  if (!decision.policyRevision) {
    fail(
      'kernel_model_route_invalid',
      'model route decision requires a policyRevision',
    );
  }

  const workProfile = normalizeWorkProfile(
    decision.workProfile,
    { actionKind },
  );

  return Object.freeze(parseKernelContract('kernel.model-route', {
    schemaVersion: 1,
    decisionId: String(decision.decisionId),
    runId: String(decision.runId),
    attemptNumber: positiveInt(decision.attemptNumber, 1),
    replanCount: positiveInt(decision.replanCount, 0),
    planRevision: positiveInt(decision.planRevision, 1),
    obligationId: decision.obligationId
      ? String(decision.obligationId)
      : null,
    actionKind,
    role,
    executionClass,
    modelClass,
    riskTier,
    independentContextRequired: decision.independentContextRequired === true,
    workProfile,
    permissions,
    reasonCodes: Object.freeze(reasonCodes),
    policyRevision: String(decision.policyRevision),
    createdAt: decision.createdAt
      ? String(decision.createdAt)
      : new Date().toISOString(),
  }));
};
