import path from 'node:path';
import { resolveRunArtifactPaths } from '../artifact-paths.js';
import { resolveKernelRuntimeHome } from '../runtime-home.js';
import { writeAtomicJson } from './store.js';
import {
  renderPromptBlock,
  renderKnowledgePromptEntry,
  computeContextDigest,
  deepRedact,
  type KnowledgePromptEntry,
} from './context-render.js';
import { matchPathScope, scoreRelevance } from './path-scope.js';
import { cheapReVerify } from './freshness.js';

type UnknownRecord = Record<string, unknown>;
type Stage = 'FRAME' | 'EXECUTE' | 'PROVE' | 'CLOSE';

interface KnowledgeRecordLike extends UnknownRecord {
  id?: unknown;
  type?: string | null;
  recordType?: string | null;
  status?: string | null;
  trustTier?: string | null;
  sourceRefs?: string[];
  sourceDigest?: string | null;
  scope?: string[];
  isGlobal?: boolean;
  statement?: string | null;
  title?: string | null;
  severity?: string | null;
  from?: string | null;
  to?: string | null;
  relation?: string | null;
  evidence?: { refs?: unknown[] | null } | null;
  practiceJson?: unknown;
}

interface KnowledgeStateStore {
  listKnowledgeRecords(input: {
    projectId?: (string) | undefined;
    statuses?: string[];
  }): KnowledgeRecordLike[];
  getProjectKnowledgeRevision(projectId?: string): unknown;
}

export interface BuildProjectKnowledgeContextInput {
  projectId?: string;
  stateStore?: KnowledgeStateStore | null;
  stage?: string;
  strictness?: string;
  runId?: string;
  objective?: string;
  changedPaths?: string[];
  projectRoot?: string | null;
  env?: NodeJS.ProcessEnv;
}

export interface ProjectKnowledgeContext extends UnknownRecord {
  schemaVersion: number;
  projectId: string;
  knowledgeRevision: unknown;
  status: string;
  degradedContext: boolean;
  quality: UnknownRecord;
  strictness: string;
  stage: string;
  policyAnchors: UnknownRecord[];
  semanticFacts: UnknownRecord[];
  graphSynopsis: UnknownRecord[];
  ontologyConstraints: UnknownRecord[];
  staleOrUnavailable: UnknownRecord[];
  omittedByPolicy: UnknownRecord[];
  promptBlock: string;
  contextPackRef: string;
  digest: string;
}

export const VALID_STAGES = [
  'FRAME',
  'EXECUTE',
  'PROVE',
  'CLOSE',
] as const;

export const STAGE_BUDGETS: Record<Stage, number> = {
  FRAME: 1200,
  EXECUTE: 2000,
  PROVE: 1500,
  CLOSE: 1000,
};

export const STAGE_TYPE_POLICY: Record<Stage, readonly string[]> = {
  FRAME: [
    'policy_anchor',
    'semantic_fact',
    'architecture_decision',
    'domain_term',
    'ontology_constraint',
    'tacit_practice',
    'episodic_observation',
  ],
  EXECUTE: [
    'policy_anchor',
    'semantic_fact',
    'component_boundary',
    'api_contract',
    'tacit_practice',
    'episodic_observation',
    'required_verification',
  ],
  PROVE: [
    'policy_anchor',
    'semantic_fact',
    'ontology_constraint',
    'required_verification',
    'known_failure_pattern',
  ],
  CLOSE: [
    'policy_anchor',
    'semantic_fact',
    'ontology_constraint',
    'required_verification',
  ],
};

const isRecord = (value: unknown): value is UnknownRecord => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);

const isValidStage = (value: string): value is Stage => (
  (VALID_STAGES as readonly string[]).includes(value)
);

