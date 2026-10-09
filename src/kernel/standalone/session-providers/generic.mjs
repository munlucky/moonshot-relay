import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { resolveProviderSessionRoots } from './resolver.mjs';
import { normalizeProviderSession } from './normalize.mjs';

const allowedExtensions = new Set(['.json', '.jsonl', '.ndjson']);
const maxFiles = 500;

async function collectFiles(roots, result = []) {
  if (result.length >= maxFiles) return result;
  for (const root of roots) {
    let entries = [];
    try { entries = await readdir(root, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (result.length >= maxFiles) break;
      const full = path.join(root, entry.name);
      if (entry.isDirectory()) await collectFiles([full], result);
      else if (entry.isFile() && allowedExtensions.has(path.extname(entry.name).toLowerCase())) result.push(full);
    }
  }
  return result;
}

function parseSessionFile(text, file) {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : { value: parsed };
  } catch {
    const lines = text.split(/\r?\n/).filter(Boolean);
    const events = lines.slice(0, 200).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
    const metadata = events.find((event) => event.sessionId || event.id || event.cwd || event.workingDirectory) || {};
    return { ...metadata, eventCount: lines.length };
  }
}

export async function discoverProviderSessions(provider, { since = null, limit = 50, env = process.env } = {}) {
  const resolution = resolveProviderSessionRoots(provider, { env });
  if (!resolution.available) return { provider, status: 'unavailable', resolution, sessions: [] };
  const files = await collectFiles(resolution.roots);
  const threshold = since ? new Date(since).getTime() : 0;
  const sessions = [];
  for (const file of files) {
    const info = await stat(file).catch(() => null);
    if (!info || (threshold && info.mtimeMs < threshold)) continue;
    const raw = await readFile(file, 'utf8').catch(() => '');
    const parsed = parseSessionFile(raw, file);
    const nativeSessionId = String(parsed.nativeSessionId || parsed.sessionId || parsed.id || path.basename(file, path.extname(file)));
    const sourceDigest = `sha256:${createHash('sha256').update(raw).digest('hex')}`;
    sessions.push({ provider, nativeSessionId, locator: file, sourceDigest, workingDirectory: parsed.workingDirectory || parsed.cwd || parsed.projectRoot || null, remote: parsed.remote || parsed.gitRemote || null, updatedAt: parsed.updatedAt || info.mtime.toISOString(), createdAt: parsed.createdAt || info.birthtime.toISOString() });
  }
  sessions.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
  return { provider, status: 'ready', resolution, sessions: sessions.slice(0, Number(limit) || 50) };
}

export async function readProviderSession(provider, nativeSessionId, { locator = null, env = process.env } = {}) {
  const resolution = resolveProviderSessionRoots(provider, { env });
  const files = locator ? [locator] : await collectFiles(resolution.roots);
  const file = files.find((candidate) => candidate === locator || path.basename(candidate).includes(String(nativeSessionId)));
  if (!file) throw Object.assign(new Error(`session_not_found: ${provider}:${nativeSessionId}`), { code: 'session_not_found' });
  const raw = await readFile(file, 'utf8');
  return { provider, nativeSessionId, locator: file, sourceDigest: `sha256:${createHash('sha256').update(raw).digest('hex')}`, raw, parsed: parseSessionFile(raw, file) };
}

export { normalizeProviderSession };
