import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  spawnSync,
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
} from 'node:child_process';
import { resolveNetworkExecution } from './network-policy.js';
import {
  discoverProjectCommands,
  findProjectCommand,
} from '../../../contracts/command-catalog.js';
import { observeProjectCommandDeclarations } from './project-command-observation.js';
import { sanitizePersistentText } from '../../../shared/persistent-sanitizer.js';
import { cleanupWindowsTimeoutProcessTree } from './process-tree.js';

const COMMAND_REF_REGEX = /^[A-Za-z0-9:._/-]+$/;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_OUTPUT_BUFFER = 32 * 1024 * 1024;
const ERROR_SUMMARY_LIMIT = 2000;

const ENV_ALLOWLIST = [
  'PATH', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'ComSpec', 'COMSPEC',
  'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
  'ProgramFiles', 'ProgramData', 'SHELL', 'LANG', 'LC_ALL', 'TZ',
] as const;

interface WindowsExecutable {
  file: string;
  needsCommandProcessor: boolean;
}

interface TrustedCommand {
  kind: string;
  commandRef: string;
  commandClass: string;
  ecosystem: string;
  command: string;
  args: string[];
  resolvedScript: string;
}

interface RunResolvedCommandInput {
  projectRoot: string;
  command: string;
  args: string[];
  label: string;
  trust: string;
  timeoutMs: number;
  evidenceDir?: string | null;
  networkPolicy?: unknown;
  env?: NodeJS.ProcessEnv;
}

import type { CommandApproval, ProofExecutionResult, TrustedProofInput, ApprovedProofInput, FlakyExecutionLike } from '../../../contracts/proof-execution.js';
export type { ProofExecutionResult } from '../../../contracts/proof-execution.js';

export class UntrustedCommandError extends Error {
  readonly code = 'UNTRUSTED_COMMAND';

  constructor(message: string) {
    super(message);
    this.name = 'UntrustedCommandError';
  }
}

export class CommandApprovalRequiredError extends Error {
  readonly code = 'COMMAND_APPROVAL_REQUIRED';

  constructor(message: string) {
    super(message);
    this.name = 'CommandApprovalRequiredError';
  }
}

const sha256 = (value: string | Buffer): string =>
  `sha256:${createHash('sha256').update(value).digest('hex')}`;

const childErrorCode = (error: unknown): string => (
  error && typeof error === 'object' && 'code' in error
    ? String(error.code || '')
    : ''
);

const timeoutCleanupDetail = (
  cleanup: ReturnType<typeof cleanupWindowsTimeoutProcessTree> | null,
): string | null => {
  if (!cleanup || cleanup.status === 'completed' || cleanup.status === 'not-applicable') {
    return null;
  }
  return 'reason' in cleanup && cleanup.reason
    ? String(cleanup.reason)
    : String(cleanup.status);
};

export const redactSecretLikeOutput = (text: unknown): string =>
  String(text || '')
    .replace(
      /((?:api[_-]?key|access[_-]?key|secret|token|password|passwd|authorization|bearer)["']?\s*[:=]\s*)(["']?)[^\s"'&]+\2/gi,
      '$1$2[REDACTED]$2',
    )
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
      '[REDACTED PRIVATE KEY]',
    );

const buildChildEnv = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ENV_ALLOWLIST) {
    if (process.env[key] !== undefined) {
      env[key] = process.env[key];
    }
  }
  return env;
};

export const resolveWindowsExecutable = (
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): WindowsExecutable | null => {
  if (
    path.isAbsolute(command)
    || command.includes('/')
    || command.includes('\\')
  ) {
    return {
      file: command,
      needsCommandProcessor: /\.(cmd|bat)$/i.test(command),
    };
  }
  const extensions = ['.EXE', '.COM', '.CMD', '.BAT'];
  const searchPath = String(env.PATH || env.Path || '')
    .split(path.delimiter)
    .filter(Boolean);
  for (const dir of searchPath) {
    for (const extension of extensions) {
      const candidate = path.join(dir, `${command}${extension}`);
      if (existsSync(candidate)) {
        return {
          file: candidate,
          needsCommandProcessor: /\.(cmd|bat)$/i.test(extension),
        };
      }
    }
  }
  return null;
};

