import { KERNEL_CONTRACT_ENUMS } from '../../contracts/schema-definitions.generated.js';
import { parseKernelContract } from '../../contracts/schema-codec.js';
// Execution Capsule (K1). The bounded execution context a worker session needs
// to do exactly one unit of work without the conversation or repository at large.

import { canonicalJson, digestWithout } from '../../shared/canonical-digest.js';
import {
  applyCapsuleBudget,
  CAPSULE_BUDGET,
  findScopeViolations,
  isSensitivePath,
  type CapsuleBudget,
} from './capsule-selection.js';
import {
  assertImplementationWorkUnitScope,
  resolveWorkUnitAllowedPaths,
  type WorkScopeContract,
  type WorkScopeStep,
} from '../../contracts/work-unit-scope.js';

type UnknownRecord = Record<string, unknown>;

interface AcceptanceLike extends UnknownRecord {
  id?: unknown;
  statement?: unknown;
  obligationIds?: unknown;
}

interface RepositoryFileLike extends UnknownRecord {
  path?: unknown;
  reason?: unknown;
  digest?: unknown;
}

interface RepositorySymbolLike extends UnknownRecord {
  symbol?: unknown;
  path?: unknown;
}

interface RepositoryRecordLike extends UnknownRecord {
  recordId?: unknown;
  summary?: unknown;
  revision?: unknown;
}

interface RepositoryBaselineLike extends UnknownRecord {
  status?: unknown;
  digest?: unknown;
  knownFailures?: unknown[];
}

interface RepositoryContextLike extends UnknownRecord {
  projectMode?: (unknown) | undefined;
  entrypoints?: unknown;
  relevantFiles?: RepositoryFileLike[];
  relevantSymbols?: RepositorySymbolLike[];
  manifests?: unknown;
  knownCommands?: unknown;
  architectureRecords?: RepositoryRecordLike[];
  knowledgeRecords?: RepositoryRecordLike[];
  walkingSkeleton?: unknown;
  baseline?: RepositoryBaselineLike | null;
}

interface ObligationLike extends UnknownRecord {
  obligationId?: unknown;
  evidenceClass?: unknown;
  allowedCommandRefs?: unknown;
  acceptanceIds?: unknown;
}

interface VerificationLike extends UnknownRecord {
  obligationId?: unknown;
  status?: unknown;
  evidenceDigest?: unknown;
  command?: unknown;
  exitCode?: unknown;
}

interface DecisionLike extends UnknownRecord {
  permissions?: unknown;
  decisionId?: unknown;
}

interface ProvenanceLike extends UnknownRecord {
  workspaceIdentity?: unknown;
  sourceIdentity?: unknown;
  taskContractDigest?: unknown;
  knowledgeContextDigest?: unknown;
  routeDecisionId?: unknown;
  createdByVersion?: unknown;
  migrationOrigin?: unknown;
  capsuleDigest?: unknown;
}

interface PermissionsLike extends UnknownRecord {
  filesystem?: unknown;
  network?: unknown;
  canDelegate?: unknown;
  canCommit?: unknown;
}

interface BudgetLike extends UnknownRecord {
  reductions?: unknown[];
  serializedBytes?: unknown;
  withinBudget?: unknown;
}

interface WorkUnitLike extends UnknownRecord {
  objective?: unknown;
  dependencies?: unknown;
  allowedPaths?: unknown;
  forbiddenPaths?: unknown;
  expectedOutputs?: unknown;
}

interface VerificationInputLike extends UnknownRecord {
  obligations?: ObligationLike[];
}

export interface ExecutionCapsuleInput extends UnknownRecord {
  runId?: unknown;
  stepId?: unknown;
  role?: unknown;
  riskTier?: unknown;
  planRevision?: unknown;
  mutationRevision?: unknown;
  objective?: unknown;
  acceptance?: AcceptanceLike[];
  constraints?: unknown;
  nonGoals?: unknown;
  workUnit?: WorkUnitLike | null;
  repositoryContext?: UnknownRecord | null;
  verification?: VerificationInputLike | null;
  permissions?: PermissionsLike | null;
  budget?: BudgetLike | null;
  provenance?: ProvenanceLike | null;
  createdAt?: unknown;
}

