// Generated from schemas/kernel.workflow-state.schema.json. Edit the schema and run build:contracts.

export interface KernelWorkflowState {
  schemaVersion: 1;
  runId: string;
  state: 'FRAME' | 'EXECUTE' | 'PROVE' | 'CLOSE';
  history: string[];
}
