export async function commitImportedKnowledgeTransaction({ stateStore, ...options } = {}) {
  if (!stateStore || typeof stateStore.commitImportedKnowledgeTransaction !== 'function') throw new Error('STATE_STORE_REQUIRED');
  return stateStore.commitImportedKnowledgeTransaction(options);
}
