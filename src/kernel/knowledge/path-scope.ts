export interface KnowledgeRelevanceItem extends Record<string, unknown> {
  status?: string | null;
  type?: string | null;
  recordType?: string | null;
  trustTier?: string | null;
  evidence?: { refs?: unknown[] | null } | null;
  scope?: string[] | null;
}

import { matchPathScope } from '../../shared/path-scope.js';
export { matchPathScope } from '../../shared/path-scope.js';

export function scoreRelevance({
  item,
  objective = '',
  paths = [],
}: {
  item: KnowledgeRelevanceItem | null | undefined;
  objective?: string;
  paths?: readonly string[];
}): number {
  if (!item || typeof item !== 'object') return 0;
  const status = item.status || 'committed';
  if (['superseded', 'rejected', 'quarantined'].includes(status)) return -100;

  let score = 0;
  const itemType = item.type || item.recordType || '';
  if (itemType === 'policy_anchor') score += 100;
  if (item.trustTier === 'verified') score += 8;
  if (status === 'committed') score += 5;
  if (item.evidence?.refs?.length) score += 3;

  if (Array.isArray(item.scope) && item.scope.length > 0) {
    for (const p of paths) {
      if (!p) continue;
      const targetPath = p.replace(/\\/g, '/').toLowerCase();
      for (const scope of item.scope) {
        const s = scope.replace(/\\/g, '/').toLowerCase();
        if (s === targetPath) score += 40;
        else if (matchPathScope(targetPath, [scope])) score += 25;
      }
    }
  } else {
    score += 1;
  }

  const itemText = JSON.stringify(item).toLowerCase();
  const objWords = objective.toLowerCase().split(/\s+/).filter((word) => word.length > 3);
  for (const word of objWords) {
    if (itemText.includes(word)) score += 10;
  }
  if (itemType === 'domain_term' && objWords.some((word) => itemText.includes(word))) score += 8;

  return score;
}

export function calculatePathRelevance(paths: readonly string[] = [], scopes: readonly string[] = []): number {
  if (!scopes || scopes.length === 0) return 0;
  let matches = 0;
  for (const p of paths) {
    if (matchPathScope(p, scopes)) matches += 5;
  }
  return matches;
}
