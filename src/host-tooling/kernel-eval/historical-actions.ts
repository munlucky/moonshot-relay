import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { classifyCommandName } from '../../contracts/command-catalog.js';
import { discoverProviderSessions } from '../../host/kernel/knowledge-input/session-provider.js';
import {
  classifyGenerationRelevance,
  type HistoricalWorkCase,
} from './historical-improvement.js';

export const HISTORICAL_ACTION_CATEGORIES = Object.freeze([
  'search',
  'read',
  'modify',
  'focused-verification',
  'full-verification',
  'kernel-lifecycle',
  'git-read',
  'git-mutation',
  'environment-setup',
  'unclassified',
] as const);

export type HistoricalActionCategory = typeof HISTORICAL_ACTION_CATEGORIES[number];

type UnknownRecord = Record<string, unknown>;

type ActionCounter = Record<HistoricalActionCategory, {
  count: number;
  failedCount: number;
}>;

export interface HistoricalActionSession {
  schemaVersion: 'kernel-historical-action-session.v1';
  provider: 'codex';
  sessionId: string;
  sourceDigest: string;
  workspaceRootDigest: string | null;
  gitRevision: string | null;
  generationRelevance: 'current' | 'resolved' | 'stale' | 'insufficient';
  linkedCaseId: string | null;
  caseLinkStatus: 'exact' | 'unlinked' | 'ambiguous';
  linkedCompletionStatus: string | null;
  actionCount: number;
  classifiedActionCount: number;
  failedActionCount: number;
  commandCount: number;
  exactDuplicateCommandCount: number;
  categories: ActionCounter;
  promotionAuthority: false;
}

export interface HistoricalActionHotspotAnalysis {
  schemaVersion: 'kernel-historical-action-hotspots.v1';
  sessionCount: number;
  linkedSessionCount: number;
  currentLinkedSessionCount: number;
  actionCount: number;
  classifiedActionCount: number;
  classificationCoverage: number | null;
  failedActionCount: number;
  commandCount: number;
  exactDuplicateCommandCount: number;
  categories: Array<{
    category: HistoricalActionCategory;
    count: number;
    failedCount: number;
    sessionCount: number;
    share: number | null;
    failureRate: number | null;
  }>;
  productionRecommendation: 'DEFER';
  reason: string;
  promotionAuthority: false;
}

interface LoadHistoricalActionSessionsOptions {
  dbPath: string;
  projectId: string;
  cases?: readonly HistoricalWorkCase[];
  currentGitRevision?: string | null;
  gitRoot?: string | null;
  env?: NodeJS.ProcessEnv;
  limit?: number;
}

const record = (value: unknown): UnknownRecord => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : {}
);

const text = (value: unknown): string | null => (
  typeof value === 'string' && value.trim() ? value.trim() : null
);

const sha256 = (value: string): string => (
  `sha256:${createHash('sha256').update(value).digest('hex')}`
);

