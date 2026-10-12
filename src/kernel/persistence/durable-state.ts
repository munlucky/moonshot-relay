import type { KernelDurableState } from '../../contracts/generated/kernel.durable-state.js';
import { parseKernelContract } from '../../contracts/schema-codec.js';
import type { ExecutionClass } from '../../contracts/execution-class.js';
import type { WorkAuthorityView } from '../run/work-authority.js';

export const DURABLE_STATE_SCHEMA_VERSION = 1 as const;

export const KERNEL_DURABLE_STATE_SECTIONS = [
  'project',
  'task',
  'work',
  'execution',
  'evidence',
  'completion',
  'knowledge',
] as const;

export const DERIVED_OR_HOST_OWNED_STATE = [
  'provider-selection-internals',
  'model-preference',
  'prompt-cache-state',
  'git-state',
  'optional-reviewer-execution-internals',
  'stagnation-internals',
  'optimization-internals',
] as const;

interface DurableRunLike {
  runId: string;
  projectId?: string | null;
  workspaceId?: string | null;
  worktreeId?: string | null;
  objective?: string | null;
  status?: string | null;
  state?: string | null;
  currentState?: string | null;
  planRevision?: number | null;
  mutationRevision?: number | null;
  contractRevision?: number | null;
  acceptanceCriteria?: unknown[];
  finalizationStatus?: string | null;
  knowledgeRevisionStart?: string | number | null;
  knowledgeRevisionClose?: string | number | null;
  knowledgeStatus?: string | null;
  taskContract?: {
    taskClass?: unknown;
    constraints?: unknown[];
    nonGoals?: unknown[];
    [key: string]: unknown;
  } | null;
  [key: string]: unknown;
}

interface VerificationLike {
  obligationId?: unknown;
  status?: unknown;
  evidenceDigest?: unknown;
  acceptanceCoverage?: unknown[];
  verifiedMutationRevision?: unknown;
  verifiedRuntimeRevision?: unknown;
}

interface ObligationLike {
  obligationId?: unknown;
  evidenceClass?: unknown;
  acceptanceIds?: unknown[];
}

interface CompletionLike {
  decision?: unknown;
  overall?: unknown;
}

export type { KernelDurableState } from '../../contracts/generated/kernel.durable-state.js';

export interface BuildKernelDurableStateInput {
  run?: DurableRunLike | null;
  workAuthority?: WorkAuthorityView | null;
  verifications?: VerificationLike[];
  obligations?: ObligationLike[];
  completion?: CompletionLike | null;
  completionDecision?: CompletionLike | null;
}

const list = (value: unknown): string[] => (
  Array.isArray(value) ? value.map((entry) => String(entry)) : []
);

const numberOrNull = (value: unknown): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const compactEvidence = (verifications: VerificationLike[] = []) => verifications.map((entry) => ({
  obligationId: String(entry.obligationId || ''),
  status: String(entry.status || 'unknown'),
  evidenceDigest: entry.evidenceDigest ?? null,
  acceptanceCoverage: list(entry.acceptanceCoverage),
  verifiedMutationRevision: numberOrNull(entry.verifiedMutationRevision ?? entry.verifiedRuntimeRevision),
}));

const providerFreeKeys = new Set([
  'provider', 'providerModel', 'model', 'modelClass', 'resolvedModel', 'requestedModel',
  'effort', 'resolvedEffort', 'requestedEffort', 'sessionId', 'nativeSessionId',
  'prompt', 'promptText', 'messages', 'cacheKey', 'promptCache', 'gitState',
  'reviewerSessionId', 'reviewerUsageReceiptId', 'stagnationState', 'optimizationState',
]);

const assertProviderFree = (value: unknown, currentPath = '$'): void => {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertProviderFree(entry, `${currentPath}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (providerFreeKeys.has(key)) {
      throw new Error(`durable_state_forbidden_field: ${currentPath}.${key}`);
    }
    assertProviderFree(child, `${currentPath}.${key}`);
  }
};

export const validateKernelDurableState = (view: unknown): KernelDurableState => {
  if (!view || typeof view !== 'object' || Array.isArray(view)) {
    throw new TypeError('durable state view must be an object');
  }
  const candidate = view as Partial<KernelDurableState>;
  if (candidate.schemaVersion !== DURABLE_STATE_SCHEMA_VERSION) {
    throw new Error('durable_state_schema_invalid');
  }
  if (candidate.authority?.source !== 'sqlite' || candidate.authority?.durable !== true) {
    throw new Error('durable_state_authority_invalid');
  }
  for (const section of KERNEL_DURABLE_STATE_SECTIONS) {
    if (!Object.hasOwn(candidate, section)) throw new Error(`durable_state_section_missing: ${section}`);
  }
  assertProviderFree(candidate);
  return parseKernelContract('kernel.durable-state', candidate);
};

export const buildKernelDurableStateView = ({
  run = null,
  workAuthority = null,
  verifications = [],
  obligations = [],
  completion = null,
  completionDecision = null,
}: BuildKernelDurableStateInput = {}): KernelDurableState | null => {
  if (!run) return null;
  const taskContract = run.taskContract || {};
  const view: KernelDurableState = {
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
      requiredObligations: obligations.map((entry) => ({
        obligationId: String(entry.obligationId || ''),
        evidenceClass: String(entry.evidenceClass || 'hard'),
        acceptanceIds: list(entry.acceptanceIds),
      })),
      verifications: compactEvidence(verifications),
    },
    completion: {
      decision: completion?.decision ?? completionDecision?.decision ?? null,
      overall: completion?.overall ?? null,
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
