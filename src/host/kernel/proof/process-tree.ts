import { matchCapture } from '../../../shared/match-capture.js';
import path from 'node:path';
import {
  spawnSync,
  type SpawnSyncReturns,
} from 'node:child_process';

const PROCESS_QUERY_TIMEOUT_MS = 5000;
const CREATION_TOLERANCE_MS = 2000;

type UnknownRecord = Record<string, unknown>;

export interface NormalizedProcessRecord {
  pid: number | null;
  parentPid: number | null;
  commandLine: string;
  creationDate: Date | null;
}

interface ObservedProcessRecord extends NormalizedProcessRecord {
  pid: number;
}

interface VerifiedProcessRecord extends ObservedProcessRecord {
  creationDate: Date;
}

export type ProcessTableResult =
  | {
      status: 'ready';
      processes: NormalizedProcessRecord[];
      reason?: undefined;
    }
  | {
      status: 'not-applicable' | 'unavailable';
      processes: NormalizedProcessRecord[];
      reason?: string;
    };

export interface VerifiedProcessTree {
  status: 'ready';
  launcherPid: number;
  launcher: VerifiedProcessRecord;
  descendants: Array<VerifiedProcessRecord & { depth: number }>;
  targets: number[];
}

export interface BlockedProcessTree {
  status: 'blocked';
  reason: string;
  launcherPid?: number;
  targets: number[];
}

export type ProcessTreeResolution =
  | VerifiedProcessTree
  | BlockedProcessTree;

export interface ProcessKillResult {
  pid: number;
  status: 'killed' | 'already-exited' | 'failed';
  exitCode: number | null;
  output: string;
}

type KillProcess = (pid: number) => ProcessKillResult;
type ReadProcessTable = () => ProcessTableResult;

interface LauncherEvidence {
  pid?: unknown;
  parentPid?: unknown;
  command?: unknown;
  args?: unknown[];
  startedAt?: unknown;
}

const recordOf = (value: unknown): UnknownRecord => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : {}
);

const errorCode = (error: unknown): string => (
  error && typeof error === 'object' && 'code' in error
    ? String(error.code || '')
    : ''
);

const asPid = (value: unknown): number | null => {
  const pid = Number(value);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
};

const normalizeText = (value: unknown): string => String(value || '')
  .replaceAll('\\', '/')
  .replace(/\s+/g, ' ')
  .trim()
  .toLowerCase();

const commandBasename = (value: unknown): string =>
  path.posix.basename(normalizeText(value));

const parseCreationDate = (value: unknown): Date | null => {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  const raw = String(value || '').trim();
  if (!raw) return null;
  const wmi = raw.match(
    /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.(\d+))?/,
  );
  if (wmi) {
    const milliseconds = Number(`0.${wmi[7] || '0'}`) * 1000;
    const date = new Date(Date.UTC(
      Number(matchCapture(wmi, 1)),
      Number(matchCapture(wmi, 2)) - 1,
      Number(matchCapture(wmi, 3)),
      Number(matchCapture(wmi, 4)),
      Number(matchCapture(wmi, 5)),
      Number(matchCapture(wmi, 6)),
      milliseconds,
    ));
    if (!Number.isNaN(date.getTime())) return date;
  }
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
};

export const normalizeProcessRecord = (
  record: unknown = {},
): NormalizedProcessRecord => {
  const source = recordOf(record);
  return {
    pid: asPid(source.pid ?? source.ProcessId),
    parentPid: asPid(source.parentPid ?? source.ParentProcessId),
    commandLine: String(
      source.commandLine ?? source.CommandLine ?? '',
    ).trim(),
    creationDate: parseCreationDate(
      source.creationDate ?? source.CreationDate,
    ),
  };
};

const powershellProcessSnapshot = (): SpawnSyncReturns<string> => spawnSync(
  'powershell.exe',
  [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    'Get-CimInstance -ClassName Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine,CreationDate | ConvertTo-Json -Compress',
  ],
  {
    encoding: 'utf8',
    timeout: PROCESS_QUERY_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  },
);

export const readWindowsProcessTable = ({
  snapshot = null,
}: {
  snapshot?: unknown[] | null;
} = {}): ProcessTableResult => {
  if (snapshot) {
    return {
      status: 'ready',
      processes: snapshot.map(normalizeProcessRecord),
    };
  }
  if (process.platform !== 'win32') {
    return { status: 'not-applicable', processes: [] };
  }
  const result = powershellProcessSnapshot();
  if (result.error || result.status !== 0) {
    return {
      status: 'unavailable',
      processes: [],
      reason: errorCode(result.error) === 'ETIMEDOUT'
        ? 'process-table-timeout'
        : 'process-table-query-failed',
    };
  }
  try {
    const parsed: unknown = JSON.parse(String(result.stdout || '[]'));
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return {
      status: 'ready',
      processes: rows
        .map(normalizeProcessRecord)
        .filter((row) => row.pid !== null),
    };
  } catch {
    return {
      status: 'unavailable',
      processes: [],
      reason: 'process-table-invalid-json',
    };
  }
};