const normalizeWorkspaceRoot = (value: unknown): string | null => {
  let normalized = text(value);
  if (!normalized) return null;
  if (/^file:\/\//iu.test(normalized)) {
    try {
      const parsed = new URL(normalized);
      normalized = decodeURIComponent(parsed.pathname || '');
      if (parsed.host) normalized = `//${parsed.host}${normalized}`;
    } catch {
      normalized = normalized.replace(/^file:\/\/+?/iu, '');
    }
  }
  normalized = normalized.replaceAll('\\', '/').replace(/\/+$/u, '');
  if (/^\/[a-z]:\//iu.test(normalized)) normalized = normalized.slice(1);
  if (/^[a-z]:\//iu.test(normalized)) normalized = normalized.toLowerCase();
  return normalized || null;
};

const matchingProjectRoot = (
  candidate: string | null,
  roots: readonly string[],
): string | null => {
  if (!candidate) return null;
  return roots.find((root) => candidate === root || candidate.startsWith(`${root}/`)) || null;
};

const normalizeSessionId = (value: unknown): string | null => {
  const normalized = text(value)?.replace(/^codex:/iu, '') || null;
  return normalized || null;
};

const emptyCounters = (): ActionCounter => Object.fromEntries(
  HISTORICAL_ACTION_CATEGORIES.map((category) => [category, { count: 0, failedCount: 0 }]),
) as ActionCounter;

const normalizedCommand = (value: unknown): string => String(value || '')
  .replace(/\r?\n/gu, ' ')
  .replace(/\s+/gu, ' ')
  .trim();

const packageScriptName = (command: string): string | null => {
  const npm = command.match(/\b(?:npm|pnpm)\s+(?:run\s+)?([a-z0-9:_.-]+)/iu);
  if (npm?.[1]) return npm[1].toLowerCase();
  const yarn = command.match(/\byarn\s+([a-z0-9:_.-]+)/iu);
  if (yarn?.[1]) return yarn[1].toLowerCase();
  const npx = command.match(/\bnpx\s+([a-z0-9:_.-]+)/iu);
  return npx?.[1]?.toLowerCase() || null;
};

const verificationCategory = (command: string): HistoricalActionCategory | null => {
  const scriptName = packageScriptName(command);
  const lowered = command.toLowerCase();
  const directName = lowered.match(/(?:^|[;&|]\s*)([a-z0-9_.-]+)/u)?.[1] || '';
  const classifierName = scriptName
    || (/\bnode\s+--test\b/u.test(lowered) ? 'test' : directName);
  const commandClass = classifyCommandName(classifierName, lowered);
  if (commandClass === 'script') return null;

  const broadPackageScript = scriptName !== null
    && !scriptName.includes(':')
    && /^(?:test|build|typecheck|lint|check|verify|ci)$/u.test(scriptName);
  const broadDirect = (
    /\bgo\s+test\s+\.\/\.\.\./u.test(lowered)
    || /\bcargo\s+test(?:\s+--workspace)?\s*$/u.test(lowered)
    || /\bpytest\s*$/u.test(lowered)
    || /\bnode\s+--test\s*$/u.test(lowered)
    || /\btsc(?:\.cmd)?\s+--noemit\s*$/u.test(lowered)
  );
  return broadPackageScript || broadDirect
    ? 'full-verification'
    : 'focused-verification';
};

export const classifyHistoricalActionCommand = (
  value: unknown,
): HistoricalActionCategory => {
  const command = normalizedCommand(value);
  if (!command) return 'unclassified';
  const lowered = command.toLowerCase();

  const gitMatch = lowered.match(/(?:^|[;&|]\s*)git(?:\.exe)?\s+([a-z-]+)([^;&|]*)/u);
  const git = gitMatch?.[1] || null;
  const gitArgs = gitMatch?.[2]?.trim() || '';
  if (git) {
    if (git === 'branch') {
      return !gitArgs || /^(?:--show-current|--list|-l|-a|--all)(?:\s|$)/u.test(gitArgs)
        ? 'git-read'
        : 'git-mutation';
    }
    if (git === 'worktree') {
      return /^(?:list)(?:\s|$)/u.test(gitArgs) ? 'git-read' : 'git-mutation';
    }
    if (git === 'tag') {
      return !gitArgs || /^(?:--list|-l)(?:\s|$)/u.test(gitArgs) ? 'git-read' : 'git-mutation';
    }
    if (git === 'remote') {
      return /^(?:add|remove|rm|rename|set-head|set-url|update|prune)(?:\s|$)/u.test(gitArgs)
        ? 'git-mutation'
        : 'git-read';
    }
    if (new Set([
      'add', 'am', 'apply', 'checkout', 'cherry-pick', 'clean', 'commit', 'fetch',
      'merge', 'mv', 'pull', 'push', 'rebase', 'reset', 'restore', 'revert', 'rm',
      'stash', 'switch',
    ]).has(git)) return 'git-mutation';
    if (new Set([
      'cat-file', 'diff', 'diff-tree', 'for-each-ref', 'log', 'ls-files', 'ls-tree',
      'merge-base', 'rev-list', 'rev-parse', 'show', 'status',
    ]).has(git)) return 'git-read';
    return 'unclassified';
  }

  if (
    /\b(?:npm|pnpm|yarn)\s+(?:ci|install|add|update)\b/u.test(lowered)
    || /\bpip(?:3)?\s+install\b/u.test(lowered)
    || /\b(?:apt|apt-get|brew|choco|winget)\s+(?:install|update|upgrade)\b/u.test(lowered)
    || /\b(?:get-ciminstance|get-process|get-command|get-nettcpconnection|get-psdrive|get-location)\b/u.test(lowered)
    || /\bdocker\s+(?:info|version|context|system\s+info)\b/u.test(lowered)
    || /\bwsl(?:\.exe)?\s+(?:--status|--list|-l)\b/u.test(lowered)
  ) return 'environment-setup';

  const verification = verificationCategory(command);
  if (verification) return verification;

  if (/\b(?:moon-relay-kernel(?:\.mjs)?|kernel\.(?:cmd|ps1))\b/u.test(lowered)) {
    return 'kernel-lifecycle';
  }

  if (
    /\b(?:set-content|add-content|out-file|new-item|remove-item|move-item|copy-item|rename-item|apply_patch)\b/u.test(lowered)
    || /(?:^|[^>])>{1,2}(?!=)/u.test(command)
  ) return 'modify';

  if (/\b(?:rg|grep|select-string|findstr)\b/u.test(lowered)) return 'search';

  if (
    /\b(?:get-content|get-childitem|get-item|test-path|get-filehash)\b/u.test(lowered)
    || /(?:^|[;&|]\s*)(?:cat|head|tail)\b/u.test(lowered)
    || /\bsed\s+-n\b/u.test(lowered)
  ) return 'read';

  return 'unclassified';
};

const commandFromToolArguments = (value: unknown): string | null => {
  if (typeof value === 'string') {
    try {
      return commandFromToolArguments(JSON.parse(value));
    } catch {
      return null;
    }
  }
  const args = record(value);
  return text(args.cmd || args.command || args.script);
};

const classifyMcpTool = (item: UnknownRecord): HistoricalActionCategory => {
  const name = text(item.name)?.toLowerCase() || '';
  const command = commandFromToolArguments(item.arguments);
  if (command && /(?:exec|command|shell)/u.test(name)) {
    return classifyHistoricalActionCommand(command);
  }
  if (/(?:checkpoint|complete_work|get_work_context|read_process|list_processes|kernel)/u.test(name)) {
    return 'kernel-lifecycle';
  }
  if (/(?:search|find|grep|query)/u.test(name)) return 'search';
  if (/(?:write|edit|replace|patch|delete|remove|move|copy)/u.test(name)) return 'modify';
  if (/(?:read|open|view|get_file|list_)/u.test(name)) return 'read';
  return 'unclassified';
};

const actionFromItem = (item: UnknownRecord): {
  category: HistoricalActionCategory;
  failed: boolean;
  commandDigest: string | null;
} | null => {
  const itemType = text(item.type);
  if (itemType === 'CommandExecution') {
    const parsed = Array.isArray(item.parsed_cmd) ? record(item.parsed_cmd[0]) : {};
    const commandParts = Array.isArray(item.command) ? item.command : [];
    const command = text(parsed.cmd) || text(commandParts[2]) || commandParts.map(String).join(' ');
    const exitCode = Number(item.exit_code ?? item.exitCode ?? record(item.result).exit_code ?? record(item.result).exitCode);
    const failed = item.status === 'failed' || (Number.isFinite(exitCode) && exitCode !== 0);
    return {
      category: classifyHistoricalActionCommand(command),
      failed,
      commandDigest: command ? normalizedCommand(command).toLowerCase() : null,
    };
  }
  if (itemType === 'FileChange') {
    return { category: 'modify', failed: item.status === 'failed', commandDigest: null };
  }
  if (itemType === 'McpToolCall') {
    return { category: classifyMcpTool(item), failed: item.status === 'failed', commandDigest: null };
  }
  return null;
};

const projectRoots = (db: DatabaseSync, projectId: string): string[] => {
  const roots = new Set<string>();
  const identity = db.prepare('SELECT canonical_root FROM project_identities WHERE project_id=?').get(projectId) as { canonical_root?: unknown } | undefined;
  const canonical = normalizeWorkspaceRoot(identity?.canonical_root);
  if (canonical) roots.add(canonical);
  const workspaces = db.prepare('SELECT canonical_root FROM project_workspaces WHERE project_id=?').all(projectId) as Array<{ canonical_root?: unknown }>;
  for (const workspace of workspaces) {
    const root = normalizeWorkspaceRoot(workspace.canonical_root);
    if (root) roots.add(root);
  }
  return [...roots].sort();
};

const caseLinks = (cases: readonly HistoricalWorkCase[]): Map<string, HistoricalWorkCase[]> => {
  const links = new Map<string, HistoricalWorkCase[]>();
  for (const item of cases) {
    if (item.sessionBindingStatus !== 'explicit') continue;
    const sessionId = normalizeSessionId(item.explicitSessionBinding);
    if (!sessionId) continue;
    const entries = links.get(sessionId) || [];
    entries.push(item);
    links.set(sessionId, entries);
  }
  return links;
};

export const loadHistoricalActionSessions = async ({
  dbPath,
  projectId,
  cases = [],
  currentGitRevision = null,
  gitRoot = null,
  env = process.env,
  limit = 500,
}: LoadHistoricalActionSessionsOptions): Promise<HistoricalActionSession[]> => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  let roots: string[];
  try {
    roots = projectRoots(db, projectId);
  } finally {
    db.close();
  }
  if (roots.length === 0) return [];

  const discovery = await discoverProviderSessions('codex', { limit, env });
  if (discovery.status !== 'ready') return [];
  const links = caseLinks(cases);
  const sessions: HistoricalActionSession[] = [];
  const seenLocators = new Set<string>();

  for (const descriptor of discovery.sessions) {
    if (!descriptor.locator || seenLocators.has(descriptor.locator)) continue;
    seenLocators.add(descriptor.locator);
    const raw = await readFile(descriptor.locator, 'utf8').catch(() => '');
    if (!raw) continue;
    const events = raw.split(/\r?\n/u).filter(Boolean).flatMap((line) => {
      try {
        return [record(JSON.parse(line))];
      } catch {
        return [];
      }
    });
    const meta = record(events.find((event) => event.type === 'session_meta')?.payload);
    const sessionId = normalizeSessionId(meta.session_id || meta.id || descriptor.nativeSessionId);
    if (!sessionId) continue;
    const linked = links.get(sessionId) || [];
    const counters = emptyCounters();
    const commandDigests: string[] = [];
    let failedActionCount = 0;
    let actionCount = 0;
    let commandCount = 0;
    let activeCwd = normalizeWorkspaceRoot(meta.cwd);
    let matchedRoot: string | null = null;

    for (const event of events) {
      if (event.type === 'turn_context') {
        activeCwd = normalizeWorkspaceRoot(record(event.payload).cwd) || activeCwd;
        continue;
      }
      if (event.type !== 'event_msg') continue;
      const payload = record(event.payload);
      if (payload.type !== 'item_completed') continue;
      const item = record(payload.item);
      const actionCwd = normalizeWorkspaceRoot(item.cwd) || activeCwd;
      const actionRoot = matchingProjectRoot(actionCwd, roots);
      if (!actionRoot) continue;
      const action = actionFromItem(item);
      if (!action) continue;
      matchedRoot ||= actionRoot;
      actionCount += 1;
      counters[action.category].count += 1;
      if (action.failed) {
        failedActionCount += 1;
        counters[action.category].failedCount += 1;
      }
      if (action.commandDigest) {
        commandCount += 1;
        commandDigests.push(action.commandDigest);
      }
    }

    if (actionCount === 0) continue;
    const git = record(meta.git);
    const linkedCase = linked.length === 1 ? linked[0]! : null;
    const gitRevision = linkedCase?.gitRevision || text(git.commit_hash);
    sessions.push({
      schemaVersion: 'kernel-historical-action-session.v1',
      provider: 'codex',
      sessionId,
      sourceDigest: sha256(raw),
      workspaceRootDigest: matchedRoot ? sha256(matchedRoot) : null,
      gitRevision,
      generationRelevance: classifyGenerationRelevance({
        gitRevision,
        currentGitRevision,
        gitRoot,
      }),
      linkedCaseId: linkedCase?.caseId || null,
      caseLinkStatus: linked.length === 1 ? 'exact' : linked.length === 0 ? 'unlinked' : 'ambiguous',
      linkedCompletionStatus: linkedCase?.completionStatus || null,
      actionCount,
      classifiedActionCount: actionCount - counters.unclassified.count,
      failedActionCount,
      commandCount,
      exactDuplicateCommandCount: commandCount - new Set(commandDigests).size,
      categories: counters,
      promotionAuthority: false,
    });
  }

  return sessions.sort((left, right) => left.sessionId.localeCompare(right.sessionId));
};

export const analyzeHistoricalActionHotspots = (
  sessions: readonly HistoricalActionSession[],
): HistoricalActionHotspotAnalysis => {
  const actionCount = sessions.reduce((sum, session) => sum + session.actionCount, 0);
  const classifiedActionCount = sessions.reduce((sum, session) => sum + session.classifiedActionCount, 0);
  const failedActionCount = sessions.reduce((sum, session) => sum + session.failedActionCount, 0);
  const commandCount = sessions.reduce((sum, session) => sum + session.commandCount, 0);
  const exactDuplicateCommandCount = sessions.reduce((sum, session) => sum + session.exactDuplicateCommandCount, 0);
  const categories = HISTORICAL_ACTION_CATEGORIES.map((category) => {
    const count = sessions.reduce((sum, session) => sum + session.categories[category].count, 0);
    const failedCount = sessions.reduce((sum, session) => sum + session.categories[category].failedCount, 0);
    return {
      category,
      count,
      failedCount,
      sessionCount: sessions.filter((session) => session.categories[category].count > 0).length,
      share: actionCount > 0 ? count / actionCount : null,
      failureRate: count > 0 ? failedCount / count : null,
    };
  }).sort((left, right) => right.count - left.count || left.category.localeCompare(right.category));

  return {
    schemaVersion: 'kernel-historical-action-hotspots.v1',
    sessionCount: sessions.length,
    linkedSessionCount: sessions.filter((session) => session.caseLinkStatus === 'exact').length,
    currentLinkedSessionCount: sessions.filter((session) => (
      session.caseLinkStatus === 'exact' && session.generationRelevance === 'current'
    )).length,
    actionCount,
    classifiedActionCount,
    classificationCoverage: actionCount > 0 ? classifiedActionCount / actionCount : null,
    failedActionCount,
    commandCount,
    exactDuplicateCommandCount,
    categories,
    productionRecommendation: 'DEFER',
    reason: 'Action hotspots are diagnostic evidence only; scheduler/cache/suppression changes require current-generation repeated causal evidence.',
    promotionAuthority: false,
  };
};
