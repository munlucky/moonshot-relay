import path from 'node:path';
import crypto from 'node:crypto';
import { loadAllProjectRecords, readProjectRevision, projectKnowledgeDirectory, writeAtomicJsonl, writeAtomicJson } from './store.mjs';
import { advanceProjectRevision } from './revision.mjs';
import { applySupersessions } from './supersession.mjs';
import { buildKnowledgeCommitReceipt } from './receipt.mjs';
import { validateKnowledgeRecord, resolveRecordType } from './records.mjs';

export class KernelKnowledgeCommitError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'KernelKnowledgeCommitError';
    this.code = code;
    this.details = details;
  }
}

export async function rebuildKnowledgeProjection(projectId, { env = process.env, stateStore = null, revisionAfter = null } = {}) {
  if (!stateStore || typeof stateStore.listKnowledgeRecords !== 'function') {
    return { status: 'failed', reason: 'state_store_required' };
  }

  try {
    const root = projectKnowledgeDirectory(projectId, { env });
    const kDir = path.join(root, 'knowledge');

    const allRecords = stateStore.listKnowledgeRecords({ projectId, statuses: ['committed'] });

    const semanticFacts = allRecords.filter((r) => r.type === 'semantic_fact' || r.type === 'policy_anchor');
    const architectureRecords = allRecords.filter((r) =>
      ['architecture_decision', 'component_boundary', 'api_contract', 'domain_term', 'known_failure_pattern', 'required_verification'].includes(r.type)
    );
    const graphRelations = allRecords.filter((r) => r.type === 'kg_relation');
    const ontologyConstraints = allRecords.filter((r) => r.type === 'ontology_constraint');
    const episodicObservations = allRecords.filter((r) => r.type === 'episodic_observation' || r.type === 'tacit_practice');

    await writeAtomicJsonl(path.join(kDir, 'semantic', 'verified-facts.jsonl'), semanticFacts);
    await writeAtomicJsonl(path.join(kDir, 'architecture', 'records.jsonl'), architectureRecords);
    await writeAtomicJsonl(path.join(kDir, 'graph', 'kg-relations.jsonl'), graphRelations);
    await writeAtomicJsonl(path.join(kDir, 'ontology', 'constraints.jsonl'), ontologyConstraints);
    await writeAtomicJsonl(path.join(kDir, 'episodic', 'observations.jsonl'), episodicObservations);

    const rev = revisionAfter !== null && revisionAfter !== undefined ? String(revisionAfter) : String(stateStore.getProjectKnowledgeRevision(projectId));
    await writeAtomicJson(path.join(kDir, 'revision.json'), {
      schemaVersion: 1,
      projectId,
      revision: rev,
      updatedAt: new Date().toISOString(),
    });
    return { status: 'completed' };
  } catch (err) {
    return { status: 'failed', error: err.message };
  }
}

