// The active npm gate (`npm test`) outgrew the Windows command-line limit
// (8191 characters), so it delegates to numbered segments instead of naming
// every file in one string. Contracts that assert "X is in the active gate"
// must therefore resolve the delegation rather than read `scripts.test` raw.

const DELEGATION = /^\s*npm run ([A-Za-z0-9:_-]+)(?:\s*&&\s*npm run ([A-Za-z0-9:_-]+))*\s*$/;

interface GatePackage { scripts?: Record<string, string> }

export const activeGateSegments = (packageJson: GatePackage | null | undefined, scriptName = 'test'): string[] => {
  const scripts = packageJson?.scripts || {};
  const script = scripts[scriptName];
  if (typeof script !== 'string') return [];
  if (!DELEGATION.test(script)) return [script];
  return script
    .split('&&')
    .map((part) => part.trim().replace(/^npm run\s+/, ''))
    .flatMap((name) => activeGateSegments(packageJson, name));
};

// Everything the active gate actually runs, as one searchable string.
export const activeGate = (packageJson: GatePackage | null | undefined, scriptName = 'test') => activeGateSegments(packageJson, scriptName).join(' ');
