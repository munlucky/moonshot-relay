import { loadAllProjectRecords } from './store.mjs';
import { scoreRelevance } from './path-scope.mjs';

export async function resolveArchitectureKnowledge({ projectId, objective = '', paths = [], env = process.env } = {}) {
  const records = await loadAllProjectRecords(projectId, { env });

  const activeFacts = (records.semanticFacts || []).filter((fact) => fact.status !== 'superseded' && fact.status !== 'rejected');
  
  const architectureDecisions = activeFacts
    .filter((fact) => fact.sourceRef?.includes('ADR') || fact.statement?.toLowerCase().includes('adr'))
    .sort((a, b) => scoreRelevance({ item: b, objective, paths }) - scoreRelevance({ item: a, objective, paths }));

  const domainTerms = activeFacts
    .filter((fact) => fact.statement?.toLowerCase().includes('term') || fact.statement?.toLowerCase().includes('domain'))
    .sort((a, b) => scoreRelevance({ item: b, objective, paths }) - scoreRelevance({ item: a, objective, paths }));

  const componentBoundaries = activeFacts
    .filter((fact) => fact.statement?.toLowerCase().includes('component') || fact.statement?.toLowerCase().includes('boundary'))
    .sort((a, b) => scoreRelevance({ item: b, objective, paths }) - scoreRelevance({ item: a, objective, paths }));

  return {
    architectureDecisions,
    domainTerms,
    componentBoundaries,
    provenance: activeFacts.map((f) => f.sourceRef).filter(Boolean),
  };
}
