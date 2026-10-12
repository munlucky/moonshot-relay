// Generated from schemas/kernel.runtime-state.schema.json. Edit the schema and run build:contracts.

export interface KernelRuntimeState {
  schemaVersion: 1;
  runId: string;
  objective: string;
  currentState: string;
  state: string;
  revision: number;
  mutationRevision: number;
  sourceIdentity: string;
  proofTier: 'T0' | 'T1' | 'T2' | 'T3';
  evidenceTier: 'E0' | 'E1' | 'E2';
  requiredObligations: string[];
  acceptanceCriteria: string[];
  status: 'active' | 'blocked' | 'completed';
  updatedAt: string;
}
