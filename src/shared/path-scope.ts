import { requiredIndex } from './required-index.js';
const embeddedGlobRegex = (glob: string): RegExp => {
  let source = '^';
  for (let index = 0; index < glob.length; index += 1) {
    const char = requiredIndex(glob, index);
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

export function matchPathScope(
  targetPath: string,
  scopes: readonly string[] = [],
): boolean {
  if (!scopes || scopes.length === 0) return true;
  const normalizedTarget = targetPath.replace(/\\/g, '/').toLowerCase();
  for (const scope of scopes) {
    const normalizedScope = scope.replace(/\\/g, '/').toLowerCase();
    if (normalizedScope === '*' || normalizedScope === '**') return true;
    if (normalizedScope.endsWith('/**')) {
      const prefix = normalizedScope.slice(0, -3);
      if (normalizedTarget === prefix || normalizedTarget.startsWith(`${prefix}/`)) return true;
    } else if (normalizedScope.endsWith('/*')) {
      const prefix = normalizedScope.slice(0, -2);
      if (normalizedTarget.startsWith(`${prefix}/`)) return true;
    } else if (normalizedScope.includes('*') || normalizedScope.includes('?')) {
      if (embeddedGlobRegex(normalizedScope).test(normalizedTarget)) return true;
    } else if (
      normalizedTarget === normalizedScope
      || normalizedTarget.startsWith(`${normalizedScope}/`)
    ) {
      return true;
    }
  }
  return false;
}
