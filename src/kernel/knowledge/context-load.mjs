import path from 'node:path';
import { resolveRunArtifactPaths } from '../artifact-paths.mjs';
import { resolveKernelRuntimeHome } from '../runtime-home.mjs';
import { loadAllProjectRecords, readProjectRevision, projectKnowledgeDirectory, writeAtomicJson } from './store.mjs';
import { renderPromptBlock, computeContextDigest, deepRedact } from './context-render.mjs';
import { matchPathScope, scoreRelevance } from './path-scope.mjs';
import { cheapReVerify } from './freshness.mjs';

export const VALID_STAGES = [
  'FRAME',
  'EXECUTE',
  'PROVE',
  'CLOSE',
];

export const STAGE_BUDGETS = {
  FRAME: 1200,
  EXECUTE: 2000,
  PROVE: 1500,
  CLOSE: 1000,
};

export const STAGE_TYPE_POLICY = {
  FRAME: ['policy_anchor', 'semantic_fact', 'architecture_decision', 'domain_term', 'ontology_constraint', 'tacit_practice', 'episodic_observation'],
  EXECUTE: ['policy_anchor', 'semantic_fact', 'component_boundary', 'api_contract', 'tacit_practice', 'episodic_observation', 'required_verification'],
  PROVE: ['policy_anchor', 'semantic_fact', 'ontology_constraint', 'required_verification', 'known_failure_pattern'],
  CLOSE: ['policy_anchor', 'semantic_fact', 'ontology_constraint', 'required_verification'],
};

export class KernelContextLoadError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'KernelContextLoadError';
    this.code = code;
    this.details = details;
  }
}

