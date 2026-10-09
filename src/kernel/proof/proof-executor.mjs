import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveNetworkExecution } from './network-policy.mjs';
import { discoverProjectCommands, findProjectCommand } from './command-catalog.mjs';
import { sanitizePersistentText } from '../persistent-sanitizer.mjs';
import { cleanupWindowsTimeoutProcessTree } from './process-tree.mjs';

const COMMAND_REF_REGEX = /^[A-Za-z0-9:._/-]+$/;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_OUTPUT_BUFFER = 32 * 1024 * 1024;
const ERROR_SUMMARY_LIMIT = 2000;

// Child processes get an explicit allowlist, never the full parent
// environment, so ambient secrets are not handed to project scripts.
const ENV_ALLOWLIST = [
  'PATH', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'ComSpec', 'COMSPEC',
  'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
  'ProgramFiles', 'ProgramData', 'SHELL', 'LANG', 'LC_ALL', 'TZ',
];

export class UntrustedCommandError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UntrustedCommandError';
    this.code = 'UNTRUSTED_COMMAND';
  }
}

export class CommandApprovalRequiredError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CommandApprovalRequiredError';
    this.code = 'COMMAND_APPROVAL_REQUIRED';
  }
}

const sha256 = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;

export const redactSecretLikeOutput = (text) => String(text || '')
  .replace(/((?:api[_-]?key|access[_-]?key|secret|token|password|passwd|authorization|bearer)["']?\s*[:=]\s*)(["']?)[^\s"'&]+\2/gi, '$1$2[REDACTED]$2')
  .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]');

const buildChildEnv = () => {
  const env = {};
  for (const key of ENV_ALLOWLIST) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
};

// Windows executable resolution (P1-6). Resolving the concrete file ourselves
// means real executables (node, go, cargo, python, make) run shell-less, and
// only `.cmd`/`.bat` shims (npm, yarn, gradle) need a command processor.
export const resolveWindowsExecutable = (command, env = process.env) => {
  if (path.isAbsolute(command) || command.includes('/') || command.includes('\\')) {
    return { file: command, needsCommandProcessor: /\.(cmd|bat)$/i.test(command) };
  }
  const extensions = ['.EXE', '.COM', '.CMD', '.BAT'];
  const searchPath = String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  for (const dir of searchPath) {
    for (const extension of extensions) {
      const candidate = path.join(dir, `${command}${extension}`);
      if (existsSync(candidate)) {
        return { file: candidate, needsCommandProcessor: /\.(cmd|bat)$/i.test(extension) };
      }
    }
  }
  return null;
};

