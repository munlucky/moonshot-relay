import { matchCapture } from '../../../shared/match-capture.js';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import type {
  InspectRepositoryFiles,
  ListTrackedFiles,
  ObserveRepositoryStructure,
  ObserveGitTreeDigest,
  RepositoryEvidenceObservation,
  RepositoryFileInspection,
  RepositorySymbolObservation,
  ScanRepositoryEvidence,
} from '../../../contracts/repository-observation.js';
import { canonicalDigest } from '../../../shared/canonical-digest.js';
import { gitLsFiles, runGit } from '../../../shared/git-safe.js';

const MANIFEST_FILES = [
  'package.json',
  'Cargo.toml',
  'go.mod',
  'pyproject.toml',
  'setup.py',
  'pom.xml',
  'build.gradle',
  'Gemfile',
  'composer.json',
] as const;

const SOURCE_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.go', '.rs',
  '.java', '.rb', '.php', '.c', '.cc', '.cpp', '.cs', '.swift', '.kt',
]);

const WALK_EXCLUDES = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'target',
  '.moonshot-relay',
  '.moon-relay',
  '.tmp',
  '.history',
  'vendor',
]);

const GREENFIELD_SOURCE_THRESHOLD = 3;
const MAX_SYMBOL_SOURCE_BYTES = 512 * 1024;

const normalizeRepositoryPath = (value: unknown): string => (
  String(value || '').replaceAll('\\', '/').replace(/^\.\//u, '')
);

const readJson = (file: string): Record<string, unknown> | null => {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
};

const dirtyPaths = (projectRoot: string): string[] => {
  const result = runGit(projectRoot, ['status', '--porcelain', '--untracked-files=all']);
  if (result.error || result.status !== 0) return [];
  return String(result.stdout || '')
    .split(/\r?\n/u)
    .map((line) => normalizeRepositoryPath(line.slice(3).trim()))
    .filter(Boolean);
};

export const scanRepositoryEvidence: ScanRepositoryEvidence = ({
  projectRoot,
}): RepositoryEvidenceObservation => {
  const manifests = MANIFEST_FILES.filter(
    (file) => existsSync(path.join(projectRoot, file)),
  );
  const buildCommands: RepositoryEvidenceObservation['buildCommands'] = [];
  const testCommands: RepositoryEvidenceObservation['testCommands'] = [];
  const entrypoints: string[] = [];

  const pkgPath = path.join(projectRoot, 'package.json');
  if (existsSync(pkgPath)) {
    const pkg = readJson(pkgPath);
    if (pkg) {
      const scripts = pkg.scripts && typeof pkg.scripts === 'object' && !Array.isArray(pkg.scripts)
        ? pkg.scripts as Record<string, unknown>
        : {};
      for (const name of Object.keys(scripts)) {
        if (/^(test|test:|check|typecheck|lint)/u.test(name)) {
          testCommands.push({ manifest: 'package.json', commandRef: name });
        }
        if (/^(build|compile|bundle)/u.test(name)) {
          buildCommands.push({ manifest: 'package.json', commandRef: name });
        }
      }
      if (typeof pkg.main === 'string' && pkg.main) entrypoints.push(pkg.main);
      if (typeof pkg.bin === 'string') entrypoints.push(pkg.bin);
      else if (pkg.bin && typeof pkg.bin === 'object' && !Array.isArray(pkg.bin)) {
        entrypoints.push(...Object.values(pkg.bin as Record<string, unknown>)
          .filter((value): value is string => typeof value === 'string'));
      }
      if (pkg.exports) entrypoints.push('exports:package.json');
    }
  }

  return {
    entrypoints: [...new Set(entrypoints)],
    manifests: [...manifests],
    buildCommands,
    testCommands,
    dirtyPaths: dirtyPaths(projectRoot),
  };
};

const countSourceFiles = (
  projectRoot: string,
  cap = GREENFIELD_SOURCE_THRESHOLD + 1,
): number => {
  let count = 0;
  const walk = (dir: string): void => {
    if (count >= cap) return;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (count >= cap) return;
      if (WALK_EXCLUDES.has(name)) continue;
      const absolute = path.join(dir, name);
      try {
        const stats = statSync(absolute);
        if (stats.isDirectory()) walk(absolute);
        else if (SOURCE_EXTENSIONS.has(path.extname(name))) count += 1;
      } catch {
        // An unreadable entry does not become an observed source fact.
      }
    }
  };
  walk(projectRoot);
  return count;
};

