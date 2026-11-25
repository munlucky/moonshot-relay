import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, type Stats } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { createZstdDecompress } from 'node:zlib';
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

const collectFiles = async (roots: readonly string[]): Promise<string[]> => {
  const files = new Set<string>();
  const visited = new Set<string>();
  const visit = async (root: string): Promise<void> => {
    if (visited.has(root)) return;
    visited.add(root);
    let entries = [];
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(root, entry.name);
      if (entry.isDirectory()) {
        await visit(full);
      } else if (
        entry.isFile()
        && (ALLOWED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
          || entry.name.toLowerCase().endsWith('.jsonl.zst'))
      ) {
        files.add(full);
      }
    }
  };
  for (const root of roots) await visit(root);
  return [...files];
};

const parseSessionFile = (text: string): UnknownRecord => {
  try {
    const parsed = asRecord(JSON.parse(text));
    return parsed.type === 'session_meta' ? asRecord(parsed.payload) : parsed;
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
    const sessionMeta = events.find((event) => event.type === 'session_meta');
    if (sessionMeta) {
      const parsed = asRecord(sessionMeta.payload);
      const turnContext = events.find((event) => (
        event.type === 'turn_context' && asRecord(event.payload).cwd
      ));
      return { ...parsed, cwd: parsed.cwd || asRecord(turnContext?.payload).cwd };
    }
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

const readSessionSource = async (file: string): Promise<{
  parsed: UnknownRecord;
  sourceDigest: string;
}> => {
  if (file.toLowerCase().endsWith('.json')) {
    const raw = await readFile(file, 'utf8');
    return { parsed: parseSessionFile(raw), sourceDigest: rawDigest(raw) };
  }
  const source = createReadStream(file);
  const digest = createHash('sha256');
  source.on('data', (chunk: Buffer) => { digest.update(chunk); });
  const decoded = file.toLowerCase().endsWith('.jsonl.zst')
    ? source.pipe(createZstdDecompress())
    : source;
  const lines: string[] = [];
  for await (const line of createInterface({ input: decoded, crlfDelay: Infinity })) {
    if (lines.length < 200 && line.trim()) lines.push(line);
  }
  return {
    parsed: parseSessionFile(lines.join('\n')),
    sourceDigest: `sha256:${digest.digest('hex')}`,
  };
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

  const codexSessions = path.join(profileRoot, 'sessions');
  const roots = name === 'codex'
    ? [existsSync(codexSessions) ? codexSessions : profileRoot]
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
  const candidates: Array<{ file: string; info: Stats }> = [];
  for (let index = 0; index < files.length; index += 64) {
    const batch = await Promise.all(files.slice(index, index + 64).map(async (file) => {
      const info = await stat(file).catch(() => null);
      return info && (!threshold || info.mtimeMs >= threshold) ? { file, info } : null;
    }));
    for (const item of batch) if (item) candidates.push(item);
  }
  candidates.sort((left, right) => right.info.mtimeMs - left.info.mtimeMs || left.file.localeCompare(right.file));

  const sessions: HostSessionDescriptor[] = [];
  const selected = candidates.slice(0, Number(limit) > 0 ? Math.floor(Number(limit)) : 50);
  for (const { file, info } of selected) {
    const { parsed, sourceDigest } = await readSessionSource(file);
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
      sourceDigest,
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

  const { parsed, sourceDigest } = await readSessionSource(file);
  return toKnowledgeInput({
    provider,
    nativeSessionId,
    locator: file,
    sourceDigest,
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
