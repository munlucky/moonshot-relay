import os from 'node:os';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

const explicit = {
  codex: ['MOON_RELAY_CODEX_SESSION_ROOT', 'CODEX_SESSION_ROOT'],
  claude: ['MOON_RELAY_CLAUDE_SESSION_ROOT', 'CLAUDE_SESSION_ROOT'],
};

export function resolveProviderSessionRoots(provider, { env = process.env, home = os.homedir() } = {}) {
  const name = String(provider || '').toLowerCase();
  for (const variable of explicit[name] || []) {
    if (env[variable]) return { provider: name, roots: [path.resolve(env[variable])], source: `env:${variable}`, available: existsSync(path.resolve(env[variable])) };
  }
  const profileRoot = name === 'codex' ? (env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(home, '.codex')) : (env.CLAUDE_CONFIG_DIR ? path.resolve(env.CLAUDE_CONFIG_DIR) : path.join(home, '.claude'));
  const configured = path.join(profileRoot, 'profile.json');
  if (existsSync(configured)) {
    try {
      const parsed = JSON.parse(readFileSync(configured, 'utf8'));
      const configuredRoot = parsed.sessionRoot || parsed.sessionsRoot || parsed.sessions;
      if (configuredRoot) return { provider: name, roots: [path.resolve(configuredRoot)], source: 'provider-profile', available: existsSync(path.resolve(configuredRoot)) };
    } catch {}
  }
  const roots = name === 'codex'
    ? [path.join(profileRoot, 'sessions'), profileRoot]
    : [path.join(profileRoot, 'projects'), path.join(profileRoot, 'sessions'), profileRoot];
  return { provider: name, roots, source: 'provider-default', available: roots.some((root) => existsSync(root)) };
}

export const providerUnavailable = (provider, resolved) => ({ provider, status: 'unavailable', reason: 'session_store_missing', resolution: resolved });
