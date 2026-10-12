import path from 'node:path';
import {
  commitImportedKnowledgeTransaction,
  type CommitImportedKnowledgeTransactionInput,
  type ImportedKnowledgeTransactionResult,
} from './transaction.js';
import { rebuildKnowledgeProjection } from '../knowledge/projection.js';
import { writeJsonAtomic } from '../standalone/common.js';
import type { UnknownRecord } from './normalize.js';

interface ProjectionStateStore {
  listKnowledgeRecords(input?: UnknownRecord): UnknownRecord[];
  getProjectKnowledgeRevision(projectId: string): number;
}

export interface CommitImportedProjectKnowledgeInput
  extends CommitImportedKnowledgeTransactionInput {
  projectId?: string;
  env?: NodeJS.ProcessEnv;
  receiptsRoot?: string;
  stateStore?: (
    CommitImportedKnowledgeTransactionInput['stateStore']
    & ProjectionStateStore
  ) | null;
}

const rebuildKnowledgeProjectionPort = rebuildKnowledgeProjection;

export async function commitImportedProjectKnowledge(
  options: CommitImportedProjectKnowledgeInput = {},
): Promise<ImportedKnowledgeTransactionResult> {
  const result = await commitImportedKnowledgeTransaction(options);

  if (
    result.status !== 'no_op'
    && options.stateStore
    && options.projectId
  ) {
    await rebuildKnowledgeProjectionPort(options.projectId, {
      env: options.env || process.env,
      stateStore: options.stateStore,
      revisionAfter: result.receipt?.knowledgeRevisionAfter ?? null,
    });
  }

  if (result.receipt && options.receiptsRoot) {
    await writeJsonAtomic(
      path.join(
        options.receiptsRoot,
        'imports',
        `${result.receipt.importId}.json`,
      ),
      result.receipt,
    );
  }
  return result;
}
