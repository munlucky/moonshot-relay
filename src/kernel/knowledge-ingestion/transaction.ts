import type { UnknownRecord } from './normalize.js';

export interface ImportedKnowledgeReceipt extends UnknownRecord {
  importId?: string;
  knowledgeRevisionAfter?: number | string | null;
}

export interface ImportedKnowledgeTransactionResult extends UnknownRecord {
  status: string;
  receipt?: ImportedKnowledgeReceipt | null;
}

export interface ImportedKnowledgeTransactionStore {
  commitImportedKnowledgeTransaction(
    options: UnknownRecord,
  ): ImportedKnowledgeTransactionResult | Promise<ImportedKnowledgeTransactionResult>;
}

export interface CommitImportedKnowledgeTransactionInput extends UnknownRecord {
  stateStore?: ImportedKnowledgeTransactionStore | null;
}

export async function commitImportedKnowledgeTransaction({
  stateStore,
  ...options
}: CommitImportedKnowledgeTransactionInput = {}): Promise<ImportedKnowledgeTransactionResult> {
  if (
    !stateStore
    || typeof stateStore.commitImportedKnowledgeTransaction !== 'function'
  ) {
    throw new Error('STATE_STORE_REQUIRED');
  }
  return stateStore.commitImportedKnowledgeTransaction(options);
}
