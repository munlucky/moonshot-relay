import path from 'node:path';
import { spawnSync } from 'node:child_process';

const PROCESS_QUERY_TIMEOUT_MS = 5000;
const CREATION_TOLERANCE_MS = 2000;

const asPid = (value) => {
  const pid = Number(value);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
};

const normalizeText = (value) => String(value || '').replaceAll('\\', '/').replace(/\s+/g, ' ').trim().toLowerCase();
const commandBasename = (value) => path.posix.basename(normalizeText(value));

const parseCreationDate = (value) => {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  const raw = String(value || '').trim();
  if (!raw) return null;
  const wmi = raw.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.(\d+))?/);
  if (wmi) {
    const milliseconds = Number(`0.${wmi[7] || '0'}`) * 1000;
    const date = new Date(Date.UTC(
      Number(wmi[1]), Number(wmi[2]) - 1, Number(wmi[3]),
      Number(wmi[4]), Number(wmi[5]), Number(wmi[6]), milliseconds,
    ));
    if (!Number.isNaN(date.getTime())) return date;
  }
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
};

export const normalizeProcessRecord = (record = {}) => ({
  pid: asPid(record.pid ?? record.ProcessId),
  parentPid: asPid(record.parentPid ?? record.ParentProcessId),
  commandLine: String(record.commandLine ?? record.CommandLine ?? '').trim(),
  creationDate: parseCreationDate(record.creationDate ?? record.CreationDate),
});

const powershellProcessSnapshot = () => spawnSync(
  'powershell.exe',
  [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    'Get-CimInstance -ClassName Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine,CreationDate | ConvertTo-Json -Compress',
  ],
  { encoding: 'utf8', timeout: PROCESS_QUERY_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
);

export const readWindowsProcessTable = ({ snapshot = null } = {}) => {
  if (snapshot) return { status: 'ready', processes: snapshot.map(normalizeProcessRecord) };
  if (process.platform !== 'win32') return { status: 'not-applicable', processes: [] };
  const result = powershellProcessSnapshot();
  if (result.error || result.status !== 0) {
    return {
      status: 'unavailable',
      processes: [],
      reason: result.error?.code === 'ETIMEDOUT' ? 'process-table-timeout' : 'process-table-query-failed',
    };
  }
  try {
    const parsed = JSON.parse(String(result.stdout || '[]'));
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return { status: 'ready', processes: rows.map(normalizeProcessRecord).filter((row) => row.pid !== null) };
  } catch {
    return { status: 'unavailable', processes: [], reason: 'process-table-invalid-json' };
  }
};

const isOlderThan = (date, boundary, toleranceMs = 0) => Boolean(
  date && boundary && date.getTime() < boundary.getTime() - toleranceMs,
);

const isProcessAncestor = ({ candidatePid, descendantPid, byPid }) => {
  let cursor = byPid.get(descendantPid);
  const visited = new Set();
  while (cursor?.parentPid && !visited.has(cursor.pid)) {
    visited.add(cursor.pid);
    if (cursor.parentPid === candidatePid) return true;
    cursor = byPid.get(cursor.parentPid);
  }
  return false;
};

const commandLineMatches = ({ commandLine, expectedCommand, expectedArgs = [] }) => {
  const line = normalizeText(commandLine);
  const command = normalizeText(expectedCommand);
  if (!line || !command) return false;
  const candidates = [...new Set([command, commandBasename(command)].filter(Boolean))];
  if (!candidates.some((candidate) => line.includes(candidate))) return false;
  return expectedArgs.every((arg) => line.includes(normalizeText(arg)));
};

export const resolveVerifiedProcessTree = ({
  processes = [],
  launcherPid,
  expectedCommand = null,
  expectedArgs = [],
  startedAt = null,
  currentPid = process.pid,
} = {}) => {
  const normalized = processes.map(normalizeProcessRecord).filter((record) => record.pid !== null);
  const byPid = new Map(normalized.map((record) => [record.pid, record]));
  const rootPid = asPid(launcherPid);
  if (!rootPid) return { status: 'blocked', reason: 'launcher-pid-missing', targets: [] };
  const root = byPid.get(rootPid);
  if (!root) return { status: 'blocked', reason: 'launcher-not-observed', launcherPid: rootPid, targets: [] };
  if (rootPid === currentPid || isProcessAncestor({ candidatePid: rootPid, descendantPid: currentPid, byPid })) {
    return { status: 'blocked', reason: 'host-ancestor-protected', launcherPid: rootPid, targets: [] };
  }
  if (!root.commandLine || !root.creationDate) {
    return { status: 'blocked', reason: 'launcher-lineage-incomplete', launcherPid: rootPid, targets: [] };
  }
  if (startedAt && isOlderThan(root.creationDate, startedAt, CREATION_TOLERANCE_MS)) {
    return { status: 'blocked', reason: 'launcher-creation-stale', launcherPid: rootPid, targets: [] };
  }
  if (!commandLineMatches({ commandLine: root.commandLine, expectedCommand, expectedArgs })) {
    return { status: 'blocked', reason: 'launcher-command-mismatch', launcherPid: rootPid, targets: [] };
  }

  const descendants = [];
  const queue = [{ record: root, depth: 0 }];
  const seen = new Set([rootPid]);
  while (queue.length > 0) {
    const { record, depth } = queue.shift();
    for (const child of normalized) {
      if (child.parentPid !== record.pid || seen.has(child.pid)) continue;
      if (child.pid === currentPid || isProcessAncestor({ candidatePid: child.pid, descendantPid: currentPid, byPid })) {
        return { status: 'blocked', reason: 'host-process-in-target-tree', launcherPid: rootPid, targets: [] };
      }
      if (!child.commandLine || !child.creationDate || isOlderThan(child.creationDate, root.creationDate)) {
        return { status: 'blocked', reason: 'descendant-lineage-incomplete-or-reused', launcherPid: rootPid, targets: [] };
      }
      seen.add(child.pid);
      descendants.push({ ...child, depth: depth + 1 });
      queue.push({ record: child, depth: depth + 1 });
    }
  }

  const targets = [
    ...descendants.sort((a, b) => b.depth - a.depth).map((record) => record.pid),
    root.pid,
  ];
  return { status: 'ready', launcherPid: root.pid, launcher: root, descendants, targets };
};

const defaultKillProcess = (pid) => {
  const result = spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
    encoding: 'utf8',
    timeout: PROCESS_QUERY_TIMEOUT_MS,
    windowsHide: true,
  });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
  const alreadyExited = result.status !== 0 && /not found|no running instance|does not exist/i.test(output);
  return {
    pid,
    status: result.status === 0 ? 'killed' : alreadyExited ? 'already-exited' : 'failed',
    exitCode: result.status,
    output: output.slice(-500),
  };
};

