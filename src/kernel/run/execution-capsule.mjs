// Execution Capsule (K1). The bounded execution context a worker session needs
// to do exactly one unit of work without the conversation, the planner's
// reasoning, or the repository at large.
//
// A capsule is identified by the digest of its own content, so:
//   - the same persisted state rebuilds a byte-identical capsule (resume), and
//   - a capsule built against an older workspace is detectably stale.
//
// Reviewers get a DIFFERENT capsule: read-only, subject-and-evidence shaped,
// carrying none of the implementer's internal context.

import { canonicalJson, digestWithout } from '../canonical-digest.mjs';
import { applyCapsuleBudget, CAPSULE_BUDGET, findScopeViolations, isSensitivePath } from './capsule-selection.mjs';
import { assertImplementationWorkUnitScope, resolveWorkUnitAllowedPaths } from './work-unit-scope.mjs';

export const CAPSULE_SCHEMA_VERSION = 1;
export const CAPSULE_ROLES = Object.freeze(['implementer', 'reviewer', 'planner', 'researcher']);
export const CAPSULE_PERMISSIONS = Object.freeze(['read_only', 'plan_write', 'workspace_write']);
export const REVIEW_CAPSULE_STAGES = Object.freeze(['contract', 'engineering', 'complexity']);

const SHA256 = /^sha256:[a-f0-9]{64}$/;

export class ExecutionCapsuleError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ExecutionCapsuleError';
    this.code = code;
  }
}

const fail = (code, message) => { throw new ExecutionCapsuleError(code, message); };

// Identity excludes createdAt on purpose: two builds of the same state must be
// the same capsule, otherwise "resume produces an equivalent capsule" could
// never be asserted.
const digestOfBody = (capsule) => {
  const { capsuleId, createdAt, provenance, ...body } = capsule || {};
  const provenanceBody = { ...(provenance || {}) };
  delete provenanceBody.capsuleDigest;
  return digestWithout({ ...body, provenance: provenanceBody }, []);
};

export const capsuleDigest = (capsule) => digestOfBody(capsule);

export const buildCapsuleId = (digest) => `capsule-${String(digest).replace(/^sha256:/, '').slice(0, 24)}`;

const stringList = (value) => (Array.isArray(value) ? value.map(String).filter(Boolean) : []);

const acceptanceList = (acceptance = []) => acceptance.map((item) => ({
  id: String(item.id || ''),
  statement: String(item.statement || ''),
  obligationIds: stringList(item.obligationIds),
})).filter((item) => item.id || item.statement);

