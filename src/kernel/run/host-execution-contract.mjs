// Kernel -> Host execution boundary.
//
// The Kernel decides what a bounded Work Unit needs. The Host decides how that
// work is carried out (provider, model, session, process, worktree, Git,
// prompt, and cache). This module is intentionally small and provider-neutral:
// it is the only shape the Kernel is allowed to hand to a Host executor.

import { normalizeExecutionClass } from './execution-class.mjs';

export const HOST_EXECUTION_CONTRACT_SCHEMA_VERSION = 2;


export const HOST_SEMANTIC_CAPABILITY_KEYS = Object.freeze([
  'freshContext',
  'workspaceWrite',
  'workspaceIsolation',
  'parallelExecution',
  'independentReview',
  'modelSelection',
]);

const semanticRequirements = ({ decision = {}, assignment = null } = {}) => {
  const resolvedAssignment = assignment || {};
  return Object.freeze({
  freshContext: resolvedAssignment.freshSessionRequired === true || decision.independentContextRequired === true,
  workspaceWrite: decision.permissions === 'workspace_write',
  workspaceIsolation: resolvedAssignment.workProfile?.parallelizable === true || resolvedAssignment.executionMode === 'parallel',
  parallelExecution: resolvedAssignment.executionMode === 'parallel',
  independentReview: decision.role === 'reviewer' && (resolvedAssignment.freshSessionRequired === true || decision.independentContextRequired === true),
  modelSelection: resolvedAssignment.modelSelectionRequired === true,
  });
};

export const admitHostExecutionContract = (contract = {}, hostCapabilities = {}) => {
  validateHostExecutionContract(contract);
  const semantic = hostCapabilities?.semantic || {};
  const missing = HOST_SEMANTIC_CAPABILITY_KEYS
    .filter((key) => contract.requirements?.[key] === true && semantic[key] !== true);
  return Object.freeze({
    schemaVersion: 1,
    decision: missing.length === 0 ? 'admitted' : 'blocked',
    missingCapabilities: missing,
    rejectionCode: missing.length === 0 ? null : 'host_capability_unavailable',
  });
};

export const HOST_OWNED_CONCERNS = Object.freeze([
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
]);

const stringOrNull = (value) => value === null || value === undefined || value === '' ? null : String(value);
const stringList = (value) => (Array.isArray(value) ? value.map(String).filter(Boolean) : []);

const providerFieldNames = new Set([
  'provider', 'providerModel', 'model', 'modelClass', 'resolvedModel', 'requestedModel',
  'effort', 'reasoning', 'reasoningEffort', 'resolvedEffort', 'requestedEffort',
  'apiKey', 'credentials', 'authorization', 'prompt', 'promptText', 'messages',
  'sessionId', 'nativeSessionId', 'worktreeRoot', 'gitState', 'cacheKey',
]);

const assertProviderNeutral = (value, path = 'contract') => {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertProviderNeutral(entry, `${path}[${index}]`));
    return;
  }
  if (typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (providerFieldNames.has(key)) {
      const error = new Error(`host_execution_contract_provider_field:${path}.${key}`);
      error.code = 'host_execution_contract_provider_field';
      throw error;
    }
    assertProviderNeutral(child, `${path}.${key}`);
  }
};

const normalizeWorkUnit = (workUnit = {}) => ({
  objective: String(workUnit.objective || ''),
  allowedPaths: stringList(workUnit.allowedPaths),
  forbiddenPaths: stringList(workUnit.forbiddenPaths),
  expectedOutputs: stringList(workUnit.expectedOutputs),
});

// Only fields needed by a Host to select an execution mechanism cross the
// boundary. The returned object deliberately omits the legacy modelClass
// projection even while persisted route decisions still expose it for older
// readers.
export const buildHostExecutionContract = ({
  decision = null,
  assignment = null,
  capsule = null,
  attemptId = null,
  workUnit = null,
} = {}) => {
  if (!decision || typeof decision !== 'object') throw new TypeError('host execution contract requires a route decision');
  const executionClass = decision.executionClass === null || decision.executionClass === undefined
    ? null
    : normalizeExecutionClass(decision.executionClass);
  const capsuleWorkUnit = capsule?.workUnit || null;
  const assignmentWorkProfile = assignment?.workProfile || decision.workProfile || null;
  const contract = {
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
    workUnit: normalizeWorkUnit(workUnit || capsuleWorkUnit || {}),
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

export const validateHostExecutionContract = (contract = {}) => {
  if (!contract || typeof contract !== 'object' || Array.isArray(contract)) {
    throw new TypeError('host execution contract must be an object');
  }
  if (contract.schemaVersion !== HOST_EXECUTION_CONTRACT_SCHEMA_VERSION) {
    throw new Error(`host_execution_contract_schema_invalid:${contract.schemaVersion}`);
  }
  if (!contract.runId || !contract.decisionId || !contract.actionKind) {
    throw new Error('host_execution_contract_identity_missing');
  }
  if (contract.executionClass !== null) normalizeExecutionClass(contract.executionClass);
  for (const key of HOST_SEMANTIC_CAPABILITY_KEYS) {
    if (typeof contract.requirements?.[key] !== 'boolean') {
      throw new Error(`host_execution_contract_requirement_invalid:${key}`);
    }
  }
  assertProviderNeutral(contract);
  return contract;
};

