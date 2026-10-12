// Generated from schemas/kernel.codebase-index-manifest.schema.json. Edit the schema and run build:contracts.

export interface KernelCodebaseIndexManifest {
  schemaVersion: 1;
  projectId: string;
  sourceCommit: string;
  sourceTreeDigest: string;
  graphDigest: string;
  skillVersion: string;
  generatedAt: string;
  status: 'fresh' | 'stale' | 'degraded' | 'cache_hit';
}
