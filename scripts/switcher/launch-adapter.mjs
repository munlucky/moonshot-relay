import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { pathsOverlap, resolveSurfaceRoots } from './paths.mjs';
import { canonicalPath } from '../kernel/runtime-home.mjs';
import { canonicalizeHostSessionId, providerForSurface } from '../kernel/run/host-session.mjs';
import { nativeProviderDescriptor } from './native-provider.mjs';
import { KERNEL_RUNTIME_ID, SURFACE_ENV } from './constants.mjs';
import { withAdeQwenOwnerArgs } from '../host/kernel/ade-context-policy.mjs';

function resolveClaudeDesktopAumid({ platform = process.platform, execFileSyncImpl = execFileSync } = {}) {
  if (platform !== 'win32') return null;
  try {
    const out = execFileSyncImpl('powershell.exe', ['-NoProfile', '-Command', '(Get-AppxPackage *Claude*).PackageFamilyName'], { encoding: 'utf8', windowsHide: true, timeout: 3000 });
    const familyName = out.trim();
    if (familyName) return familyName + '!Claude';
  } catch {}
  return 'Claude_pzs8sxrjxfjjc!Claude';
}

function resolveCommandPath(command, { platform = process.platform, execFileSyncImpl = execFileSync } = {}) {
  if (!command || path.isAbsolute(command)) return command;
  if (platform === 'win32') {
    try {
      const output = execFileSyncImpl('where.exe', [command], { encoding: 'utf8', windowsHide: true, timeout: 3000 });
      const found = output.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
      if (found) return found;
    } catch {}
  }
  return command;
}

const runtimeEnvKeys = Object.freeze([
  'MOON_RELAY_TRACK',
  'MOON_RELAY_KERNEL_HOME',
  'MOON_RELAY_KERNEL_RUN_ID',
  'MOON_RELAY_KERNEL_PROJECT_ID',
  'MOON_RELAY_KERNEL_SESSION_ID',
  'MOON_RELAY_KERNEL_LEGACY_SESSION_ID',
  'MOON_RELAY_KERNEL_PROVIDER',
  'MOON_RELAY_KERNEL_SURFACE',
  'MOON_RELAY_KERNEL_WORKSPACE_ID',
  'MOON_RELAY_WORKSPACE_ROOT',
]);

export function buildProcessEnvironment({ surface, roots, workspaceRoot = null, workspaceId = null, runId = null, projectId = null, sessionId = null, baseEnv = process.env } = {}) {
  if (!roots?.runtimeHome || !roots?.providerHome) throw new Error('unsafe_target: native provider roots are required');
  if (pathsOverlap(roots.runtimeHome, roots.providerHome)) {
    throw Object.assign(new Error('unsafe_target: native provider home overlaps Kernel runtime'), { code: 'unsafe_target' });
  }
  const env = { ...baseEnv };
  for (const key of runtimeEnvKeys) delete env[key];
  const provider = providerForSurface(surface);
  env.MOON_RELAY_KERNEL_HOME = canonicalPath(roots.runtimeHome);
  env.MOON_RELAY_KERNEL_RUNTIME = KERNEL_RUNTIME_ID;
  env.PATH = path.join(roots.runtimeHome, 'bin') + path.delimiter + (env.PATH || env.Path || '');
  delete env.Path;
  if (runId) env.MOON_RELAY_KERNEL_RUN_ID = String(runId);
  if (projectId) env.MOON_RELAY_KERNEL_PROJECT_ID = String(projectId);
  if (sessionId) env.MOON_RELAY_KERNEL_SESSION_ID = canonicalizeHostSessionId({ provider, sessionId });
  env.MOON_RELAY_KERNEL_PROVIDER = provider;
  if (workspaceId) env.MOON_RELAY_KERNEL_WORKSPACE_ID = String(workspaceId);
  if (surface) env.MOON_RELAY_KERNEL_SURFACE = surface;
  if (workspaceRoot) env.MOON_RELAY_WORKSPACE_ROOT = path.resolve(workspaceRoot);

  // Native provider homes are operator/user-owned. Preserve the complete
  // provider environment; the Kernel runtime never swaps all Provider homes.
  // When a caller supplies an explicit native root and no corresponding
  // process binding exists, bind only the active surface.
  const providerEnv = SURFACE_ENV[surface];
  if (providerEnv && !env[providerEnv]) env[providerEnv] = roots.providerHome;
  if (surface === 'ade_cli') {
    // ADE embeds Qwen Code but owns an independent provider home. Bind the
    // underlying Qwen runtime to ADE_HOME so it cannot accidentally hydrate
    // ~/.qwen or another raw Qwen profile. System defaults are lowest
    // precedence and therefore preserve operator/project model settings.
    env.QWEN_HOME = roots.providerHome;
    env.QWEN_CODE_DISABLE_WORKFLOWS = '1';
    if (!env.QWEN_CODE_SYSTEM_DEFAULTS_PATH) {
      env.QWEN_CODE_SYSTEM_DEFAULTS_PATH = path.join(roots.providerHome, 'qwen-system-defaults.json');
    }
  }
  if (surface === 'antigravity_desktop') {
    if (!env.GEMINI_HOME) env.GEMINI_HOME = roots.providerHome;
    if (!env.ANTIGRAVITY_HOME) env.ANTIGRAVITY_HOME = roots.providerHome;
  }
  return env;
}

