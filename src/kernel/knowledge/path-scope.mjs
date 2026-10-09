import path from 'node:path';

const embeddedGlobRegex = (glob) => {
  let source = '^';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === '*') {
      if (glob[index + 1] === '*') {
        source += '.*';
        index += 1;
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
    }
  }
  return new RegExp(`${source}$`);
};

export function matchPathScope(targetPath, scopes = []) {
  if (!scopes || scopes.length === 0) return true;
  const normalizedTarget = targetPath.replace(/\\/g, '/').toLowerCase();
  for (const scope of scopes) {
    const s = scope.replace(/\\/g, '/').toLowerCase();
    if (s === '*' || s === '**') return true;
    if (s.endsWith('/**')) {
      const prefix = s.slice(0, -3);
      if (normalizedTarget === prefix || normalizedTarget.startsWith(`${prefix}/`)) return true;
    } else if (s.endsWith('/*')) {
      const prefix = s.slice(0, -2);
      if (normalizedTarget.startsWith(`${prefix}/`)) return true;
    } else if (s.includes('*') || s.includes('?')) {
      if (embeddedGlobRegex(s).test(normalizedTarget)) return true;
    } else if (normalizedTarget === s || normalizedTarget.startsWith(`${s}/`)) {
      return true;
    }
  }
  return false;
}

export function scoreRelevance({ item, objective = '', paths = [] }) {
  if (!item || typeof item !== 'object') return 0;
  const status = item.status || 'committed';
  if (['superseded', 'rejected', 'quarantined'].includes(status)) return -100;

  let score = 0;
  const itemType = item.type || item.recordType || '';
  if (itemType === 'policy_anchor') score += 100;
  if (item.trustTier === 'verified') score += 8;
  if (status === 'committed') score += 5;
  if (item.evidence?.refs?.length > 0) score += 3;

  if (item.scope && Array.isArray(item.scope) && item.scope.length > 0) {
    for (const p of paths) {
      if (!p) continue;
      const targetPath = p.replace(/\\/g, '/').toLowerCase();
      for (const scope of item.scope) {
        const s = scope.replace(/\\/g, '/').toLowerCase();
        if (s === targetPath) {
          score += 40;
        } else if (matchPathScope(targetPath, [scope])) {
          score += 25;
        }
      }
    }
  } else {
    score += 1;
  }

  const itemText = JSON.stringify(item).toLowerCase();
  const objWords = objective.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
  for (const word of objWords) {
    if (itemText.includes(word)) {
      score += 10;
    }
  }

  if (itemType === 'domain_term' && objWords.some((w) => itemText.includes(w))) {
    score += 8;
  }

  return score;
}

export function calculatePathRelevance(paths = [], scopes = []) {
  if (!scopes || scopes.length === 0) return 0;
  let matches = 0;
  for (const p of paths) {
    if (matchPathScope(p, scopes)) {
      matches += 5;
    }
  }
  return matches;
}