export async function buildProjectKnowledgeContext({
  projectId,
  stateStore = null,
  stage = 'FRAME',
  strictness = 'advisory',
  runId = 'standalone-run',
  objective = '',
  changedPaths = [],
  projectRoot = null,
  env = process.env,
} = {}) {
  if (!VALID_STAGES.includes(stage)) {
    throw new KernelContextLoadError('INVALID_STAGE', `Invalid stage: ${stage}`);
  }

  let knowledgeRevision = '1';
  let rawPolicyAnchors = [];
  let rawSemanticFacts = [];
  let rawGraphRelations = [];
  let rawOntologyConstraints = [];
  let contextLoadError = null;

  try {
    if (stateStore && typeof stateStore.listKnowledgeRecords === 'function') {
      knowledgeRevision = String(stateStore.getProjectKnowledgeRevision ? stateStore.getProjectKnowledgeRevision(projectId) : 1);
      const allRecords = stateStore.listKnowledgeRecords({ projectId, statuses: ['committed', 'verified'] });
      rawPolicyAnchors = allRecords.filter((r) => r.type === 'policy_anchor');
      rawSemanticFacts = allRecords.filter((r) => r.type !== 'policy_anchor' && r.type !== 'kg_relation' && r.type !== 'ontology_constraint');
      rawGraphRelations = allRecords.filter((r) => r.type === 'kg_relation');
      rawOntologyConstraints = allRecords.filter((r) => r.type === 'ontology_constraint');
    } else {
      knowledgeRevision = await readProjectRevision(projectId, { env });
      const records = await loadAllProjectRecords(projectId, { env });
      rawPolicyAnchors = records.policyAnchors || [];
      rawSemanticFacts = [
        ...(records.semanticFacts || []),
        ...(records.architectureRecords || []),
        ...(records.architectureDecisions || []),
        ...(records.observations || []),
      ];
      rawGraphRelations = records.kgRelations || [];
      rawOntologyConstraints = records.ontologyConstraints || [];
    }
  } catch (error) {
    // Context availability is a first-class receipt state. Do not present a
    // failed store read as an empty but ready knowledge pack.
    contextLoadError = error;
  }

  const staleOrUnavailable = [];
  const omittedByPolicy = [];

  // Filter 1: Exclude stale or superseded records
  const isRecordActive = (rec) => {
    if (!rec || typeof rec !== 'object') return false;
    if (['superseded', 'rejected', 'archived'].includes(rec.status)) {
      staleOrUnavailable.push({ id: rec.id || 'unknown', reason: `status_${rec.status}` });
      return false;
    }
    if (rec.trustTier === 'quarantined' && stage !== 'FRAME') {
      omittedByPolicy.push({ id: rec.id || 'unknown', reason: 'quarantined_trust_tier' });
      return false;
    }
    // Filter 1.5: freshness (§21.3). When the project filesystem is available,
    // a cheap re-verify decides keep-vs-stale. A record whose referenced source
    // vanished ('stale') or drifted ('needs_deep_verify') is omitted from the
    // served context rather than rendered as still-verified knowledge.
    if (projectRoot && Array.isArray(rec.sourceRefs) && rec.sourceRefs.length > 0) {
      const freshness = cheapReVerify(rec, { projectRoot });
      if (freshness.status === 'stale' || freshness.status === 'needs_deep_verify') {
        staleOrUnavailable.push({ id: rec.id || 'unknown', reason: `freshness_${freshness.status}` });
        return false;
      }
    }
    return true;
  };

  let selectedPolicy = rawPolicyAnchors.filter(isRecordActive);
  let selectedFacts = rawSemanticFacts.filter(isRecordActive);
  let selectedConstraints = rawOntologyConstraints.filter(isRecordActive);

  // Filter 2: STAGE_TYPE_POLICY filtering
  const allowedTypes = STAGE_TYPE_POLICY[stage] || [];
  if (allowedTypes.length > 0) {
    selectedFacts = selectedFacts.filter((f) => {
      const type = f.type || f.recordType || 'semantic_fact';
      if (allowedTypes.includes(type)) return true;
      omittedByPolicy.push({ id: f.id || 'unknown', reason: `type_${type}_not_in_${stage}` });
      return false;
    });
  }

  // Filter 3: Relevance scoring & ranking (score > 0 || isGlobal === true)
  selectedFacts = selectedFacts
    .map((fact) => {
      const score = scoreRelevance({ item: fact, objective, paths: changedPaths });
      return { fact, score };
    })
    .filter(({ fact, score }) => score > 0 || fact.isGlobal === true || (!fact.scope || fact.scope.length === 0))
    .sort((a, b) => b.score - a.score)
    .map(({ fact }) => fact);

  selectedConstraints = selectedConstraints.filter((constraint) => {
    if (!constraint.scope || constraint.scope.length === 0) return true;
    if (changedPaths.length === 0) return true;
    return changedPaths.some((p) => matchPathScope(p, constraint.scope));
  });

  const selectedGraph = rawGraphRelations
    .filter(isRecordActive)
    .map((rel) => ({
      from: rel.from,
      to: rel.to,
      relation: rel.relation,
      statement: `${rel.from} ${rel.relation} ${rel.to}`,
    }));

  // Record-based budget truncation
  const maxBudgetTokens = STAGE_BUDGETS[stage] || 1500;
  const maxChars = maxBudgetTokens * 4;

  const budgetedFacts = [];
  let currentLength = 0;
  for (const fact of selectedFacts) {
    const factLen = (fact.statement || JSON.stringify(fact)).length + 10;
    if (currentLength + factLen > maxChars) {
      omittedByPolicy.push({ id: fact.id || 'unknown', reason: 'record_budget_exceeded' });
    } else {
      budgetedFacts.push(fact);
      currentLength += factLen;
    }
  }

  const promptBlock = renderPromptBlock({
    stage,
    policyAnchors: selectedPolicy,
    semanticFacts: budgetedFacts,
    graphSynopsis: selectedGraph,
    ontologyConstraints: selectedConstraints,
  });

  const artifactPaths = resolveRunArtifactPaths({ runtimeHome: resolveKernelRuntimeHome({ env }), projectId, runId });
  const contextPackRef = path.join('runs', runId, 'projections', 'context', `${stage}.json`);
  const selectedCounts = {
    policy: selectedPolicy.length,
    facts: budgetedFacts.length,
    constraints: selectedConstraints.length,
    graph: selectedGraph.length,
  };
  const usableRecordCount = Object.values(selectedCounts).reduce((sum, count) => sum + count, 0);
  const omittedCounts = {
    stale: staleOrUnavailable.filter((entry) => String(entry.reason || '').startsWith('freshness_')).length,
    unavailable: staleOrUnavailable.filter((entry) => String(entry.reason || '').includes('unavailable') || String(entry.reason || '').includes('load_failed')).length,
    policy: omittedByPolicy.length,
    total: staleOrUnavailable.length + omittedByPolicy.length,
  };
  const status = contextLoadError
    ? 'unavailable'
    : usableRecordCount > 0
      ? 'ready-populated'
      : staleOrUnavailable.length > 0
        ? 'stale'
        : 'ready-empty';
  if (contextLoadError) {
    staleOrUnavailable.push({
      id: 'context-store',
      reason: 'load_failed',
      errorCode: contextLoadError.code || contextLoadError.name || 'context_load_failed',
    });
    omittedCounts.unavailable += 1;
    omittedCounts.total += 1;
  }

  const rawPayload = {
    schemaVersion: 1,
    projectId,
    knowledgeRevision,
    status,
    degradedContext: status !== 'ready-populated',
    quality: {
      status,
      usableRecordCount,
      selectedCounts,
      omittedCounts,
      reason: contextLoadError
        ? 'context-store-read-failed'
        : status === 'ready-empty'
          ? 'no-usable-records'
          : status === 'stale'
            ? 'all-candidates-stale-or-unavailable'
            : null,
    },
    strictness,
    stage,
    policyAnchors: selectedPolicy,
    semanticFacts: budgetedFacts,
    graphSynopsis: selectedGraph,
    ontologyConstraints: selectedConstraints,
    staleOrUnavailable,
    omittedByPolicy,
    promptBlock,
    contextPackRef,
  };

  const contextPayload = deepRedact(rawPayload);
  const digest = computeContextDigest(contextPayload);
  contextPayload.digest = digest;

  // Persist context pack
  const packPath = path.join(artifactPaths.projections, 'context', `${stage}.json`);
  await writeAtomicJson(packPath, contextPayload);

  return contextPayload;
}