interface RunLike extends UnknownRecord {
  runId: string;
  proofTier?: unknown;
  contractRevision?: unknown;
  planRevision?: unknown;
  mutationRevision?: unknown;
  objective?: unknown;
  requiredObligations?: unknown;
  currentWorkspaceIdentity?: unknown;
  sourceIdentity?: unknown;
  taskContract?: UnknownRecord | null;
}

interface StepLike extends WorkScopeStep, UnknownRecord {
  objective?: unknown;
  dependencyIds?: unknown;
  forbiddenPaths?: unknown;
  expectedOutputs?: unknown;
}

interface ContractLike extends WorkScopeContract, UnknownRecord {
  acceptance?: AcceptanceLike[];
  constraints?: unknown;
  nonGoals?: unknown;
  forbiddenPaths?: unknown;
  digest?: unknown;
}

interface KnowledgeContextLike extends UnknownRecord {
  digest?: unknown;
}

interface ImplementationSessionLike extends UnknownRecord {
  actorSessionId?: unknown;
  attemptId?: unknown;
  capsuleDigest?: unknown;
  modelClass?: unknown;
  resolvedModel?: unknown;
}

interface ReviewSubjectLike extends UnknownRecord {
  changedPaths?: unknown;
  diffDigest?: unknown;
  workspaceIdentity?: unknown;
  mutationRevision?: unknown;
}

interface ReviewScopeLike extends UnknownRecord {
  stage?: unknown;
  requiredChecks?: unknown;
  obligationId?: unknown;
}

interface ImplementationReceiptLike extends UnknownRecord {
  actorSessionId?: unknown;
  attemptId?: unknown;
  capsuleDigest?: unknown;
  modelClass?: unknown;
  resolvedModel?: unknown;
}

export interface ReviewCapsuleInput extends UnknownRecord {
  runId?: unknown;
  stepId?: unknown;
  riskTier?: unknown;
  planRevision?: unknown;
  objective?: unknown;
  acceptance?: AcceptanceLike[];
  subject?: ReviewSubjectLike | null;
  verificationEvidence?: VerificationLike[];
  implementationReceipt?: ImplementationReceiptLike | null;
  reviewScope?: ReviewScopeLike | null;
  provenance?: ProvenanceLike | null;
  createdAt?: unknown;
}

export const CAPSULE_SCHEMA_VERSION = 1;
export const CAPSULE_ROLES = Object.freeze(KERNEL_CONTRACT_ENUMS['kernel.execution-capsule']['role']);
export const CAPSULE_PERMISSIONS = Object.freeze(KERNEL_CONTRACT_ENUMS['kernel.execution-capsule']['permissions.filesystem']);
export const REVIEW_CAPSULE_STAGES = Object.freeze(KERNEL_CONTRACT_ENUMS['kernel.review-capsule']['reviewScope.stage']);

const SHA256 = /^sha256:[a-f0-9]{64}$/;

export class ExecutionCapsuleError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ExecutionCapsuleError';
    this.code = code;
  }
}

const fail = (code: string, message: string): never => {
  throw new ExecutionCapsuleError(code, message);
};

const recordOf = (value: unknown): UnknownRecord => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : {}
);

const recordList = (value: unknown): UnknownRecord[] => (
  Array.isArray(value)
    ? value.filter(
      (entry): entry is UnknownRecord => (
        entry !== null && typeof entry === 'object' && !Array.isArray(entry)
      ),
    )
    : []
);

