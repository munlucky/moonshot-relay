import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { observeWorkspaceIdentity } from '../run/workspace-identity.mjs';
import { writeJsonAtomic } from './common.mjs';

export const digestText = (value) => `sha256:${createHash('sha256').update(String(value || '')).digest('hex')}`;
export const digestJson = (value) => digestText(JSON.stringify(value));

export const workspaceSnapshot = (projectRoot) => observeWorkspaceIdentity({ projectRoot });

export const assertSourceUnchanged = (before, after) => {
  if (before?.identity && after?.identity && before.identity !== after.identity) {
    const error = new Error('STANDALONE_SOURCE_MUTATION');
    error.code = 'STANDALONE_SOURCE_MUTATION';
    error.before = before;
    error.after = after;
    throw error;
  }
  return true;
};

export const resolveArtifactDestination = ({ project, output = null, defaultSubdir, defaultName }) => {
  const target = output
    ? path.resolve(output)
    : path.join(project.projectRuntimeRoot, 'artifacts', defaultSubdir, defaultName);
  return target;
};

export const ensureArtifactParent = async (file) => {
  await mkdir(path.dirname(file), { recursive: true });
  return file;
};

export const writeArtifactText = async (file, text) => {
  await ensureArtifactParent(file);
  const fs = await import('node:fs/promises');
  await fs.writeFile(file, String(text), 'utf8');
  return file;
};

export const listFilesRecursive = async (root, relative = '') => {
  const target = path.join(root, relative);
  try {
    const info = await stat(target);
    if (info.isFile()) return [relative.replaceAll('\\', '/')];
  } catch {
    return [];
  }
  const output = [];
  for (const entry of await readdir(target, { withFileTypes: true })) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) output.push(...await listFilesRecursive(root, child));
    else output.push(child.replaceAll('\\', '/'));
  }
  return output.sort();
};

export const digestFiles = async (root, files) => {
  const rows = [];
  for (const rel of [...files].sort()) {
    rows.push({ path: rel.replaceAll('\\', '/'), content: await readFile(path.join(root, rel), 'utf8') });
  }
  return digestJson(rows);
};

export async function writeArtifactBundle({ directory, files, metadata = {} }) {
  const refs = [];
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(directory, relative);
    if (relative.endsWith('.json')) await writeJsonAtomic(absolute, typeof content === 'string' ? JSON.parse(content) : content);
    else await writeArtifactText(absolute, content);
    refs.push({ path: path.relative(directory, absolute).replaceAll('\\', '/'), digest: digestText(typeof content === 'string' ? content : JSON.stringify(content)) });
  }
  return { directory, files: refs, metadata, artifactDigest: digestJson({ files: refs, metadata }) };
}