export const teardownVerifiedProcessTree = ({ tree, killProcess = defaultKillProcess, remainingPids = null } = {}) => {
  if (!tree || tree.status !== 'ready') {
    return { status: 'blocked', reason: tree?.reason || 'lineage-not-verified', targetPids: [] };
  }
  const results = tree.targets.map((pid) => killProcess(pid));
  const failed = results.filter((result) => !['killed', 'already-exited'].includes(result?.status));
  const survivors = Array.isArray(remainingPids) ? remainingPids.filter((pid) => tree.targets.includes(pid)) : [];
  return {
    status: failed.length > 0 || survivors.length > 0 ? 'failed' : 'completed',
    launcherPid: tree.launcherPid,
    targetPids: tree.targets,
    results,
    survivors,
    reason: failed.length > 0 ? 'process-tree-kill-failed' : survivors.length > 0 ? 'descendants-survived' : null,
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
} = {}) => {
  if (platform !== 'win32') return { status: 'not-applicable', platform, targetPids: [] };
  const snapshot = processTable || readProcessTable();
  if (snapshot.status !== 'ready') return { status: 'blocked', platform, reason: snapshot.reason || 'process-table-unavailable', targetPids: [] };
  const current = snapshot.processes.map(normalizeProcessRecord).filter((record) => record.pid !== null);
  const currentPids = new Set(current.map((record) => record.pid));
  let tree = resolveVerifiedProcessTree({
    processes: current,
    launcherPid,
    expectedCommand,
    expectedArgs,
    startedAt,
    currentPid,
  });
  let lineageSource = 'cleanup-snapshot';

  // The Windows process table can lose CommandLine/CreationDate fields, or the
  // launcher can exit between the timeout signal and the cleanup snapshot.
  // Retain the Host-owned spawn identity plus an immediate post-spawn snapshot
  // so timeout cleanup can still prove descendants without guessing a PID.
  // A current, conflicting row is never overwritten: possible PID reuse stays
  // fail-closed.
  if (tree.status !== 'ready'
    && ['launcher-not-observed', 'launcher-lineage-incomplete'].includes(tree.reason)
    && Number(launcherEvidence?.pid) === Number(launcherPid)
    && normalizeText(launcherEvidence?.command) === normalizeText(expectedCommand)
    && (launcherEvidence?.args || []).length === expectedArgs.length
    && (launcherEvidence?.args || []).every((arg, index) => normalizeText(arg) === normalizeText(expectedArgs[index]))) {
    const launchRows = launchProcessTable?.status === 'ready'
      ? launchProcessTable.processes.map(normalizeProcessRecord).filter((record) => record.pid !== null)
      : [];
    const retainedRoot = launchRows.find((record) => record.pid === Number(launcherPid)) || null;
    const currentRoot = current.find((record) => record.pid === Number(launcherPid)) || null;
    if (currentRoot?.creationDate && retainedRoot?.creationDate
      && Math.abs(currentRoot.creationDate.getTime() - retainedRoot.creationDate.getTime()) > CREATION_TOLERANCE_MS) {
      return { status: 'blocked', platform, reason: 'launcher-pid-reused', launcherPid: Number(launcherPid), targetPids: [] };
    }
    const root = {
      pid: Number(launcherPid),
      parentPid: currentRoot?.parentPid || retainedRoot?.parentPid || Number(launcherEvidence.parentPid) || null,
      commandLine: currentRoot?.commandLine || retainedRoot?.commandLine
        || [launcherEvidence.command, ...(launcherEvidence.args || [])].join(' '),
      creationDate: currentRoot?.creationDate || retainedRoot?.creationDate
        || parseCreationDate(launcherEvidence.startedAt || startedAt),
    };
    tree = resolveVerifiedProcessTree({
      processes: [...current.filter((record) => record.pid !== root.pid), root],
      launcherPid,
      expectedCommand,
      expectedArgs,
      startedAt,
      currentPid,
    });
    lineageSource = retainedRoot ? 'launch-snapshot' : 'host-spawn-evidence';
  }
  if (tree.status !== 'ready') return { ...tree, platform, targetPids: [] };
  const liveTargets = tree.targets.filter((pid) => currentPids.has(pid));
  if (liveTargets.length === 0) {
    return {
      status: 'completed',
      platform,
      launcherPid: tree.launcherPid,
      targetPids: [],
      results: [],
      survivors: [],
      reason: null,
      classification: 'launcher-exited-no-observed-descendants',
      lineageSource,
    };
  }
  const cleanup = teardownVerifiedProcessTree({ tree: { ...tree, targets: liveTargets }, killProcess });
  // Survivor accounting is meaningful only after taskkill has run. A snapshot
  // taken before this point merely repeats the pre-kill target list.
  const postSnapshot = readProcessTable();
  if (postSnapshot.status !== 'ready') {
    return {
      ...cleanup,
      status: 'blocked',
      platform,
      launcherPid: tree.launcherPid,
      targetPids: liveTargets,
      survivors: [],
      reason: 'post-cleanup-process-table-unavailable',
    };
  }
  const remainingPids = postSnapshot.processes.map((record) => normalizeProcessRecord(record).pid).filter(Boolean);
  const survivors = remainingPids.filter((pid) => liveTargets.includes(pid));
  const failed = cleanup.results.filter((result) => !['killed', 'already-exited'].includes(result?.status));
  return {
    ...cleanup,
    status: failed.length > 0 || survivors.length > 0 ? 'failed' : 'completed',
    survivors,
    reason: failed.length > 0 ? 'process-tree-kill-failed' : survivors.length > 0 ? 'descendants-survived' : null,
    platform,
    lineageSource,
  };
};