export const observeRepositoryStructure: ObserveRepositoryStructure = ({
  projectRoot,
}) => {
  const manifests = MANIFEST_FILES.filter(
    (file) => existsSync(path.join(projectRoot, file)),
  );
  const history = runGit(projectRoot, ['rev-list', '--count', 'HEAD']);
  const hasGitHistory = !history.error
    && history.status === 0
    && Number(String(history.stdout || '').trim()) > 0;

  return {
    manifests: [...manifests],
    sourceFileCountAtLeast: countSourceFiles(projectRoot),
    hasGitHistory,
  };
};

export const observeGitTreeDigest: ObserveGitTreeDigest = ({ projectRoot }) => {
  const result = runGit(projectRoot, ['rev-parse', 'HEAD^{tree}']);
  if (result.error || result.status !== 0) return null;
  const digest = String(result.stdout || '').trim();
  return digest || null;
};

export const listTrackedFiles: ListTrackedFiles = ({ projectRoot }) => {
  const result = gitLsFiles(projectRoot);
  if (result.error || result.status !== 0) return [];
  return [...new Set(String(result.stdout || '')
    .split(/\r?\n/u)
    .map(normalizeRepositoryPath)
    .filter(Boolean))]
    .sort();
};

const fileDigest = (projectRoot: string, relative: string): string | null => {
  try {
    const absolute = path.join(projectRoot, relative);
    if (!existsSync(absolute) || !statSync(absolute).isFile()) return null;
    return `sha256:${createHash('sha256').update(readFileSync(absolute)).digest('hex')}`;
  } catch {
    return null;
  }
};

const SYMBOL_PATTERNS = Object.freeze({
  js: [
    /^\s*export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/u,
    /^\s*export\s+class\s+([A-Za-z_$][\w$]*)/u,
    /^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/u,
    /^\s*export\s+(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/u,
  ],
  py: [/^\s*def\s+([A-Za-z_]\w*)/u, /^\s*class\s+([A-Za-z_]\w*)/u],
  go: [/^\s*func\s+(?:\([^)]*\)\s*)?([A-Z]\w*)/u, /^\s*type\s+([A-Z]\w*)/u],
  rs: [/^\s*pub\s+(?:async\s+)?fn\s+([A-Za-z_]\w*)/u, /^\s*pub\s+(?:struct|enum|trait)\s+([A-Za-z_]\w*)/u],
  rb: [/^\s*def\s+([A-Za-z_]\w*)/u, /^\s*class\s+([A-Z]\w*)/u],
});

const PATTERNS_FOR_EXTENSION: Readonly<Record<string, keyof typeof SYMBOL_PATTERNS>> = Object.freeze({
  '.js': 'js',
  '.mjs': 'js',
  '.cjs': 'js',
  '.jsx': 'js',
  '.ts': 'js',
  '.tsx': 'js',
  '.py': 'py',
  '.go': 'go',
  '.rs': 'rs',
  '.rb': 'rb',
});

const extractSymbols = (
  projectRoot: string,
  paths: readonly string[],
): RepositorySymbolObservation[] => {
  const found: RepositorySymbolObservation[] = [];
  for (const relative of paths) {
    const group = PATTERNS_FOR_EXTENSION[path.extname(relative).toLowerCase()];
    const patterns = group ? SYMBOL_PATTERNS[group] : null;
    if (!patterns) continue;

    let source: string;
    try {
      const absolute = path.join(projectRoot, relative);
      if (!existsSync(absolute) || statSync(absolute).size > MAX_SYMBOL_SOURCE_BYTES) continue;
      source = readFileSync(absolute, 'utf8');
    } catch {
      continue;
    }

    const seen = new Set<string>();
    for (const line of source.split(/\r?\n/u)) {
      for (const pattern of patterns) {
        const match = line.match(pattern);
        if (!match?.[1] || seen.has(matchCapture(match, 1))) continue;
        seen.add(matchCapture(match, 1));
        found.push({ symbol: matchCapture(match, 1), path: relative });
      }
    }
  }

  return found.sort(
    (left, right) => left.path.localeCompare(right.path)
      || left.symbol.localeCompare(right.symbol),
  );
};

export const inspectRepositoryFiles: InspectRepositoryFiles = ({
  projectRoot,
  paths = [],
  includeSymbols = false,
}): RepositoryFileInspection => {
  const normalizedPaths = [...new Set(paths.map(normalizeRepositoryPath).filter(Boolean))].sort();
  const entries = normalizedPaths.map((relative) => [
    relative,
    fileDigest(projectRoot, relative),
  ] as const);
  return {
    digests: Object.fromEntries(entries),
    symbols: includeSymbols ? extractSymbols(projectRoot, normalizedPaths) : [],
    aggregateDigest: canonicalDigest(entries),
  };
};
