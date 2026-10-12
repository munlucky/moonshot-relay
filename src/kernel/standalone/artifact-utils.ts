import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { writeJsonAtomic } from './common.js';

export interface WorkspaceSnapshot {
  identity?: unknown;
  [key: string]: unknown;
}

export type WorkspaceIdentityObserver = (input: {
  projectRoot: string;
}) => WorkspaceSnapshot;

interface StandaloneMutationError extends Error {
  code: string;
  before: WorkspaceSnapshot;
  after: WorkspaceSnapshot;
}

interface ArtifactProject {
  projectRuntimeRoot: string;
}

export interface ArtifactReference {
  path: string;
  digest: string;
}

export interface ArtifactBundle {
  directory: string;
  files: ArtifactReference[];
  metadata: Record<string, unknown>;
  artifactDigest: string;
}

export const digestText = (value: unknown): string => (
  `sha256:${createHash('sha256').update(String(value || '')).digest('hex')}`
);

export const digestJson = (value: unknown): string => (
  digestText(JSON.stringify(value))
);

export const workspaceSnapshot = (
  projectRoot: string,
  observeWorkspaceIdentity: WorkspaceIdentityObserver | null,
): WorkspaceSnapshot => {
  if (typeof observeWorkspaceIdentity !== 'function') {
    throw new Error('workspace_identity_observer_required');
  }
  return observeWorkspaceIdentity({ projectRoot });
};

export const assertSourceUnchanged = (
  before: WorkspaceSnapshot,
  after: WorkspaceSnapshot,
): true => {
  if (
    before.identity
    && after.identity
    && before.identity !== after.identity
  ) {
    const error = new Error(
      'STANDALONE_SOURCE_MUTATION',
    ) as StandaloneMutationError;
    error.code = 'STANDALONE_SOURCE_MUTATION';
    error.before = before;
    error.after = after;
    throw error;
  }
  return true;
};

export const resolveArtifactDestination = ({
  project,
  output = null,
  defaultSubdir,
  defaultName,
}: {
  project: ArtifactProject;
  output?: string | null;
  defaultSubdir: string;
  defaultName: string;
}): string => (
  output
    ? path.resolve(output)
    : path.join(
      project.projectRuntimeRoot,
      'artifacts',
      defaultSubdir,
      defaultName,
    )
);

export const ensureArtifactParent = async (
  file: string,
): Promise<string> => {
  await mkdir(path.dirname(file), { recursive: true });
  return file;
};

export const writeArtifactText = async (
  file: string,
  text: unknown,
): Promise<string> => {
  await ensureArtifactParent(file);
  await writeFile(file, String(text), 'utf8');
  return file;
};

export const listFilesRecursive = async (
  root: string,
  relative = '',
): Promise<string[]> => {
  const target = path.join(root, relative);
  try {
    const info = await stat(target);
    if (info.isFile()) return [relative.replaceAll('\\', '/')];
  } catch {
    return [];
  }
  const output: string[] = [];
  for (const entry of await readdir(target, { withFileTypes: true })) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      output.push(...await listFilesRecursive(root, child));
    } else {
      output.push(child.replaceAll('\\', '/'));
    }
  }
  return output.sort();
};

export const digestFiles = async (
  root: string,
  files: string[],
): Promise<string> => {
  const rows: Array<{ path: string; content: string }> = [];
  for (const rel of [...files].sort()) {
    rows.push({
      path: rel.replaceAll('\\', '/'),
      content: await readFile(path.join(root, rel), 'utf8'),
    });
  }
  return digestJson(rows);
};

export async function writeArtifactBundle({
  directory,
  files,
  metadata = {},
}: {
  directory: string;
  files: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}): Promise<ArtifactBundle> {
  const refs: ArtifactReference[] = [];
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(directory, relative);
    if (relative.endsWith('.json')) {
      await writeJsonAtomic(
        absolute,
        typeof content === 'string' ? JSON.parse(content) : content,
      );
    } else {
      await writeArtifactText(absolute, content);
    }
    refs.push({
      path: path.relative(directory, absolute).replaceAll('\\', '/'),
      digest: digestText(
        typeof content === 'string' ? content : JSON.stringify(content),
      ),
    });
  }
  return {
    directory,
    files: refs,
    metadata,
    artifactDigest: digestJson({ files: refs, metadata }),
  };
}
