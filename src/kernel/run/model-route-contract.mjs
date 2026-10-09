// Kernel→Host model route contract (§6.1). The Kernel decides a LOGICAL model
// class and records the decision; the Host maps that class onto a provider
// model. Nothing provider-shaped — credentials, prompt text, reasoning, raw
// output — may cross this boundary, so the decision is a closed, checked record.

import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  EXECUTION_CLASSES,
  LEGACY_MODEL_CLASSES,
  executionClassForAction,
  executionClassFromLegacyModelClass,
  isProviderExecutionClass,
  legacyModelClassForExecutionClass,
  normalizeExecutionClass,
} from './execution-class.mjs';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

export const MODEL_POLICY_SOURCE = 'kernel/model-policy.yaml';
export const ACTION_KINDS = Object.freeze(['understand', 'design', 'plan', 'implement', 'debug', 'review_contract', 'review_engineering', 'replan', 'prove', 'close']);
// Deprecated compatibility export. New Kernel contracts use executionClass;
// this name remains readable until the Host consumers are migrated in the
// later decomplexification waves.
export const MODEL_CLASSES = LEGACY_MODEL_CLASSES;
export { EXECUTION_CLASSES };
export const ROLES = Object.freeze(['planner', 'implementer', 'reviewer', 'kernel']);
export const PERMISSIONS = Object.freeze(['read_only', 'plan_write', 'workspace_write', 'kernel_runtime']);
export const RISK_TIERS = Object.freeze(['T0', 'T1', 'T2', 'T3']);
export const BUILD_ACTIONS = Object.freeze(['implement', 'debug']);
export const REVIEW_ACTIONS = Object.freeze(['review_contract', 'review_engineering']);
export const WORK_PROFILE_COMPLEXITIES = Object.freeze(['routine', 'standard', 'complex', 'large-refactor']);

// Host-only or secret-bearing fields. A decision carrying any of them is
// rejected rather than trimmed, so a leak fails closed instead of silently.
const FORBIDDEN_DECISION_FIELDS = Object.freeze([
  'apiKey', 'apiKeys', 'authorization', 'credentials', 'secret', 'secrets',
  'prompt', 'promptText', 'messages', 'transcript', 'chainOfThought', 'reasoning',
  'requestBody', 'stdout', 'stderr', 'env', 'environment', 'providerModel', 'resolvedModel',
]);

export class ModelRouteContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ModelRouteContractError';
    this.code = code;
  }
}

const fail = (code, message) => { throw new ModelRouteContractError(code, message); };

const normalizeComplexity = (value) => {
  const aliases = { 'routine-batch': 'routine', simple: 'standard' };
  const normalized = aliases[String(value)] || String(value);
  if (!WORK_PROFILE_COMPLEXITIES.includes(normalized)) {
    fail('kernel_work_profile_invalid', `workProfile.complexity must be one of: ${WORK_PROFILE_COMPLEXITIES.join(', ')}`);
  }
  return normalized;
};

const executionClassForWorkProfile = (profile = {}, { actionKind = 'implement' } = {}) => {
  const explicit = profile.executionClass;
  if (Object.hasOwn(profile, 'executionClass')) return normalizeExecutionClass(explicit);
  return executionClassForAction(actionKind, { complexity: profile.complexity });
};

// The work profile is intentionally provider-neutral. It tells a Host actor
// what shape of work it is receiving; it never carries a model id, provider,
// prompt, or effort setting across the Kernel boundary.
export const normalizeWorkProfile = (profile = null, { actionKind = 'implement' } = {}) => {
  if (profile === null || profile === undefined) return null;
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    fail('kernel_work_profile_invalid', 'workProfile must be an object or null');
  }
  for (const field of ['model', 'effort', 'provider', 'providerModel', 'resolvedModel', 'resolvedEffort']) {
    if (Object.hasOwn(profile, field)) fail('kernel_work_profile_forbidden_field', `workProfile must not carry provider field: ${field}`);
  }
  const complexity = normalizeComplexity(profile.complexity ?? 'standard');
  const executionClass = executionClassForWorkProfile(profile, { actionKind });
  if (executionClass === null && !['prove', 'close'].includes(actionKind)) {
    fail('kernel_work_profile_invalid', `workProfile.executionClass is required for action: ${actionKind}`);
  }
  const booleanField = (name, fallback = false) => {
    if (profile[name] === undefined) return fallback;
    if (typeof profile[name] !== 'boolean') fail('kernel_work_profile_invalid', `workProfile.${name} must be boolean`);
    return profile[name];
  };
  return Object.freeze({
    executionClass,
    complexity,
    repeatedFailure: booleanField('repeatedFailure'),
    independentContextRequired: booleanField('independentContextRequired'),
    parallelizable: booleanField('parallelizable'),
  });
};