const isOlderThan = (
  date: Date | null | undefined,
  boundary: Date | null | undefined,
  toleranceMs = 0,
): boolean => Boolean(
  date
  && boundary
  && date.getTime() < boundary.getTime() - toleranceMs,
);

const isObservedProcess = (
  record: NormalizedProcessRecord,
): record is ObservedProcessRecord => record.pid !== null;

const isProcessAncestor = ({
  candidatePid,
  descendantPid,
  byPid,
}: {
  candidatePid: number;
  descendantPid: number;
  byPid: Map<number, ObservedProcessRecord>;
}): boolean => {
  let cursor = byPid.get(descendantPid);
  const visited = new Set<number>();
  while (cursor?.parentPid && !visited.has(cursor.pid)) {
    visited.add(cursor.pid);
    if (cursor.parentPid === candidatePid) return true;
    cursor = byPid.get(cursor.parentPid);
  }
  return false;
};

const commandLineMatches = ({
  commandLine,
  expectedCommand,
  expectedArgs = [],
}: {
  commandLine: unknown;
  expectedCommand: unknown;
  expectedArgs?: readonly unknown[];
}): boolean => {
  const line = normalizeText(commandLine);
  const command = normalizeText(expectedCommand);
  if (!line || !command) return false;
  const candidates = [
    ...new Set([command, commandBasename(command)].filter(Boolean)),
  ];
  if (!candidates.some((candidate) => line.includes(candidate))) {
    return false;
  }
  return expectedArgs.every(
    (arg) => line.includes(normalizeText(arg)),
  );
};

export const resolveVerifiedProcessTree = ({
  processes = [],
  launcherPid,
  expectedCommand = null,
  expectedArgs = [],
  startedAt = null,
  currentPid = process.pid,
}: {
  processes?: unknown[];
  launcherPid?: unknown;
  expectedCommand?: unknown;
  expectedArgs?: unknown[];
  startedAt?: (Date | null) | undefined;
  currentPid?: number;
} = {}): ProcessTreeResolution => {
  const normalized = processes
    .map(normalizeProcessRecord)
    .filter(isObservedProcess);
  const byPid = new Map(
    normalized.map((record) => [record.pid, record]),
  );
  const rootPid = asPid(launcherPid);
  if (!rootPid) {
    return {
      status: 'blocked',
      reason: 'launcher-pid-missing',
      targets: [],
    };
  }
  const root = byPid.get(rootPid);
  if (!root) {
    return {
      status: 'blocked',
      reason: 'launcher-not-observed',
      launcherPid: rootPid,
      targets: [],
    };
  }
  if (
    rootPid === currentPid
    || isProcessAncestor({
      candidatePid: rootPid,
      descendantPid: currentPid,
      byPid,
    })
  ) {
    return {
      status: 'blocked',
      reason: 'host-ancestor-protected',
      launcherPid: rootPid,
      targets: [],
    };
  }
  if (!root.commandLine || !root.creationDate) {
    return {
      status: 'blocked',
      reason: 'launcher-lineage-incomplete',
      launcherPid: rootPid,
      targets: [],
    };
  }
  if (
    startedAt
    && isOlderThan(
      root.creationDate,
      startedAt,
      CREATION_TOLERANCE_MS,
    )
  ) {
    return {
      status: 'blocked',
      reason: 'launcher-creation-stale',
      launcherPid: rootPid,
      targets: [],
    };
  }
  if (!commandLineMatches({
    commandLine: root.commandLine,
    expectedCommand,
    expectedArgs,
  })) {
    return {
      status: 'blocked',
      reason: 'launcher-command-mismatch',
      launcherPid: rootPid,
      targets: [],
    };
  }

  const verifiedRoot: VerifiedProcessRecord = {
    ...root,
    creationDate: root.creationDate,
  };
  const descendants: Array<VerifiedProcessRecord & { depth: number }> = [];
  const queue: Array<{ record: VerifiedProcessRecord; depth: number }> = [
    { record: verifiedRoot, depth: 0 },
  ];
  const seen = new Set<number>([rootPid]);
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    const { record, depth } = current;
    for (const child of normalized) {
      if (
        child.parentPid !== record.pid
        || seen.has(child.pid)
      ) {
        continue;
      }
      if (
        child.pid === currentPid
        || isProcessAncestor({
          candidatePid: child.pid,
          descendantPid: currentPid,
          byPid,
        })
      ) {
        return {
          status: 'blocked',
          reason: 'host-process-in-target-tree',
          launcherPid: rootPid,
          targets: [],
        };
      }
      if (
        !child.commandLine
        || !child.creationDate
        || isOlderThan(child.creationDate, record.creationDate)
      ) {
        return {
          status: 'blocked',
          reason: 'descendant-lineage-incomplete-or-reused',
          launcherPid: rootPid,
          targets: [],
        };
      }
      const verifiedChild: VerifiedProcessRecord = {
        ...child,
        creationDate: child.creationDate,
      };
      seen.add(child.pid);
      descendants.push({
        ...verifiedChild,
        depth: depth + 1,
      });
      queue.push({
        record: verifiedChild,
        depth: depth + 1,
      });
    }
  }

  const targets = [
    ...descendants
      .sort((left, right) => right.depth - left.depth)
      .map((record) => record.pid),
    verifiedRoot.pid,
  ];
  return {
    status: 'ready',
    launcherPid: verifiedRoot.pid,
    launcher: verifiedRoot,
    descendants,
    targets,
  };
};