// Token safety is scoped to how the token will actually be delivered. A
// shell-less spawn passes argv untouched, so only control characters matter.
// The Windows command processor (needed for `.cmd` shims) is the one path
// where a token can break out of its quoting, and there the breakout
// characters are `"` and `%` — everything else is literal inside quotes (P1-6).
export const assertSafeCommandTokens = (tokens = [], { commandProcessor = false } = {}) => {
  for (const token of tokens) {
    if (typeof token !== 'string') {
      throw new UntrustedCommandError(`Command token must be a string: ${JSON.stringify(token)}`);
    }
    if (/[\x00-\x1f]/.test(token)) {
      throw new UntrustedCommandError(`Command token contains control characters: ${JSON.stringify(token)}`);
    }
    if (commandProcessor && /["%]/.test(token)) {
      throw new UntrustedCommandError(`Command token cannot be safely quoted for the Windows command processor: ${JSON.stringify(token)}`);
    }
  }
  return tokens;
};

// P0 trust boundary: only commands the project itself declares (npm/pnpm/yarn
// scripts, Makefile targets, or the canonical task command of a detected
// ecosystem manifest) are executable. Arbitrary commands are rejected here.
export const resolveTrustedCommand = ({ projectRoot = process.cwd(), commandRef } = {}) => {
  if (!commandRef || typeof commandRef !== 'string' || !COMMAND_REF_REGEX.test(commandRef)) {
    throw new UntrustedCommandError(`commandRef must match ${COMMAND_REF_REGEX}: ${commandRef}`);
  }
  const found = findProjectCommand({ projectRoot, commandRef });
  if (!found) {
    const available = discoverProjectCommands({ projectRoot }).map((command) => command.commandRef);
    throw new UntrustedCommandError(
      available.length > 0
        ? `Command ref is not declared by this project: ${commandRef} (declared: ${available.slice(0, 20).join(', ')})`
        : `No project manifest declares any runnable command at ${projectRoot}; cannot resolve trusted command`,
    );
  }
  return {
    kind: found.ecosystem === 'node' ? 'manifest-script' : `${found.ecosystem}-command`,
    commandRef,
    commandClass: found.commandClass,
    ecosystem: found.ecosystem,
    command: found.command,
    args: found.args,
    resolvedScript: found.declaration,
  };
};

// Shared runner for any resolved command (trusted project command or an
// explicitly approved discovered command). Isolation, digests, and honest
// facts are identical regardless of how the command was authorized.
const runResolvedCommand = ({ projectRoot, command, args, label, trust, timeoutMs, evidenceDir, networkPolicy = 'inherited', env = process.env }) => {
  // Resolve (and, when required, refuse) the network policy BEFORE running, so
  // isolation is never recorded unless the wrapper is actually applied.
  const network = resolveNetworkExecution({ policy: networkPolicy, env });
  const wrapped = network.wrapArgv(command, args);
  const effectiveTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, 30 * 60 * 1000) : DEFAULT_TIMEOUT_MS;
  const startedAt = new Date();
  const spawnOptions = {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: effectiveTimeout,
    maxBuffer: MAX_OUTPUT_BUFFER,
    env: buildChildEnv(),
  };
  let expectedCommand = wrapped.command;
  // On Windows the executable is resolved to a concrete file. Real executables
  // run shell-less; only `.cmd`/`.bat` shims go through the command processor,
  // and then every token is metacharacter-free (assertSafeCommandTokens) and
  // individually quoted, so nothing composable reaches it (P1-6).
  let result;
  if (process.platform === 'win32') {
    const resolved = resolveWindowsExecutable(wrapped.command, spawnOptions.env);
    if (!resolved) {
      throw new UntrustedCommandError(`Executable not found on PATH: ${wrapped.command}`);
    }
    expectedCommand = resolved.file;
    assertSafeCommandTokens([resolved.file, ...wrapped.args], { commandProcessor: resolved.needsCommandProcessor });
    result = resolved.needsCommandProcessor
      ? spawnSync(
        process.env.ComSpec || process.env.COMSPEC || 'cmd.exe',
        ['/d', '/s', '/c', `"${[resolved.file, ...wrapped.args].map((token) => `"${token}"`).join(' ')}"`],
        { ...spawnOptions, windowsVerbatimArguments: true },
      )
      : spawnSync(resolved.file, wrapped.args, spawnOptions);
  } else {
    assertSafeCommandTokens([wrapped.command, ...wrapped.args]);
    result = spawnSync(wrapped.command, wrapped.args, spawnOptions);
  }

  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  const timedOut = Boolean(result.error && result.error.code === 'ETIMEDOUT');
  const spawnFailed = Boolean(result.error && !timedOut);
  const exitCode = typeof result.status === 'number' ? result.status : 1;
  const timeoutCleanup = timedOut
    ? cleanupWindowsTimeoutProcessTree({
      launcherPid: result.pid,
      expectedCommand,
      expectedArgs: wrapped.args,
      startedAt,
    })
    : null;

  let evidenceRef = null;
  if (evidenceDir) {
    const stamp = `${startedAt.toISOString().replace(/[:.]/g, '-')}-${String(label).replace(/[^A-Za-z0-9_-]/g, '_')}`;
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(path.join(evidenceDir, `${stamp}.stdout.log`), sanitizePersistentText(stdout));
    writeFileSync(path.join(evidenceDir, `${stamp}.stderr.log`), sanitizePersistentText(stderr));
    evidenceRef = `evidence://proof/${stamp}`;
  }

  const failed = timedOut || spawnFailed || exitCode !== 0;
  const errorSummary = failed
    ? redactSecretLikeOutput(`${result.error ? `${result.error.message}\n` : ''}${stderr.slice(-ERROR_SUMMARY_LIMIT)}${stderr ? '' : stdout.slice(-ERROR_SUMMARY_LIMIT)}${timeoutCleanup?.status && timeoutCleanup.status !== 'completed' && timeoutCleanup.status !== 'not-applicable' ? `\nTimeout cleanup: ${timeoutCleanup.reason || timeoutCleanup.status}` : ''}`).trim()
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
    exitCode: timedOut || spawnFailed ? exitCode || 1 : exitCode,
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
    networkMechanism: network.mechanism || null,
    evidenceRef,
    errorSummary,
    timeoutCleanup,
  };
};

