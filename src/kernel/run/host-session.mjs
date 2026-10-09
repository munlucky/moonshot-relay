const PROVIDER_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const SESSION_PREFIX_PATTERN = /^([a-z][a-z0-9-]{0,31}):(.+)$/;

export class ProviderSessionError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ProviderSessionError';
    this.code = 'provider_session_invalid';
    this.errorCode = 'provider_session_invalid';
    this.nextAction = 'reopen-from-correct-worktree';
    this.details = details;
  }
}

export class HostBindingConflictError extends Error {
  constructor(bindings = []) {
    super('host_binding_conflict');
    this.name = 'HostBindingConflictError';
    this.code = 'host_binding_conflict';
    this.errorCode = 'host_binding_conflict';
    this.nextAction = 'reopen-from-correct-worktree';
    this.details = { bindings };
  }
}

const requireProvider = (provider) => {
  const normalized = String(provider || '').trim().toLowerCase();
  if (!PROVIDER_PATTERN.test(normalized)) {
    throw new ProviderSessionError('provider and nativeSessionId are required', { provider });
  }
  return normalized;
};

const requireNativeSessionId = (nativeSessionId) => {
  const normalized = String(nativeSessionId || '').trim();
  if (!normalized || normalized.includes('\0')) {
    throw new ProviderSessionError('provider and nativeSessionId are required');
  }
  return normalized;
};

export function createHostSessionId({ provider, nativeSessionId } = {}) {
  return `${requireProvider(provider)}:${requireNativeSessionId(nativeSessionId)}`;
}

export function canonicalizeHostSessionId({ provider, sessionId } = {}) {
  const normalizedProvider = requireProvider(provider);
  const normalizedSessionId = requireNativeSessionId(sessionId);
  const scoped = normalizedSessionId.match(SESSION_PREFIX_PATTERN);
  if (!scoped) {
    return createHostSessionId({
      provider: normalizedProvider,
      nativeSessionId: normalizedSessionId,
    });
  }
  if (scoped[1] !== normalizedProvider && normalizedProvider !== 'unknown-host') {
    throw new ProviderSessionError('session provider does not match the launching provider', {
      provider: normalizedProvider,
      sessionProvider: scoped[1],
    });
  }
  return normalizedSessionId;
}

export function resolveCanonicalHostSession({
  provider,
  explicitSessionId = null,
  envSessionId = null,
  codexThreadId = null,
} = {}) {
  const candidates = [
    ['cli', explicitSessionId, provider],
    ['environment', envSessionId, provider],
    ['codex-thread', codexThreadId, 'codex'],
  ].filter(([, value]) => String(value || '').trim());
  if (candidates.length === 0) return { sessionId: null, nativeSessionId: null, source: null };
  const resolved = candidates.map(([source, value, candidateProvider]) => ({
    source,
    nativeSessionId: String(value).trim(),
    sessionId: canonicalizeHostSessionId({ provider: candidateProvider, sessionId: value }),
  }));
  if (new Set(resolved.map((item) => item.sessionId)).size > 1) {
    throw new HostBindingConflictError(resolved.map(({ source, sessionId }) => ({ source, sessionId })));
  }
  return resolved[0];
}

export function providerForSurface(surface) {
  const normalized = String(surface || '').trim().toLowerCase();
  if (normalized === 'codex_desktop' || normalized === 'codex') return 'codex';
  if (normalized === 'codex_cli') return 'codex-cli';
  if (normalized === 'claude_desktop' || normalized === 'claude') return 'claude';
  if (normalized === 'claude_cli' || normalized === 'claude_code') return 'claude-code';
  if (normalized === 'qwen_cli' || normalized === 'qwen') return 'qwen';
  if (normalized === 'ade_cli' || normalized === 'ade') return 'ade';
  if (normalized === 'antigravity_desktop' || normalized === 'antigravity') return 'antigravity';
  return 'unknown-host';
}