const parseValue = (raw) => {
  const value = raw.trim();
  if (/^\[.*\]$/.test(value)) return value.replace(/^\[|\]$/g, '').split(',').map((item) => item.trim()).filter(Boolean);
  if (value === 'true' || value === 'false') return value === 'true';
  if (/^-?\d+$/.test(value)) return Number(value);
  return value.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, (_, d, s) => d ?? s);
};

export const parseModelPolicyText = (text, { sourceRef = MODEL_POLICY_SOURCE } = {}) => {
  const raw = String(text ?? '');
  const doc = { schemaVersion: null, policyRevision: null, thresholds: {}, executionClasses: {}, modelClasses: {}, actionDefaults: {} };
  let section = null;
  let key = null;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const top = line.match(/^([A-Za-z][A-Za-z0-9_]*):\s*(.*)$/);
    if (top) {
      if (!Object.hasOwn(doc, top[1])) fail('kernel_model_policy_malformed', `Unknown field in ${sourceRef}: ${top[1]}`);
      section = top[1];
      key = null;
      if (top[2].trim()) doc[section] = parseValue(top[2]);
      continue;
    }
    const entry = line.match(/^ {2}([A-Za-z0-9_]+):\s*(.*)$/);
    if (entry && section && doc[section] && typeof doc[section] === 'object') {
      if (entry[2].trim()) { doc[section][entry[1]] = parseValue(entry[2]); key = null; } else { key = entry[1]; doc[section][key] = {}; }
      continue;
    }
    const field = line.match(/^ {4}([A-Za-z0-9_]+):\s*(.+)$/);
    if (field && section && key) { doc[section][key][field[1]] = parseValue(field[2]); continue; }
    fail('kernel_model_policy_malformed', `Malformed ${sourceRef}: ${line.trim()}`);
  }

  if (doc.schemaVersion !== 1) fail('kernel_model_policy_schema_invalid', `${sourceRef} schemaVersion must be 1`);
  if (!doc.policyRevision) fail('kernel_model_policy_revision_missing', `${sourceRef} policyRevision is required`);
  const declaredExecutionClasses = Object.keys(doc.executionClasses).length > 0
    ? doc.executionClasses
    : Object.fromEntries(Object.entries(doc.modelClasses)
      .filter(([name]) => name !== 'kernel')
      .map(([name, spec]) => [
        name === 'frontier_reasoning' ? 'planning' : name === 'value_coding' ? 'standard' : name,
        spec,
      ]));
  for (const [name, spec] of Object.entries(declaredExecutionClasses)) {
    if (!EXECUTION_CLASSES.includes(name)) fail('kernel_model_policy_class_unknown', `${sourceRef} declares an unknown execution class: ${name}`);
    if (typeof spec.providerModelRequired !== 'boolean') fail('kernel_model_policy_class_invalid', `${sourceRef} execution class ${name} requires providerModelRequired`);
  }
  for (const action of ACTION_KINDS) {
    const spec = doc.actionDefaults[action];
    if (!spec) fail('kernel_model_policy_action_missing', `${sourceRef} has no default for action: ${action}`);
    const executionClass = spec.executionClass
      || (spec.modelClass ? executionClassFromLegacyModelClass(spec.modelClass) : null);
    const expected = executionClassForAction(action);
    if (executionClass !== null && executionClass !== expected && !(action === 'implement' && executionClass === 'complex_implementation')) {
      fail('kernel_model_policy_action_invalid', `${sourceRef} action ${action} has an invalid executionClass`);
    }
    if (action !== 'prove' && action !== 'close' && !executionClass) {
      fail('kernel_model_policy_action_invalid', `${sourceRef} action ${action} requires an executionClass`);
    }
    if (!ROLES.includes(spec.role)) fail('kernel_model_policy_action_invalid', `${sourceRef} action ${action} has an invalid role`);
    if (!PERMISSIONS.includes(spec.permissions)) fail('kernel_model_policy_action_invalid', `${sourceRef} action ${action} has invalid permissions`);
  }
  const { retryEscalationThreshold, stagnationThreshold } = doc.thresholds;
  if (!Number.isInteger(retryEscalationThreshold) || retryEscalationThreshold < 1) fail('kernel_model_policy_threshold_invalid', `${sourceRef} retryEscalationThreshold must be a positive integer`);
  if (!Number.isInteger(stagnationThreshold) || stagnationThreshold < 1) fail('kernel_model_policy_threshold_invalid', `${sourceRef} stagnationThreshold must be a positive integer`);

  const actionDefaults = Object.fromEntries(Object.entries(doc.actionDefaults).map(([action, spec]) => {
    const executionClass = spec.executionClass
      || (spec.modelClass ? executionClassFromLegacyModelClass(spec.modelClass) : null);
    const normalized = { ...spec, executionClass };
    // Read-only compatibility for the pre-B1 Kernel consumers. It is not part
    // of the canonical serialized policy surface.
    Object.defineProperty(normalized, 'modelClass', {
      enumerable: false,
      configurable: false,
      get: () => executionClass === null ? 'kernel' : legacyModelClassForExecutionClass(executionClass),
    });
    return [action, Object.freeze(normalized)];
  }));
  const normalizedPolicy = {
    schemaVersion: 1,
    policyRevision: doc.policyRevision,
    thresholds: Object.freeze(doc.thresholds),
    executionClasses: Object.freeze(declaredExecutionClasses),
    actionDefaults: Object.freeze(actionDefaults),
    sourceRef,
    sourceDigest: createHash('sha256').update(raw).digest('hex'),
  };
  Object.defineProperty(normalizedPolicy, 'modelClasses', {
    enumerable: false,
    configurable: false,
    get: () => {
      const providerClasses = Object.entries(declaredExecutionClasses);
      const frontier = providerClasses.find(([name]) => ['planning', 'review', 'complex_implementation'].includes(name))?.[1];
      const standard = providerClasses.find(([name]) => name === 'standard')?.[1];
      return Object.freeze({
        frontier_reasoning: frontier || { requiredCapabilities: [], providerModelRequired: true },
        value_coding: standard || { requiredCapabilities: [], providerModelRequired: true },
        kernel: { requiredCapabilities: [], providerModelRequired: false },
      });
    },
  });
  return Object.freeze(normalizedPolicy);
};