// The capsule is a closed record: anything not declared here cannot reach a
// worker through it.
export const normalizeExecutionCapsule = (input = {}) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('kernel_capsule_invalid', 'execution capsule must be an object');
  if (!input.runId) fail('kernel_capsule_invalid', 'execution capsule requires a runId');
  if (!CAPSULE_ROLES.includes(input.role)) fail('kernel_capsule_invalid', `role must be one of: ${CAPSULE_ROLES.join(', ')}`);
  if (!CAPSULE_PERMISSIONS.includes(input.permissions?.filesystem)) {
    fail('kernel_capsule_invalid', `permissions.filesystem must be one of: ${CAPSULE_PERMISSIONS.join(', ')}`);
  }
  if (!SHA256.test(String(input.provenance?.workspaceIdentity || ''))) {
    fail('kernel_capsule_invalid', 'provenance.workspaceIdentity must be a sha256:<hex> workspace identity');
  }
  if (!Number.isInteger(input.mutationRevision) || input.mutationRevision < 0) {
    fail('kernel_capsule_invalid', 'mutationRevision must be a non-negative integer');
  }

  const repository = input.repositoryContext || {};
  const leaked = [
    ...stringList(repository.entrypoints),
    ...(repository.relevantFiles || []).map((file) => file?.path),
    ...stringList(repository.manifests),
  ].filter((entry) => entry && isSensitivePath(entry));
  if (leaked.length > 0) fail('kernel_capsule_secret_path', `execution capsule must not name secret-bearing paths: ${leaked.join(', ')}`);

  const body = {
    schemaVersion: CAPSULE_SCHEMA_VERSION,
    runId: String(input.runId),
    stepId: input.stepId ? String(input.stepId) : null,
    role: input.role,
    riskTier: String(input.riskTier || 'T0'),
    planRevision: Number.isInteger(input.planRevision) && input.planRevision > 0 ? input.planRevision : 1,
    mutationRevision: input.mutationRevision,
    objective: String(input.objective || ''),
    acceptance: acceptanceList(input.acceptance || []),
    constraints: stringList(input.constraints),
    nonGoals: stringList(input.nonGoals),
    workUnit: {
      objective: String(input.workUnit?.objective || input.objective || ''),
      dependencies: stringList(input.workUnit?.dependencies),
      allowedPaths: stringList(input.workUnit?.allowedPaths),
      forbiddenPaths: stringList(input.workUnit?.forbiddenPaths),
      expectedOutputs: stringList(input.workUnit?.expectedOutputs),
    },
    repositoryContext: {
      projectMode: repository.projectMode ? String(repository.projectMode) : null,
      entrypoints: stringList(repository.entrypoints),
      relevantFiles: (repository.relevantFiles || []).map((file) => ({
        path: String(file.path),
        reason: String(file.reason || ''),
        digest: file.digest && SHA256.test(file.digest) ? file.digest : null,
      })),
      relevantSymbols: (repository.relevantSymbols || []).map((symbol) => ({
        symbol: String(symbol.symbol || ''),
        path: String(symbol.path || ''),
      })),
      manifests: stringList(repository.manifests),
      knownCommands: stringList(repository.knownCommands),
      architectureRecords: (repository.architectureRecords || []).map((record) => ({
        recordId: String(record.recordId),
        summary: String(record.summary || ''),
      })),
      knowledgeRecords: (repository.knowledgeRecords || []).map((record) => ({
        recordId: String(record.recordId),
        summary: String(record.summary || ''),
        revision: Number.isInteger(record.revision) ? record.revision : null,
      })),
      walkingSkeleton: repository.walkingSkeleton || null,
      baseline: {
        status: String(repository.baseline?.status || 'unknown'),
        digest: repository.baseline?.digest && SHA256.test(repository.baseline.digest) ? repository.baseline.digest : null,
        knownFailures: Array.isArray(repository.baseline?.knownFailures) ? repository.baseline.knownFailures : [],
      },
    },
    verification: {
      obligations: (input.verification?.obligations || []).map((obligation) => ({
        obligationId: String(obligation.obligationId),
        evidenceClass: String(obligation.evidenceClass || 'hard'),
        allowedCommandRefs: stringList(obligation.allowedCommandRefs),
        acceptanceIds: stringList(obligation.acceptanceIds),
      })),
    },
    permissions: {
      filesystem: input.permissions.filesystem,
      network: String(input.permissions.network || 'inherited'),
      canDelegate: input.permissions.canDelegate === true,
      canCommit: input.permissions.canCommit === true,
    },
    budget: {
      reductions: Array.isArray(input.budget?.reductions) ? input.budget.reductions : [],
      serializedBytes: Number.isInteger(input.budget?.serializedBytes) ? input.budget.serializedBytes : null,
      withinBudget: input.budget?.withinBudget !== false,
    },
    provenance: {
      workspaceIdentity: String(input.provenance.workspaceIdentity),
      sourceIdentity: input.provenance.sourceIdentity ? String(input.provenance.sourceIdentity) : null,
      taskContractDigest: input.provenance.taskContractDigest ? String(input.provenance.taskContractDigest) : null,
      knowledgeContextDigest: input.provenance.knowledgeContextDigest ? String(input.provenance.knowledgeContextDigest) : null,
      routeDecisionId: input.provenance.routeDecisionId ? String(input.provenance.routeDecisionId) : null,
      createdByVersion: String(input.provenance.createdByVersion || 'kernel.execution-capsule.v1'),
      migrationOrigin: input.provenance.migrationOrigin ? String(input.provenance.migrationOrigin) : null,
    },
  };

  const digest = digestOfBody(body);
  return Object.freeze({
    ...body,
    capsuleId: buildCapsuleId(digest),
    provenance: Object.freeze({ ...body.provenance, capsuleDigest: digest }),
    createdAt: input.createdAt ? String(input.createdAt) : new Date().toISOString(),
  });
};

