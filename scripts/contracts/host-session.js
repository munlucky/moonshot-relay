// Generated from src/contracts/host-session.ts. Edit the source and run npm run build.
import { matchCapture } from '../lib/match-capture.js';
const PROVIDER_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const SESSION_PREFIX_PATTERN = /^([a-z][a-z0-9-]{0,31}):(.+)$/;
export class ProviderSessionError extends Error {
    code = 'provider_session_invalid';
    errorCode = 'provider_session_invalid';
    nextAction = 'reopen-from-correct-worktree';
    details;
    constructor(message, details = {}) {
        super(message);
        this.name = 'ProviderSessionError';
        this.details = details;
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
export function createHostSessionId({ provider, nativeSessionId, } = {}) {
    return `${requireProvider(provider)}:${requireNativeSessionId(nativeSessionId)}`;
}
export function canonicalizeHostSessionId({ provider, sessionId, } = {}) {
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
        throw new ProviderSessionError('session provider does not match the launching provider', {
            provider: normalizedProvider,
            sessionProvider: matchCapture(scoped, 1),
        });
    }
    return normalizedSessionId;
}