let cached = null;
export const loadModelPolicy = ({ sourceRoot: root = sourceRoot, text } = {}) => {
  if (text === undefined && root === sourceRoot && cached) return cached;
  const policy = parseModelPolicyText(text ?? readFileSync(path.join(root, MODEL_POLICY_SOURCE), 'utf8'));
  if (text === undefined && root === sourceRoot) cached = policy;
  return policy;
};

export const buildDecisionId = ({ runId = 'run', attemptNumber = 1, sequence = 0, actionKind = 'implement' } = {}) =>
  `route-${createHash('sha256').update(`${runId}|${attemptNumber}|${sequence}|${actionKind}`).digest('hex').slice(0, 24)}`;

// A delegated execution assignment is derived from the persisted route
// decision. It is intentionally provider-neutral and deterministic so the
// report boundary can consume the handle without adding provider/session data
// to the Kernel decision. Owner-direct turns do not need an assignment handle.
export const buildExecutionAssignmentId = (decisionId = null) => {
  const value = String(decisionId || '');
  return /^route-[a-f0-9]{8,64}$/.test(value)
    ? `assignment-${value.slice('route-'.length)}`
    : null;
};

// A route decision is only usable once it is closed and provider-free.
export const normalizeModelRouteDecision = (decision = {}) => {
  if (!decision || typeof decision !== 'object' || Array.isArray(decision)) fail('kernel_model_route_invalid', 'model route decision must be an object');
  for (const field of FORBIDDEN_DECISION_FIELDS) {
    if (Object.hasOwn(decision, field)) fail('kernel_model_route_forbidden_field', `model route decision must not carry host/provider field: ${field}`);
  }
  if (!decision.decisionId || !/^route-[a-f0-9]{8,64}$/.test(String(decision.decisionId))) fail('kernel_model_route_invalid', 'model route decision requires a route-<hex> decisionId');
  if (!decision.runId) fail('kernel_model_route_invalid', 'model route decision requires a runId');
  if (!ACTION_KINDS.includes(decision.actionKind)) fail('kernel_model_action_invalid', `actionKind must be one of: ${ACTION_KINDS.join(', ')}`);
  if (Object.hasOwn(decision, 'modelClass') && !MODEL_CLASSES.includes(decision.modelClass)) fail('kernel_model_class_invalid', `modelClass must be one of: ${MODEL_CLASSES.join(', ')}`);
  let executionClass;
  if (Object.hasOwn(decision, 'executionClass')) {
    try {
      executionClass = normalizeExecutionClass(decision.executionClass);
    } catch (error) {
      fail('kernel_execution_class_invalid', error.message);
    }
  } else if (Object.hasOwn(decision, 'modelClass')) {
    try {
      executionClass = executionClassFromLegacyModelClass(decision.modelClass);
    } catch (error) {
      fail('kernel_model_class_invalid', error.message);
    }
  } else {
    executionClass = executionClassForAction(decision.actionKind, {
      complexity: decision.workProfile?.complexity,
    });
  }
  const modelClass = Object.hasOwn(decision, 'modelClass')
    ? decision.modelClass
    : legacyModelClassForExecutionClass(executionClass);
  if (Object.hasOwn(decision, 'executionClass') && Object.hasOwn(decision, 'modelClass')
    && legacyModelClassForExecutionClass(executionClass) !== modelClass) {
    fail('kernel_model_route_invalid', 'executionClass and modelClass are incongruent');
  }
  if (!ROLES.includes(decision.role)) fail('kernel_model_route_invalid', `role must be one of: ${ROLES.join(', ')}`);
  if (!PERMISSIONS.includes(decision.permissions)) fail('kernel_model_route_invalid', `permissions must be one of: ${PERMISSIONS.join(', ')}`);
  if (!RISK_TIERS.includes(decision.riskTier)) fail('kernel_model_route_invalid', `riskTier must be one of: ${RISK_TIERS.join(', ')}`);
  const reasonCodes = Array.isArray(decision.reasonCodes) ? decision.reasonCodes.map(String).filter(Boolean) : [];
  if (reasonCodes.length === 0) fail('kernel_model_route_invalid', 'model route decision requires at least one reason code');
  if (!decision.policyRevision) fail('kernel_model_route_invalid', 'model route decision requires a policyRevision');
  const positiveInt = (value, fallbackValue) => (Number.isInteger(value) && value >= 0 ? value : fallbackValue);
  const workProfile = normalizeWorkProfile(decision.workProfile, { actionKind: decision.actionKind });
  return Object.freeze({
    schemaVersion: 1,
    decisionId: String(decision.decisionId),
    runId: String(decision.runId),
    attemptNumber: positiveInt(decision.attemptNumber, 1),
    replanCount: positiveInt(decision.replanCount, 0),
    planRevision: positiveInt(decision.planRevision, 1),
    obligationId: decision.obligationId ? String(decision.obligationId) : null,
    actionKind: decision.actionKind,
    role: decision.role,
    executionClass,
    modelClass,
    riskTier: decision.riskTier,
    independentContextRequired: decision.independentContextRequired === true,
    workProfile,
    permissions: decision.permissions,
    reasonCodes: Object.freeze(reasonCodes),
    policyRevision: String(decision.policyRevision),
    createdAt: decision.createdAt ? String(decision.createdAt) : new Date().toISOString(),
  });
};

