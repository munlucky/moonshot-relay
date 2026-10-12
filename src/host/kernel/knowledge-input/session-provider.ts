import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  HostSessionDescriptor,
  HostSessionDiscovery,
  HostSessionKnowledgeInput,
  HostSessionProviderAdapter,
  HostSessionResolution,
} from '../../../contracts/knowledge-input.js';
import { redactText } from '../../../shared/redaction.js';

type UnknownRecord = Record<string, unknown>;

const ALLOWED_EXTENSIONS = new Set(['.json', '.jsonl', '.ndjson']);
const MAX_FILES = 500;
const SUPPORTED_PROVIDERS = new Set(['codex', 'claude']);

const EXPLICIT_ROOTS: Record<string, string[]> = {
  codex: ['MOON_RELAY_CODEX_SESSION_ROOT', 'CODEX_SESSION_ROOT'],
  claude: ['MOON_RELAY_CLAUDE_SESSION_ROOT', 'CLAUDE_SESSION_ROOT'],
};

const asRecord = (value: unknown): UnknownRecord => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : {}
);

const safeText = (value: unknown): string | null => {
  if (value === null || value === undefined || value === '') return null;
  return redactText(value);
};

const safeList = (value: unknown): string[] => {
  const input = Array.isArray(value) ? value : value ? [value] : [];
  return input.map((entry) => redactText(entry)).filter(Boolean);
};

const rawDigest = (raw: string): string => (
  'sha256:' + createHash('sha256').update(raw).digest('hex')
);

const collectFiles = async (
  roots: readonly string[],
  result: string[] = [],
): Promise<string[]> => {
  if (result.length >= MAX_FILES) return result;
  for (const root of roots) {
    let entries = [];
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (result.length >= MAX_FILES) break;
      const full = path.join(root, entry.name);
      if (entry.isDirectory()) {
        await collectFiles([full], result);
      } else if (
        entry.isFile()
        && ALLOWED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
      ) {
        result.push(full);
      }
    }
  }
  return result;
};

const parseSessionFile = (text: string): UnknownRecord => {
  try {
    return asRecord(JSON.parse(text));
  } catch {
    const lines = text.split(/\r?\n/).filter(Boolean);
    const events = lines
      .slice(0, 200)
      .map((line) => {
        try {
          return asRecord(JSON.parse(line));
        } catch {
          return null;
        }
      })
      .filter((entry): entry is UnknownRecord => Boolean(entry));
    const metadata = events.find((event) => (
      event.sessionId
      || event.id
      || event.cwd
      || event.workingDirectory
    ));
    return metadata
      ? { ...metadata, eventCount: lines.length }
      : { eventCount: lines.length };
  }
};

const toKnowledgeInput = ({
  provider,
  nativeSessionId,
  locator,
  sourceDigest,
  parsed,
}: {
  provider: string;
  nativeSessionId: string;
  locator: string | null;
  sourceDigest: string;
  parsed: UnknownRecord;
}): HostSessionKnowledgeInput => {
  const workingDirectory = safeText(
    parsed.workingDirectory
    || parsed.cwd
    || parsed.projectRoot
    || parsed.workspaceRoot,
  );
  const remote = safeText(parsed.remote || parsed.gitRemote || parsed.repository);
  const base = {
    schemaVersion: 1 as const,
    provider,
    nativeSessionId,
    locator,
    workingDirectory,
    remote,
    createdAt: safeText(parsed.createdAt || parsed.timestamp),
    updatedAt: safeText(parsed.updatedAt || parsed.timestamp),
    objective: safeText(parsed.objective),
    changedFiles: safeList(parsed.changedFiles || parsed.changedPaths || parsed.files),
    decisions: safeList(parsed.decisions || parsed.userDecisions || parsed.architectureChoices),
    failures: safeList(parsed.failures || parsed.knownFailures || parsed.unresolvedIssues),
    nextSteps: safeList(parsed.nextSteps || parsed.next),
  };
  return {
    ...base,
    sourceDigest,
  };
};