// Builds the implementer capsule from persisted state only. The caller supplies
// the pieces it already read; nothing here reaches back into a conversation.
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
} = {}) => {
  if (!run) fail('kernel_capsule_invalid', 'buildExecutionCapsule requires the run');
  if (decision?.permissions === 'workspace_write') {
    assertImplementationWorkUnitScope({ step, contract, actionType: 'implement' });
  }
  const outstanding = new Set(outstandingObligations || run.requiredObligations || []);
  const relevantObligations = obligations.filter((obligation) => outstanding.size === 0 || outstanding.has(obligation.obligationId));

  const draft = {
    runId: run.runId,
    stepId: step?.stepId || null,
    role: 'implementer',
    riskTier: run.proofTier,
    planRevision: Number(step?.planRevision || run.contractRevision || 1),
    mutationRevision: run.mutationRevision,
    objective: objective || step?.objective || run.objective,
    acceptance: (contract?.acceptance || []).map((item) => ({
      id: item.id,
      statement: item.statement,
      obligationIds: obligations.filter((obligation) => (obligation.acceptanceIds || []).includes(item.id)).map((obligation) => obligation.obligationId),
    })),
    constraints: contract?.constraints || [],
    nonGoals: contract?.nonGoals || [],
    workUnit: {
      objective: step?.objective || objective || run.objective,
      dependencies: step?.dependencyIds || [],
      allowedPaths: resolveWorkUnitAllowedPaths({ step, contract }),
      forbiddenPaths: step?.forbiddenPaths?.length ? step.forbiddenPaths : (contract?.forbiddenPaths || []),
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
      filesystem: decision?.permissions === 'read_only' ? 'read_only' : 'workspace_write',
      network: 'inherited',
      canDelegate: false,
      canCommit: false,
    },
    provenance: {
      workspaceIdentity: workspaceIdentity || run.currentWorkspaceIdentity,
      sourceIdentity: run.sourceIdentity,
      taskContractDigest: contract?.digest || run.taskContract?.digest || null,
      knowledgeContextDigest: knowledgeContext?.digest || null,
      routeDecisionId: decision?.decisionId || null,
    },
    createdAt,
  };

  const budgeted = applyCapsuleBudget(draft, budget);
  return normalizeExecutionCapsule({
    ...budgeted.capsule,
    budget: { reductions: budgeted.reductions, serializedBytes: budgeted.serializedBytes, withinBudget: budgeted.withinBudget },
    createdAt,
  });
};

