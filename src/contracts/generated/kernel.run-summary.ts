// Generated from schemas/kernel.run-summary.schema.json. Edit the schema and run build:contracts.

export interface KernelRunSummary {
  schemaVersion: 1;
  tier: 'E0';
  objective: string;
  status: string;
  evidenceRefs: unknown[];
  [k: string]: unknown | undefined;
}
