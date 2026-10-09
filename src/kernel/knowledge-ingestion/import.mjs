import path from 'node:path';
import { commitImportedKnowledgeTransaction } from './transaction.mjs';
import { rebuildKnowledgeProjection } from '../knowledge/commit.mjs';
import { writeJsonAtomic } from '../standalone/common.mjs';

export async function commitImportedProjectKnowledge(options = {}) {
  const result = await commitImportedKnowledgeTransaction(options);
  if (result.status !== 'no_op' && options.stateStore && options.projectId) {
    await rebuildKnowledgeProjection(options.projectId, { env: options.env || process.env, stateStore: options.stateStore, revisionAfter: result.receipt?.knowledgeRevisionAfter ?? null });
  }
  if (result.receipt && options.receiptsRoot) {
    await writeJsonAtomic(path.join(options.receiptsRoot, 'imports', `${result.receipt.importId}.json`), result.receipt);
  }
  return result;
}