// Identity excludes createdAt so rebuilding the same persisted state produces
// the same capsule.
const digestOfBody = (capsule: unknown): string => {
  const record = recordOf(capsule);
  const {
    capsuleId: _capsuleId,
    createdAt: _createdAt,
    provenance,
    ...body
  } = record;
  const provenanceBody = { ...recordOf(provenance) };
  delete provenanceBody.capsuleDigest;
  return digestWithout({ ...body, provenance: provenanceBody }, []);
};

export const capsuleDigest = (capsule: unknown): string => digestOfBody(capsule);

export const buildCapsuleId = (digest: unknown): string => (
  `capsule-${String(digest).replace(/^sha256:/, '').slice(0, 24)}`
);

const stringList = (value: unknown): string[] => (
  Array.isArray(value) ? value.map(String).filter(Boolean) : []
);

const acceptanceList = (acceptance: AcceptanceLike[] = []) => acceptance
  .map((item) => ({
    id: String(item.id || ''),
    statement: String(item.statement || ''),
    obligationIds: stringList(item.obligationIds),
  }))
  .filter((item) => item.id || item.statement);

export const normalizeExecutionCapsule = (
  input: ExecutionCapsuleInput = {},
) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail('kernel_capsule_invalid', 'execution capsule must be an object');
  }
  if (!input.runId) {
    fail('kernel_capsule_invalid', 'execution capsule requires a runId');
  }
  if (!(CAPSULE_ROLES as readonly unknown[]).includes(input.role)) {
    fail(
      'kernel_capsule_invalid',
      `role must be one of: ${CAPSULE_ROLES.join(', ')}`,
    );
  }

  const permissions = input.permissions || {};
  if (!(CAPSULE_PERMISSIONS as readonly unknown[]).includes(permissions.filesystem)) {
    fail(
      'kernel_capsule_invalid',
      `permissions.filesystem must be one of: ${CAPSULE_PERMISSIONS.join(', ')}`,
    );
  }

  const provenance = input.provenance || {};
  if (!SHA256.test(String(provenance.workspaceIdentity || ''))) {
    fail(
      'kernel_capsule_invalid',
      'provenance.workspaceIdentity must be a sha256:<hex> workspace identity',
    );
  }

  const mutationRevision = Number(input.mutationRevision);
  if (!Number.isInteger(mutationRevision) || mutationRevision < 0) {
    fail(
      'kernel_capsule_invalid',
      'mutationRevision must be a non-negative integer',
    );
  }

  const repository = input.repositoryContext || {};
  const leaked = [
    ...stringList(repository.entrypoints),
    ...recordList(repository.relevantFiles).map((file) => file.path),
    ...stringList(repository.manifests),
  ].filter((entry) => entry && isSensitivePath(entry));

  if (leaked.length > 0) {
    fail(
      'kernel_capsule_secret_path',
      `execution capsule must not name secret-bearing paths: ${leaked.join(', ')}`,
    );
  }

  const workUnit = input.workUnit || {};
  const verification = input.verification || {};
  const baseline = recordOf(repository.baseline);

  const body = {
    schemaVersion: CAPSULE_SCHEMA_VERSION,
    runId: String(input.runId),
    stepId: input.stepId ? String(input.stepId) : null,
    role: String(input.role),
    riskTier: String(input.riskTier || 'T0'),
    planRevision: Number.isInteger(input.planRevision) && Number(input.planRevision) > 0
      ? Number(input.planRevision)
      : 1,
    mutationRevision,
    objective: String(input.objective || ''),
    acceptance: acceptanceList(input.acceptance || []),
    constraints: stringList(input.constraints),
    nonGoals: stringList(input.nonGoals),
    workUnit: {
      objective: String(workUnit.objective || input.objective || ''),
      dependencies: stringList(workUnit.dependencies),
      allowedPaths: stringList(workUnit.allowedPaths),
      forbiddenPaths: stringList(workUnit.forbiddenPaths),
      expectedOutputs: stringList(workUnit.expectedOutputs),
    },
    repositoryContext: {
      projectMode: repository.projectMode ? String(repository.projectMode) : null,
      entrypoints: stringList(repository.entrypoints),
      relevantFiles: recordList(repository.relevantFiles).map((file) => ({
        path: String(file.path),
        reason: String(file.reason || ''),
        digest: file.digest && SHA256.test(String(file.digest))
          ? String(file.digest)
          : null,
      })),
      relevantSymbols: recordList(repository.relevantSymbols).map((symbol) => ({
        symbol: String(symbol.symbol || ''),
        path: String(symbol.path || ''),
      })),
      manifests: stringList(repository.manifests),
      knownCommands: stringList(repository.knownCommands),
      architectureRecords: recordList(repository.architectureRecords).map((record) => ({
        recordId: String(record.recordId),
        summary: String(record.summary || ''),
      })),
      knowledgeRecords: recordList(repository.knowledgeRecords).map((record) => ({
        recordId: String(record.recordId),
        summary: String(record.summary || ''),
        revision: Number.isInteger(record.revision)
          ? Number(record.revision)
          : null,
      })),
      walkingSkeleton: repository.walkingSkeleton || null,
      baseline: {
        status: String(baseline.status || 'unknown'),
        digest: baseline.digest && SHA256.test(String(baseline.digest))
          ? String(baseline.digest)
          : null,
        knownFailures: Array.isArray(baseline.knownFailures)
          ? baseline.knownFailures
          : [],
      },
    },
    verification: {
      obligations: (verification.obligations || []).map((obligation) => ({
        obligationId: String(obligation.obligationId),
        evidenceClass: String(obligation.evidenceClass || 'hard'),
        allowedCommandRefs: stringList(obligation.allowedCommandRefs),
        acceptanceIds: stringList(obligation.acceptanceIds),
      })),
    },
    permissions: {
      filesystem: String(permissions.filesystem),
      network: String(permissions.network || 'inherited'),
      canDelegate: permissions.canDelegate === true,
      canCommit: permissions.canCommit === true,
    },
    budget: {
      reductions: Array.isArray(input.budget?.reductions)
        ? input.budget.reductions
        : [],
      serializedBytes: Number.isInteger(input.budget?.serializedBytes)
        ? Number(input.budget?.serializedBytes)
        : null,
      withinBudget: input.budget?.withinBudget !== false,
    },
    provenance: {
      workspaceIdentity: String(provenance.workspaceIdentity),
      sourceIdentity: provenance.sourceIdentity
        ? String(provenance.sourceIdentity)
        : null,
      taskContractDigest: provenance.taskContractDigest
        ? String(provenance.taskContractDigest)
        : null,
      knowledgeContextDigest: provenance.knowledgeContextDigest
        ? String(provenance.knowledgeContextDigest)
        : null,
      routeDecisionId: provenance.routeDecisionId
        ? String(provenance.routeDecisionId)
        : null,
      createdByVersion: String(
        provenance.createdByVersion || 'kernel.execution-capsule.v1',
      ),
      migrationOrigin: provenance.migrationOrigin
        ? String(provenance.migrationOrigin)
        : null,
    },
  };

  const digest = digestOfBody(body);
  return Object.freeze(parseKernelContract('kernel.execution-capsule', {
    ...body,
    capsuleId: buildCapsuleId(digest),
    provenance: Object.freeze({
      ...body.provenance,
      capsuleDigest: digest,
    }),
    createdAt: input.createdAt
      ? String(input.createdAt)
      : new Date().toISOString(),
  }));
};

