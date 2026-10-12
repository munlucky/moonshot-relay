import path from 'node:path';
import { readFileSync } from 'node:fs';
import { resolveRuntimeRoot } from '../shared/runtime-assets.js';
import { resolveDomainPolicies } from './proof/domain-policy.js';
import { compactCapabilityGuidance } from './capability-guidance.js';

type UnknownRecord = Record<string, unknown>;

interface CapabilityMetadata {
  priority: number;
  condition: string;
  guidance: string | null;
}

interface CapabilityCatalog {
  capabilityConditionsRevision?: string;
  capabilityConditions?: Record<string, CapabilityMetadata>;
}

export interface KernelCapabilityTask extends UnknownRecord {
  riskTier?: string;
  proofTier?: string;
  route?: string[];
  taskClass?: string;
  flags?: Record<string, boolean>;
  capabilities?: string[];
  sourceMutation?: boolean;
  behaviorChanging?: boolean;
  ambiguityChangesOutcome?: boolean;
  domainTerminologyConflict?: boolean;
  complex?: boolean;
  filesChanged?: number;
  publicContract?: boolean;
  acceptanceAmbiguity?: boolean;
  newDependency?: boolean;
  safeParallelSplit?: boolean;
  independentDeliverables?: boolean;
  acceptanceUnverifiable?: boolean;
  objectiveNonGoalConflict?: boolean;
  architectureBoundary?: boolean;
  migration?: boolean;
  irreversibleDecision?: boolean;
  longLivedResume?: boolean;
  testSurfaceAvailable?: boolean;
  repeatedFailure?: boolean;
  repeatedBlocker?: boolean;
  rootCauseAmbiguous?: boolean;
  explicitCompletionAttempt?: boolean;
  gitCloseoutRequested?: boolean;
  completionAccepted?: boolean;
  knowledgeCommitReceiptExists?: boolean;
  securityBoundary?: boolean;
  authBoundary?: boolean;
  frontend?: boolean;
  visualBehavior?: boolean;
  browserProof?: boolean;
}

interface CapabilityState extends UnknownRecord {
  sourceMutation: boolean;
  behaviorChanging: boolean;
  ambiguityChangesOutcome: boolean;
  domainTerminologyConflict: boolean;
  taskClass: string;
  complex: boolean;
  filesChanged: number;
  bug: boolean;
  reviewSpec: boolean;
  reviewStandards: boolean;
  reviewComplexity: boolean;
  safeParallelSplit: boolean;
  independentDeliverables: boolean;
  requirements: boolean;
  design: boolean;
  planning: boolean;
  focusedTest: boolean;
  systematicDebugging: boolean;
  domainPolicies: ReturnType<typeof resolveDomainPolicies>;
  verification: boolean;
  gitCloseoutRequested: boolean;
  completionAccepted: boolean;
  knowledgeCommitReceiptExists: boolean;
  riskTier: string;
}

const sourceRoot = resolveRuntimeRoot(import.meta.url);
const catalog = JSON.parse(
  readFileSync(path.join(sourceRoot, 'catalog', 'kernel-skills.json'), 'utf8'),
) as CapabilityCatalog;
const revision = catalog.capabilityConditionsRevision
  || 'kernel-capability-conditions.v1';
const conditions = catalog.capabilityConditions || {};

export class KernelCapabilityError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'KernelCapabilityError';
    this.code = code;
  }
}

const hasMutation = (task: KernelCapabilityTask): boolean => (
  task.sourceMutation === true
  || task.behaviorChanging === true
  || Number(task.filesChanged || 0) > 0
  || ['feature', 'refactor', 'bug', 'ui', 'long-running'].includes(
    String(task.taskClass || ''),
  )
);

