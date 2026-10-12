// Generated from schemas/kernel.knowledge-contract.schema.json. Edit the schema and run build:contracts.

export interface KernelKnowledgeContract {
  schemaVersion: 1;
  projectId: string;
  knowledgeRevision: string;
  status: 'ready' | 'stale' | 'degraded_read' | 'degraded_write' | 'not_configured';
  strictness: 'advisory' | 'required';
  stage: 'FRAME' | 'SHAPE' | 'SLICE' | 'SCHEDULE' | 'EXECUTE' | 'PROVE' | 'CLOSE';
  policyAnchors?: unknown[];
  semanticFacts?: unknown[];
  graphSynopsis?: unknown[];
  ontologyConstraints?: unknown[];
  staleOrUnavailable?: unknown[];
  omittedByPolicy?: unknown[];
  promptBlock?: string;
  contextPackRef?: string;
  digest?: string;
  [k: string]: unknown | undefined;
}
