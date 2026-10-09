import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveKernelProjectIdentity } from '../project-identity.mjs';
import { resolveKernelRuntimeHome, resolveProjectTrackSync } from '../runtime-home.mjs';

export const STANDALONE_SKILL_VERSION = '1.0.0';

export const sha256 = (value) => `sha256:${createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')}`;

export function resolveStandaloneProject({ cwd = process.cwd(), env = process.env } = {}) {
  const track = resolveProjectTrackSync(cwd, { env, allowAccountRootDefault: true }).track;
  if (track !== 'kernel') throw Object.assign(new Error(`wrong_harness: standalone Kernel utility requires an account-root Kernel binding for this project/worktree (found ${track || 'none'})`), { code: 'wrong_harness' });
  const identity = resolveKernelProjectIdentity({ cwd, env });
  const runtimeHome = resolveKernelRuntimeHome({ env });
  const projectRuntimeRoot = path.join(runtimeHome, 'state', 'projects', identity.projectId);
  return {
    ...identity,
    runtimeHome,
    projectRuntimeRoot,
    knowledgeRoot: path.join(projectRuntimeRoot, 'knowledge'),
    codebaseRoot: path.join(projectRuntimeRoot, 'codebase'),
    importsRoot: path.join(projectRuntimeRoot, 'imports'),
    receiptsRoot: path.join(projectRuntimeRoot, 'receipts'),
  };
}

export async function writeJsonAtomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temp, file);
  return file;
}

export async function readJson(file, fallback = null) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return fallback; }
}

export function parseCliArgs(args = []) {
  const result = { _: [], json: false };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--json') { result.json = true; continue; }
    if (!arg.startsWith('--')) { result._.push(arg); continue; }
    const [rawKey, inline] = arg.slice(2).split('=', 2);
    const key = rawKey.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (inline !== undefined) result[key] = inline;
    else if (args[index + 1] && !args[index + 1].startsWith('--')) result[key] = args[++index];
    else result[key] = true;
  }
  return result;
}

export const listArg = (value) => (Array.isArray(value) ? value : String(value || '').split(',')).map((item) => String(item).trim()).filter(Boolean);

export function printResult(result, { json = false } = {}) {
  if (json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else if (typeof result === 'string') process.stdout.write(`${result}\n`);
  else process.stdout.write(`${Object.entries(result || {}).map(([key, value]) => `${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`).join('\n')}\n`);
}
