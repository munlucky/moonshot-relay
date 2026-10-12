import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  HostCodebaseFileObservation,
  HostCodebaseIndex,
  HostCodebaseIndexResult,
  HostCodebaseManifest,
} from '../../../contracts/knowledge-input.js';
import { runGit } from '../../../shared/git-safe.js';
import { writeJsonAtomic } from '../../../shared/atomic-json.js';

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  '.moon-relay',
  '.moonshot-relay',
  'dist',
  'build',
  'coverage',
  'state',
]);

const SOURCE_EXTENSIONS = new Set([
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.jsx',
  '.py',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.json',
  '.yaml',
  '.yml',
]);

export const CODEBASE_INDEX_VERSION = '1.0.0';

const normalizePath = (value: string): string => value.replaceAll('\\', '/');
const fileDigest = (content: string): string => createHash('sha256').update(content).digest('hex');

const parseSource = (
  pathName: string,
  content: string,
): Omit<HostCodebaseFileObservation, 'size' | 'digest'> => {
  const imports = [...content.matchAll(/(?:import\s+(?:[^'";]+?\s+from\s+)?|require\s*\(|from\s+|use\s+)["']([^"']+)["']/g)]
    .map((match) => match[1])
    .filter((value): value is string => Boolean(value));
  const symbols = [...content.matchAll(/\b(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|def|struct)\s+([A-Za-z_$][\w$]*)/g)]
    .map((match) => match[1])
    .filter((value): value is string => Boolean(value));
  const apiSurface = [...content.matchAll(/(?:export\s+(?:async\s+)?(?:function|class|const|let|var)|@(?:Get|Post|Put|Delete|Route)|router\.(?:get|post|put|delete))\s*\(?\s*([A-Za-z_$][\w$.-]*)?/gi)]
    .map((match) => match[1])
    .filter((value): value is string => Boolean(value));

  return {
    path: normalizePath(pathName),
    imports: [...new Set(imports)],
    symbols: [...new Set(symbols)],
    apiSurface: [...new Set(apiSurface)],
  };
};

const collectFiles = async (
  root: string,
  current = root,
  result: HostCodebaseFileObservation[] = [],
): Promise<HostCodebaseFileObservation[]> => {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await collectFiles(root, path.join(current, entry.name), result);
      continue;
    }

    const extension = path.extname(entry.name).toLowerCase();
    if (!SOURCE_EXTENSIONS.has(extension)) continue;
    const full = path.join(current, entry.name);
    const relative = normalizePath(path.relative(root, full));
    const content = await readFile(full, 'utf8').catch(() => '');
    if (content.length > 2_000_000) continue;
    result.push({
      ...parseSource(relative, content),
      size: content.length,
      digest: fileDigest(content),
    });
  }
  return result;
};

export const digestIndex = (index: unknown): string => (
  'sha256:' + createHash('sha256').update(JSON.stringify(index)).digest('hex')
);

export const buildCodebaseManifest = ({
  projectId,
  sourceCommit = '',
  sourceTreeDigest = '',
  graphDigest = '',
  skillVersion = CODEBASE_INDEX_VERSION,
  status = 'fresh',
  generatedAt = new Date().toISOString(),
}: {
  projectId: string;
  sourceCommit?: string;
  sourceTreeDigest?: string;
  graphDigest?: string;
  skillVersion?: string;
  status?: string;
  generatedAt?: string;
}): HostCodebaseManifest => ({
  schemaVersion: 1,
  projectId,
  sourceCommit,
  sourceTreeDigest,
  graphDigest,
  skillVersion,
  generatedAt,
  status,
});

const readJson = async <T>(file: string, fallback: T): Promise<T> => {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
};

export async function buildCodebaseIndex({
  projectRoot = process.cwd(),
  projectId,
  codebaseRoot,
  runtimeHome = null,
  skillVersion = CODEBASE_INDEX_VERSION,
  force = false,
}: {
  projectRoot?: string;
  projectId: string;
  codebaseRoot: string;
  runtimeHome?: string | null;
  skillVersion?: string;
  force?: boolean;
}): Promise<HostCodebaseIndexResult> {
  void runtimeHome;
  if (!projectId || !codebaseRoot) {
    throw new Error('buildCodebaseIndex requires projectId and codebaseRoot');
  }

  const files = await collectFiles(path.resolve(projectRoot));
  const sourceTreeDigest = 'sha256:' + createHash('sha256')
    .update(JSON.stringify(files.map(({ path: filePath, digest }) => [filePath, digest])))
    .digest('hex');
  const sourceCommitResult = runGit(projectRoot, ['rev-parse', 'HEAD']);
  const sourceCommit = sourceCommitResult.status === 0
    ? String(sourceCommitResult.stdout || '').trim()
    : '';

  const manifestPath = path.join(codebaseRoot, 'index-manifest.json');
  const previous = await readJson<HostCodebaseManifest | null>(manifestPath, null);
  if (
    !force
    && previous
    && previous.sourceTreeDigest === sourceTreeDigest
    && previous.skillVersion === skillVersion
  ) {
    return {
      status: 'cache_hit',
      mode: 'cache_hit',
      projectId,
      codebaseRoot,
      manifest: previous,
      changedFiles: [],
      deletedFiles: [],
    };
  }

  const emptyMap: HostCodebaseIndex = {
    schemaVersion: 1,
    projectId,
    sourceTreeDigest: '',
    sourceCommit: '',
    generatedAt: '',
    files: [],
  };
  const oldMap = previous
    ? await readJson<HostCodebaseIndex>(path.join(codebaseRoot, 'codebase-map.json'), emptyMap)
    : emptyMap;
  const oldByPath = new Map(oldMap.files.map((file) => [file.path, file.digest]));
  const newByPath = new Map(files.map((file) => [file.path, file.digest]));
  const changedFiles = files
    .filter((file) => oldByPath.get(file.path) !== file.digest)
    .map((file) => file.path);
  const deletedFiles = [...oldByPath.keys()].filter((filePath) => !newByPath.has(filePath));

  const generatedAt = new Date().toISOString();
  const map: HostCodebaseIndex = {
    schemaVersion: 1,
    projectId,
    sourceTreeDigest,
    sourceCommit,
    generatedAt,
    files,
  };
  const annotations = {
    schemaVersion: 1,
    projectId,
    sourceTreeDigest,
    annotations: files.map((file) => ({
      path: file.path,
      component: file.path.split('/')[0] || file.path,
      symbolCount: file.symbols.length,
      apiCount: file.apiSurface.length,
    })),
  };
  const graph = {
    schemaVersion: 1,
    projectId,
    nodes: files.map((file) => ({ id: file.path, kind: 'file' })),
    edges: files.flatMap((file) => file.imports.map((target) => ({
      from: file.path,
      to: target,
      kind: 'imports',
    }))),
  };
  const graphDigest = digestIndex(graph);
  const manifest = buildCodebaseManifest({
    projectId,
    sourceCommit,
    sourceTreeDigest,
    graphDigest,
    skillVersion,
    status: 'fresh',
    generatedAt,
  });

  await mkdir(codebaseRoot, { recursive: true });
  await Promise.all([
    writeJsonAtomic(path.join(codebaseRoot, 'codebase-map.json'), map),
    writeJsonAtomic(path.join(codebaseRoot, 'semantic-annotations.json'), annotations),
    writeJsonAtomic(path.join(codebaseRoot, 'diff-overlay.json'), {
      schemaVersion: 1,
      changedFiles,
      deletedFiles,
      generatedAt,
    }),
    writeJsonAtomic(manifestPath, manifest),
  ]);

  return {
    status: 'completed',
    mode: previous ? 'incremental' : 'full',
    projectId,
    codebaseRoot,
    manifest,
    changedFiles,
    deletedFiles,
    fileCount: files.length,
  };
}

export const incrementalRefresh = (
  options: Parameters<typeof buildCodebaseIndex>[0],
): Promise<HostCodebaseIndexResult> => buildCodebaseIndex({ ...options, force: false });

export async function queryCodebaseIndex({
  codebaseRoot,
  query = '',
  limit = 50,
}: {
  codebaseRoot: string;
  query?: string;
  limit?: number;
}) {
  const map = await readJson<HostCodebaseIndex | null>(
    path.join(codebaseRoot, 'codebase-map.json'),
    null,
  );
  if (!map) throw new Error('codebase_index_missing');
  const needle = String(query || '').toLowerCase();
  const files = map.files
    .filter((file) => !needle || JSON.stringify(file).toLowerCase().includes(needle))
    .slice(0, Number(limit) || 50);
  return {
    status: 'ready',
    projectId: map.projectId,
    sourceTreeDigest: map.sourceTreeDigest,
    query: needle,
    files,
  };
}