const procedureParts = (record: KnowledgeRecordLike): {
  metadata: UnknownRecord;
  body: UnknownRecord;
} | null => {
  if (record.type !== 'episodic_observation' || !isRecord(record.practiceJson)) {
    return null;
  }
  if (record.practiceJson.kind !== 'procedure') return null;
  const metadata = isRecord(record.practiceJson.metadata)
    ? record.practiceJson.metadata
    : {};
  const body = isRecord(record.practiceJson.body)
    ? record.practiceJson.body
    : {};
  return { metadata, body };
};

const procedureSearchView = (
  record: KnowledgeRecordLike,
): KnowledgeRecordLike => {
  const procedure = procedureParts(record);
  if (!procedure) return record;
  return {
    ...record,
    practiceJson: {
      kind: 'procedure',
      metadata: procedure.metadata,
    },
  };
};

const procedureScopeMatches = (
  record: KnowledgeRecordLike,
  changedPaths: readonly string[],
): boolean => {
  if (!procedureParts(record)) return true;
  if (!record.scope || record.scope.length === 0 || changedPaths.length === 0) {
    return true;
  }
  return changedPaths.some((changedPath) => (
    matchPathScope(changedPath, record.scope || [])
  ));
};

const errorCodeOf = (error: unknown): string => {
  if (error instanceof Error && error.name) {
    const withCode = error as Error & { code?: unknown };
    return withCode.code ? String(withCode.code) : error.name;
  }
  if (isRecord(error)) {
    if (error.code) return String(error.code);
    if (error.name) return String(error.name);
  }
  return 'context_load_failed';
};

export class KernelContextLoadError extends Error {
  code: string;
  details: UnknownRecord;