export const buildExecutionCapsule = ({
  run,
  step = null,
  decision = null,
  objective = null,
  contract = null,
  obligations = [],
  outstandingObligations = null,
  repositoryContext = {},
  knowledgeContext = null,
  workspaceIdentity = null,
  budget = CAPSULE_BUDGET,
  createdAt = null,
}: {
  run?: RunLike | null;
  step?: StepLike | null;
  decision?: DecisionLike | null;
  objective?: unknown;
  contract?: (ContractLike | null) | undefined;
  obligations?: ObligationLike[];
  outstandingObligations?: unknown[] | null;
  repositoryContext?: RepositoryContextLike;
  knowledgeContext?: KnowledgeContextLike | null;
  workspaceIdentity?: unknown;
  budget?: CapsuleBudget;
  createdAt?: unknown;
} = {}) => {
  if (!run) {
    fail(
      'kernel_capsule_invalid',
      'buildExecutionCapsule requires the run',
    );
  }

  if (decision?.permissions === 'workspace_write') {
    assertImplementationWorkUnitScope({
      step,
      contract,
      actionType: 'implement',
    });
  }

  const activeRun = run as RunLike;
  const outstanding = new Set(
    (outstandingObligations || (
      Array.isArray(activeRun.requiredObligations)
        ? activeRun.requiredObligations
        : []
    )).map(String),
  );
  const relevantObligations = obligations.filter((obligation) => (
    outstanding.size === 0
    || outstanding.has(String(obligation.obligationId))
  ));

  const acceptance = contract?.acceptance || [];
  const draft: ExecutionCapsuleInput = {
    runId: activeRun.runId,
    stepId: step?.stepId || null,
    role: 'implementer',
    riskTier: activeRun.proofTier,
    planRevision: Number(step?.planRevision || activeRun.contractRevision || 1),
    mutationRevision: activeRun.mutationRevision,
    objective: objective || step?.objective || activeRun.objective,
    acceptance: acceptance.map((item) => ({
      id: item.id,
      statement: item.statement,
      obligationIds: obligations
        .filter((obligation) => (
          stringList(obligation.acceptanceIds).includes(String(item.id))
        ))
        .map((obligation) => obligation.obligationId),
    })),
    constraints: contract?.constraints || [],
    nonGoals: contract?.nonGoals || [],
    workUnit: {
      objective: step?.objective || objective || activeRun.objective,
      dependencies: step?.dependencyIds || [],
      allowedPaths: resolveWorkUnitAllowedPaths({ step, contract }),
      forbiddenPaths: Array.isArray(step?.forbiddenPaths)
        && step.forbiddenPaths.length
        ? step.forbiddenPaths
        : contract?.forbiddenPaths || [],
      expectedOutputs: step?.expectedOutputs || [],
    },
    repositoryContext,
    verification: {
      obligations: relevantObligations.map((obligation) => ({
        obligationId: obligation.obligationId,
        evidenceClass: obligation.evidenceClass,
        allowedCommandRefs: obligation.allowedCommandRefs,
        acceptanceIds: obligation.acceptanceIds,
      })),
    },
    permissions: {
      filesystem: decision?.permissions === 'read_only'
        ? 'read_only'
        : 'workspace_write',
      network: 'inherited',
      canDelegate: false,
      canCommit: false,
    },
    provenance: {
      workspaceIdentity: workspaceIdentity || activeRun.currentWorkspaceIdentity,
      sourceIdentity: activeRun.sourceIdentity,
      taskContractDigest: contract?.digest
        || recordOf(activeRun.taskContract).digest
        || null,
      knowledgeContextDigest: knowledgeContext?.digest || null,
      routeDecisionId: decision?.decisionId || null,
    },
    createdAt,
  };

  const budgeted = applyCapsuleBudget(draft, budget);
  return normalizeExecutionCapsule({
    ...budgeted.capsule,
    budget: {
      reductions: budgeted.reductions,
      serializedBytes: budgeted.serializedBytes,
      withinBudget: budgeted.withinBudget,
    },
    createdAt,
  });
};

