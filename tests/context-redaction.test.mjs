import test from 'node:test';
import assert from 'node:assert/strict';
import { redactSecrets } from '../scripts/kernel/knowledge/context-render.js';

test('Context Redaction - redacts secret tokens and sensitive environment payloads', async () => {
  const payload = 'api_key: sk-proj-12345678901234567890 AND token: ghp_12345678901234567890';
  const redacted = redactSecrets(payload);

  assert.equal(redacted.includes('sk-proj-12345678901234567890'), false);
  assert.equal(redacted.includes('ghp_12345678901234567890'), false);
  assert.equal(redacted.includes('[REDACTED]'), true);
});
