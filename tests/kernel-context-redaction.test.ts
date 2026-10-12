import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildKernelContext } from '../src/kernel/context-build.js';

test('raw logs are omitted and secrets are redacted from JSON objects and text content', () => {
  const secretToken = 'secret-token-abc-999';
  const secretApiKey = 'secret-api-key-12345';
  const secretBearer = 'bearer-token-xyz-555';
  const secretPassword = 'my-db-password-777';

  const r = buildKernelContext({
    stage: 'PROVE',
    principles: [],
    taskContract: {
      objective: 'x',
      token: secretToken,
      nested: {
        api_key: secretApiKey,
        auth: {
          password: secretPassword,
        },
      },
    },
    stageRecords: [
      { id: 'log', type: 'raw-runtime-log', content: 'secret=raw-content' },
      { id: 'doc', type: 'doc', content: `api_key=${secretApiKey} and Authorization: Bearer ${secretBearer}` },
    ],
  });

  assert.ok(Array.isArray(r.receipt.omitted));
  const omitted: unknown = r.receipt.omitted[0];
  assert.ok(omitted && typeof omitted === 'object' && 'reason' in omitted);
  assert.equal(omitted.reason, 'forbidden-type');

  // Verify none of the sensitive secrets appear in promptBlock
  assert.doesNotMatch(r.promptBlock, new RegExp(secretToken));
  assert.doesNotMatch(r.promptBlock, new RegExp(secretApiKey));
  assert.doesNotMatch(r.promptBlock, new RegExp(secretBearer));
  assert.doesNotMatch(r.promptBlock, new RegExp(secretPassword));
  assert.doesNotMatch(r.promptBlock, /raw-content/);

  // Verify redaction placeholder is present
  assert.match(r.promptBlock, /REDACTED/);
});