const defaultKillProcess: KillProcess = (pid) => {
  const result = spawnSync(
    'taskkill.exe',
    ['/PID', String(pid), '/T', '/F'],
    {
      encoding: 'utf8',
      timeout: PROCESS_QUERY_TIMEOUT_MS,
      windowsHide: true,
    },
  );
  const output = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
  const alreadyExited = result.status !== 0
    && /not found|no running instance|does not exist/i.test(output);
  return {
    pid,
    status: result.status === 0
      ? 'killed'
      : alreadyExited
        ? 'already-exited'
        : 'failed',
    exitCode: result.status,
    output: output.slice(-500),
  };
};

export const teardownVerifiedProcessTree = ({
  tree,
  killProcess = defaultKillProcess,
  remainingPids = null,
}: {
  tree?: ProcessTreeResolution | null;
  killProcess?: KillProcess;
  remainingPids?: number[] | null;
} = {}) => {
  if (!tree || tree.status !== 'ready') {
    return {
      status: 'blocked',
      reason: tree?.reason || 'lineage-not-verified',
      targetPids: [] as number[],
    };
  }
  const results = tree.targets.map(
    (pid) => killProcess(pid),
  );
  const failed = results.filter(
    (result) => !['killed', 'already-exited'].includes(result.status),
  );
  const survivors = Array.isArray(remainingPids)
    ? remainingPids.filter((pid) => tree.targets.includes(pid))
    : [];
  return {
    status: failed.length > 0 || survivors.length > 0
      ? 'failed'
      : 'completed',
    launcherPid: tree.launcherPid,
    targetPids: tree.targets,
    results,
    survivors,
    reason: failed.length > 0
      ? 'process-tree-kill-failed'
      : survivors.length > 0
        ? 'descendants-survived'
        : null,
  };
};

