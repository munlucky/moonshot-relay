import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPromptEnvelope, renderCacheablePrompt, renderFullPrompt, findControlLeaks, SEGMENT_KINDS } from '../src/host/kernel/prompt-envelope.js';
import { buildToolManifest } from '../src/host/kernel/tool-manifest.js';
import { buildKernelContextSegments } from '../src/host/kernel/context-segments.js';

const manifest = () => buildToolManifest([
  { name: 'read_file', description: 'Read a file', inputSchema: { type: 'object' } },
  { name: 'edit_file', description: 'Edit a file', inputSchema: { type: 'object' } },
]);

const context = () => buildKernelContextSegments({
  projectStable: { policyAnchors: [{ id: 'pa1', type: 'policy_anchor', revision: 'r1', statement: 'Core stays provider-neutral.' }] },
  runStable: { objective: 'Stabilize the prefix.', acceptance: ['Deterministic segments.'] },
  volatile: { step: { stepId: 'step-1', objective: 'Add segments.' } },
}).segments;

const build = (overrides = {}) => buildPromptEnvelope({
  provider: 'claude',
  surface: 'claude',
  role: 'implementer',
  toolManifest: manifest(),
  contextSegments: context(),
  modelPolicy: { modelClass: 'value_coding', resolvedModel: 'model-a', resolvedEffort: 'high' },
  capabilities: { supportsPromptCache: true, supportsExplicitCacheBreakpoints: true },
  control: { runId: 'run-alpha-01', stepId: 'step-alpha-01', capsuleId: 'capsule-alpha-01', routeDecisionId: 'route-abc12345', admissionId: 'adm-alpha-01', mutationRevision: 7 },
  ...overrides,
});

test('an envelope emits every segment kind in cache order', () => {
  const envelope = build();
  assert.equal(envelope.schemaVersion, 2);
  assert.deepEqual(envelope.segments.map((s) => s.kind), SEGMENT_KINDS);
  assert.deepEqual(envelope.segments.map((s) => s.cacheable), [true, true, true, true, true, false]);
});

test('control metadata never reaches the prompt', () => {
  const envelope = build();
  assert.deepEqual(findControlLeaks(envelope), []);
  const prompt = renderFullPrompt(envelope);
  for (const value of ['run-alpha-01', 'step-alpha-01', 'capsule-alpha-01', 'route-abc12345', 'adm-alpha-01']) {
    assert.ok(!prompt.includes(value), `control value leaked into the prompt: ${value}`);
  }
  assert.equal(envelope.control.runId, 'run-alpha-01');
});

test('the resolved model and effort are cache identity but not prompt content', () => {
  const envelope = build();
  const prompt = renderFullPrompt(envelope);
  assert.ok(!prompt.includes('model-a'));
  assert.ok(!/\bhigh\b/.test(prompt.split('Run Stable')[0] ?? ''));
  assert.equal(envelope.cacheIdentity.resolvedModel, 'model-a');
  assert.equal(envelope.cacheIdentity.resolvedEffort, 'high');
});

test('the cacheable prompt excludes the volatile tail', () => {
  const envelope = build();
  const cacheable = renderCacheablePrompt(envelope);
  assert.ok(!cacheable.includes('step-1'));
  assert.ok(renderFullPrompt(envelope).includes('step-1'));
});

test('a capability the Host did not declare yields no explicit cache mode', () => {
  const envelope = build({ capabilities: {} });
  assert.equal(envelope.cachePolicy.providerMode, 'none');
  assert.equal(envelope.cachePolicy.unsupportedReason, 'provider-unsupported');
});

test('a Host with implicit-only caching does not get explicit breakpoints', () => {
  const envelope = build({ capabilities: { supportsPromptCache: true } });
  assert.equal(envelope.cachePolicy.providerMode, 'implicit');
});
