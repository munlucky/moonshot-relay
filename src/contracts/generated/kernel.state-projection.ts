// Generated from schemas/kernel.state-projection.schema.json. Edit the schema and run build:contracts.

export interface KernelStateProjection {
  schemaVersion: 1;
  runId: string;
  runtimeRevision: number;
  status: string;
  currentState: string;
  sourceDigest: {
    [k: string]: unknown | undefined;
  };
}
