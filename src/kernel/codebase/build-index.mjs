import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { gitTreeDigest } from '../../shared/candidate-identity.mjs';
import { runGit } from '../../shared/git-safe.mjs';
import { writeJsonAtomic, sha256, STANDALONE_SKILL_VERSION } from '../standalone/common.mjs';
import { buildCodebaseManifest, digestIndex } from './manifest.mjs';

const SKIP_DIRS = new Set(['.git', 'node_modules', '.moon-relay', '.moonshot-relay', 'dist', 'build', 'coverage', 'state']);
const SOURCE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.go', '.rs', '.java', '.kt', '.json', '.yaml', '.yml']);

const normalizePath = (value) => value.replaceAll('\\', '/');
const fileDigest = (content) => createHash('sha256').update(content).digest('hex');

function parseSource(pathName, content) {
  const imports = [...content.matchAll(/(?:import\s+(?:[^'";]+?\s+from\s+)?|require\s*\(|from\s+|use\s+)["']([^"']+)["']/g)].map((match) => match[1]).filter(Boolean);
  const symbols = [...content.matchAll(/\b(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|def|struct)\s+([A-Za-z_$][\w$]*)/g)].map((match) => match[1]);
  const apiSurface = [...content.matchAll(/(?:export\s+(?:async\s+)?(?:function|class|const|let|var)|@(?:Get|Post|Put|Delete|Route)|router\.(?:get|post|put|delete))\s*\(?\s*([A-Za-z_$][\w$.-]*)?/gi)].map((match) => match[1]).filter(Boolean);
  return { path: normalizePath(pathName), imports: [...new Set(imports)], symbols: [...new Set(symbols)], apiSurface: [...new Set(apiSurface)] };
}

async function collectFiles(root, current = root, result = []) {
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
    result.push({ ...parseSource(relative, content), size: content.length, digest: fileDigest(content) });
  }
  return result;
}

export async function buildCodebaseIndex({ projectRoot = process.cwd(), projectId, codebaseRoot, runtimeHome = null, skillVersion = STANDALONE_SKILL_VERSION, force = false } = {}) {
  if (!projectId || !codebaseRoot) throw new Error('buildCodebaseIndex requires projectId and codebaseRoot');
  const files = await collectFiles(path.resolve(projectRoot));
  const sourceTreeDigest = `sha256:${createHash('sha256').update(JSON.stringify(files.map(({ path: filePath, digest }) => [filePath, digest]))).digest('hex')}`;
  const sourceCommitResult = runGit(projectRoot, ['rev-parse', 'HEAD']);
  const sourceCommit = sourceCommitResult.status === 0 ? String(sourceCommitResult.stdout || '').trim() : '';
  const manifestPath = path.join(codebaseRoot, 'index-manifest.json');
  let previous = null;
  try { previous = JSON.parse(await readFile(manifestPath, 'utf8')); } catch {}
  if (!force && previous && previous.sourceTreeDigest === sourceTreeDigest && previous.skillVersion === skillVersion) return { status: 'cache_hit', mode: 'cache_hit', projectId, codebaseRoot, manifest: previous, changedFiles: [], deletedFiles: [] };
  const oldMap = previous ? await readFile(path.join(codebaseRoot, 'codebase-map.json'), 'utf8').then(JSON.parse).catch(() => ({ files: [] })) : { files: [] };
  const oldByPath = new Map((oldMap.files || []).map((file) => [file.path, file.digest]));
  const newByPath = new Map(files.map((file) => [file.path, file.digest]));
  const changedFiles = files.filter((file) => oldByPath.get(file.path) !== file.digest).map((file) => file.path);
  const deletedFiles = [...oldByPath.keys()].filter((filePath) => !newByPath.has(filePath));
  const map = { schemaVersion: 1, projectId, sourceTreeDigest, sourceCommit, generatedAt: new Date().toISOString(), files };
  const annotations = { schemaVersion: 1, projectId, sourceTreeDigest, annotations: files.map((file) => ({ path: file.path, component: file.path.split('/')[0] || file.path, symbolCount: file.symbols.length, apiCount: file.apiSurface.length })) };
  const graph = { schemaVersion: 1, projectId, nodes: files.map((file) => ({ id: file.path, kind: 'file' })), edges: files.flatMap((file) => file.imports.map((target) => ({ from: file.path, to: target, kind: 'imports' }))) };
  const graphDigest = digestIndex(graph);
  const manifest = buildCodebaseManifest({ projectId, sourceCommit, sourceTreeDigest, graphDigest, skillVersion, status: 'fresh' });
  await mkdir(codebaseRoot, { recursive: true });
  await Promise.all([
    writeJsonAtomic(path.join(codebaseRoot, 'codebase-map.json'), map),
    writeJsonAtomic(path.join(codebaseRoot, 'semantic-annotations.json'), annotations),
    writeJsonAtomic(path.join(codebaseRoot, 'diff-overlay.json'), { schemaVersion: 1, changedFiles, deletedFiles, generatedAt: manifest.generatedAt }),
    writeJsonAtomic(manifestPath, manifest),
  ]);
  return { status: 'completed', mode: previous ? 'incremental' : 'full', projectId, codebaseRoot, manifest, changedFiles, deletedFiles, fileCount: files.length };
}
