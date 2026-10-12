// Generated from schemas/kernel.knowledge-record.schema.json. Edit the schema and run build:contracts.

export interface KernelKnowledgeRecord {
  id: string;
  projectId: string;
  type:
    | 'policy_anchor'
    | 'semantic_fact'
    | 'architecture_decision'
    | 'domain_term'
    | 'component_boundary'
    | 'api_contract'
    | 'kg_relation'
    | 'ontology_constraint'
    | 'episodic_observation'
    | 'known_failure_pattern'
    | 'required_verification'
    | 'provenance_event'
    | 'knowledge_candidate';
  statement: string;
  status: 'observed' | 'staged' | 'verified' | 'rejected' | 'committed' | 'superseded' | 'archived' | 'quarantined';
  trustTier: 'authoritative' | 'verified' | 'derived' | 'quarantined' | 'degraded';
  createdAt: string;
  updatedAt?: string;
  sourceRef?: string;
  evidence?: unknown;
  provenance?: {
    [k: string]: unknown | undefined;
  }[];
  supersedes?: string[];
  [k: string]: unknown | undefined;
}
