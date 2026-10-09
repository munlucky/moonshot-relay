import { createHash } from 'node:crypto';
import { redactSessionSnapshot } from '../../knowledge-ingestion/redact.mjs';
import { normalizeSession as normalizeBase } from '../../knowledge-ingestion/normalize.mjs';

export function normalizeProviderSession({ provider, nativeSessionId, locator, session } = {}) {
  const safe = redactSessionSnapshot(session || {});
  const digest = `sha256:${createHash('sha256').update(JSON.stringify(safe)).digest('hex')}`;
  return normalizeBase({ ...safe, sourceDigest: digest }, { provider, nativeSessionId, locator });
}