const defaultCommand = (surface, platform = process.platform) => {
  if (surface === 'claude_desktop') return platform === 'darwin' ? 'Claude' : 'Claude.exe';
  if (surface === 'claude_cli') return 'claude';
  if (surface === 'qwen_cli') return 'qwen';
  if (surface === 'ade_cli') return 'ade';
  if (surface === 'codex_cli') return 'codex';
  return surface;
};

export function buildLaunchSpec({ surface, sourceRoot = process.cwd(), workspaceRoot = null, workspaceId = null, runId = null, projectId = null, sessionId = null, command, args = [], roots = resolveSurfaceRoots({ surface, sourceRoot }) } = {}) {
  const resolvedWorkspace = workspaceRoot ? path.resolve(workspaceRoot) : path.resolve(sourceRoot);
  const nativeProvider = {
    ...nativeProviderDescriptor({ surface, command, runtimeHome: roots.runtimeHome }),
    completionAuthority: 'kernel',
    runtime: KERNEL_RUNTIME_ID,
  };
  return {
    schemaVersion: 1,
    surface,
    runtime: KERNEL_RUNTIME_ID,
    command: command || nativeProvider.command || defaultCommand(surface),
    args: surface === 'ade_cli' ? withAdeQwenOwnerArgs(args) : [...args],
    aumid: null,
    roots,
    workspaceRoot: resolvedWorkspace,
    cwd: resolvedWorkspace || process.cwd(),
    expectedPublicSkills: ['moon-relay-kernel'],
    providerRuntime: nativeProvider,
    env: buildProcessEnvironment({ surface, roots, workspaceRoot: resolvedWorkspace, workspaceId, runId, projectId, sessionId }),
  };
}