// prove/close are Kernel-owned: they must never ask the Host for a model.
export const requiresProviderModel = (executionClassOrModelClass, policy = loadModelPolicy()) => {
  const executionClass = EXECUTION_CLASSES.includes(executionClassOrModelClass)
    ? executionClassOrModelClass
    : executionClassFromLegacyModelClass(executionClassOrModelClass);
  if (executionClass === null) return false;
  return policy.executionClasses?.[executionClass]?.providerModelRequired === true
    || policy.modelClasses?.[executionClassOrModelClass]?.providerModelRequired === true;
};

export const ENFORCEMENT_STRATEGIES = Object.freeze(['subagent', 'session', 'advisory', 'unsupported']);

// What the Host declares it can actually do (§6.2). Everything defaults to
// "cannot", so a Host that forgets to declare a capability is treated as
// unable to enforce rather than assumed able.
export const normalizeHostCapabilities = (capabilities = {}) => {
  if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) fail('kernel_host_capability_invalid', 'host capabilities must be an object');
  if (!capabilities.surface) fail('kernel_host_capability_invalid', 'host capabilities require a surface');
  const flag = (name) => capabilities[name] === true;
  return Object.freeze({
    schemaVersion: 1,
    surface: String(capabilities.surface),
    supportsSubagentModel: flag('supportsSubagentModel'),
    supportsSessionModelOverride: flag('supportsSessionModelOverride'),
    supportsIndependentContext: flag('supportsIndependentContext'),
    supportsCrossSurfaceReview: flag('supportsCrossSurfaceReview') || flag('supportsIndependentContext'),
    supportsReadOnlyReview: flag('supportsReadOnlyReview'),
    supportsUsageTokens: flag('supportsUsageTokens'),
    supportsResolvedModelIdentity: flag('supportsResolvedModelIdentity'),
  });
};

