import path from 'node:path';
import { access, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolveKernelRuntimeHome } from './runtime-home.mjs';

const nodeRelativePath = (platform = process.platform) => (platform === 'win32' ? 'node.exe' : path.join('bin', 'node'));

export const sha256File = async (file) => createHash('sha256').update(await readFile(file)).digest('hex');

export const parseNodeVersion = (verStr) => {
  const clean = String(verStr || '').trim().replace(/^v/, '');
  const parts = clean.split('.').map(Number);
  return { major: parts[0] || 0, minor: parts[1] || 0, patch: parts[2] || 0, raw: verStr };
};

export const resolveKernelNode = async ({
  runtimeHome = resolveKernelRuntimeHome(),
  platform = process.platform,
  arch = process.arch,
  fallback = process.execPath,
  requireManifest = true,
  skipExecuteCheck = false,
  minNodeMajor = 22,
  minNodeMinor = 13,
} = {}) => {
  const managed = path.join(runtimeHome, 'runtime', 'current', nodeRelativePath(platform));
  const manifestPath = path.join(runtimeHome, 'runtime', 'current', 'runtime-manifest.json');

  try {
    await access(managed);
  } catch {
    return { source: 'host-fallback', nodePath: fallback, reason: 'managed-binary-not-found' };
  }

  let manifest = null;
  try {
    const manifestText = await readFile(manifestPath, 'utf8');
    manifest = JSON.parse(manifestText);
  } catch (err) {
    if (requireManifest) {
      return { source: 'host-fallback', nodePath: fallback, reason: err.code === 'ENOENT' ? 'missing-manifest' : `invalid-manifest:${err.message}` };
    }
  }

  if (manifest) {
    if (manifest.schemaVersion !== 1) {
      return { source: 'host-fallback', nodePath: fallback, reason: `schema-version-mismatch:${manifest.schemaVersion}` };
    }
    if (manifest.productId !== 'moon-relay-kernel') {
      return { source: 'host-fallback', nodePath: fallback, reason: `product-id-mismatch:${manifest.productId}` };
    }
    if (!manifest.runtimeHome || manifest.runtimeHome !== runtimeHome) {
      return { source: 'host-fallback', nodePath: fallback, reason: `runtime-home-mismatch:${manifest.runtimeHome}!=${runtimeHome}` };
    }
    if (!manifest.platform || manifest.platform !== platform) {
      return { source: 'host-fallback', nodePath: fallback, reason: `platform-mismatch:${manifest.platform}!=${platform}` };
    }
    if (!manifest.arch || manifest.arch !== arch) {
      return { source: 'host-fallback', nodePath: fallback, reason: `arch-mismatch:${manifest.arch}!=${arch}` };
    }
    if (!manifest.nodePath || manifest.nodePath !== managed) {
      return { source: 'host-fallback', nodePath: fallback, reason: `node-path-mismatch:${manifest.nodePath}!=${managed}` };
    }
    if (!manifest.checksum) {
      return { source: 'host-fallback', nodePath: fallback, reason: 'missing-manifest-checksum' };
    }
    const computedChecksum = await sha256File(managed);
    if (manifest.checksum !== computedChecksum) {
      return { source: 'host-fallback', nodePath: fallback, reason: 'checksum-mismatch' };
    }
  }

  if (!skipExecuteCheck) {
    try {
      const out = execFileSync(managed, ['--version'], { encoding: 'utf8', timeout: 3000 });
      if (!out || !out.trim().startsWith('v')) {
        return { source: 'host-fallback', nodePath: fallback, reason: 'binary-execution-invalid-output' };
      }
      const ver = parseNodeVersion(out.trim());
      if (ver.major < minNodeMajor || (ver.major === minNodeMajor && ver.minor < minNodeMinor)) {
        return { source: 'host-fallback', nodePath: fallback, reason: `node-version-insufficient:${ver.raw}` };
      }
    } catch (execErr) {
      return { source: 'host-fallback', nodePath: fallback, reason: `binary-execution-failed:${execErr.message}` };
    }
  }

  const checksum = await sha256File(managed);
  return { source: 'managed', nodePath: managed, checksum };
};

export const buildRuntimeManifest = async ({ runtimeHome, nodePath, platform = process.platform, arch = process.arch }) => ({
  schemaVersion: 1,
  productId: 'moon-relay-kernel',
  runtimeHome,
  platform,
  arch,
  nodePath,
  checksum: await sha256File(nodePath),
});