  constructor(code: string, message: string, details: UnknownRecord = {}) {
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
}: BuildProjectKnowledgeContextInput = {}): Promise<ProjectKnowledgeContext> {
  if (!isValidStage(stage)) {
    throw new KernelContextLoadError('INVALID_STAGE', `Invalid stage: ${stage}`);
  }

  if (
    !stateStore
    || typeof stateStore.listKnowledgeRecords !== 'function'
    || typeof stateStore.getProjectKnowledgeRevision !== 'function'
  ) {
    throw new KernelContextLoadError(
      'KNOWLEDGE_AUTHORITY_REQUIRED',
      'SQLite-backed Knowledge authority is required to build project context',
    );
  }

  let knowledgeRevision = '1';
  let rawPolicyAnchors: KnowledgeRecordLike[] = [];
  let rawSemanticFacts: KnowledgeRecordLike[] = [];
  let rawGraphRelations: KnowledgeRecordLike[] = [];
  let rawOntologyConstraints: KnowledgeRecordLike[] = [];
  let contextLoadError: unknown = null;

  try {
    knowledgeRevision = String(stateStore.getProjectKnowledgeRevision(projectId));
    const allRecords = stateStore.listKnowledgeRecords({
      projectId,
      statuses: ['committed', 'verified'],
    });
    rawPolicyAnchors = allRecords.filter((record) => record.type === 'policy_anchor');
    rawSemanticFacts = allRecords.filter(
      (record) => (
        record.type !== 'policy_anchor'
        && record.type !== 'kg_relation'
        && record.type !== 'ontology_constraint'
      ),
    );
    rawGraphRelations = allRecords.filter((record) => record.type === 'kg_relation');
    rawOntologyConstraints = allRecords.filter(
      (record) => record.type === 'ontology_constraint',
    );
  } catch (error) {
    // Context availability is a first-class receipt state. Do not present a
    // failed store read as an empty but ready knowledge pack.
    contextLoadError = error;
  }

  const staleOrUnavailable: UnknownRecord[] = [];
  const omittedByPolicy: UnknownRecord[] = [];

  // Filter 1: Exclude stale or superseded records.
  const isRecordActive = (record: KnowledgeRecordLike): boolean => {
    if (['superseded', 'rejected', 'archived'].includes(String(record.status || ''))) {
      staleOrUnavailable.push({
        id: record.id || 'unknown',
        reason: `status_${record.status}`,
      });
      return false;
    }
    if (record.trustTier === 'quarantined' && stage !== 'FRAME') {
      omittedByPolicy.push({
        id: record.id || 'unknown',
        reason: 'quarantined_trust_tier',
      });
      return false;
    }

    const procedure = procedureParts(record);
    if (procedure?.metadata.validUntil) {
      const validUntil = Date.parse(String(procedure.metadata.validUntil));
      if (!Number.isFinite(validUntil)) {
        staleOrUnavailable.push({
          id: record.id || 'unknown',
          reason: 'procedure_valid_until_invalid',
        });
        return false;
      }
      if (validUntil <= Date.now()) {
        staleOrUnavailable.push({
          id: record.id || 'unknown',
          reason: 'procedure_expired',
        });
        return false;
      }
    }

    // Filter 1.5: freshness (§21.3). When the project filesystem is available,
    // a cheap re-verify decides keep-vs-stale. A record whose referenced source
    // vanished ('stale') or drifted ('needs_deep_verify') is omitted from the
    // served context rather than rendered as still-verified knowledge.
    if (projectRoot && Array.isArray(record.sourceRefs) && record.sourceRefs.length > 0) {
      const freshness = cheapReVerify(record, { projectRoot });
      if (
        freshness.status === 'stale'
        || freshness.status === 'needs_deep_verify'
      ) {
        staleOrUnavailable.push({
          id: record.id || 'unknown',
          reason: `freshness_${freshness.status}`,
        });
        return false;
      }
    }
    return true;
  };

  let selectedPolicy = rawPolicyAnchors.filter(isRecordActive);
  let selectedFacts = rawSemanticFacts.filter(isRecordActive);
  let selectedConstraints = rawOntologyConstraints.filter(isRecordActive);

  // Filter 2: STAGE_TYPE_POLICY filtering.
  const allowedTypes = STAGE_TYPE_POLICY[stage];
  if (allowedTypes.length > 0) {
    selectedFacts = selectedFacts.filter((fact) => {
      const type = fact.type || fact.recordType || 'semantic_fact';
      if (allowedTypes.includes(type)) return true;
      omittedByPolicy.push({
        id: fact.id || 'unknown',
        reason: `type_${type}_not_in_${stage}`,
      });
      return false;
    });
  }

  // Filter 3: Procedure scope, then metadata-only relevance scoring.
  selectedFacts = selectedFacts
    .filter((fact) => {
      if (procedureScopeMatches(fact, changedPaths)) return true;
      omittedByPolicy.push({
        id: fact.id || 'unknown',
        reason: 'procedure_scope_outside',
      });
      return false;
    })
    .map((fact) => ({
      fact,
      score: scoreRelevance({
        item: procedureSearchView(fact),
        objective,
        paths: changedPaths,
      }),
    }))
    .filter(({ fact, score }) => (
      score > 0
      || fact.isGlobal === true
      || !fact.scope
      || fact.scope.length === 0
    ))
    .sort((left, right) => right.score - left.score)
    .map(({ fact }) => fact);

  selectedConstraints = selectedConstraints.filter((constraint) => {
    if (!constraint.scope || constraint.scope.length === 0) return true;
    if (changedPaths.length === 0) return true;
    return changedPaths.some((changedPath) => (
      matchPathScope(changedPath, constraint.scope || [])
    ));
  });

  const selectedGraph: KnowledgePromptEntry[] = rawGraphRelations
    .filter(isRecordActive)
    .map((relation) => ({
      from: relation.from || null,
      to: relation.to || null,
      relation: relation.relation || null,
      statement: `${relation.from} ${relation.relation} ${relation.to}`,
    }));

  // Record-based budget truncation.
  const maxBudgetTokens = STAGE_BUDGETS[stage];
  const maxChars = maxBudgetTokens * 4;

  const budgetedFacts: KnowledgeRecordLike[] = [];
  let currentLength = 0;
  for (const fact of selectedFacts) {
    const factLength = renderKnowledgePromptEntry(fact).length + 10;
    if (currentLength + factLength > maxChars) {
      omittedByPolicy.push({
        id: fact.id || 'unknown',
        reason: 'record_budget_exceeded',
      });
    } else {
      budgetedFacts.push(fact);
      currentLength += factLength;
    }
  }

  const promptBlock = renderPromptBlock({
    stage,
    policyAnchors: selectedPolicy,
    semanticFacts: budgetedFacts,
    graphSynopsis: selectedGraph,
    ontologyConstraints: selectedConstraints,
  });

  const artifactPaths = resolveRunArtifactPaths({
    runtimeHome: resolveKernelRuntimeHome({ env }),
    projectId,
    runId,
  });
  const contextPackRef = path.join(
    'runs',
    runId,
    'projections',
    'context',
    `${stage}.json`,
  );
  const selectedCounts = {
    policy: selectedPolicy.length,
    facts: budgetedFacts.length,
    constraints: selectedConstraints.length,
    graph: selectedGraph.length,
  };
  const usableRecordCount = Object.values(selectedCounts)
    .reduce((sum, count) => sum + count, 0);
  const omittedCounts = {
    stale: staleOrUnavailable.filter((entry) => {
      const reason = String(entry.reason || '');
      return reason.startsWith('freshness_') || reason.startsWith('procedure_');
    }).length,
    unavailable: staleOrUnavailable.filter((entry) => (
      String(entry.reason || '').includes('unavailable')
      || String(entry.reason || '').includes('load_failed')
    )).length,
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
      errorCode: errorCodeOf(contextLoadError),
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

  const redacted = deepRedact(rawPayload);
  const isRecords = (value: unknown): value is UnknownRecord[] => Array.isArray(value) && value.every(isRecord);
  if (!isRecord(redacted) || typeof redacted.schemaVersion !== 'number' || typeof redacted.projectId !== 'string'
    || typeof redacted.status !== 'string' || typeof redacted.degradedContext !== 'boolean' || !isRecord(redacted.quality)
    || typeof redacted.strictness !== 'string' || typeof redacted.stage !== 'string'
    || !isRecords(redacted.policyAnchors) || !isRecords(redacted.semanticFacts) || !isRecords(redacted.graphSynopsis)
    || !isRecords(redacted.ontologyConstraints) || !isRecords(redacted.staleOrUnavailable) || !isRecords(redacted.omittedByPolicy)
    || typeof redacted.promptBlock !== 'string' || typeof redacted.contextPackRef !== 'string') {
    throw new KernelContextLoadError(
      'CONTEXT_REDACTION_INVALID',
      'Redacted project knowledge context must remain an object',
    );
  }
  const contextPayload: ProjectKnowledgeContext = {
    ...redacted, schemaVersion: redacted.schemaVersion, projectId: redacted.projectId,
    knowledgeRevision: redacted.knowledgeRevision, status: redacted.status, degradedContext: redacted.degradedContext,
    quality: redacted.quality, strictness: redacted.strictness, stage: redacted.stage,
    policyAnchors: redacted.policyAnchors, semanticFacts: redacted.semanticFacts, graphSynopsis: redacted.graphSynopsis,
    ontologyConstraints: redacted.ontologyConstraints, staleOrUnavailable: redacted.staleOrUnavailable,
    omittedByPolicy: redacted.omittedByPolicy, promptBlock: redacted.promptBlock, contextPackRef: redacted.contextPackRef,
    digest: computeContextDigest(redacted),
  };

  // Persist context pack.
  const packPath = path.join(
    artifactPaths.projections,
    'context',
    `${stage}.json`,
  );
  await writeAtomicJson(packPath, contextPayload);

  return contextPayload;
}