const conditionState = (
  task: KernelCapabilityTask = {},
): CapabilityState => {
  const riskTier = String(task.riskTier || task.proofTier || 'T0');
  const route = Array.isArray(task.route) ? task.route : [];
  const routeIncludesExecute = route.length > 0
    ? route.includes('EXECUTE')
    : task.taskClass !== 'analysis';
  const flags: Record<string, boolean> = { ...(task.flags || {}) };
  for (const key of [
    'securityBoundary',
    'authBoundary',
    'frontend',
    'visualBehavior',
    'browserProof',
  ] as const) {
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
    reviewSpec: ['T2', 'T3'].includes(riskTier)
      || task.publicContract === true
      || task.acceptanceAmbiguity === true,
    reviewStandards: ['T1', 'T2', 'T3'].includes(riskTier)
      && task.behaviorChanging === true,
    reviewComplexity: task.complex === true || task.newDependency === true,
    safeParallelSplit: task.safeParallelSplit === true,
    independentDeliverables: task.independentDeliverables === true,
    requirements: task.acceptanceUnverifiable === true
      || task.objectiveNonGoalConflict === true
      || task.ambiguityChangesOutcome === true,
    design: task.architectureBoundary === true
      || task.publicContract === true
      || task.migration === true
      || task.irreversibleDecision === true,
    planning: task.independentDeliverables === true
      || task.longLivedResume === true
      || task.safeParallelSplit === true,
    focusedTest: task.behaviorChanging === true
      && task.testSurfaceAvailable === true,
    systematicDebugging: task.repeatedFailure === true
      || task.repeatedBlocker === true
      || task.rootCauseAmbiguous === true,
    domainPolicies: resolveDomainPolicies({ ...task, flags }),
    verification: routeIncludesExecute || task.explicitCompletionAttempt === true,
    gitCloseoutRequested: task.gitCloseoutRequested === true,
    completionAccepted: task.completionAccepted === true,
    knowledgeCommitReceiptExists: task.knowledgeCommitReceiptExists === true,
    riskTier,
  };
};

const isActive = (id: string, state: CapabilityState): boolean => {
  if (id === 'kernel-minimal-correct-change') return state.sourceMutation;
  if (id === 'kernel-domain-modeling') {
    return state.ambiguityChangesOutcome || state.domainTerminologyConflict;
  }
  if (id === 'kernel-tracer-slicing') {
    return state.taskClass === 'long-running'
      || state.complex
      || state.safeParallelSplit
      || state.independentDeliverables;
  }
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
  if (id === 'kernel-conditional-frontend-guidance') {
    return state.domainPolicies.frontend.active;
  }
  if (id === 'kernel-browser-proof-adapter') {
    return state.domainPolicies.browser.required;
  }
  if (id === 'kernel-security-review-policy') {
    return state.domainPolicies.security.required;
  }
  if (id === 'kernel-simplification-check') {
    return state.domainPolicies.simplification.active;
  }
  if (id === 'kernel-verification-before-completion') {
    return state.verification;
  }
  if (id === 'kernel-commit-closeout') {
    return state.gitCloseoutRequested && state.completionAccepted;
  }
  return false;
};

export const resolveKernelCapabilities = (
  task: KernelCapabilityTask = {},
) => {
  const known = new Set(Object.keys(conditions));
  const requested = Array.isArray(task.capabilities) ? task.capabilities : [];
  for (const capability of requested) {
    if (!known.has(capability)) {
      throw new KernelCapabilityError(
        'kernel_capability_unknown',
        `Unknown capability: ${capability}`,
      );
    }
  }

  const state = conditionState(task);
  const internalSelected = Object.entries(conditions)
    .filter(([id]) => isActive(id, state))
    .map(([id, metadata]) => ({
      id,
      priority: metadata.priority,
      reason: metadata.condition,
      activationCondition: metadata.condition,
      guidance: metadata.guidance,
    }))
    .sort((left, right) => (
      left.priority - right.priority || left.id.localeCompare(right.id)
    ));

  const { selected, compacted } = compactCapabilityGuidance(
    internalSelected,
    state,
  );
  const internalIds = new Set(internalSelected.map((entry) => entry.id));
  const deferred = Object.entries(conditions)
    .filter(([id]) => !internalIds.has(id))
    .map(([id, metadata]) => ({
      id,
      reason: 'condition_not_met',
      activationCondition: metadata.condition,
    }));
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
