// Generated from schemas/kernel.release-evidence.schema.json. Edit the schema and run build:contracts.

export interface KernelReleaseEvidence {
  schemaVersion: 1;
  tier: 'E2';
  acceptanceCoverage: unknown[];
  completionDecision: 'accepted' | 'blocked';
  [k: string]: unknown | undefined;
}
