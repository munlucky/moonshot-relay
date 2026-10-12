// Generated from schemas/kernel.knowledge-candidate.schema.json. Edit the schema and run build:contracts.

export interface KernelKnowledgeCandidate {
  candidateId: string;
  runId: string;
  projectId: string;
  proposedType: 'policy_anchor' | 'semantic_fact' | 'kg_relation' | 'ontology_constraint' | 'episodic_observation';
  statement: string;
  scope?: unknown[];
  relatedFiles?: unknown[];
  sourceRefs?: unknown[];
  evidenceRefs?: unknown[];
  confidence?: number;
  status: 'observed' | 'staged' | 'verified' | 'rejected' | 'committed' | 'superseded' | 'archived';
  supersedes?: unknown[];
  rejectionReasons?: unknown[];
  [k: string]: unknown | undefined;
}