export async function commitProjectKnowledge({
  runId,
  projectId,
  stateStore = null,
  expectedKnowledgeRevision = null,
  completionDecisionRef = null,
  candidates = null,
  supersessionProposals = [],
  sourceIdentity = 'kernel-source',
  faultInjection = null,
  env = process.env,
} = {}) {
  if (!stateStore || typeof stateStore.getRun !== 'function') {
    throw new KernelKnowledgeCommitError(
      'COMPLETION_AUTHORITY_REQUIRED',
      'Kernel stateStore is required for completion authority'
    );
  }

  const run = stateStore.getRun(runId);
  const completion = stateStore.getCompletionDecision ? stateStore.getCompletionDecision(runId) : null;

  if (!run) {
    throw new KernelKnowledgeCommitError('RUN_NOT_FOUND', `Run ${runId} not found`);
  }
  if (!completion) {
    throw new KernelKnowledgeCommitError('COMPLETION_DECISION_REQUIRED', `Run ${runId} has no authoritative completion decision`);
  }
  if (completion.decision !== 'accepted') {
    throw new KernelKnowledgeCommitError('COMPLETION_NOT_ACCEPTED', `Run ${runId} completion decision is ${completion.decision}`);
  }
  if (run.projectId !== projectId) {
    throw new KernelKnowledgeCommitError('PROJECT_ID_MISMATCH', `Run project mismatch: expected ${projectId} but found ${run.projectId}`);
  }
  if (completion.sourceIdentity !== run.sourceIdentity) {
    throw new KernelKnowledgeCommitError('SOURCE_IDENTITY_MISMATCH', `Completion decision source identity mismatch for run ${runId}`);
  }
  if (completion.mutationRevision !== run.mutationRevision) {
    throw new KernelKnowledgeCommitError('STALE_COMPLETION_DECISION', `Completion decision mutation revision mismatch for run ${runId}`);
  }

  // Format candidates if passed explicitly (e.g. from tests)
  let recordsToCommit = null;
  let acceptedCandidates = [];
  let rejectedCandidates = [];

  if (Array.isArray(candidates)) {
    acceptedCandidates = candidates.filter((c) => c.status === 'verified' || c.status === 'committed');
    rejectedCandidates = candidates.filter((c) => c.status === 'rejected');
    recordsToCommit = acceptedCandidates.map((cand) => {
      const recType = resolveRecordType(cand.proposedType || cand.type);
      const rec = {
        id: cand.candidateId || cand.id || `rec-${crypto.randomUUID()}`,
        candidateId: cand.candidateId || cand.id,
        projectId,
        type: recType,
        statement: cand.statement,
        scope: cand.scope || [],
        status: 'committed',
        trustTier: 'verified',
        createdAt: new Date().toISOString(),
        evidence: { refs: cand.evidenceRefs || [] },
      };
      validateKnowledgeRecord(rec);
      return rec;
    });
  } else {
    const dbCandidates = stateStore.getKnowledgeCandidates(runId);
    acceptedCandidates = dbCandidates.filter((c) => c.status === 'verified').map((c) => c.candidateJson);
    rejectedCandidates = dbCandidates.filter((c) => c.status === 'rejected').map((c) => c.candidateJson);
  }

  const transactionId = `tx-${crypto.randomUUID()}`;
  const supersessions = supersessionProposals.map((p) => p.targetId || p);

  let txResult;
  try {
    txResult = stateStore.commitKnowledgeTransaction({
      transactionId,
      runId,
      projectId,
      expectedRevision: expectedKnowledgeRevision,
      records: recordsToCommit,
      supersessions,
      provenance: { runId, sourceIdentity, committedCount: acceptedCandidates.length },
      faultInjection,
      noChange: acceptedCandidates.length === 0 && supersessions.length === 0,
    });
  } catch (err) {
    throw new KernelKnowledgeCommitError(
      err.message.includes('STALE_KNOWLEDGE_REVISION') ? 'STALE_KNOWLEDGE_REVISION' : 'TRANSACTION_FAILED',
      err.message,
      { originalError: err }
    );
  }

  const { revisionBefore, revisionAfter, status: txStatus } = txResult;

  let projectionStatus = 'completed';
  const projRes = await rebuildKnowledgeProjection(projectId, { env, stateStore, revisionAfter });
  if (projRes.status === 'failed') {
    projectionStatus = 'failed';
  }

  const receipt = buildKnowledgeCommitReceipt({
    runId,
    projectId,
    sourceIdentity: completion.sourceIdentity || sourceIdentity,
    mutationRevision: completion.mutationRevision || 1,
    completionDecisionRef: completion.evidenceDigest || completionDecisionRef || `accepted-${runId}`,
    revisionBefore,
    revisionAfter,
    acceptedCandidates,
    rejectedCandidates,
    supersededRecords: supersessions,
    evidenceRefs: acceptedCandidates.flatMap((c) => c.evidenceRefs || []),
    projectionStatus,
    status: txStatus || 'committed',
  });

  try {
    const root = projectKnowledgeDirectory(projectId, { env });
    const receiptPath = path.join(root, 'receipts', `${runId}-knowledge-closeout.json`);
    await writeAtomicJson(receiptPath, receipt);
  } catch (e) {
    // Non-fatal receipt save error
  }

  return receipt;
}
