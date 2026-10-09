import path from 'node:path';
import { readProjectRevision, projectKnowledgeDirectory, writeAtomicJson } from './store.mjs';

export async function advanceProjectRevision(projectId, { env = process.env } = {}) {
  const current = await readProjectRevision(projectId, { env });
  const nextNum = Number.parseInt(current, 10) + 1;
  const nextRevision = String(isNaN(nextNum) ? 1 : nextNum);

  const root = projectKnowledgeDirectory(projectId, { env });
  const revisionPath = path.join(root, 'knowledge', 'revision.json');

  const payload = {
    schemaVersion: 1,
    projectId,
    revision: nextRevision,
    updatedAt: new Date().toISOString(),
  };

  await writeAtomicJson(revisionPath, payload);
  return { revisionBefore: current, revisionAfter: nextRevision };
}