// A Host that cannot prove which model ran can never be more than advisory,
// and one that cannot select a model at all is unsupported.
export const resolveEnforcementStrategy = (capabilities, decision = null) => {
  const host = normalizeHostCapabilities(capabilities);
  if (decision && (decision.executionClass === null || decision.modelClass === 'kernel')) return 'unsupported';
  // Independent review is a separate native session/surface concern. A Host
  // may be unable to launch a child worker and still accept a review receipt
  // from another native surface, so this is not an ordinary execution blocker.
  if (!host.supportsResolvedModelIdentity) {
    return host.supportsSubagentModel || host.supportsSessionModelOverride ? 'advisory' : 'unsupported';
  }
  if (host.supportsSubagentModel) return 'subagent';
  if (host.supportsSessionModelOverride) return 'session';
  return 'advisory';
};

export const ENFORCEMENT_STATUSES = Object.freeze(['enforced', 'fallback', 'advisory', 'unsupported', 'failed']);
export const RESULT_STATUSES = Object.freeze(['completed', 'failed', 'interrupted', 'abandoned']);

const SESSION_ID = /^sha256:[a-f0-9]{64}$/;
// A count the Host did not report stays null. Recording it as 0 would make an
// unmeasured run look free, which is the one thing measurement must not do.
const optionalCount = (value, field) => {
  if (value === null || value === undefined) return null;
  if (!Number.isInteger(value) || value < 0) fail('kernel_model_usage_invalid', `${field} must be a non-negative integer or null`);
  return value;
};

export const buildReceiptId = ({ decisionId, actorSessionId, startedAt = '' } = {}) =>
  `usage-${createHash('sha256').update(`${decisionId}|${actorSessionId}|${startedAt}`).digest('hex').slice(0, 24)}`;

// Cache and routing economics (Wave 8). Cache *reads* save money and cache
// *writes* cost it, so a receipt that reports only "cached tokens" cannot tell a
// profitable prefix from a losing one. They are recorded separately, and a value
// the Host did not measure stays null.
export const CACHE_MODES = Object.freeze(['off', 'shadow', 'on']);
export const CACHE_MISS_REASONS = Object.freeze([
  'cold-prefix', 'tool-schema-changed', 'common-prefix-changed', 'provider-prefix-changed',
  'project-prefix-changed', 'run-prefix-changed', 'model-changed', 'effort-changed',
  'speed-mode-changed', 'session-reset', 'provider-unsupported', 'usage-unreported', 'unknown',
]);
export const MODEL_ESCALATION_REASONS = Object.freeze([
  'risk-tier', 'complexity', 'repeated-failure', 'review-policy', 'user-request',
  'quality-regression', 'provider-fallback', 'unknown',
]);

const optionalEnum = (value, allowed, field) => {
  if (value === null || value === undefined || value === '') return null;
  if (!allowed.includes(String(value))) fail('kernel_model_usage_invalid', `${field} must be one of: ${allowed.join(', ')}`);
  return String(value);
};

const optionalText = (value) => (value === null || value === undefined || value === '' ? null : String(value));

