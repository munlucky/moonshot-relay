import path from 'node:path';
import { lstat, stat } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { canonicalPath } from '../../kernel/runtime-home.js';
const isWithin = (root: string, target: string): boolean => {
  const resolvedRoot = canonicalPath(root);
  const resolvedTarget = canonicalPath(target);
  return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(resolvedRoot + path.sep);
};

export async function physicalTargetIdentity(target: string, { protectedRoots = [] }: { protectedRoots?: readonly string[] } = {}) {
  const lexical = path.resolve(target);
  const canonical = canonicalPath(target);
  let info: Stats | null = null;
  let symlink = false;
  try { info = await stat(lexical); symlink = (await lstat(lexical)).isSymbolicLink(); } catch { /* typed absence below */ }
  const resolved = canonical;
  const parentReparse: string[] = [];
  let cursor = lexical;
  while (cursor && cursor !== path.dirname(cursor)) {
    try {
      if ((await lstat(cursor)).isSymbolicLink() && !['/var', '/tmp', '/etc'].includes(cursor.replace(/\\/g, '/'))) {
        parentReparse.push(cursor);
      }
    } catch { /* missing parent */ }
    cursor = path.dirname(cursor);
  }
  const collision = protectedRoots.find((root) => {
    const resolvedRoot = path.resolve(root);
    return isWithin(resolvedRoot, resolved) || isWithin(resolved, resolvedRoot);
  });
  return {
    canonicalPath: resolved,
    finalResolvedPath: resolved,
    volumeId: info?.dev ?? null,
    fileId: info?.ino ?? null,
    reparseTag: symlink ? 'symlink' : null,
    parentChainReparse: parentReparse,
    ownerSid: 'unavailable',
    aclSummary: 'unavailable',
    filesystem: process.platform === 'win32' ? 'ntfs_or_windows_fs_unverified' : info ? 'posix' : 'unknown',
    exists: Boolean(info),
    safe: !symlink && parentReparse.length === 0 && !collision,
    collisionWith: collision || null,
  };
}