// Reviewer capsule (§6.8). Subject, evidence, and scope — never the
// implementer's reasoning, never write permission.
export const normalizeReviewCapsule = (input = {}) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('kernel_review_capsule_invalid', 'review capsule must be an object');
  if (!input.runId) fail('kernel_review_capsule_invalid', 'review capsule requires a runId');
  if (!REVIEW_CAPSULE_STAGES.includes(input.reviewScope?.stage)) {
    fail('kernel_review_capsule_invalid', `reviewScope.stage must be one of: ${REVIEW_CAPSULE_STAGES.join(', ')}`);
  }
  if (!SHA256.test(String(input.subject?.workspaceIdentity || ''))) {
    fail('kernel_review_capsule_invalid', 'subject.workspaceIdentity must be a sha256:<hex> workspace identity');
  }
  if (!Number.isInteger(input.subject?.mutationRevision) || input.subject.mutationRevision < 0) {
    fail('kernel_review_capsule_invalid', 'subject.mutationRevision must be a non-negative integer');
  }

  const body = {
    schemaVersion: CAPSULE_SCHEMA_VERSION,
    runId: String(input.runId),
    stepId: input.stepId ? String(input.stepId) : null,
    role: 'reviewer',
    riskTier: String(input.riskTier || 'T0'),
    planRevision: Number.isInteger(input.planRevision) && input.planRevision > 0 ? input.planRevision : 1,
    objective: String(input.objective || ''),
    acceptance: acceptanceList(input.acceptance || []),
    subject: {
      changedPaths: stringList(input.subject.changedPaths),
      diffDigest: input.subject.diffDigest && SHA256.test(input.subject.diffDigest) ? input.subject.diffDigest : null,
      workspaceIdentity: String(input.subject.workspaceIdentity),
      mutationRevision: input.subject.mutationRevision,
    },
    verificationEvidence: (input.verificationEvidence || []).map((entry) => ({
      obligationId: String(entry.obligationId || ''),
      status: String(entry.status || ''),
      evidenceDigest: entry.evidenceDigest ? String(entry.evidenceDigest) : null,
      command: entry.command ? String(entry.command) : null,
      exitCode: Number.isInteger(entry.exitCode) ? entry.exitCode : null,
    })),
    implementationReceipt: {
      actorSessionId: input.implementationReceipt?.actorSessionId ? String(input.implementationReceipt.actorSessionId) : null,
      attemptId: input.implementationReceipt?.attemptId ? String(input.implementationReceipt.attemptId) : null,
      capsuleDigest: input.implementationReceipt?.capsuleDigest ? String(input.implementationReceipt.capsuleDigest) : null,
      modelClass: input.implementationReceipt?.modelClass ? String(input.implementationReceipt.modelClass) : null,
      resolvedModel: input.implementationReceipt?.resolvedModel ? String(input.implementationReceipt.resolvedModel) : null,
    },
    reviewScope: {
      stage: input.reviewScope.stage,
      requiredChecks: stringList(input.reviewScope.requiredChecks),
      obligationId: input.reviewScope.obligationId ? String(input.reviewScope.obligationId) : null,
    },
    permissions: { filesystem: 'read_only', network: 'inherited', canDelegate: false, canCommit: false },
    provenance: {
      workspaceIdentity: String(input.subject.workspaceIdentity),
      sourceIdentity: input.provenance?.sourceIdentity ? String(input.provenance.sourceIdentity) : null,
      routeDecisionId: input.provenance?.routeDecisionId ? String(input.provenance.routeDecisionId) : null,
      createdByVersion: String(input.provenance?.createdByVersion || 'kernel.review-capsule.v1'),
      migrationOrigin: input.provenance?.migrationOrigin ? String(input.provenance.migrationOrigin) : null,
    },
  };

  const digest = digestOfBody(body);
  return Object.freeze({
    ...body,
    capsuleId: buildCapsuleId(digest),
    provenance: Object.freeze({ ...body.provenance, capsuleDigest: digest }),
    createdAt: input.createdAt ? String(input.createdAt) : new Date().toISOString(),
  });
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
} = {}) => {
  if (!run) fail('kernel_review_capsule_invalid', 'buildReviewCapsule requires the run');
  return normalizeReviewCapsule({
    runId: run.runId,
    stepId: step?.stepId || null,
    riskTier: run.proofTier,
    planRevision: Number(step?.planRevision || run.contractRevision || 1),
    objective: run.objective,
    acceptance: (contract?.acceptance || []).map((item) => ({ id: item.id, statement: item.statement })),
    subject: {
      changedPaths,
      diffDigest,
      workspaceIdentity: run.currentWorkspaceIdentity,
      mutationRevision: run.mutationRevision,
    },
    verificationEvidence: verifications.map((verification) => ({
      obligationId: verification.obligationId,
      status: verification.status,
      evidenceDigest: verification.evidenceDigest,
      command: verification.command,
      exitCode: verification.exitCode,
    })),
    implementationReceipt: {
      actorSessionId: implementationSession?.actorSessionId || null,
      attemptId: implementationSession?.attemptId || null,
      capsuleDigest: implementationSession?.capsuleDigest || null,
      modelClass: implementationSession?.modelClass || null,
      resolvedModel: implementationSession?.resolvedModel || null,
    },
    reviewScope: { stage, requiredChecks, obligationId },
    provenance: { sourceIdentity: run.sourceIdentity, routeDecisionId: decision?.decisionId || null },
    createdAt,
  });
};

// A capsule describes a workspace state. Once that state moves, the capsule is
// no longer a description of anything the worker can act on.
export const capsuleStaleness = ({ capsule, run } = {}) => {
  const reasons = [];
  if (!capsule) return { stale: true, reasons: ['capsule-missing'] };
  if (!run) return { stale: true, reasons: ['run-missing'] };
  if (capsule.runId !== run.runId) reasons.push('capsule-run-mismatch');
  const capsuleMutationRevision = capsule.role === 'reviewer'
    ? capsule.subject?.mutationRevision
    : capsule.mutationRevision;
  if (capsuleMutationRevision !== run.mutationRevision) reasons.push('capsule-stale-mutation-revision');
  if (run.currentWorkspaceIdentity && capsule.provenance.workspaceIdentity !== run.currentWorkspaceIdentity) {
    reasons.push('capsule-stale-workspace-identity');
  }
  // A step capsule belongs to a PLAN revision, a run-level one to the contract
  // revision. Exempting step capsules from the check let a replan — which bumps
  // the plan revision without touching the workspace — leave a superseded
  // capsule looking current, so its allowed paths would be enforced instead of
  // the replacement step's.
  const expectedRevision = capsule.stepId ? Number(run.planRevision || 1) : Number(run.contractRevision || 1);
  if (capsule.planRevision !== expectedRevision) reasons.push('capsule-stale-plan-revision');
  return { stale: reasons.length > 0, reasons };
};

export { CAPSULE_BUDGET, findScopeViolations, canonicalJson };