export const normalizeReviewCapsule = (
  input: ReviewCapsuleInput = {},
) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail(
      'kernel_review_capsule_invalid',
      'review capsule must be an object',
    );
  }
  if (!input.runId) {
    fail(
      'kernel_review_capsule_invalid',
      'review capsule requires a runId',
    );
  }

  const reviewScope = input.reviewScope || {};
  if (!(REVIEW_CAPSULE_STAGES as readonly unknown[]).includes(reviewScope.stage)) {
    fail(
      'kernel_review_capsule_invalid',
      `reviewScope.stage must be one of: ${REVIEW_CAPSULE_STAGES.join(', ')}`,
    );
  }

  const subject = input.subject || {};
  if (!SHA256.test(String(subject.workspaceIdentity || ''))) {
    fail(
      'kernel_review_capsule_invalid',
      'subject.workspaceIdentity must be a sha256:<hex> workspace identity',
    );
  }

  const mutationRevision = Number(subject.mutationRevision);
  if (!Number.isInteger(mutationRevision) || mutationRevision < 0) {
    fail(
      'kernel_review_capsule_invalid',
      'subject.mutationRevision must be a non-negative integer',
    );
  }

  const implementationReceipt = input.implementationReceipt || {};
  const provenance = input.provenance || {};

  const body = {
    schemaVersion: CAPSULE_SCHEMA_VERSION,
    runId: String(input.runId),
    stepId: input.stepId ? String(input.stepId) : null,
    role: 'reviewer',
    riskTier: String(input.riskTier || 'T0'),
    planRevision: Number.isInteger(input.planRevision) && Number(input.planRevision) > 0
      ? Number(input.planRevision)
      : 1,
    objective: String(input.objective || ''),
    acceptance: acceptanceList(input.acceptance || []),
    subject: {
      changedPaths: stringList(subject.changedPaths),
      diffDigest: subject.diffDigest && SHA256.test(String(subject.diffDigest))
        ? String(subject.diffDigest)
        : null,
      workspaceIdentity: String(subject.workspaceIdentity),
      mutationRevision,
    },
    verificationEvidence: (input.verificationEvidence || []).map((entry) => ({
      obligationId: String(entry.obligationId || ''),
      status: String(entry.status || ''),
      evidenceDigest: entry.evidenceDigest
        ? String(entry.evidenceDigest)
        : null,
      command: entry.command ? String(entry.command) : null,
      exitCode: Number.isInteger(entry.exitCode)
        ? Number(entry.exitCode)
        : null,
    })),
    implementationReceipt: {
      actorSessionId: implementationReceipt.actorSessionId
        ? String(implementationReceipt.actorSessionId)
        : null,
      attemptId: implementationReceipt.attemptId
        ? String(implementationReceipt.attemptId)
        : null,
      capsuleDigest: implementationReceipt.capsuleDigest
        ? String(implementationReceipt.capsuleDigest)
        : null,
      modelClass: implementationReceipt.modelClass
        ? String(implementationReceipt.modelClass)
        : null,
      resolvedModel: implementationReceipt.resolvedModel
        ? String(implementationReceipt.resolvedModel)
        : null,
    },
    reviewScope: {
      stage: String(reviewScope.stage),
      requiredChecks: stringList(reviewScope.requiredChecks),
      obligationId: reviewScope.obligationId
        ? String(reviewScope.obligationId)
        : null,
    },
    permissions: {
      filesystem: 'read_only',
      network: 'inherited',
      canDelegate: false,
      canCommit: false,
    },
    provenance: {
      workspaceIdentity: String(subject.workspaceIdentity),
      sourceIdentity: provenance.sourceIdentity
        ? String(provenance.sourceIdentity)
        : null,
      routeDecisionId: provenance.routeDecisionId
        ? String(provenance.routeDecisionId)
        : null,
      createdByVersion: String(
        provenance.createdByVersion || 'kernel.review-capsule.v1',
      ),
      migrationOrigin: provenance.migrationOrigin
        ? String(provenance.migrationOrigin)
        : null,
    },
  };

  const digest = digestOfBody(body);
  return Object.freeze(parseKernelContract('kernel.review-capsule', {
    ...body,
    capsuleId: buildCapsuleId(digest),
    provenance: Object.freeze({
      ...body.provenance,
      capsuleDigest: digest,
    }),
    createdAt: input.createdAt
      ? String(input.createdAt)
      : new Date().toISOString(),
  }));
};