// What the Host actually did with a decision (§6.3). A Host that could not
// enforce the requested class must say so; it may not claim `enforced`.
export const normalizeModelUsageReceipt = (receipt = {}) => {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) fail('kernel_model_usage_invalid', 'model usage receipt must be an object');
  if (!receipt.decisionId || !/^route-[a-f0-9]{8,64}$/.test(String(receipt.decisionId))) fail('kernel_model_usage_invalid', 'model usage receipt requires the route-<hex> decisionId it answers');
  if (!receipt.runId) fail('kernel_model_usage_invalid', 'model usage receipt requires a runId');
  if (!receipt.hostSurface) fail('kernel_model_usage_invalid', 'model usage receipt requires a hostSurface');
  if (!SESSION_ID.test(String(receipt.actorSessionId || ''))) fail('kernel_model_usage_session_invalid', 'actorSessionId must be a sha256:<hex> digest so raw session identifiers never persist');
  if (receipt.parentSessionId && !SESSION_ID.test(String(receipt.parentSessionId))) fail('kernel_model_usage_session_invalid', 'parentSessionId must be a sha256:<hex> digest when provided');
  if (receipt.attemptId && !/^attempt-[a-f0-9-]{8,96}$/.test(String(receipt.attemptId))) fail('kernel_model_usage_invalid', 'attemptId must match attempt-<hex-or-uuid>');
  if (!ENFORCEMENT_STATUSES.includes(receipt.enforcementStatus)) fail('kernel_model_usage_invalid', `enforcementStatus must be one of: ${ENFORCEMENT_STATUSES.join(', ')}`);
  if (!RESULT_STATUSES.includes(receipt.resultStatus)) fail('kernel_model_usage_invalid', `resultStatus must be one of: ${RESULT_STATUSES.join(', ')}`);
  const resolvedModel = receipt.resolvedModel ? String(receipt.resolvedModel) : null;
  if (!resolvedModel && receipt.enforcementStatus === 'enforced') {
    fail('kernel_model_usage_enforcement_unproven', 'enforcementStatus "enforced" requires the resolved provider model the Host actually used');
  }
  const requestedModel = receipt.requestedModel ? String(receipt.requestedModel) : null;
  const requestedEffort = receipt.requestedEffort ? String(receipt.requestedEffort).toLowerCase() : null;
  const resolvedEffort = receipt.resolvedEffort ? String(receipt.resolvedEffort).toLowerCase() : null;
  const observedModel = receipt.observedModel ? String(receipt.observedModel) : null;
  const observedEffort = receipt.observedEffort ? String(receipt.observedEffort).toLowerCase() : null;
  // Receipts written before requested/observed identity fields existed remain
  // readable. New receipts carry at least one of those fields and therefore
  // must prove the provider terminal/rollout independently of resolution.
  const modernModelIdentity = Boolean(requestedModel || observedModel);
  const modernEffortIdentity = Boolean(requestedEffort || observedEffort);
  if (receipt.enforcementStatus === 'enforced' && modernModelIdentity) {
    if (!observedModel) {
      fail('kernel_model_usage_enforcement_unproven', 'enforcementStatus "enforced" requires an observed provider model equal to the requested model');
    }
  }
  if (receipt.enforcementStatus === 'enforced' && modernEffortIdentity) {
    if (!observedEffort) {
      fail('kernel_model_usage_enforcement_unproven', 'enforcementStatus "enforced" requires an observed reasoning effort equal to the requested effort');
    }
  }
  if (receipt.enforcementStatus === 'enforced' && (modernModelIdentity || modernEffortIdentity)) {
    if (requestedModel && resolvedModel !== requestedModel) {
      fail('kernel_model_usage_enforcement_unproven', 'enforcementStatus "enforced" requires the resolved provider model to equal the requested model');
    }
    if (requestedEffort && requestedEffort !== resolvedEffort) {
      fail('kernel_model_usage_enforcement_unproven', 'enforcementStatus "enforced" requires the resolved reasoning effort to equal the requested effort');
    }
    if (requestedModel && observedModel !== requestedModel) {
      fail('kernel_model_usage_enforcement_unproven', 'enforcementStatus "enforced" requires an observed provider model equal to the requested model');
    }
    if (requestedEffort && observedEffort !== requestedEffort) {
      fail('kernel_model_usage_enforcement_unproven', 'enforcementStatus "enforced" requires an observed reasoning effort equal to the requested effort');
    }
    if (modernModelIdentity && observedModel !== resolvedModel) {
      fail('kernel_model_usage_enforcement_unproven', 'enforcementStatus "enforced" requires observed and resolved provider models to agree');
    }
    if (modernEffortIdentity && requestedEffort && observedEffort !== resolvedEffort) {
      fail('kernel_model_usage_enforcement_unproven', 'enforcementStatus "enforced" requires observed and resolved reasoning effort to agree');
    }
  }
  const startedAt = receipt.startedAt ? String(receipt.startedAt) : null;
  // Backward compatibility runs both ways: a Host that reports only the legacy
  // `cachedInputTokens` is read as a cache read, and a Host that reports the new
  // field keeps the legacy one populated so existing readers do not go blind.
  const cacheReadInputTokens = optionalCount(
    receipt.cacheReadInputTokens ?? receipt.cachedInputTokens ?? null,
    'cacheReadInputTokens',
  );
  const cachedInputTokens = optionalCount(
    receipt.cachedInputTokens ?? receipt.cacheReadInputTokens ?? null,
    'cachedInputTokens',
  );
  return Object.freeze({
    schemaVersion: 1,
    receiptId: String(receipt.receiptId || buildReceiptId({ decisionId: receipt.decisionId, actorSessionId: receipt.actorSessionId, startedAt })),
    decisionId: String(receipt.decisionId),
    runId: String(receipt.runId),
    hostSurface: String(receipt.hostSurface),
    actorSessionId: String(receipt.actorSessionId),
    parentSessionId: receipt.parentSessionId ? String(receipt.parentSessionId) : null,
    resolvedModel,
    resolvedEffort,
    requestedModel,
    requestedEffort,
    observedModel,
    observedEffort,
    role: optionalText(receipt.role),
    actionKind: optionalText(receipt.actionKind),
    workProfile: normalizeWorkProfile(receipt.workProfile, { actionKind: receipt.actionKind || 'implement' }),
    dispatchMechanism: optionalText(receipt.dispatchMechanism),
    enforcementReason: optionalText(receipt.enforcementReason),
    fallbackReason: optionalText(receipt.fallbackReason),
    // Lineage the later phases attach: which bounded context the turn ran on
    // (K1) and which admission let it dispatch (K3). Absent on a legacy or
    // un-capsuled turn, never invented.
    attemptId: receipt.attemptId ? String(receipt.attemptId) : null,
    bindingId: receipt.bindingId ? String(receipt.bindingId) : null,
    capsuleId: receipt.capsuleId ? String(receipt.capsuleId) : null,
    capsuleDigest: receipt.capsuleDigest ? String(receipt.capsuleDigest) : null,
    admissionId: receipt.admissionId ? String(receipt.admissionId) : null,
    admissionDigest: receipt.admissionDigest ? String(receipt.admissionDigest) : null,
    stepId: receipt.stepId ? String(receipt.stepId) : null,
    enforcementStatus: receipt.enforcementStatus,
    resultStatus: receipt.resultStatus,
    startedAt,
    finishedAt: receipt.finishedAt ? String(receipt.finishedAt) : null,
    wallClockMs: optionalCount(receipt.wallClockMs, 'wallClockMs'),
    inputTokens: optionalCount(receipt.inputTokens, 'inputTokens'),
    cachedInputTokens,
    outputTokens: optionalCount(receipt.outputTokens, 'outputTokens'),
    costMicros: optionalCount(receipt.costMicros, 'costMicros'),
    // Wave 8 economics. Provider/surface are recorded here because the same
    // model class can run on more than one surface in a single project.
    provider: optionalText(receipt.provider),
    surface: optionalText(receipt.surface),
    speedMode: optionalText(receipt.speedMode),
    reasoningContext: optionalText(receipt.reasoningContext),
    reasoningMode: optionalText(receipt.reasoningMode),
    delegationMode: optionalText(receipt.delegationMode),
    sessionLineageId: optionalText(receipt.sessionLineageId),
    previousResponseIdDigest: optionalText(receipt.previousResponseIdDigest),
    promptPrefixDigest: optionalText(receipt.promptPrefixDigest),
    promptCacheKeyDigest: optionalText(receipt.promptCacheKeyDigest),
    cacheMode: optionalEnum(receipt.cacheMode, CACHE_MODES, 'cacheMode'),
    cacheTtl: optionalText(receipt.cacheTtl),
    cacheMissReason: optionalEnum(receipt.cacheMissReason, CACHE_MISS_REASONS, 'cacheMissReason'),
    modelEscalationReason: optionalEnum(receipt.modelEscalationReason, MODEL_ESCALATION_REASONS, 'modelEscalationReason'),
    eligiblePrefixTokens: optionalCount(receipt.eligiblePrefixTokens ?? null, 'eligiblePrefixTokens'),
    uncachedInputTokens: optionalCount(receipt.uncachedInputTokens ?? null, 'uncachedInputTokens'),
    cacheReadInputTokens,
    cacheWriteInputTokens: optionalCount(receipt.cacheWriteInputTokens ?? null, 'cacheWriteInputTokens'),
    reasoningTokens: optionalCount(receipt.reasoningTokens ?? null, 'reasoningTokens'),
    createdAt: receipt.createdAt ? String(receipt.createdAt) : new Date().toISOString(),
  });
};

