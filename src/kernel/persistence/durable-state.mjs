// Minimal Kernel durable-state authority (Wave B10); receipts stay evidence.

export const DURABLE_STATE_SCHEMA_VERSION = 1;

export const KERNEL_DURABLE_STATE_SECTIONS = Object.freeze([
  'project',
  'task',
  'work',
  'execution',
  'evidence',
  'completion',
  'knowledge',
]);

export const DERIVED_OR_HOST_OWNED_STATE = Object.freeze([
  'provider-selection-internals',
  'model-preference',
  'prompt-cache-state',
  'git-state',
  'optional-reviewer-execution-internals',
  'stagnation-internals',
  'optimization-internals',
]);

const list = (value) => (Array.isArray(value) ? value : []).map((entry) => String(entry));
const numberOrNull = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);

const compactEvidence = (verifications = []) => (Array.isArray(verifications) ? verifications : []).map((entry) => ({
  obligationId: String(entry.obligationId || ''),
  status: String(entry.status || 'unknown'),
  evidenceDigest: entry.evidenceDigest || null,
  acceptanceCoverage: list(entry.acceptanceCoverage),
  verifiedMutationRevision: numberOrNull(entry.verifiedMutationRevision ?? entry.verifiedRuntimeRevision),
}));

const providerFreeKeys = new Set([
  'provider', 'providerModel', 'model', 'modelClass', 'resolvedModel', 'requestedModel',
  'effort', 'resolvedEffort', 'requestedEffort', 'sessionId', 'nativeSessionId',
  'prompt', 'promptText', 'messages', 'cacheKey', 'promptCache', 'gitState',
  'reviewerSessionId', 'reviewerUsageReceiptId', 'stagnationState', 'optimizationState',
]);

const assertProviderFree = (value, path = '$') => {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertProviderFree(entry, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (providerFreeKeys.has(key)) throw new Error(`durable_state_forbidden_field: ${path}.${key}`);
    assertProviderFree(child, `${path}.${key}`);
  }
};

export const validateKernelDurableState = (view) => {
  if (!view || typeof view !== 'object' || Array.isArray(view)) throw new TypeError('durable state view must be an object');
  if (view.schemaVersion !== DURABLE_STATE_SCHEMA_VERSION) throw new Error('durable_state_schema_invalid');
  if (view.authority?.source !== 'sqlite' || view.authority?.durable !== true) throw new Error('durable_state_authority_invalid');
  for (const section of KERNEL_DURABLE_STATE_SECTIONS) {
    if (!Object.hasOwn(view, section)) throw new Error(`durable_state_section_missing: ${section}`);
  }
  assertProviderFree(view);
  return view;
};

export const buildKernelDurableStateView = ({
  run = null,
  workAuthority = null,
  verifications = [],
  obligations = [],
  completion = null,
  completionDecision = null,
} = {}) => {
  if (!run) return null;
  const taskContract = run.taskContract || {};
  const view = {
    schemaVersion: DURABLE_STATE_SCHEMA_VERSION,
    authority: { source: 'sqlite', durable: true },
    project: {
      projectId: run.projectId || null,
      workspaceId: run.workspaceId || null,
      worktreeId: run.worktreeId || null,
    },
    task: {
      runId: String(run.runId),
      objective: String(run.objective || ''),
      taskClass: String(taskContract.taskClass || 'feature'),
      contractRevision: numberOrNull(run.contractRevision) || 1,
      acceptanceCriteria: list(run.acceptanceCriteria),
      constraints: list(taskContract.constraints),
      nonGoals: list(taskContract.nonGoals),
    },
    work: {
      status: String(run.status || 'active'),
      state: String(run.state || run.currentState || ''),
      planRevision: numberOrNull(run.planRevision) || 1,
      mutationRevision: numberOrNull(run.mutationRevision) || 0,
      cursor: workAuthority?.cursor || null,
      currentWorkUnit: workAuthority?.currentWorkUnit || null,
      progress: workAuthority?.progress || null,
      resume: workAuthority?.resume || null,
    },
    execution: {
      executionClass: workAuthority?.executionClass || null,
    },
    evidence: {
      requiredObligations: (Array.isArray(obligations) ? obligations : []).map((entry) => ({
        obligationId: String(entry.obligationId || ''),
        evidenceClass: String(entry.evidenceClass || 'hard'),
        acceptanceIds: list(entry.acceptanceIds),
      })),
      verifications: compactEvidence(verifications),
    },
    completion: {
      decision: completion?.decision || completionDecision?.decision || null,
      overall: completion?.overall || null,
      finalizationStatus: run.finalizationStatus || null,
    },
    knowledge: {
      revisionStart: run.knowledgeRevisionStart || null,
      revisionClose: run.knowledgeRevisionClose || null,
      status: run.knowledgeStatus || null,
    },
  };
  return validateKernelDurableState(view);
};
