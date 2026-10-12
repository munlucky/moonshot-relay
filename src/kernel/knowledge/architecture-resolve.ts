import { scoreRelevance } from './path-scope.js';

interface KnowledgeFactLike {
  type?: string | null;
  recordType?: string | null;
  status?: string | null;
  sourceRef?: string | null;
  statement?: string | null;
  [key: string]: unknown;
}

interface KnowledgeRecordReader {
  listKnowledgeRecords(input?: {
    projectId?: string | null;
    statuses?: string[];
  }): KnowledgeFactLike[];
}

export interface ResolveArchitectureKnowledgeInput {
  projectId: string;
  objective?: string;
  paths?: string[];
  stateStore?: KnowledgeRecordReader | null;
  records?: KnowledgeFactLike[] | null;
}

export async function resolveArchitectureKnowledge({
  projectId,
  objective = '',
  paths = [],
  stateStore = null,
  records = null,
}: ResolveArchitectureKnowledgeInput) {
  const sourceRecords = stateStore
    ? stateStore.listKnowledgeRecords({
        projectId,
        statuses: ['verified', 'committed', 'superseded', 'rejected'],
      })
    : Array.isArray(records)
      ? records
      : null;
  if (!sourceRecords) {
    throw Object.assign(
      new Error('SQLite Knowledge authority or explicit records are required'),
      { code: 'KNOWLEDGE_AUTHORITY_REQUIRED' },
    );
  }

  const activeFacts = sourceRecords
    .filter((fact) => ['semantic_fact', 'policy_anchor'].includes(String(fact.type || fact.recordType || 'semantic_fact')))
    .filter((fact) => fact.status !== 'superseded' && fact.status !== 'rejected');

  const byRelevance = (left: KnowledgeFactLike, right: KnowledgeFactLike) => (
    scoreRelevance({ item: right, objective, paths }) - scoreRelevance({ item: left, objective, paths })
  );

  const architectureDecisions = activeFacts
    .filter((fact) => fact.sourceRef?.includes('ADR') || fact.statement?.toLowerCase().includes('adr'))
    .sort(byRelevance);

  const domainTerms = activeFacts
    .filter((fact) => fact.statement?.toLowerCase().includes('term') || fact.statement?.toLowerCase().includes('domain'))
    .sort(byRelevance);

  const componentBoundaries = activeFacts
    .filter((fact) => fact.statement?.toLowerCase().includes('component') || fact.statement?.toLowerCase().includes('boundary'))
    .sort(byRelevance);

  return {
    architectureDecisions,
    domainTerms,
    componentBoundaries,
    provenance: activeFacts
      .map((fact) => fact.sourceRef)
      .filter((ref): ref is string => Boolean(ref)),
  };
}