export function resolveProviderSessionRoots(
  provider: string,
  {
    env = process.env,
    home = os.homedir(),
  }: {
    env?: NodeJS.ProcessEnv;
    home?: string;
  } = {},
): HostSessionResolution {
  const name = String(provider || '').toLowerCase();
  for (const variable of EXPLICIT_ROOTS[name] || []) {
    const configured = env[variable];
    if (configured) {
      const root = path.resolve(configured);
      return {
        provider: name,
        roots: [root],
        source: 'env:' + variable,
        available: existsSync(root),
      };
    }
  }

  const profileRoot = name === 'codex'
    ? (env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(home, '.codex'))
    : (env.CLAUDE_CONFIG_DIR ? path.resolve(env.CLAUDE_CONFIG_DIR) : path.join(home, '.claude'));
  const configured = path.join(profileRoot, 'profile.json');
  if (existsSync(configured)) {
    try {
      const parsed = asRecord(JSON.parse(readFileSync(configured, 'utf8')));
      const configuredRoot = parsed.sessionRoot || parsed.sessionsRoot || parsed.sessions;
      if (configuredRoot) {
        const root = path.resolve(String(configuredRoot));
        return {
          provider: name,
          roots: [root],
          source: 'provider-profile',
          available: existsSync(root),
        };
      }
    } catch {
      // Invalid provider profile falls through to the provider default roots.
    }
  }

  const roots = name === 'codex'
    ? [path.join(profileRoot, 'sessions'), profileRoot]
    : [path.join(profileRoot, 'projects'), path.join(profileRoot, 'sessions'), profileRoot];
  return {
    provider: name,
    roots,
    source: 'provider-default',
    available: roots.some((root) => existsSync(root)),
  };
}

export async function discoverProviderSessions(
  provider: string,
  {
    since = null,
    limit = 50,
    env = process.env,
  }: {
    since?: string | null;
    limit?: number;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<HostSessionDiscovery> {
  const resolution = resolveProviderSessionRoots(provider, { env });
  if (!resolution.available) {
    return {
      provider,
      status: 'unavailable',
      resolution,
      sessions: [],
    };
  }

  const files = await collectFiles(resolution.roots);
  const threshold = since ? new Date(since).getTime() : 0;
  const sessions: HostSessionDescriptor[] = [];

  for (const file of files) {
    const info = await stat(file).catch(() => null);
    if (!info || (threshold && info.mtimeMs < threshold)) continue;
    const raw = await readFile(file, 'utf8').catch(() => '');
    const parsed = parseSessionFile(raw);
    const nativeSessionId = String(
      parsed.nativeSessionId
      || parsed.sessionId
      || parsed.id
      || path.basename(file, path.extname(file)),
    );
    sessions.push({
      provider,
      nativeSessionId,
      locator: file,
      sourceDigest: rawDigest(raw),
      workingDirectory: safeText(parsed.workingDirectory || parsed.cwd || parsed.projectRoot),
      remote: safeText(parsed.remote || parsed.gitRemote),
      updatedAt: safeText(parsed.updatedAt) || info.mtime.toISOString(),
      createdAt: safeText(parsed.createdAt) || info.birthtime.toISOString(),
    });
  }

  sessions.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
  return {
    provider,
    status: 'ready',
    resolution,
    sessions: sessions.slice(0, Number(limit) || 50),
  };
}

export async function readProviderSession(
  provider: string,
  nativeSessionId: string,
  {
    locator = null,
    env = process.env,
  }: {
    locator?: string | null;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<HostSessionKnowledgeInput> {
  const resolution = resolveProviderSessionRoots(provider, { env });
  const files = locator ? [locator] : await collectFiles(resolution.roots);
  const file = files.find((candidate) => (
    candidate === locator
    || path.basename(candidate).includes(String(nativeSessionId))
  ));
  if (!file) {
    throw Object.assign(
      new Error('session_not_found: ' + provider + ':' + nativeSessionId),
      { code: 'session_not_found' },
    );
  }

  const raw = await readFile(file, 'utf8');
  const parsed = parseSessionFile(raw);
  return toKnowledgeInput({
    provider,
    nativeSessionId,
    locator: file,
    sourceDigest: rawDigest(raw),
    parsed,
  });
}

export const providerFor = (provider: string): HostSessionProviderAdapter | null => {
  const name = String(provider || '').toLowerCase();
  if (!SUPPORTED_PROVIDERS.has(name)) return null;
  return {
    discoverSessions: (options = {}) => discoverProviderSessions(name, options),
    readSession: (nativeSessionId, options = {}) => readProviderSession(name, nativeSessionId, options),
  };
};
