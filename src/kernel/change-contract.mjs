export function normalizeChangedContract(input = {}) {
  if (!input || typeof input !== 'object') {
    return { changedPaths: [], changedFileCount: 0 };
  }

  const rawPaths = Array.isArray(input.changedPaths)
    ? input.changedPaths
    : Array.isArray(input.changedFiles)
      ? input.changedFiles
      : Array.isArray(input.filesChanged)
        ? input.filesChanged
        : [];

  const changedPaths = rawPaths
    .filter((p) => p && typeof p === 'string')
    .map((p) => p.replace(/\\/g, '/'));

  let changedFileCount = Number.isFinite(input.changedFileCount)
    ? Number(input.changedFileCount)
    : Number.isFinite(input.filesChanged)
      ? Number(input.filesChanged)
      : changedPaths.length;

  if (changedFileCount < changedPaths.length) {
    changedFileCount = changedPaths.length;
  }

  return {
    changedPaths,
    changedFileCount,
  };
}

export const CONTRACT_CHANGE_CLASSES = Object.freeze([
  'clarification',
  'defect-within-scope',
  'scope-extension',
  'replacement',
]);

const values = (value) => (Array.isArray(value) ? value : value ? [value] : []).map((item) => String(item).replace(/\\/g, '/')).filter(Boolean);
const setEqual = (left, right) => JSON.stringify([...new Set(values(left))].sort()) === JSON.stringify([...new Set(values(right))].sort());
const isWithin = (candidate, declared) => values(candidate).every((item) => values(declared).some((scope) => item === scope || scope === '*' || scope === '**' || (scope.endsWith('/**') && item.startsWith(scope.slice(0, -2))) || item.startsWith(`${scope}/`)));

export const classifyContractChange = ({ previous = null, next = null } = {}) => {
  if (!previous || !next) return 'clarification';
  const explicit = next.changeClass || next.flags?.changeClass;
  if (CONTRACT_CHANGE_CLASSES.includes(explicit)) return explicit;
  if (next.replacement === true || next.flags?.replacement === true) return 'replacement';
  const previousPaths = [...values(previous.allowedPaths), ...values(previous.forbiddenPaths)];
  const nextPaths = [...values(next.allowedPaths), ...values(next.forbiddenPaths)];
  if (next.scopeExtension === true || next.flags?.scopeExtension === true || (nextPaths.length > 0 && previousPaths.length === 0) || !isWithin(nextPaths, previousPaths.length > 0 ? previousPaths : ['**'])) return 'scope-extension';
  if (next.defectWithinScope === true || next.flags?.defectWithinScope === true || next.taskClass === 'bug') {
    return 'defect-within-scope';
  }
  if (setEqual(previous.allowedPaths, next.allowedPaths) && setEqual(previous.forbiddenPaths, next.forbiddenPaths)) return 'clarification';
  return 'defect-within-scope';
};
