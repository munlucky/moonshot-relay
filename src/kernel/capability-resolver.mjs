import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveDomainPolicies } from './proof/domain-policy.mjs';
import { compactCapabilityGuidance } from './capability-guidance.mjs';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const catalog = JSON.parse(readFileSync(path.join(sourceRoot, 'catalog', 'kernel-skills.json'), 'utf8'));
const revision = catalog.capabilityConditionsRevision || 'kernel-capability-conditions.v1';
const conditions = catalog.capabilityConditions || {};

export class KernelCapabilityError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'KernelCapabilityError';
    this.code = code;
  }
}

const hasMutation = (task) => task.sourceMutation === true
  || task.behaviorChanging === true
  || Number(task.filesChanged || 0) > 0
  || ['feature', 'refactor', 'bug', 'ui', 'long-running'].includes(task.taskClass);

const conditionState = (task = {}) => {
  const riskTier = task.riskTier || task.proofTier || 'T0';
  const route = Array.isArray(task.route) ? task.route : [];
  const routeIncludesExecute = route.length ? route.includes('EXECUTE') : task.taskClass !== 'analysis';
  const flags = { ...(task.flags || {}) };
  for (const key of ['securityBoundary', 'authBoundary', 'frontend', 'visualBehavior', 'browserProof']) {
    if (task[key] === true) flags[key] = true;
  }
  return {
    sourceMutation: hasMutation(task),
    behaviorChanging: task.behaviorChanging === true,
    ambiguityChangesOutcome: task.ambiguityChangesOutcome === true,
    domainTerminologyConflict: task.domainTerminologyConflict === true,
    taskClass: String(task.taskClass || 'feature'),
    complex: task.complex === true,
    filesChanged: Number(task.filesChanged || 0),
    bug: String(task.taskClass || '') === 'bug',
    reviewSpec: ['T2', 'T3'].includes(riskTier) || task.publicContract === true || task.acceptanceAmbiguity === true,
    reviewStandards: ['T1', 'T2', 'T3'].includes(riskTier) && task.behaviorChanging === true,
    reviewComplexity: task.complex === true || task.newDependency === true,
    safeParallelSplit: task.safeParallelSplit === true,
    independentDeliverables: task.independentDeliverables === true,
    requirements: task.acceptanceUnverifiable === true || task.objectiveNonGoalConflict === true || task.ambiguityChangesOutcome === true,
    design: task.architectureBoundary === true || task.publicContract === true || task.migration === true || task.irreversibleDecision === true,
    planning: task.independentDeliverables === true || task.longLivedResume === true || task.safeParallelSplit === true,
    focusedTest: task.behaviorChanging === true && task.testSurfaceAvailable === true,
    systematicDebugging: task.repeatedFailure === true || task.repeatedBlocker === true || task.rootCauseAmbiguous === true,
    domainPolicies: resolveDomainPolicies({ ...task, flags }),
    verification: routeIncludesExecute || task.explicitCompletionAttempt === true,
    gitCloseoutRequested: task.gitCloseoutRequested === true,
    completionAccepted: task.completionAccepted === true,
    knowledgeCommitReceiptExists: task.knowledgeCommitReceiptExists === true,
    riskTier,
  };
};

const isActive = (id, state) => {
  if (id === 'kernel-minimal-correct-change') return state.sourceMutation;
  if (id === 'kernel-domain-modeling') return state.ambiguityChangesOutcome || state.domainTerminologyConflict;
  if (id === 'kernel-tracer-slicing') return state.taskClass === 'long-running'
    || state.complex
    || state.safeParallelSplit === true
    || state.independentDeliverables === true;
  if (id === 'kernel-test-driven-development') return state.behaviorChanging;
  if (id === 'kernel-diagnosing-bugs') return state.bug;
  if (id === 'kernel-review-spec') return state.reviewSpec;
  if (id === 'kernel-review-standards') return state.reviewStandards;
  if (id === 'kernel-review-complexity') return state.reviewComplexity;
  if (id === 'kernel-requirements-analysis') return state.requirements;
  if (id === 'kernel-conditional-design') return state.design;
  if (id === 'kernel-conditional-planning') return state.planning;
  if (id === 'kernel-focused-test-guidance') return state.focusedTest;
  if (id === 'kernel-systematic-debugging') return state.systematicDebugging;
  if (id === 'kernel-conditional-frontend-guidance') return state.domainPolicies.frontend.active;
  if (id === 'kernel-browser-proof-adapter') return state.domainPolicies.browser.required;
  if (id === 'kernel-security-review-policy') return state.domainPolicies.security.required;
  if (id === 'kernel-simplification-check') return state.domainPolicies.simplification.active;
  if (id === 'kernel-verification-before-completion') return state.verification;
  if (id === 'kernel-commit-closeout') {
    return Boolean(state.gitCloseoutRequested && state.completionAccepted);
  }
  return false;
};

export const resolveKernelCapabilities = (task = {}) => {
  const known = new Set(Object.keys(conditions));
  const requested = Array.isArray(task.capabilities) ? task.capabilities : [];
  for (const capability of requested) {
    if (!known.has(capability)) throw new KernelCapabilityError('kernel_capability_unknown', `Unknown capability: ${capability}`);
  }
  const state = conditionState(task);
  // Internal activation stays granular; the guidance compiler decides what the
  // model actually sees.
  const internalSelected = Object.entries(conditions)
    .filter(([id]) => isActive(id, state))
    .map(([id, metadata]) => ({ id, priority: metadata.priority, reason: metadata.condition, activationCondition: metadata.condition, guidance: metadata.guidance }))
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  const { selected, compacted } = compactCapabilityGuidance(internalSelected, state);
  const internalIds = new Set(internalSelected.map((entry) => entry.id));
  const deferred = Object.entries(conditions)
    .filter(([id]) => !internalIds.has(id))
    .map(([id, metadata]) => ({ id, reason: 'condition_not_met', activationCondition: metadata.condition }));
  const ignoredRequested = requested
    .filter((id) => !internalIds.has(id))
    .map((id) => ({ id, reason: 'caller_forced_condition_not_met' }));
  return {
    schemaVersion: 1,
    revision,
    status: 'ready',
    conditions: state,
    selected,
    internalSelected,
    compacted,
    deferred,
    ignoredRequested,
  };
};
