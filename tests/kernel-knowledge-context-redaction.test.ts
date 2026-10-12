import test from 'node:test';
import assert from 'node:assert/strict';
import { redactSecrets, renderPromptBlock } from '../src/kernel/knowledge/context-render.js';

test('redactSecrets sanitizes API keys and tokens', () => {
  const input = 'API key api_key: "sk-1234567890abcdef12345678" and secret token ghp_1234567890abcdef1234';
  const redacted = redactSecrets(input);
  assert.ok(!redacted.includes('sk-1234567890abcdef12345678'));
  assert.ok(!redacted.includes('ghp_1234567890abcdef1234'));
  assert.ok(redacted.includes('[REDACTED]'));
});

test('renderPromptBlock excludes raw graph and logs', () => {
  const rendered = renderPromptBlock({
    stage: 'FRAME',
    semanticFacts: [{ statement: 'Sanitized fact statement' }],
  });

  assert.ok(rendered.includes('Sanitized fact statement'));
  assert.ok(!rendered.includes('raw_graph_payload'));
});
