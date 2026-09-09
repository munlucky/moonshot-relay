import path from 'node:path';
import { providerForSurface } from '../kernel/run/host-session.mjs';
import { resolveCommand } from './app-resolver/common.mjs';

// Kernel owns orchestration and its Node runtime only. The provider process
// remains the native installation selected by the host/operator; provider
// binaries are never copied into or resolved from the Kernel payload.
export const NATIVE_PROVIDER_POLICY = Object.freeze({
  schemaVersion: 1,
  mode: 'native-provider',
  managedRuntime: 'kernel-node-only',
  dataRoot: 'native-provider-home',
  executionLayer: 'native-surface',
  runtimeIsolation: 'kernel-state-only',
  completionAuthority: 'kernel',
});

const PROVIDERS = Object.freeze({
  claude_desktop: { command: process.platform === 'darwin' ? 'Claude' : 'Claude.exe', envKey: 'CLAUDE_DESKTOP_EXECUTABLE' },
  claude_cli: { command: 'claude', envKey: 'CLAUDE_EXECUTABLE' },
  codex_cli: { command: 'codex', envKey: 'CODEX_EXECUTABLE' },
  codex_desktop: { command: 'ChatGPT.exe', envKey: 'CODEX_DESKTOP_EXECUTABLE' },
  qwen_cli: { command: 'qwen', envKey: 'QWEN_EXECUTABLE' },
  ade_cli: { command: 'ade', envKey: 'ADE_EXECUTABLE' },
  antigravity_desktop: { command: 'Antigravity.exe', envKey: 'ANTIGRAVITY_EXECUTABLE' },
});

const pathKey = (value) => path.resolve(value).replaceAll('\\', '/').toLowerCase();
const isWithin = (root, target) => target === root || target.startsWith(`${root}/`);

export const nativeProviderDescriptor = ({ surface, command = null, runtimeHome = null, env = process.env } = {}) => {
  const defaults = PROVIDERS[surface];
  if (!defaults) throw new Error(`unsupported_native_provider_surface: ${surface}`);
  const configured = command || env?.[defaults.envKey] || defaults.command;
  if (runtimeHome && path.isAbsolute(configured)) {
    const kernelRoot = pathKey(runtimeHome);
    const providerCommand = pathKey(configured);
    if (isWithin(kernelRoot, providerCommand)) {
      throw Object.assign(new Error('managed_provider_runtime_forbidden'), {
        code: 'managed_provider_runtime_forbidden',
        details: { surface, command: configured, runtimeHome },
      });
    }
  }
  return {
    ...NATIVE_PROVIDER_POLICY,
    provider: providerForSurface(surface),
    surface,
    command: configured,
    commandSource: command ? 'launch-spec' : env?.[defaults.envKey] ? 'operator-env' : 'native-default',
    envKey: defaults.envKey,
  };
};

export async function resolveNativeProvider({ surface, command = null, runtimeHome = null, env = process.env, commandResolver = resolveCommand } = {}) {
  const descriptor = nativeProviderDescriptor({ surface, command, runtimeHome, env });
  if (command || env?.[descriptor.envKey]) {
    return { ...descriptor, status: 'configured' };
  }
  const resolved = await commandResolver(descriptor.command);
  return { ...descriptor, status: resolved ? 'resolved' : 'not_found', resolvedCommand: resolved || null };
}
