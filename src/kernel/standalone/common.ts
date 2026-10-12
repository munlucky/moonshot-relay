import { requiredIndex } from '../../shared/required-index.js';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveKernelProjectIdentity } from '../project-identity.js';
import { resolveKernelRuntimeHome, resolveProjectTrackSync } from '../runtime-home.js';
import { writeJsonAtomic } from '../../shared/atomic-json.js';

export interface StandaloneCliArgs {
  _: string[];
  json: boolean;
  [key: string]: string | boolean | string[] | undefined;
}

export const STANDALONE_SKILL_VERSION = '1.0.0';

export const sha256 = (value: unknown): string => `sha256:${createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')}`;

export function resolveStandaloneProject({
  cwd = process.cwd(),
  env = process.env,
}: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
} = {}) {
  const track = resolveProjectTrackSync(cwd, {
    env,
    allowAccountRootDefault: true,
  }).track;
  if (track !== 'kernel') {
    throw Object.assign(
      new Error(`wrong_harness: standalone Kernel utility requires an account-root Kernel binding for this project/worktree (found ${track || 'none'})`),
      { code: 'wrong_harness' },
    );
  }
  const identity = resolveKernelProjectIdentity({ cwd, env });
  const runtimeHome = resolveKernelRuntimeHome({ env });
  const projectRuntimeRoot = path.join(
    runtimeHome,
    'state',
    'projects',
    identity.projectId,
  );
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

export { writeJsonAtomic };

export async function readJson<T = unknown>(
  file: string,
  fallback: T | null = null,
): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

export function parseCliArgs(args: string[] = []): StandaloneCliArgs {
  const result: StandaloneCliArgs = { _: [], json: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = requiredIndex(args, index);
    if (arg === '--json') {
      result.json = true;
      continue;
    }
    if (!arg.startsWith('--')) {
      result._.push(arg);
      continue;
    }
    const [rawKey = '', inline] = arg.slice(2).split('=', 2);
    const key = rawKey.replace(
      /-([a-z])/g,
      (_match: string, letter: string) => letter.toUpperCase(),
    );
    if (inline !== undefined) result[key] = inline;
    else if (args[index + 1] && !requiredIndex(args, index + 1).startsWith('--')) {
      result[key] = args[index += 1];
    } else {
      result[key] = true;
    }
  }
  return result;
}

export const listArg = (value: unknown): string[] => (
  Array.isArray(value) ? value : String(value || '').split(',')
)
  .map((item) => String(item).trim())
  .filter(Boolean);

export function printResult(
  result: unknown,
  { json = false }: { json?: boolean } = {},
): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (typeof result === 'string') {
    process.stdout.write(`${result}\n`);
    return;
  }
  const record = result && typeof result === 'object'
    ? result as Record<string, unknown>
    : {};
  process.stdout.write(
    `${Object.entries(record)
      .map(([key, value]) => `${key}: ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`)
      .join('\n')}\n`,
  );
}