export function spawnNativeSurface(spec, { spawnImpl = spawn, platform = process.platform, execFileSyncImpl = execFileSync } = {}) {
  if (platform === 'win32' && (spec.surface === 'claude_desktop' || spec.surface === 'claude-app')) {
    const cmdExecutable = process.env.ComSpec || path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
    const aumid = spec.aumid || resolveClaudeDesktopAumid({ platform, execFileSyncImpl });
    if (aumid) {
      const shellTarget = 'shell:AppsFolder\\' + aumid;
      const child = spawnImpl(cmdExecutable, ['/c', 'start', shellTarget, ...spec.args], {
        env: spec.env,
        cwd: spec.cwd || process.cwd(),
        windowsHide: false,
        detached: true,
        stdio: 'ignore',
      });
      child.on?.('error', () => {});
      child.unref?.();
      return { pid: child.pid || null, status: 'launch_requested', child, launcher: 'cmd_shell_activation' };
    }
  }
  if (platform === 'darwin' && (spec.surface === 'claude_desktop' || spec.surface === 'claude-app')) {
    const openArgs = ['-a', 'Claude'];
    if (spec.args.length) openArgs.push('--args', ...spec.args);
    const child = spawnImpl('open', openArgs, {
      env: spec.env,
      cwd: spec.cwd || process.cwd(),
      detached: true,
      stdio: 'ignore',
    });
    child.on?.('error', () => {});
    child.unref?.();
    return { pid: child.pid || null, status: 'launch_requested', child, launcher: 'macos_open' };
  }
  if (platform === 'win32' && spec.surface?.endsWith('_cli')) {
    const cmdExecutable = process.env.ComSpec || path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
    const resolvedTarget = resolveCommandPath(spec.command, { platform, execFileSyncImpl });
    const child = spawnImpl(cmdExecutable, ['/d', '/s', '/c', 'start', '', resolvedTarget, ...spec.args], {
      env: spec.env,
      cwd: spec.cwd || process.cwd(),
      windowsHide: false,
      detached: true,
      stdio: 'ignore',
    });
    child.on?.('error', () => {});
    child.unref?.();
    return { pid: child.pid || null, status: 'launch_requested', child, launcher: 'cmd_start_cli' };
  }

  const isCmdOrBat = platform === 'win32' && (/\.(cmd|bat)$/i.test(spec.command) || spec.surface?.endsWith('_cli'));
  const options = {
    env: spec.env,
    cwd: spec.cwd || process.cwd(),
    windowsHide: platform === 'win32' && spec.surface === 'antigravity_desktop' ? false : true,
    detached: platform === 'win32' && spec.surface === 'antigravity_desktop',
    stdio: 'ignore',
    ...(isCmdOrBat ? { shell: true } : {}),
  };

  const isWindowsApps = platform === 'win32' && (/[\\/]WindowsApps[\\/]/i.test(spec.command) || Boolean(spec.aumid));
  if (isWindowsApps) {
    const env = {
      ...spec.env,
      MOON_SWITCHER_TARGET: spec.command,
      MOON_SWITCHER_ARGS_JSON: JSON.stringify(spec.args),
      MOON_SWITCHER_AUMID: spec.aumid || '',
      MOON_SWITCHER_WINDOW_TITLE: spec.surface === 'antigravity_desktop' ? 'Antigravity' : 'ChatGPT',
    };
    const aumid = spec.aumid || null;
    const shellTarget = 'shell:AppsFolder\\' + aumid;
    let child;
    if (aumid) {
      const cmdExecutable = process.env.ComSpec || path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
      child = spawnImpl(cmdExecutable, ['/c', 'start', shellTarget, ...spec.args], { ...options, env });
      child.on?.('error', () => {});
    } else {
      const psScript = "$ErrorActionPreference='SilentlyContinue'; $envHash = @{}; Get-ChildItem env: | ForEach-Object { $envHash[$_.Name] = $_.Value }; try { Start-Process -FilePath $env:MOON_SWITCHER_TARGET -ArgumentList (@($env:MOON_SWITCHER_ARGS_JSON | ConvertFrom-Json)) -Environment $envHash -WindowStyle Normal } catch { Start-Process -FilePath $env:MOON_SWITCHER_TARGET -ArgumentList (@($env:MOON_SWITCHER_ARGS_JSON | ConvertFrom-Json)) -WindowStyle Normal }";
      const psExec = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      child = spawnImpl(psExec, ['-NoProfile', '-Command', psScript], { ...options, env });
      child.on?.('error', () => {});
      child.unref?.();
    }
    return { pid: null, status: 'launch_requested', child, launcher: aumid ? 'cmd_shell_activation' : 'powershell_start_process' };
  }

  const child = spawnImpl(spec.command, spec.args, options);
  child.on?.('error', () => {});
  child.unref?.();
  return { pid: child.pid || null, status: 'launch_requested', child, launcher: 'direct' };
}