export const executeTrustedProof = ({ projectRoot = process.cwd(), commandRef, timeoutMs = DEFAULT_TIMEOUT_MS, evidenceDir, networkPolicy = 'inherited', env = process.env } = {}) => {
  const trusted = resolveTrustedCommand({ projectRoot, commandRef });
  const execution = runResolvedCommand({ projectRoot, command: trusted.command, args: trusted.args, label: commandRef, trust: trusted.kind, timeoutMs, evidenceDir, networkPolicy, env });
  return { ...execution, commandClass: trusted.commandClass, ecosystem: trusted.ecosystem };
};

const APPROVED_COMMAND_ALLOWLIST = new Set(['npm', 'npx', 'node', 'pnpm', 'yarn', 'python', 'python3', 'pytest', 'go', 'cargo', 'make', 'mvn', 'gradle', 'bash', 'sh']);

// Discovered / ad-hoc command path (§11.3): a command not declared by the
// project may only run when the caller supplies an explicit approval
// (approvedBy + approvalReceipt) that is bound to the exact argv it approved.
export const executeApprovedProof = ({ projectRoot = process.cwd(), command, args = [], approval, label, timeoutMs = DEFAULT_TIMEOUT_MS, evidenceDir, networkPolicy = 'inherited', env = process.env } = {}) => {
  if (!approval || !approval.approvedBy || !approval.approvalReceipt) {
    throw new CommandApprovalRequiredError(`Discovered command "${command}" requires explicit approval (approvedBy + approvalReceipt)`);
  }
  if (typeof command !== 'string' || !APPROVED_COMMAND_ALLOWLIST.has(command)) {
    throw new UntrustedCommandError(`Approved command executable must be one of: ${[...APPROVED_COMMAND_ALLOWLIST].join(', ')}`);
  }
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
    throw new UntrustedCommandError('Approved command args must be an array of strings');
  }
  // The approval must cover the argv actually executed, not just the
  // executable name, so an approved `npm test` cannot be replayed as anything
  // else (P1-6).
  const argvDigest = sha256(JSON.stringify([command, ...args]));
  if (approval.argvDigest && approval.argvDigest !== argvDigest) {
    throw new UntrustedCommandError(`Approval receipt is bound to a different command line (expected ${approval.argvDigest}, got ${argvDigest})`);
  }
  const execution = runResolvedCommand({ projectRoot, command, args, label: label || command, trust: 'approved-discovered', timeoutMs, evidenceDir, networkPolicy, env });
  return { ...execution, argvDigest, commandClass: 'script', ecosystem: 'approved' };
};

export const approvalArgvDigest = (command, args = []) => sha256(JSON.stringify([command, ...args]));

// Re-runs a command once at the same workspace state to detect flakiness
// (§17.2): a differing pass/fail across identical runs marks it a candidate.
export const executeWithFlakyRerun = (runner) => {
  const first = runner();
  if (first.status === 'passed') return { ...first, flaky: false, reruns: 0 };
  const second = runner();
  const flaky = second.status !== first.status;
  return { ...second, flaky, reruns: 1, firstStatus: first.status };
};
