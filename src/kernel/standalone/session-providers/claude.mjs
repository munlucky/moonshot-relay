import { discoverProviderSessions, readProviderSession, normalizeProviderSession } from './generic.mjs';
export const discoverSessions = (options = {}) => discoverProviderSessions('claude', options);
export const readSession = (nativeSessionId, options = {}) => readProviderSession('claude', nativeSessionId, options);
export { normalizeProviderSession as normalizeSession };