export const cleanupWindowsTimeoutProcessTree = ({
  launcherPid,
  expectedCommand,
  expectedArgs = [],
  startedAt,
  processTable = null,
  launchProcessTable = null,
  launcherEvidence = null,
  killProcess = defaultKillProcess,
  readProcessTable = readWindowsProcessTable,
  currentPid = process.pid,
  platform = process.platform,
}: {
  launcherPid?: unknown;
  expectedCommand?: unknown;
  expectedArgs?: unknown[];
  startedAt?: Date | null;
  processTable?: ProcessTableResult | null;
  launchProcessTable?: ProcessTableResult | null;
  launcherEvidence?: LauncherEvidence | null;
  killProcess?: KillProcess;
  readProcessTable?: ReadProcessTable;
  currentPid?: number;
  platform?: NodeJS.Platform;
} = {}) => {
  if (platform !== 'win32') {
    return {
      status: 'not-applicable',
      platform,
      targetPids: [] as number[],
    };
  }
  const snapshot = processTable || readProcessTable();
  if (snapshot.status !== 'ready') {
    return {
      status: 'blocked',
      platform,
      reason: snapshot.reason || 'process-table-unavailable',
      targetPids: [] as number[],
    };
  }
  const current = snapshot.processes
    .map(normalizeProcessRecord)
    .filter(isObservedProcess);
  const currentPids = new Set(
    current.map((record) => record.pid),
  );
  let tree = resolveVerifiedProcessTree({
    processes: current,
    launcherPid,
    expectedCommand,
    expectedArgs,
    startedAt,
    currentPid,
  });
  let lineageSource = 'cleanup-snapshot';

  if (
    tree.status !== 'ready'
    && ['launcher-not-observed', 'launcher-lineage-incomplete']
      .includes(tree.reason)
    && launcherEvidence !== null
    && Number(launcherEvidence.pid) === Number(launcherPid)
    && normalizeText(launcherEvidence.command)
      === normalizeText(expectedCommand)
    && (launcherEvidence.args || []).length === expectedArgs.length
    && (launcherEvidence.args || []).every(
      (arg, index) => normalizeText(arg)
        === normalizeText(expectedArgs[index]),
    )
  ) {
    const launchRows = launchProcessTable?.status === 'ready'
      ? launchProcessTable.processes
          .map(normalizeProcessRecord)
          .filter(isObservedProcess)
      : [];
    const retainedRoot = launchRows.find(
      (record) => record.pid === Number(launcherPid),
    ) || null;
    const currentRoot = current.find(
      (record) => record.pid === Number(launcherPid),
    ) || null;
    if (
      currentRoot?.creationDate
      && retainedRoot?.creationDate
      && Math.abs(
        currentRoot.creationDate.getTime()
        - retainedRoot.creationDate.getTime(),
      ) > CREATION_TOLERANCE_MS
    ) {
      return {
        status: 'blocked',
        platform,
        reason: 'launcher-pid-reused',
        launcherPid: Number(launcherPid),
        targetPids: [] as number[],
      };
    }
    const root: NormalizedProcessRecord = {
      pid: Number(launcherPid),
      parentPid:
        currentRoot?.parentPid
        || retainedRoot?.parentPid
        || Number(launcherEvidence.parentPid)
        || null,
      commandLine:
        currentRoot?.commandLine
        || retainedRoot?.commandLine
        || [
          String(launcherEvidence.command || ''),
          ...(launcherEvidence.args || []).map(String),
        ].join(' '),
      creationDate:
        currentRoot?.creationDate
        || retainedRoot?.creationDate
        || parseCreationDate(
          launcherEvidence.startedAt || startedAt,
        ),
    };
    tree = resolveVerifiedProcessTree({
      processes: [
        ...current.filter((record) => record.pid !== root.pid),
        root,
      ],
      launcherPid,
      expectedCommand,
      expectedArgs,
      startedAt,
      currentPid,
    });
    lineageSource = retainedRoot
      ? 'launch-snapshot'
      : 'host-spawn-evidence';
  }

  if (tree.status !== 'ready') {
    return {
      ...tree,
      platform,
      targetPids: [] as number[],
    };
  }
  const liveTargets = tree.targets.filter(
    (pid) => currentPids.has(pid),
  );
  if (liveTargets.length === 0) {
    return {
      status: 'completed',
      platform,
      launcherPid: tree.launcherPid,
      targetPids: [] as number[],
      results: [] as ProcessKillResult[],
      survivors: [] as number[],
      reason: null,
      classification: 'launcher-exited-no-observed-descendants',
      lineageSource,
    };
  }
  const cleanup = teardownVerifiedProcessTree({
    tree: { ...tree, targets: liveTargets },
    killProcess,
  });
  const postSnapshot = readProcessTable();
  if (postSnapshot.status !== 'ready') {
    return {
      ...cleanup,
      status: 'blocked',
      platform,
      launcherPid: tree.launcherPid,
      targetPids: liveTargets,
      survivors: [] as number[],
      reason: 'post-cleanup-process-table-unavailable',
    };
  }
  const remainingPids = postSnapshot.processes
    .map((record) => normalizeProcessRecord(record).pid)
    .filter((pid): pid is number => pid !== null);
  const survivors = remainingPids.filter(
    (pid) => liveTargets.includes(pid),
  );
  const results: ProcessKillResult[] = 'results' in cleanup
    && Array.isArray(cleanup.results)
    ? cleanup.results
    : [];
  const failed = results.filter(
    (result) => !['killed', 'already-exited'].includes(result.status),
  );
  return {
    ...cleanup,
    status: failed.length > 0 || survivors.length > 0
      ? 'failed'
      : 'completed',
    survivors,
    reason: failed.length > 0
      ? 'process-tree-kill-failed'
      : survivors.length > 0
        ? 'descendants-survived'
        : null,
    platform,
    lineageSource,
  };
};