export const buildReviewCapsule = ({
  run,
  step = null,
  decision = null,
  contract = null,
  stage = 'engineering',
  obligationId = null,
  requiredChecks = [],
  changedPaths = [],
  diffDigest = null,
  verifications = [],
  implementationSession = null,
  createdAt = null,
}: {
  run?: RunLike | null;
  step?: StepLike | null;
  decision?: DecisionLike | null;
  contract?: ContractLike | null;
  stage?: unknown;
  obligationId?: unknown;
  requiredChecks?: unknown[];
  changedPaths?: unknown[];
  diffDigest?: unknown;
  verifications?: VerificationLike[];
  implementationSession?: ImplementationSessionLike | null;
  createdAt?: unknown;
} = {}) => {
  if (!run) {
    fail(
      'kernel_review_capsule_invalid',
      'buildReviewCapsule requires the run',
    );
  }

  const activeRun = run as RunLike;
  return normalizeReviewCapsule({
    runId: activeRun.runId,
    stepId: step?.stepId || null,
    riskTier: activeRun.proofTier,
    planRevision: Number(step?.planRevision || activeRun.contractRevision || 1),
    objective: activeRun.objective,
    acceptance: (contract?.acceptance || []).map((item) => ({
      id: item.id,
      statement: item.statement,
    })),
    subject: {
      changedPaths,
      diffDigest,
      workspaceIdentity: activeRun.currentWorkspaceIdentity,
      mutationRevision: activeRun.mutationRevision,
    },
    verificationEvidence: verifications,
    implementationReceipt: {
      actorSessionId: implementationSession?.actorSessionId || null,
      attemptId: implementationSession?.attemptId || null,
      capsuleDigest: implementationSession?.capsuleDigest || null,
      modelClass: implementationSession?.modelClass || null,
      resolvedModel: implementationSession?.resolvedModel || null,
    },
    reviewScope: {
      stage,
      requiredChecks,
      obligationId,
    },
    provenance: {
      sourceIdentity: activeRun.sourceIdentity,
      routeDecisionId: decision?.decisionId || null,
    },
    createdAt,
  });
};