export const assertSafeCommandTokens = (
  tokens: readonly unknown[] = [],
  {
    commandProcessor = false,
  }: {
    commandProcessor?: boolean;
  } = {},
): string[] => {
  const safe: string[] = [];
  for (const token of tokens) {
    if (typeof token !== 'string') {
      throw new UntrustedCommandError(
        `Command token must be a string: ${JSON.stringify(token)}`,
      );
    }
    if (/[\x00-\x1f]/.test(token)) {
      throw new UntrustedCommandError(
        `Command token contains control characters: ${JSON.stringify(token)}`,
      );
    }
    if (commandProcessor && /["%]/.test(token)) {
      throw new UntrustedCommandError(
        `Command token cannot be safely quoted for the Windows command processor: ${JSON.stringify(token)}`,
      );
    }
    safe.push(token);
  }
  return safe;
};

export const resolveTrustedCommand = ({
  projectRoot = process.cwd(),
  commandRef,
}: {
  projectRoot?: string;
  commandRef?: (string | null) | undefined;
} = {}): TrustedCommand => {
  if (
    !commandRef
    || typeof commandRef !== 'string'
    || !COMMAND_REF_REGEX.test(commandRef)
  ) {
    throw new UntrustedCommandError(
      `commandRef must match ${COMMAND_REF_REGEX}: ${String(commandRef)}`,
    );
  }
  const commands = discoverProjectCommands({
    observation: observeProjectCommandDeclarations({ projectRoot }),
  });
  const found = findProjectCommand({ commands, commandRef });
  if (!found) {
    const available = commands.map((command) => command.commandRef);
    throw new UntrustedCommandError(
      available.length > 0
        ? `Command ref is not declared by this project: ${commandRef} (declared: ${available.slice(0, 20).join(', ')})`
        : `No project manifest declares any runnable command at ${projectRoot}; cannot resolve trusted command`,
    );
  }
  return {
    kind: found.ecosystem === 'node'
      ? 'manifest-script'
      : `${found.ecosystem}-command`,
    commandRef,
    commandClass: found.commandClass,
    ecosystem: found.ecosystem,
    command: found.command,
    args: found.args,
    resolvedScript: found.declaration,
  };
};

const runResolvedCommand = ({
  projectRoot,
  command,
  args,
  label,
  trust,
  timeoutMs,
  evidenceDir,
  networkPolicy = 'inherited',
  env = process.env,
}: RunResolvedCommandInput): ProofExecutionResult => {
  const network = resolveNetworkExecution({
    policy: networkPolicy,
    env,
  });
  const wrapped = network.wrapArgv(command, args);
  const effectiveTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? Math.min(timeoutMs, 30 * 60 * 1000)
    : DEFAULT_TIMEOUT_MS;
  const startedAt = new Date();
  const spawnOptions: SpawnSyncOptionsWithStringEncoding = {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: effectiveTimeout,
    maxBuffer: MAX_OUTPUT_BUFFER,
    env: buildChildEnv(),
  };
  let expectedCommand = wrapped.command;
  let result: SpawnSyncReturns<string>;

  if (process.platform === 'win32') {
    const resolved = resolveWindowsExecutable(
      wrapped.command,
      spawnOptions.env,
    );
    if (!resolved) {
      throw new UntrustedCommandError(
        `Executable not found on PATH: ${wrapped.command}`,
      );
    }
    expectedCommand = resolved.file;
    const safeTokens = assertSafeCommandTokens(
      [resolved.file, ...wrapped.args],
      { commandProcessor: resolved.needsCommandProcessor },
    );
    result = resolved.needsCommandProcessor
      ? spawnSync(
          process.env.ComSpec || process.env.COMSPEC || 'cmd.exe',
          [
            '/d',
            '/s',
            '/c',
            `"${safeTokens.map((token) => `"${token}"`).join(' ')}"`,
          ],
          { ...spawnOptions, windowsVerbatimArguments: true },
        )
      : spawnSync(resolved.file, wrapped.args, spawnOptions);
  } else {
    assertSafeCommandTokens([wrapped.command, ...wrapped.args]);
    result = spawnSync(
      wrapped.command,
      wrapped.args,
      spawnOptions,
    );
  }

  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  const timedOut = childErrorCode(result.error) === 'ETIMEDOUT';
  const spawnFailed = Boolean(result.error && !timedOut);
  const exitCode = typeof result.status === 'number'
    ? result.status
    : 1;
  const timeoutCleanup = timedOut
    ? cleanupWindowsTimeoutProcessTree({
        launcherPid: result.pid,
        expectedCommand,
        expectedArgs: wrapped.args,
        startedAt,
      })
    : null;

  let evidenceRef: string | null = null;
  if (evidenceDir) {
    const stamp = `${startedAt.toISOString().replace(/[:.]/g, '-')}-${String(label).replace(/[^A-Za-z0-9_-]/g, '_')}`;
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(
      path.join(evidenceDir, `${stamp}.stdout.log`),
      sanitizePersistentText(stdout),
    );
    writeFileSync(
      path.join(evidenceDir, `${stamp}.stderr.log`),
      sanitizePersistentText(stderr),
    );
    evidenceRef = `evidence://proof/${stamp}`;
  }

  const failed = timedOut || spawnFailed || exitCode !== 0;
  const cleanupDetail = timeoutCleanupDetail(timeoutCleanup);
  const errorSummary = failed
    ? redactSecretLikeOutput(
        `${result.error ? `${result.error.message}\n` : ''}${stderr.slice(-ERROR_SUMMARY_LIMIT)}${stderr ? '' : stdout.slice(-ERROR_SUMMARY_LIMIT)}${cleanupDetail ? `\nTimeout cleanup: ${cleanupDetail}` : ''}`,
      ).trim()
    : null;

  return {
    obligationExecutor: 'kernel-runtime',
    trust,
    commandRef: label,
    command,
    args,
    executedCommand: wrapped.command,
    executedArgs: wrapped.args,
    cwd: projectRoot,
    exitCode: timedOut || spawnFailed
      ? exitCode || 1
      : exitCode,
    timedOut,
    status: failed ? 'failed' : 'passed',
    stdoutDigest: sha256(stdout),
    stderrDigest: sha256(stderr),
    outputDigest: sha256(`${stdout}\n--stderr--\n${stderr}`),
    executedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    timeoutMs: effectiveTimeout,
    networkIsolation: network.networkIsolation,
    networkPolicy: network.networkPolicy,
    networkMechanism: 'mechanism' in network
      ? network.mechanism || null
      : null,
    evidenceRef,
    errorSummary,
    timeoutCleanup,
  };
};

export const executeTrustedProof = ({
  projectRoot = process.cwd(),
  commandRef,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  evidenceDir = null,
  networkPolicy = 'inherited',
  env = process.env,
}: TrustedProofInput = {}) => {
  const trusted = resolveTrustedCommand({
    projectRoot,
    commandRef,
  });
  const execution = runResolvedCommand({
    projectRoot,
    command: trusted.command,
    args: trusted.args,
    label: trusted.commandRef,
    trust: trusted.kind,
    timeoutMs,
    evidenceDir,
    networkPolicy,
    env,
  });
  return {
    ...execution,
    commandClass: trusted.commandClass,
    ecosystem: trusted.ecosystem,
  };
};

const APPROVED_COMMAND_ALLOWLIST = new Set([
  'npm', 'npx', 'node', 'pnpm', 'yarn', 'python', 'python3', 'pytest',
  'go', 'cargo', 'make', 'mvn', 'gradle', 'bash', 'sh',
]);

export const executeApprovedProof = ({
  projectRoot = process.cwd(),
  command,
  args = [],
  approval,
  label = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  evidenceDir = null,
  networkPolicy = 'inherited',
  env = process.env,
}: ApprovedProofInput = {}) => {
  if (!approval || !approval.approvedBy || !approval.approvalReceipt) {
    throw new CommandApprovalRequiredError(
      `Discovered command "${String(command)}" requires explicit approval (approvedBy + approvalReceipt)`,
    );
  }
  if (
    typeof command !== 'string'
    || !APPROVED_COMMAND_ALLOWLIST.has(command)
  ) {
    throw new UntrustedCommandError(
      `Approved command executable must be one of: ${[...APPROVED_COMMAND_ALLOWLIST].join(', ')}`,
    );
  }
  if (
    !Array.isArray(args)
    || args.some((arg) => typeof arg !== 'string')
  ) {
    throw new UntrustedCommandError(
      'Approved command args must be an array of strings',
    );
  }
  const safeArgs = args.filter(
    (arg): arg is string => typeof arg === 'string',
  );

  const argvDigest = sha256(
    JSON.stringify([command, ...safeArgs]),
  );
  if (
    approval.argvDigest
    && String(approval.argvDigest) !== argvDigest
  ) {
    throw new UntrustedCommandError(
      `Approval receipt is bound to a different command line (expected ${String(approval.argvDigest)}, got ${argvDigest})`,
    );
  }
  const execution = runResolvedCommand({
    projectRoot,
    command,
    args: safeArgs,
    label: label || command,
    trust: 'approved-discovered',
    timeoutMs,
    evidenceDir,
    networkPolicy,
    env,
  });
  return {
    ...execution,
    argvDigest,
    commandClass: 'script',
    ecosystem: 'approved',
  };
};

export const approvalArgvDigest = (
  command: string,
  args: readonly string[] = [],
): string => sha256(JSON.stringify([command, ...args]));

export const executeWithFlakyRerun = <T extends FlakyExecutionLike>(
  runner: () => T,
) => {
  const first = runner();
  if (first.status === 'passed') {
    return { ...first, flaky: false, reruns: 0 };
  }
  const second = runner();
  const flaky = second.status !== first.status;
  return {
    ...second,
    flaky,
    reruns: 1,
    firstStatus: first.status,
  };
};
