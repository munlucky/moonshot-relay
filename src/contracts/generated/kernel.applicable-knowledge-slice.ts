// Generated from schemas/kernel.applicable-knowledge-slice.schema.json. Edit the schema and run build:contracts.

export interface KernelApplicableKnowledgeSlice {
  architectureDecisions: unknown[];
  architectureRequirements: unknown[];
  domainTerms: unknown[];
  componentBoundaries: unknown[];
  apiDataContracts?: unknown[];
  graphRelations?: unknown[];
  ontologyConstraints: unknown[];
  tacitPractices: unknown[];
  knownFailurePatterns?: unknown[];
  requiredVerifications?: unknown[];
  unresolvedConflicts?: unknown[];
  provenance: unknown[];
  [k: string]: unknown | undefined;
}