// Derived cache and routing metrics (Wave 8). Every ratio is null when its
// denominator is zero or unmeasured — a 0% hit rate and "nobody reported"
// are different facts, and only one of them is a problem to fix.
const ratio = (numerator, denominator) =>
  (numerator === null || denominator === null || !denominator ? null : numerator / denominator);

const sum = (receipts, field) => receipts.reduce((total, receipt) => (receipt[field] === null || receipt[field] === undefined ? total : (total ?? 0) + receipt[field]), null);

// A ratio summed independently per field mixes populations: a receipt that
// reports the denominator but not the numerator (or the reverse) still
// contributes to one side, silently pulling the published rate toward
// whichever side happened to be reported. Only a receipt that reports BOTH
// fields may contribute to either side of the ratio.
const pairedRatio = (receipts, numeratorField, denominatorField) => {
  let numerator = null;
  let denominator = null;
  for (const receipt of receipts) {
    const numValue = receipt[numeratorField];
    const denValue = receipt[denominatorField];
    if (numValue === null || numValue === undefined || denValue === null || denValue === undefined) continue;
    numerator = (numerator ?? 0) + numValue;
    denominator = (denominator ?? 0) + denValue;
  }
  return ratio(numerator, denominator);
};

export const summarizeCacheEconomics = (receipts = []) => {
  const eligiblePrefixTokens = sum(receipts, 'eligiblePrefixTokens');
  const cacheReadInputTokens = sum(receipts, 'cacheReadInputTokens');
  const cacheWriteInputTokens = sum(receipts, 'cacheWriteInputTokens');
  const inputTokens = sum(receipts, 'inputTokens');
  const outputTokens = sum(receipts, 'outputTokens');
  const reasoningTokens = sum(receipts, 'reasoningTokens');
  const continuationEligible = receipts.filter((receipt) => receipt.sessionLineageId !== null);
  const continued = continuationEligible.filter((receipt, index, all) =>
    all.findIndex((other) => other.sessionLineageId === receipt.sessionLineageId) !== index);
  return Object.freeze({
    schemaVersion: 1,
    receipts: receipts.length,
    totals: Object.freeze({ eligiblePrefixTokens, cacheReadInputTokens, cacheWriteInputTokens, inputTokens, outputTokens, reasoningTokens }),
    eligibleHitRatio: pairedRatio(receipts, 'cacheReadInputTokens', 'eligiblePrefixTokens'),
    totalInputCacheRatio: pairedRatio(receipts, 'cacheReadInputTokens', 'inputTokens'),
    writeReadRatio: pairedRatio(receipts, 'cacheWriteInputTokens', 'cacheReadInputTokens'),
    reasoningRatio: pairedRatio(receipts, 'reasoningTokens', 'outputTokens'),
    sessionContinuationRate: continuationEligible.length ? continued.length / continuationEligible.length : null,
    missReasons: Object.freeze(Object.fromEntries(
      [...new Set(receipts.map((receipt) => receipt.cacheMissReason).filter(Boolean))]
        .sort()
        .map((reason) => [reason, receipts.filter((receipt) => receipt.cacheMissReason === reason).length]),
    )),
  });
};