export const capsuleStaleness = ({
  capsule,
  run,
}: {
  capsule?: UnknownRecord | null;
  run?: RunLike | null;
} = {}) => {
  const reasons: string[] = [];
  if (!capsule) return { stale: true, reasons: ['capsule-missing'] };
  if (!run) return { stale: true, reasons: ['run-missing'] };

  if (capsule.runId !== run.runId) reasons.push('capsule-run-mismatch');

  const subject = recordOf(capsule.subject);
  const capsuleMutationRevision = capsule.role === 'reviewer'
    ? subject.mutationRevision
    : capsule.mutationRevision;

  if (capsuleMutationRevision !== run.mutationRevision) {
    reasons.push('capsule-stale-mutation-revision');
  }

  const provenance = recordOf(capsule.provenance);
  if (
    run.currentWorkspaceIdentity
    && provenance.workspaceIdentity !== run.currentWorkspaceIdentity
  ) {
    reasons.push('capsule-stale-workspace-identity');
  }

  const expectedRevision = capsule.stepId
    ? Number(run.planRevision || 1)
    : Number(run.contractRevision || 1);
  if (capsule.planRevision !== expectedRevision) {
    reasons.push('capsule-stale-plan-revision');
  }

  return {
    stale: reasons.length > 0,
    reasons,
  };
};

export { CAPSULE_BUDGET, findScopeViolations, canonicalJson };
