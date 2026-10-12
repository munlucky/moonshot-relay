import { matchCapture } from '../../../shared/match-capture.js';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type {
  MakeProjectCommandObservation,
  NodeProjectCommandObservation,
  ProjectCommandDeclarationObservation,
} from '../../../contracts/project-command.js';

const OBSERVED_MANIFESTS = [
  'go.mod',
  'Cargo.toml',
  'pyproject.toml',
  'setup.py',
  'pom.xml',
  'build.gradle',
] as const;

const MAKEFILES = ['Makefile', 'makefile', 'GNUmakefile'] as const;
const MAKE_TARGET_REGEX = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*:(?!=)/u;

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

const readText = (file: string): string | null => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};

const observeNode = (projectRoot: string): NodeProjectCommandObservation | null => {
  const packagePath = path.join(projectRoot, 'package.json');
  if (!existsSync(packagePath)) return null;

  const manifest = readJson(packagePath);
  if (!manifest) return null;

  const scriptsRecord = manifest.scripts
    && typeof manifest.scripts === 'object'
    && !Array.isArray(manifest.scripts)
    ? manifest.scripts as Record<string, unknown>
    : {};
  const scripts = Object.fromEntries(
    Object.entries(scriptsRecord)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );

  const dependencySections = [
    manifest.dependencies,
    manifest.devDependencies,
    manifest.optionalDependencies,
    manifest.peerDependencies,
  ];
  const hasTypeScriptDependency = dependencySections.some((section) => (
    section
    && typeof section === 'object'
    && !Array.isArray(section)
    && typeof (section as Record<string, unknown>).typescript === 'string'
  ));

  const runner = existsSync(path.join(projectRoot, 'pnpm-lock.yaml'))
    ? 'pnpm'
    : existsSync(path.join(projectRoot, 'yarn.lock'))
      ? 'yarn'
      : 'npm';

  const localTypeScriptBinary = [
    path.join(projectRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc'),
    path.join(projectRoot, 'node_modules', '.bin', 'tsc'),
  ].find((candidate) => existsSync(candidate));

  return {
    runner,
    scripts,
    hasTypeScriptDependency,
    hasTypeScriptConfig: existsSync(path.join(projectRoot, 'tsconfig.json')),
    localTypeScriptBinary: localTypeScriptBinary
      ? path.relative(projectRoot, localTypeScriptBinary).replaceAll('\\', '/')
      : null,
  };
};

const observeMake = (projectRoot: string): MakeProjectCommandObservation | null => {
  const source = MAKEFILES.find((name) => existsSync(path.join(projectRoot, name)));
  if (!source) return null;

  const text = readText(path.join(projectRoot, source));
  if (!text) return { source, targets: [] };

  const targets = new Set<string>();
  for (const line of text.split(/\r?\n/u)) {
    if (/^\s/u.test(line) || line.startsWith('#') || line.startsWith('.')) continue;
    const match = line.match(MAKE_TARGET_REGEX);
    if (match?.[1]) targets.add(matchCapture(match, 1));
  }
  return { source, targets: [...targets].sort() };
};

export const observeProjectCommandDeclarations = ({
  projectRoot,
}: {
  projectRoot: string;
}): ProjectCommandDeclarationObservation => ({
  schemaVersion: 1,
  manifests: OBSERVED_MANIFESTS
    .filter((name) => existsSync(path.join(projectRoot, name))),
  node: observeNode(projectRoot),
  make: observeMake(projectRoot),
});
