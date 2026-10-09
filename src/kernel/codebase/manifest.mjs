import { createHash } from 'node:crypto';

export const CODEBASE_INDEX_VERSION = '1.0.0';

export const digestIndex = (index) => `sha256:${createHash('sha256').update(JSON.stringify(index)).digest('hex')}`;

export function buildCodebaseManifest({ projectId, sourceCommit = '', sourceTreeDigest = '', graphDigest = '', skillVersion = CODEBASE_INDEX_VERSION, status = 'fresh', generatedAt = new Date().toISOString() } = {}) {
  return { schemaVersion: 1, projectId, sourceCommit, sourceTreeDigest, graphDigest, skillVersion, generatedAt, status };
}