// Routing measurement (§12). Counted from decisions and receipts only; a turn
// whose Host reported no tokens contributes to the turn counts but never to
// the token totals, which stay null rather than silently becoming 0.
export const summarizeModelRouting = (decisions = [], receipts = []) => {
  const byDecision = new Map(decisions.map((decision) => [decision.decisionId, decision]));
  const summary = {
    totalTurns: decisions.length,
    frontierTurns: decisions.filter((d) => d.modelClass === 'frontier_reasoning').length,
    valueTurns: decisions.filter((d) => d.modelClass === 'value_coding').length,
    kernelOnlyActions: decisions.filter((d) => d.modelClass === 'kernel').length,
    escalatedTurns: decisions.filter((d) => d.reasonCodes.some((code) => code.endsWith('_ESCALATION') || code.endsWith('_REPLAN') || code === 'PROTECTED_OBLIGATION_FAILURE')).length,
    independentReviewTurns: decisions.filter((d) => d.independentContextRequired === true).length,
    enforcedTurns: 0,
    fallbackTurns: 0,
    advisoryTurns: 0,
    unsupportedTurns: 0,
    failedTurns: 0,
    receiptCoverage: { receipts: receipts.length, providerTurns: decisions.filter((d) => d.modelClass !== 'kernel').length },
    tokens: { input: null, cachedInput: null, output: null, reportedTurns: 0 },
  };
  const counters = { enforced: 'enforcedTurns', fallback: 'fallbackTurns', advisory: 'advisoryTurns', unsupported: 'unsupportedTurns', failed: 'failedTurns' };
  for (const receipt of receipts) {
    summary[counters[receipt.enforcementStatus]] += 1;
    if (receipt.inputTokens === null && receipt.outputTokens === null) continue;
    summary.tokens.reportedTurns += 1;
    summary.tokens.input = (summary.tokens.input ?? 0) + (receipt.inputTokens ?? 0);
    summary.tokens.cachedInput = (summary.tokens.cachedInput ?? 0) + (receipt.cachedInputTokens ?? 0);
    summary.tokens.output = (summary.tokens.output ?? 0) + (receipt.outputTokens ?? 0);
  }
  summary.resolvedModels = [...new Set(receipts.map((receipt) => (receipt.resolvedModel ? `${byDecision.get(receipt.decisionId)?.modelClass || 'unknown'}:${receipt.resolvedModel}` : null)).filter(Boolean))];
  return summary;
};

// Session identity is hashed before it is stored, so a Host may hand over its
// native session id without that value ever reaching the database.
export const hashSessionId = (value) => (value === null || value === undefined || value === ''
  ? null
  : (SESSION_ID.test(String(value)) ? String(value) : `sha256:${createHash('sha256').update(String(value)).digest('hex')}`));
