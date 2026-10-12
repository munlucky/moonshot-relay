// Generated from schemas/kernel.qa-report.schema.json. Edit the schema and run build:contracts.

export interface KernelQaReport {
  schemaVersion: 1;
  tier: 'E1' | 'E2';
  proofTier: 'T1' | 'T2' | 'T3';
  checks: unknown[];
  [k: string]: unknown | undefined;
}
