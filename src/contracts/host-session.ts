import { matchCapture } from '../shared/match-capture.js';
const PROVIDER_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const SESSION_PREFIX_PATTERN = /^([a-z][a-z0-9-]{0,31}):(.+)$/;

export class ProviderSessionError extends Error {
  readonly code = 'provider_session_invalid';
  readonly errorCode = 'provider_session_invalid';
  readonly nextAction = 'reopen-from-correct-worktree';
  readonly details: Record<string, unknown>;

  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ProviderSessionError';
    this.details = details;
  }
}

const requireProvider = (provider: unknown): string => {
  const normalized = String(provider || '').trim().toLowerCase();
  if (!PROVIDER_PATTERN.test(normalized)) {
    throw new ProviderSessionError(
      'provider and nativeSessionId are required',
      { provider },
    );
  }
  return normalized;
};

const requireNativeSessionId = (nativeSessionId: unknown): string => {
  const normalized = String(nativeSessionId || '').trim();
  if (!normalized || normalized.includes('\0')) {
    throw new ProviderSessionError('provider and nativeSessionId are required');
  }
  return normalized;
};

export function createHostSessionId({
  provider,
  nativeSessionId,
}: {
  provider?: unknown;
  nativeSessionId?: unknown;
} = {}): string {
  return `${requireProvider(provider)}:${requireNativeSessionId(nativeSessionId)}`;
}

export function canonicalizeHostSessionId({
  provider,
  sessionId,
}: {
  provider?: unknown;
  sessionId?: unknown;
} = {}): string {
  const normalizedProvider = requireProvider(provider);
  const normalizedSessionId = requireNativeSessionId(sessionId);
  const scoped = normalizedSessionId.match(SESSION_PREFIX_PATTERN);
  if (!scoped) {
    return createHostSessionId({
      provider: normalizedProvider,
      nativeSessionId: normalizedSessionId,
    });
  }
  if (matchCapture(scoped, 1) !== normalizedProvider && normalizedProvider !== 'unknown-host') {
    throw new ProviderSessionError(
      'session provider does not match the launching provider',
      {
        provider: normalizedProvider,
        sessionProvider: matchCapture(scoped, 1),
      },
    );
  }
  return normalizedSessionId;
}
